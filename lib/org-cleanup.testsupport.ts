// Org cleanup for database-gated suites (test-only, not collected by vitest, whose
// include is `**/*.test.ts`; not reachable from the served application).
//
// Why this exists: when a realdb test hits its timeout, vitest moves on but the test's
// body keeps running, still writing rows of the same org. The next beforeEach (or the
// file's afterAll) then runs `org.deleteMany`, whose ON DELETE CASCADE walks the child
// tables while the zombie body inserts into them. The insert holds a KEY SHARE lock on
// the org row and its own new child rows; the cascade holds the org row and waits on a
// child row: Postgres reports a deadlock (40P01) and the cleanup fails the suite, hiding
// the timeout that caused it (wave 6i, .benchmark-runs/wave-6i/deadlock-investigation).
//
// The cleanup here runs the same delete with a short `lock_timeout`, well under the
// server's `deadlock_timeout` (1 s by default). A cleanup that would wait on the zombie
// gives up with 55P03 before the deadlock detector runs, releasing what it held so the
// zombie can finish, then retries after a short backoff. A deadlock the cleanup is chosen
// for anyway (40P01) or a serialization failure (40001) is retried the same way. Once the
// time budget is spent it falls back to the plain delete, which waits as long as it must:
// the old behaviour, so a slow but live lock holder can never make cleanup fail sooner.
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** deadlock_detected, lock_not_available (lock_timeout), serialization_failure. */
const LOCK_CONFLICT_SQLSTATES = new Set(["40P01", "55P03", "40001"]);

type OrgCleanupClient = Pick<PrismaClient, "$transaction" | "$executeRaw" | "org">;

export interface OrgCleanupOptions {
  /** How long one bounded attempt waits on a lock before giving up. Keep under deadlock_timeout. */
  lockTimeoutMs?: number;
  /** How long bounded attempts are retried before the plain, unbounded delete. */
  budgetMs?: number;
  /** Attempts in all, bounded and plain, before the last lock conflict is thrown. */
  maxAttempts?: number;
}

/** The SQLSTATE an error from Prisma or its pg driver adapter carries, wherever it is nested. */
export function sqlStateOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const e = queue.shift();
    if (typeof e !== "object" || e === null || seen.has(e)) continue;
    seen.add(e);
    const fields = e as {
      originalCode?: unknown;
      code?: unknown;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    for (const code of [fields.originalCode, fields.code]) {
      // Prisma's own codes (P1000-P6999) share the shape; SQLSTATE class P0 is PL/pgSQL.
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !/^P[1-9]\d{3}$/.test(code)) return code;
    }
    queue.push(fields.meta?.driverAdapterError, fields.cause);
  }
  return undefined;
}

/** Whether `error` is a lock conflict a retry can get past: a deadlock, a lock timeout, a serialization failure. */
export function isLockConflict(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state !== undefined) return LOCK_CONFLICT_SQLSTATES.has(state);
  // P2034: Prisma's own code for "write conflict or deadlock" when no SQLSTATE survives.
  if ((error as { code?: unknown } | null)?.code === "P2034") return true;
  return error instanceof Error && /deadlock detected|lock timeout|could not serialize access/i.test(error.message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `db.org.deleteMany(args)`, retried past lock conflicts with a timed-out test body that is
 * still writing to the org. Same arguments, same result, same cascade.
 */
export async function deleteOrgsWithRetry(
  db: OrgCleanupClient,
  args: Prisma.OrgDeleteManyArgs,
  { lockTimeoutMs = 200, budgetMs = 6_000, maxAttempts = 25 }: OrgCleanupOptions = {},
): Promise<Prisma.BatchPayload> {
  const deadline = Date.now() + budgetMs;
  const lockTimeout = `${lockTimeoutMs}ms`;
  for (let attempt = 1; ; attempt++) {
    try {
      if (Date.now() >= deadline) return await db.org.deleteMany(args);
      const [, result] = await db.$transaction([
        // A transaction-local session setting, not a query on any model: no scope or tenant to gate.
        // eslint-disable-next-line no-restricted-syntax
        db.$executeRaw`SELECT set_config('lock_timeout', ${lockTimeout}, true)`,
        db.org.deleteMany(args),
      ]);
      return result;
    } catch (error) {
      if (attempt >= maxAttempts || !isLockConflict(error)) throw error;
      await sleep(Math.min(25 * 2 ** attempt, 500) * (0.5 + Math.random() / 2));
    }
  }
}
