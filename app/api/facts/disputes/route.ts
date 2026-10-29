// UC9 — pending fact disputes for the scope-admin resolution UI (reuses the approval-inbox
// pattern). Returns `disputed` rows the caller has authority to resolve: per the
// conflict-resolution doc, that's admin (`access.manage`) on the fact's scope. Each distinct
// scope is gated through check() (audited) — a scope admin sees only their scopes' disputes,
// not the whole org's.
import { requireAccessContext } from "@/lib/access-context";
import { listResolvableFactDisputes } from "@/services/memory/fact-disputes";

export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const disputes = await listResolvableFactDisputes(rc.ctx);
  return Response.json({ disputes });
}
