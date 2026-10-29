// Tenant-scoped read of a generated brief (Handoff/Architecture/QA output). Also
// re-gated through check() on the brief's own scopePath (item
// revoke-does-not-revoke-brief-access-20260919, live-proven at STEP 5b of
// app/api/handoff-e2e-lifecycle.live.test.ts): org-scoping alone let a grantee
// keep reading the full scoped extract after their grant was revoked, since
// "the sensitive part was already gated at generation time" stopped being true
// the moment a brief became a persisted, repeatedly-readable row instead of a
// one-shot response. A public/unauthenticated shareable-link variant is future
// work.
//
// A reader the check denies gets the same 404 as an id that does not exist
// (lib/brief-access.ts), so this route cannot be used to probe for briefs.
//
// DELETE removes a brief permanently, withdrawn or not. It is for an org admin
// clearing a scope (a brief left in a scope stops the scope from being deleted,
// services/memory/scope-deletion.ts), so the decision is `access.manage` at the org
// root, made before the brief is looked up: a caller without it gets the same 403,
// and the same recorded refusal, for a real brief and for an id never issued. A brief
// actually removed also leaves a visible `record.removed` row naming it by id.
import { requireAccessContext } from "@/lib/access-context";
import { briefNotFound } from "@/lib/brief-access";
import { check, orgRootPath } from "@/services/access";
import { authorizeBrief } from "@/services/memory/briefs";
import { deleteBrief } from "@/services/memory/delete-brief";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.read" });
  if (access.status !== "allowed") return briefNotFound();

  return Response.json({ brief: access.brief });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const decision = await check(rc.ctx, {
    action: "access.manage",
    scope: orgRootPath(rc.org.id),
    target: `briefs:delete:${id}`,
  });
  if (!decision.allowed) return Response.json({ error: decision.reason }, { status: 403 });

  if (!(await deleteBrief(rc.ctx, id))) return briefNotFound();
  return Response.json({ deleted: id });
}
