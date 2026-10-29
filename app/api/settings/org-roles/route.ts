// GET  /api/settings/org-roles?page=N — one page of the org's job-title role mappings,
//      searched (q) and ordered (sort, order) as lib/settings-lists.ts lists them;
//      `{ roles, total, count, page, pageSize }`
// POST /api/settings/org-roles — create or update a role→user mapping
//
// Both calls also need check() to allow the read or write at the org root, before
// any row is read; services/resolver/org-roles.ts makes that decision and says why.

import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { WRITE_REFUSED } from "@/lib/settings-lists";
import { SYSTEM_ACTOR_ID } from "@/services/access/system-actors";
import { readOrgRolePage, saveOrgRole } from "@/services/resolver/org-roles";
import { memory } from "@/services/memory";

const adminRequired = () => NextResponse.json({ error: "admin required" }, { status: 403 });
const writeRefused = () => NextResponse.json({ error: WRITE_REFUSED.roles }, { status: 403 });

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:org-roles:list"))) return adminRequired();

  const found = await readOrgRolePage(rc.ctx, new URL(req.url).searchParams);
  if (!found) return adminRequired();
  if ("error" in found) return NextResponse.json({ error: found.error }, { status: 400 });
  const { rows, ...page } = found;
  return NextResponse.json({ roles: rows, ...page });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:org-roles:save"))) return writeRefused();

  let body: { role?: string; userId?: string; aliases?: string[] | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["role", "userId", "aliases[]"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const { role, userId } = body;
  const aliases = body.aliases ?? [];
  if (!role?.trim() || !userId?.trim()) {
    return NextResponse.json({ error: "role and userId required" }, { status: 400 });
  }
  const saved = await saveOrgRole(rc.ctx, {
    role: role.trim(),
    userId,
    aliases: aliases.map((alias) => alias.trim()).filter(Boolean),
  });
  if (saved.outcome === "denied") return writeRefused();
  if (saved.outcome === "unstorable") return NextResponse.json({ error: saved.error }, { status: 400 });
  if (saved.outcome === "not-a-member") return NextResponse.json({ error: "user not found in org" }, { status: 404 });

  // The graph may know this role's holder by an older name: the role title itself,
  // ingested before the role was mapped, or the previous holder. Move those facts
  // to the person. Fire-and-forget; it does not block the response.
  const { row, previousName } = saved;
  const name = row.user.name;
  if (previousName && name && previousName !== name) {
    memory.transferEntity({ groupId: rc.org.id, oldName: previousName, newName: name }).catch(() => {});
  }

  // Ingest the role fact so the relationship appears in the memory graph.
  // Graphiti will invalidate any prior fact for this role if the person changed.
  if (name) {
    memory
      .ingest({
        groupId: rc.org.id,
        content: `${name} is the ${row.role} of ${rc.org.name}.`,
        actorType: "extraction",
        origin: rc.ctx.origin,
        actorId: SYSTEM_ACTOR_ID,
        actorName: "org-roles",
      })
      .catch(() => {});
  }

  return NextResponse.json({ role: row }, { status: 201 });
}
