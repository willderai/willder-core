import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { parseAccessListQuery } from "@/lib/access-lists";
import {
  ACCOUNT_LIST_SPEC,
  ACCOUNT_PAGE_SIZE,
  INTEGRATION_PROVIDERS,
  type IntegrationProviderName,
} from "@/lib/integration-lists";
import { latestAttempts, readConnectedAccountPage } from "@/services/integrations/account-page";

// GET /api/integrations?provider=<gmail|outlook|slack|figma>&page=N — one provider's
// external connections in this org: a page of its connected accounts, searched (q) and
// ordered (sort, order) as lib/integration-lists.ts lists them, and its newest pending,
// errored and disconnected attempt, which the card shows while nothing is connected.
//   `{ integrations, total, count, page, pageSize, attempts: { pending, error, disconnected } }`
// Tenant-scoped to the caller's org; any authenticated member can see what's connected.
// Secrets never leave here: only the provider account reference, status and
// non-secret metadata (see the Integration model).
export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const provider = params.get("provider");
  if (!INTEGRATION_PROVIDERS.includes(provider as IntegrationProviderName)) {
    return NextResponse.json({ error: `provider must be one of ${INTEGRATION_PROVIDERS.join(", ")}` }, { status: 400 });
  }
  const query = parseAccessListQuery(params, ACCOUNT_LIST_SPEC);
  if (query === null) return NextResponse.json({ error: "page is required" }, { status: 400 });
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });

  const [page, attempts] = await Promise.all([
    readConnectedAccountPage(rc.org.id, provider as IntegrationProviderName, query),
    latestAttempts(rc.org.id, provider as IntegrationProviderName),
  ]);
  return NextResponse.json({
    integrations: page.rows,
    total: page.total,
    count: page.count,
    page: query.page,
    pageSize: ACCOUNT_PAGE_SIZE,
    attempts,
  });
}
