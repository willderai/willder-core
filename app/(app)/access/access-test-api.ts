// A fake of the paged GET /api/access/grants and /api/access/capabilities in
// the Access page's component tests: it answers a page request over a fixture with
// the semantics services/access/access-list-pages.ts gives the query (that file's
// realdb test pins the SQL), so a test checks what the tabs send and show.
import { ACCESS_PAGE_SIZE, GRANT_LIST_SPEC, TOKEN_LIST_SPEC, parseAccessListQuery } from "@/lib/access-lists";
import type { GrantRow, TokenRow } from "@/services/access/access-list-pages";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A token fixture; the route adds the scope's name, absent here unless a test sets it. */
export type TokenFixture = Omit<TokenRow, "scopeName"> & { scopeName?: string | null };

function contains(text: string | null | undefined, search: string): boolean {
  return (text ?? "").toLowerCase().includes(search.toLowerCase());
}

const byText = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
const byTime = (a: string, b: string) => new Date(a).getTime() - new Date(b).getTime();

function page<R>(rows: R[], count: number, pageNumber: number) {
  const start = (pageNumber - 1) * ACCESS_PAGE_SIZE;
  return {
    rows: rows.slice(start, start + ACCESS_PAGE_SIZE),
    total: rows.length,
    count,
    page: pageNumber,
    pageSize: ACCESS_PAGE_SIZE,
  };
}

function grantExpiry(g: GrantRow): string {
  if (g.expiresAt === null) return "permanent";
  const left = new Date(g.expiresAt).getTime() - Date.now();
  return left <= 0 ? "expired" : left <= WEEK_MS ? "soon" : "later";
}

/** The JSON GET /api/access/grants?page= answers over `grants`, given in newest-first order. */
export function grantsPage(url: string, grants: GrantRow[]) {
  const q = parseAccessListQuery(new URL(url, "http://localhost").searchParams, GRANT_LIST_SPEC);
  if (q === null || "error" in q) throw new Error(`not a page request: ${url}`);
  const { permission, grantee, expiry } = q.filters;
  const kept = grants.filter(
    (g) =>
      (!permission || g.permission === permission) &&
      (!grantee || g.granteeType === grantee) &&
      (!expiry || grantExpiry(g) === expiry) &&
      (q.search === "" ||
        [g.scope.name, g.scope.path, g.granteeName, g.granteeId, g.granteeType, g.permission].some((t) =>
          contains(t, q.search),
        )),
  );
  const sign = q.order === "asc" ? 1 : -1;
  const compare = (a: GrantRow, b: GrantRow): number => {
    if (q.sort === "scope") return sign * byText(a.scope.path, b.scope.path);
    if (q.sort === "grantee") return sign * byText(a.granteeName ?? a.granteeId, b.granteeName ?? b.granteeId);
    if (q.sort === "expires") {
      if (a.expiresAt === b.expiresAt) return 0;
      if (a.expiresAt === null) return sign;
      if (b.expiresAt === null) return -sign;
      return sign * byTime(a.expiresAt, b.expiresAt);
    }
    return sign * byTime(a.createdAt, b.createdAt);
  };
  const { rows, ...rest } = page([...kept].sort(compare), grants.length, q.page);
  return { grants: rows, ...rest };
}

function tokenStatus(c: TokenFixture): string {
  if (c.revokedAt) return "revoked";
  if (new Date(c.expiresAt) < new Date()) return "expired";
  return c.agentDeactivated ? "deactivated" : "active";
}

/** The JSON GET /api/access/capabilities?page= answers over `tokens`, given in newest-first order. */
export function tokensPage(url: string, tokens: TokenFixture[]) {
  const q = parseAccessListQuery(new URL(url, "http://localhost").searchParams, TOKEN_LIST_SPEC);
  if (q === null || "error" in q) throw new Error(`not a page request: ${url}`);
  const { status, permission } = q.filters;
  const kept = tokens
    .map((c) => ({ ...c, scopeName: c.scopeName ?? null }))
    .filter(
      (c) =>
        (!status || tokenStatus(c) === status) &&
        (!permission || c.permission === permission) &&
        (q.search === "" ||
          [c.agentId, c.id, c.scopePath, c.scopeName, c.permission, tokenStatus(c)].some((t) => contains(t, q.search))),
    );
  const sign = q.order === "asc" ? 1 : -1;
  const compare = (a: TokenRow, b: TokenRow): number =>
    q.sort === "agent"
      ? sign * byText(a.agentId, b.agentId)
      : q.sort === "expires"
        ? sign * byTime(a.expiresAt, b.expiresAt)
        : sign * byTime(a.createdAt, b.createdAt);
  const { rows, ...rest } = page(kept.sort(compare), tokens.length, q.page);
  return { capabilities: rows, ...rest };
}
