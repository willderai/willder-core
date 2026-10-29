// One-time backfill of `User.emailVerified` from Clerk, for users stored before
// the column existed.
//
// Source-connect widening (services/access/source-widening.ts) trusts an email
// match only when `emailVerified` is true, so every user left at null counts as
// gaining access on every connect until their next sign-in. This pages through
// those users, asks Clerk about them a page at a time, and records the value with
// the same rule sign-in and the Clerk webhook use (lib/clerk-email.ts).
//
// The rule it enforces: it only ever fills a null, and only on the address the
// value was computed for. A row that already holds a value, including one written
// by a sign-in or webhook while this runs, is never changed, and a row whose
// address changed meanwhile is left for the next run. That also makes it
// resumable: a rerun skips every row already filled.
// A user Clerk no longer knows stays null and is counted, never guessed.
//
// It reports counts and internal user ids only, never an email address.
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { emailsOfClerkUser, storedEmailVerified } from "@/lib/clerk-email";

/** One user as the Clerk Backend API returns it, narrowed to what the backfill reads. */
export interface ClerkDirectoryUser {
  id: string;
  emailAddresses: readonly { emailAddress: string; verification: { status: string } | null }[];
}

/**
 * The part of the Clerk Backend client (`createClerkClient()` from @clerk/backend)
 * the backfill calls. Users missing from the response are unknown to Clerk.
 */
export interface ClerkUserDirectory {
  users: {
    getUserList(params: { userId: string[]; limit: number }): Promise<{ data: readonly ClerkDirectoryUser[] }>;
  };
}

export interface BackfillOptions {
  /** Write the values. Without it the run only counts what it would write. */
  apply: boolean;
  /** Users per database page and per Clerk request; Clerk accepts at most 100. */
  pageSize?: number;
  /** Limit the run to one org's users (internal Org.id). */
  orgId?: string;
  /** How many times one page is retried after a 429 before the run stops. */
  maxRetries?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillSummary {
  apply: boolean;
  /** Users with no value that the run looked at. */
  scanned: number;
  /** Users whose stored address Clerk lists as verified. */
  verified: number;
  /** Users Clerk knows whose stored address it does not list as verified. */
  unverified: number;
  /** Users Clerk did not return; left null. */
  unknownToClerk: number;
  /** Rows written (always 0 on a dry run). */
  written: number;
  /** Rows that gained a value, or a different address, before this run wrote them; left as found. */
  alreadySet: number;
  rateLimitWaits: number;
  /** The internal id of the last user looked at, or null when there were none. */
  lastUserId: string | null;
}

const CLERK_MAX_PAGE = 100;
const DEFAULT_RETRY_AFTER_SECONDS = 10;
/** The longest single wait the run sits through; Clerk asking for more stops it. */
const MAX_RETRY_AFTER_SECONDS = 300;
const DEFAULT_MAX_RETRIES = 8;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The seconds a Clerk 429 asks the caller to wait, or null when the error is not a 429. */
function retryAfterSeconds(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { status, retryAfter } = error as { status?: unknown; retryAfter?: unknown };
  if (status !== 429) return null;
  return typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Fill `User.emailVerified` from Clerk for every user that has none, in id order.
 * Throws when Clerk fails for a reason other than a 429, or keeps answering 429
 * past `maxRetries`; pages written before that stay written, and a rerun resumes.
 */
export async function backfillEmailVerified(
  db: PrismaClient,
  clerk: ClerkUserDirectory,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const pageSize = Math.min(options.pageSize ?? CLERK_MAX_PAGE, CLERK_MAX_PAGE);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? realSleep;
  const summary: BackfillSummary = {
    apply: options.apply,
    scanned: 0,
    verified: 0,
    unverified: 0,
    unknownToClerk: 0,
    written: 0,
    alreadySet: 0,
    rateLimitWaits: 0,
    lastUserId: null,
  };

  async function askClerk(clerkIds: string[]): Promise<readonly ClerkDirectoryUser[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await clerk.users.getUserList({ userId: clerkIds, limit: clerkIds.length })).data;
      } catch (error) {
        const wait = retryAfterSeconds(error);
        if (wait === null) throw error;
        if (wait > MAX_RETRY_AFTER_SECONDS) {
          throw new Error(
            `Clerk asked to wait ${wait}s, over the ${MAX_RETRY_AFTER_SECONDS}s cap; rerun after that to resume after user ${summary.lastUserId ?? "(none)"}`,
          );
        }
        if (attempt >= maxRetries) {
          throw new Error(
            `Clerk rate limit persisted after ${maxRetries} retries; rerun to resume after user ${summary.lastUserId ?? "(none)"}`,
          );
        }
        summary.rateLimitWaits++;
        log(`rate limited by Clerk; waiting ${wait}s before retrying this page`);
        await sleep(wait * 1000);
      }
    }
  }

  // Keyset paging on id: users Clerk does not know stay null, so filtering on
  // null alone would serve them again on every page.
  for (let page = 1; ; page++) {
    const users = await db.user.findMany({
      where: {
        emailVerified: null,
        ...(options.orgId ? { orgId: options.orgId } : {}),
        ...(summary.lastUserId ? { id: { gt: summary.lastUserId } } : {}),
      },
      orderBy: { id: "asc" },
      take: pageSize,
      select: { id: true, clerkId: true, email: true },
    });
    if (users.length === 0) break;

    const clerkUsers = await askClerk(users.map((u) => u.clerkId));
    const byClerkId = new Map(clerkUsers.map((u) => [u.id, u]));

    for (const user of users) {
      summary.scanned++;
      const clerkUser = byClerkId.get(user.clerkId);
      if (!clerkUser) {
        summary.unknownToClerk++;
        continue;
      }
      const emailVerified = storedEmailVerified(user.email, emailsOfClerkUser(clerkUser));
      if (emailVerified) summary.verified++;
      else summary.unverified++;
      if (!options.apply) continue;
      const { count } = await db.user.updateMany({
        where: { id: user.id, email: user.email, emailVerified: null },
        data: { emailVerified },
      });
      summary.written += count;
      if (count === 0) summary.alreadySet++;
    }

    summary.lastUserId = users[users.length - 1].id;
    log(
      `page ${page}: through user ${summary.lastUserId}; scanned ${summary.scanned}, ` +
        `verified ${summary.verified}, unverified ${summary.unverified}, unknown to Clerk ${summary.unknownToClerk}, ` +
        `written ${summary.written}`,
    );
  }

  return summary;
}
