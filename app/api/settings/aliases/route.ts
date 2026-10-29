// GET  /api/settings/aliases?page=N — one page of the org's entity aliases (admin only),
//      searched (q), filtered (type) and ordered (sort, order) as lib/settings-lists.ts lists
//      them; `{ aliases, total, count, page, pageSize }`
// POST /api/settings/aliases — create or update an alias entry
//
// The registry holds names taken from the graph at any scope (a merge records the
// merged entity's old name), so both calls also need check() to allow the read or
// write at the org root; services/memory/entity-aliases.ts makes that decision.

import { NextResponse } from "next/server";
import { UnstorableTextError } from "@/lib/unstorable-text";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { parseAccessListQuery } from "@/lib/access-lists";
import { ALIAS_LIST_SPEC, WRITE_REFUSED } from "@/lib/settings-lists";
import { readEntityAliasPage, saveEntityAlias } from "@/services/memory/entity-aliases";
import type { EntityType } from "@/services/resolver";

const adminRequired = () => NextResponse.json({ error: "admin required" }, { status: 403 });
const writeRefused = () => NextResponse.json({ error: WRITE_REFUSED.aliases }, { status: 403 });

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:aliases:list"))) {
    return adminRequired();
  }

  const query = parseAccessListQuery(new URL(req.url).searchParams, ALIAS_LIST_SPEC);
  if (query === null) return NextResponse.json({ error: "page is required" }, { status: 400 });
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });

  const found = await readEntityAliasPage(rc.ctx, query);
  if (!found) return adminRequired();
  const { rows, ...page } = found;
  return NextResponse.json({ aliases: rows, ...page });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:aliases:save"))) return writeRefused();

  let body: {
    entityId?: string;
    entityType?: string;
    canonicalName?: string;
    aliases?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["entityId", "entityType", "canonicalName", "aliases[]"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const { entityId, entityType, canonicalName, aliases } = body;
  if (!entityId || !entityType || !canonicalName || !Array.isArray(aliases)) {
    return NextResponse.json({ error: "entityId, entityType, canonicalName, aliases[] required" }, { status: 400 });
  }

  const validTypes: EntityType[] = ["user", "account", "contact", "org"];
  if (!validTypes.includes(entityType as EntityType)) {
    return NextResponse.json({ error: "entityType must be user|account|contact|org" }, { status: 400 });
  }

  try {
    const row = await saveEntityAlias(rc.ctx, {
      entityId,
      entityType: entityType as EntityType,
      canonicalName,
      aliases: aliases.map((alias) => alias.trim()).filter(Boolean),
      createdBy: rc.user.id,
    });
    if (!row) return writeRefused();
    return NextResponse.json({ alias: row }, { status: 201 });
  } catch (error) {
    if (error instanceof UnstorableTextError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
