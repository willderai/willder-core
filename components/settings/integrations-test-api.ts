// A fake of the paged GET /api/integrations?provider= in the Integrations cards'
// component tests: it answers a page request over a fixture of every integration row
// with the semantics services/integrations/account-page.ts gives the query (that file's
// realdb test pins the SQL), so a test checks what the cards send and show.
import { parseAccessListQuery } from "@/lib/access-lists";
import { ACCOUNT_LIST_SPEC, ACCOUNT_PAGE_SIZE } from "@/lib/integration-lists";

/** The fields of an integration row this fake reads; a fixture may carry any others. */
type IntegrationFixture = {
  id: string;
  provider: string;
  externalAccountId: string | null;
  status: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

/** True for a GET of a provider's account list (not a per-integration route). */
export function isIntegrationsList(url: string): boolean {
  return new URL(url, "http://localhost").pathname === "/api/integrations";
}

function accountName(row: IntegrationFixture): string {
  const { email, teamName } = row.meta ?? {};
  return (typeof email === "string" ? email : typeof teamName === "string" ? teamName : row.externalAccountId) ?? "";
}

/**
 * The JSON GET /api/integrations?provider=&page= answers over `rows`, which hold every
 * provider and status, newest first.
 */
export function integrationsPage<R extends IntegrationFixture>(url: string, rows: R[]) {
  const params = new URL(url, "http://localhost").searchParams;
  const q = parseAccessListQuery(params, ACCOUNT_LIST_SPEC);
  if (q === null || "error" in q) throw new Error(`not a page request: ${url}`);
  const provider = params.get("provider");
  const mine = rows.filter((r) => r.provider === provider);
  const connected = mine.filter((r) => r.status === "connected");
  const needle = q.search.toLowerCase();
  const kept = connected.filter(
    (r) => needle === "" || [accountName(r), r.externalAccountId ?? ""].some((t) => t.toLowerCase().includes(needle)),
  );
  const sign = q.order === "asc" ? 1 : -1;
  const ordered = [...kept].sort((a, b) =>
    q.sort === "account"
      ? sign * accountName(a).toLowerCase().localeCompare(accountName(b).toLowerCase())
      : sign * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
  );
  const newest = (status: string) => mine.find((r) => r.status === status) ?? null;
  const start = (q.page - 1) * ACCOUNT_PAGE_SIZE;
  return {
    integrations: ordered.slice(start, start + ACCOUNT_PAGE_SIZE),
    total: kept.length,
    count: connected.length,
    page: q.page,
    pageSize: ACCOUNT_PAGE_SIZE,
    attempts: { pending: newest("pending"), error: newest("error"), disconnected: newest("disconnected") },
  };
}
