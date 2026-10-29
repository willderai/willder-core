// Denial responses for the /api/briefs/:id routes.
//
// The rule: a caller who may not read a brief cannot learn that it exists. A
// brief in another org, a brief at a scope the caller holds no read grant on,
// and an id that was never issued all get the same 404 with the same body, in
// the same time (existence-timing.realdb.test.ts).
// Only a caller who can already read the brief may see a 403, when they lack
// the stronger permission a write route needs: telling them "no" says nothing
// they could not already see.
import type { AccessContext } from "@/services/access";
import { can } from "@/services/access";
import type { BriefAccess } from "@/services/memory/briefs";

/** The one response for "no brief you can see has this id". */
export function briefNotFound(): Response {
  return Response.json({ error: "brief not found" }, { status: 404 });
}

/**
 * The response for a write route that may not proceed. 404 when the brief is
 * absent or the caller cannot read it, so the write route is not an existence
 * probe; 403 with the reason when they can read it. The read probe runs for an
 * absent brief too, at the org root its decision was made at, so both 404s cost
 * the same work. It is `can()`, not `check()`: the write decision was already
 * audited by authorizeBrief().
 */
export async function briefWriteDenied(
  ctx: AccessContext,
  access: Exclude<BriefAccess, { status: "allowed" }>,
): Promise<Response> {
  const readable = await can(ctx, { action: "memory.read", scope: access.scopePath });
  if (access.status === "missing" || !readable.allowed) return briefNotFound();
  return Response.json({ error: `access denied: ${access.decision.reason}` }, { status: 403 });
}
