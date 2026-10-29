// What a pasted GitHub token can reach, asked of GitHub before anything is stored:
// the repositories it can list, what kind of token it is, whether GitHub says it can
// write, and which parts of one repository it may read. The connect form shows all of
// it so a person picks a repository instead of typing one, and sees a token broader
// than one repository before saving it.
//
// The one rule: report only what GitHub's own answers show. A fine-grained token's
// permissions are not visible to the token itself, so its write access is "unknown",
// never "no". A listing GitHub filtered for an organization's SAML single sign-on
// says so, so its count is never read as everything the token reaches. Nothing here
// stores the token, and no error carries it.
//
// The parts check follows the rule of a GitHub token-reach measure (a part
// is unreadable only on GitHub's 403 "Resource not accessible by ..."), written again
// here on purpose: that script is the measure's own answer key, and a measure that
// imported the product's probe would be taking the product's word.

import { createHash } from "node:crypto";
import { parseRepoFullName } from "./github";

const API = "https://api.github.com";
const PER_PAGE = 100;
/** Repositories one listing reads at most. Past it the listing says it stopped, and an exact owner/name is looked up directly. */
export const MAX_LISTED_REPOSITORIES = 2_000;
const MAX_PAGES = MAX_LISTED_REPOSITORIES / PER_PAGE;
/** Listing pages asked for at once. */
const PARALLEL_PAGES = 5;
/** How long one GitHub request may take before the probe gives up on it. */
const REQUEST_TIMEOUT_MS = 10_000;
/** How long a token's listing is reused, so searching and paging do not re-read GitHub. */
const LISTING_TTL_MS = 60_000;
/** Finished listings kept at once, oldest dropped first: at most about 30 MB of repository summaries. Reads in flight come on top. */
const MAX_CACHED_LISTINGS = 50;

/** GitHub's wording when a token lacks the permission an endpoint needs. */
const PERMISSION_DENIED = /resource not accessible by/i;
/**
 * The classic and OAuth scopes that only read. Any other scope (`repo`,
 * `public_repo`, `delete_repo`, `admin:org`, `workflow`, ...) can change
 * something at GitHub, so a scope this list does not name is counted as one
 * that writes, never assumed harmless.
 */
const READ_ONLY_SCOPES = new Set([
  "read:org",
  "read:user",
  "user:email",
  "read:packages",
  "read:discussion",
  "read:project",
  "read:gpg_key",
  "read:public_key",
  "read:repo_hook",
  "read:ssh_signing_key",
  "read:enterprise",
  "read:audit_log",
]);
/** GitHub's wording when an organization's SAML single sign-on or IP allow list blocks a token. */
const ORG_POLICY_BLOCKED = /SAML enforcement|single sign-on|IP allow list/i;
/** `X-GitHub-SSO` on a refusal: the organization's SAML single sign-on has not authorized the token. */
const SSO_REQUIRED = /(?:^|,)\s*required\s*(?:;|,|$)/i;
/** `X-GitHub-SSO` on a 200: GitHub left out the repositories of organizations whose SSO has not authorized the token. */
const SSO_PARTIAL_RESULTS = /(?:^|,)\s*partial-results\s*(?:;|,|$)/i;
/** The `organizations=<id>,<id>` parameter that names them, as a parameter of its own. */
const SSO_ORGANIZATIONS = /(?:^|;)\s*organizations\s*=([^;]*)/gi;

/** Why GitHub did not answer the probe. */
export type GitHubProbeRefusal = "token-rejected" | "cannot-list" | "org-blocked" | "rate-limited" | "unavailable";

/** A probe GitHub refused or did not answer. The message is written for the person who pasted the token, and never contains it. */
export class GitHubProbeError extends Error {
  constructor(
    message: string,
    readonly reason: GitHubProbeRefusal,
    /** When GitHub says to try again, for a rate limit; otherwise null. */
    readonly retryAt: string | null = null,
  ) {
    super(message);
  }
}

export type GitHubTokenKind = "fine-grained" | "classic" | "oauth-app" | "github-app" | "unknown";

/** How far a token reaches beyond the repository it is pasted for, as far as GitHub tells. */
export interface GitHubTokenBreadth {
  kind: GitHubTokenKind;
  /** The classic or OAuth scopes GitHub lists in `X-OAuth-Scopes`; null when GitHub sends no such header (a fine-grained token). */
  scopes: string[] | null;
  /** "yes" when a scope can change something at GitHub, "no" when every scope only reads, "unknown" when GitHub does not say. */
  canWrite: "yes" | "no" | "unknown";
  /** The scopes behind a "yes", in GitHub's order; empty otherwise. */
  writeScopes: string[];
  /** When the token expires, from GitHub's `GitHub-Authentication-Token-Expiration`; null when GitHub sends none. */
  expiresAt: string | null;
}

/** What the picker shows of one repository. */
export interface GitHubRepositorySummary {
  fullName: string;
  private: boolean;
  visibility: "public" | "private" | "internal";
  description: string | null;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
}

export interface TokenRepositories {
  breadth: GitHubTokenBreadth;
  repositories: GitHubRepositorySummary[];
  /** True when the token lists more than MAX_LISTED_REPOSITORIES, so `repositories` is not all of them. */
  truncated: boolean;
  /**
   * The organizations GitHub left out of the listing because their SAML single
   * sign-on has not authorized the token, by GitHub's numeric organization id,
   * from `X-GitHub-SSO: partial-results; organizations=<ids>` on any listing page
   * read (GitHub sends it on every page). Null when no page said so. Empty when GitHub said results were withheld but
   * named no organization. GitHub sends ids only; a name would take another
   * request per organization, which SSO refuses for the same token.
   */
  ssoWithheldOrganizationIds: string[] | null;
}

/** One part of a repository a sync reads, each behind its own token permission. */
export type RepositoryPart = "readme" | "issues" | "pulls" | "commits";

/** The request that reads one item of each part, in the order a sync reads them. */
const PART_PATHS: Record<RepositoryPart, string> = {
  readme: "/readme",
  issues: "/issues?state=all&per_page=1",
  pulls: "/pulls?state=all&per_page=1",
  commits: "/commits?per_page=1",
};

/**
 * Whether `value` could be a GitHub token: GitHub's token alphabet (letters,
 * digits, `_`) at a token's length. Checked before the value goes into a
 * header, so nothing else rides along with it.
 */
export function looksLikeGitHubToken(value: string): boolean {
  return /^[A-Za-z0-9_]{30,255}$/.test(value);
}

interface RawRepo {
  full_name?: unknown;
  private?: unknown;
  visibility?: unknown;
  description?: unknown;
  archived?: unknown;
  fork?: unknown;
  pushed_at?: unknown;
}

function summaryOf(raw: RawRepo): GitHubRepositorySummary | null {
  if (typeof raw?.full_name !== "string") return null;
  const isPrivate = raw.private === true;
  const visibility =
    raw.visibility === "public" || raw.visibility === "private" || raw.visibility === "internal"
      ? raw.visibility
      : isPrivate
        ? "private"
        : "public";
  return {
    fullName: raw.full_name,
    private: isPrivate,
    visibility,
    description: typeof raw.description === "string" && raw.description !== "" ? raw.description : null,
    archived: raw.archived === true,
    fork: raw.fork === true,
    pushedAt: typeof raw.pushed_at === "string" ? raw.pushed_at : null,
  };
}

/** A GET against api.github.com with `token`. A connection that fails or times out is a probe error. */
async function get(path: string, token: string): Promise<Response> {
  try {
    return await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "willder-connector",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GitHubProbeError("GitHub did not answer. Try again in a minute.", "unavailable");
  }
}

/** The probe error for a response GitHub refused, from its status, headers and body. */
async function refusalOf(res: Response): Promise<GitHubProbeError> {
  const body = await res.text().catch(() => "");
  if (res.status === 401) {
    return new GitHubProbeError(
      "GitHub rejected this token. Check it was copied whole and has not expired or been revoked.",
      "token-rejected",
    );
  }
  const primaryExhausted = res.headers.get("x-ratelimit-remaining") === "0";
  if (res.status === 429 || (res.status === 403 && (primaryExhausted || /rate limit/i.test(body)))) {
    // A secondary limit says when in `retry-after`; only the primary limit resets at `x-ratelimit-reset`.
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAt =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? new Date(Date.now() + retryAfter * 1000).toISOString()
        : primaryExhausted && Number.isFinite(reset) && reset > 0
          ? new Date(reset * 1000).toISOString()
          : null;
    return new GitHubProbeError(
      "GitHub's rate limit for this token is used up. Try again later.",
      "rate-limited",
      retryAt,
    );
  }
  if (
    res.status === 403 &&
    (SSO_REQUIRED.test(res.headers.get("x-github-sso") ?? "") || ORG_POLICY_BLOCKED.test(body))
  ) {
    return new GitHubProbeError(
      "An organization blocks this token (SAML single sign-on or an IP allow list). Authorize the token for that organization on GitHub, then try again.",
      "org-blocked",
    );
  }
  if (res.status === 403 && PERMISSION_DENIED.test(body)) {
    return new GitHubProbeError(
      "This token cannot list repositories. Use a fine-grained personal access token with read access to Metadata.",
      "cannot-list",
    );
  }
  return new GitHubProbeError(`GitHub did not answer (HTTP ${res.status}). Try again in a minute.`, "unavailable");
}

/** GitHub's expiry header ("2026-11-14 00:00:00 UTC") as ISO 8601, or null for any other shape. */
function expiryOf(header: string | null): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(header?.trim() ?? "");
  return m ? `${m[1]}T${m[2]}Z` : null;
}

/** What GitHub's headers on any answer to `token` say about how far it reaches. */
function breadthOf(token: string, headers: Headers): GitHubTokenBreadth {
  const header = headers.get("x-oauth-scopes");
  const scopes =
    header === null
      ? null
      : header
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
  const kind: GitHubTokenKind = token.startsWith("github_pat_")
    ? "fine-grained"
    : token.startsWith("ghp_")
      ? "classic"
      : token.startsWith("gho_")
        ? "oauth-app"
        : token.startsWith("ghu_") || token.startsWith("ghs_")
          ? "github-app"
          : scopes !== null
            ? "classic"
            : "unknown";
  // A fine-grained or app token's permissions are its own, not scopes; GitHub does not show them to the token.
  const scoped = (kind === "classic" || kind === "oauth-app") && scopes !== null;
  const writeScopes = scoped ? scopes.filter((s) => !READ_ONLY_SCOPES.has(s)) : [];
  const canWrite = !scoped ? "unknown" : writeScopes.length > 0 ? "yes" : "no";
  return {
    kind,
    scopes,
    canWrite,
    writeScopes,
    expiresAt: expiryOf(headers.get("github-authentication-token-expiration")),
  };
}

/** The page numbers a `Link` header names, by relation. */
function linkPages(link: string | null): { next: number | null; last: number | null } {
  const page = (rel: string) => {
    const m = new RegExp(`<([^>]+)>;\\s*rel="${rel}"`).exec(link ?? "");
    // A link that is not an absolute URL names no page: read it as absent, never throw.
    const n = m && URL.canParse(m[1]) ? Number(new URL(m[1]).searchParams.get("page")) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  return { next: page("next"), last: page("last") };
}

/**
 * The organizations the listing pages' `X-GitHub-SSO` headers say were withheld,
 * each once in the order GitHub first names it; null when no page says results
 * were withheld. An id that is not a number is not GitHub's, and is dropped.
 */
function ssoWithheldOf(responses: Response[]): string[] | null {
  let ids: Set<string> | null = null;
  for (const res of responses) {
    const header = res.headers.get("x-github-sso");
    if (header === null || !SSO_PARTIAL_RESULTS.test(header)) continue;
    ids ??= new Set();
    for (const [, list] of header.matchAll(SSO_ORGANIZATIONS)) {
      for (const id of list.split(",").map((s) => s.trim())) {
        // One id, however many leading zeros it is written with.
        if (/^\d+$/.test(id)) ids.add(id.replace(/^0+(?=\d)/, ""));
      }
    }
  }
  return ids === null ? null : [...ids];
}

async function listingPage(token: string, page: number): Promise<{ res: Response; repos: GitHubRepositorySummary[] }> {
  const res = await get(`/user/repos?per_page=${PER_PAGE}&sort=full_name&page=${page}`, token);
  if (!res.ok) throw await refusalOf(res);
  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new GitHubProbeError(
      "GitHub answered with something other than a list of repositories. Try again in a minute.",
      "unavailable",
    );
  }
  return {
    res,
    repos: body.map((raw) => summaryOf(raw as RawRepo)).filter((r): r is GitHubRepositorySummary => r !== null),
  };
}

/**
 * Every repository `token` can list (`GET /user/repos`), up to
 * MAX_LISTED_REPOSITORIES, in name order so pages read at once do not shift
 * under each other, the token's breadth from GitHub's headers, and the
 * organizations any page says SSO withheld. Any page GitHub refuses fails the
 * whole listing: a partial list would read as all of it.
 */
export async function readTokenRepositories(token: string): Promise<TokenRepositories> {
  const first = await listingPage(token, 1);
  const pages = [first.repos];
  const responses = [first.res];
  const { next, last } = linkPages(first.res.headers.get("link"));
  let more = next !== null;
  if (last !== null) {
    const wanted = Array.from({ length: Math.min(last, MAX_PAGES) - 1 }, (_, i) => i + 2);
    for (let i = 0; i < wanted.length; i += PARALLEL_PAGES) {
      const batch = await Promise.all(wanted.slice(i, i + PARALLEL_PAGES).map((n) => listingPage(token, n)));
      pages.push(...batch.map((p) => p.repos));
      responses.push(...batch.map((p) => p.res));
    }
    more = last > MAX_PAGES;
  } else {
    // No `last` link: follow `next` one page at a time.
    for (let n = next; n !== null && pages.length < MAX_PAGES; ) {
      const page = await listingPage(token, n);
      pages.push(page.repos);
      responses.push(page.res);
      n = linkPages(page.res.headers.get("link")).next;
      more = n !== null;
    }
  }
  const seen = new Set<string>();
  const repositories = pages.flat().filter((r) => {
    const key = r.fullName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    breadth: breadthOf(token, first.res.headers),
    repositories,
    truncated: more,
    ssoWithheldOrganizationIds: ssoWithheldOf(responses),
  };
}

const listings = new Map<string, { expires: number; settled: boolean; value: Promise<TokenRepositories> }>();

/**
 * `readTokenRepositories`, reused for a minute under `key`. The caller builds
 * the key from who is asking and `tokenFingerprint`, so a listing is only ever
 * served back to the person and token that read it. A read still in flight is
 * shared, so searching while the first read runs starts no second one. A
 * refusal is dropped as soon as it settles, so a retry asks GitHub again.
 * `refresh` reads GitHub again even within the minute, for a person who has
 * just changed the token at GitHub (authorized it for an organization's SSO).
 * It skips only a finished listing: a request that arrives while a read is in
 * flight, refresh or not, joins that read, so overlapping refreshes cost GitHub
 * one listing.
 */
export function cachedTokenRepositories(
  key: string,
  token: string,
  { refresh = false } = {},
): Promise<TokenRepositories> {
  const now = Date.now();
  const hit = listings.get(key);
  // A read in flight is always joined, however long it has run; a finished one
  // serves for the minute unless this is a refresh.
  if (hit && (!hit.settled || (!refresh && hit.expires > now))) return hit.value;
  const value = readTokenRepositories(token);
  listings.delete(key);
  const entry = { expires: now + LISTING_TTL_MS, settled: false, value };
  listings.set(key, entry);
  value.then(
    () => {
      entry.settled = true;
    },
    () => {
      if (listings.get(key) === entry) listings.delete(key);
    },
  );
  // Only finished listings are dropped, oldest first (a Map iterates in insertion
  // order). Dropping a read in flight would free nothing, since the read holds its
  // pages until it settles, and a request that overlaps it would start another.
  while (listings.size > MAX_CACHED_LISTINGS) {
    const oldestFinished = [...listings].find(([, e]) => e.settled)?.[0];
    if (oldestFinished === undefined) break;
    listings.delete(oldestFinished);
  }
  return value;
}

/** A one-way fingerprint of a token, for a cache key; the token itself is never kept. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** `owner/name` checked before it goes into a request path. */
function repoPath(fullName: string): string {
  const { owner, name } = parseRepoFullName(fullName);
  return `/repos/${owner}/${name}`;
}

/** One repository by name, for a token whose listing does not hold it; null when the token cannot see it. */
export async function findRepository(token: string, fullName: string): Promise<GitHubRepositorySummary | null> {
  const res = await get(repoPath(fullName), token);
  if (res.status === 404) return null;
  if (!res.ok) throw await refusalOf(res);
  return summaryOf((await res.json().catch(() => null)) as RawRepo);
}

/**
 * The parts of `fullName` a token may not read, in the order a sync reads them.
 * A part is unreadable only when GitHub refuses it for lack of permission. A
 * part with nothing in it (no README: 404; issues turned off: 410; an empty
 * repository's commits: 409) is readable.
 * Any other refusal is a probe error, never a part marked unreadable.
 */
export async function unreadableParts(token: string, fullName: string): Promise<RepositoryPart[]> {
  const base = repoPath(fullName);
  const parts = Object.keys(PART_PATHS) as RepositoryPart[];
  const answers = await Promise.all(
    parts.map(async (part) => {
      const res = await get(`${base}${PART_PATHS[part]}`, token);
      if (res.ok || res.status === 404 || res.status === 409 || res.status === 410) return null;
      const body = await res
        .clone()
        .text()
        .catch(() => "");
      // An organization's SSO refusal can be worded like a missing permission; its header says which it is.
      const ssoRefused = SSO_REQUIRED.test(res.headers.get("x-github-sso") ?? "");
      if (res.status === 403 && !ssoRefused && PERMISSION_DENIED.test(body)) return part;
      throw await refusalOf(res);
    }),
  );
  return answers.filter((part): part is RepositoryPart => part !== null);
}
