// GET /api/memory/stores: per-store counts for one scope, or one page of one store;
// check() must allow memory.read on the scope first.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { parseStoreListQuery } from "@/lib/memory-store-lists";
import { check, isValidLtreePath, normalizeScopePath, orgRootPath } from "@/services/access";
import { readStoreOverview, readStorePage } from "@/services/memory/store-overview";

// GET /api/memory/stores — what memory holds in one scope, store by store.
//
// Backs every Explore tab but Graph, and the counts in their labels (the Graph
// tab keeps reading /api/memory/graph). This route only
// authorizes: check() must allow memory.read on the scope, then
// services/memory/store-overview reads that scope and its descendants. An
// invalid ?scope= falls back to the org root, which check() still has to allow
// (the read-route convention; see the graph route).
//
// With ?list=records|briefs|rules|notes|chunks|files it returns one page of that store instead,
// searched (q), filtered, ordered (sort, order) and paged (page), with the number
// of matching rows; lib/memory-store-lists.ts lists the accepted values. A value
// outside them is a 400 that names the accepted ones. The same check() runs first,
// and the scope rule is applied before the search, the filter and the count.

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const list = parseStoreListQuery(params);
  if (list !== null && "error" in list) return NextResponse.json({ error: list.error }, { status: 400 });

  let requested = normalizeScopePath(params.get("scope") ?? undefined);
  if (requested && !isValidLtreePath(requested)) requested = undefined;

  const decision = await check(rc.ctx, { action: "memory.read", scope: requested, target: "stores:overview" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const scope = requested ?? orgRootPath(rc.org.id);
  if (list !== null) return NextResponse.json(await readStorePage(rc.org.id, scope, list));
  return NextResponse.json(await readStoreOverview(rc.org.id, scope));
}
