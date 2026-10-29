// DELETE /api/settings/aliases/:id — remove an alias row by DB id. Needs an org
// admin role and check() allowing a memory write at the org root (see
// services/memory/entity-aliases.ts for why the registry is memory).

import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { WRITE_REFUSED } from "@/lib/settings-lists";
import { removeEntityAlias } from "@/services/memory/entity-aliases";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const refused = () => NextResponse.json({ error: WRITE_REFUSED.aliases }, { status: 403 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:aliases:delete"))) return refused();

  const { id } = await params;
  const outcome = await removeEntityAlias(rc.ctx, id);
  if (outcome === "denied") return refused();
  if (outcome === "missing") return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
