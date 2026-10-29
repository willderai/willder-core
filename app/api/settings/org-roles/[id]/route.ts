// DELETE /api/settings/org-roles/:id — remove a role mapping by DB id. Needs an org
// admin role and check() allowing a write at the org root; services/resolver/org-roles.ts
// decides, before the row is looked up, so a refused caller cannot tell an id that
// exists from one that does not.

import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { WRITE_REFUSED } from "@/lib/settings-lists";
import { removeOrgRole } from "@/services/resolver/org-roles";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const refused = () => NextResponse.json({ error: WRITE_REFUSED.roles }, { status: 403 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:org-roles:delete"))) return refused();

  const { id } = await params;
  const outcome = await removeOrgRole(rc.ctx, id);
  if (outcome === "denied") return refused();
  if (outcome === "missing") return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
