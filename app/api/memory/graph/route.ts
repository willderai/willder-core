// GET /api/memory/graph: nodes and edges for the explorer; check() gates memory.read on the requested
// scope (or the org root when none is given) before the store is reached.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import {
  AccessDeniedError,
  descendantScopePaths,
  isValidLtreePath,
  normalizeScopePath,
  orgRootPath,
} from "@/services/access";

// GET /api/memory/graph — entities (nodes) + the facts linking them (edges), for the
// node-explorer view. Access-gated (memory.read) + audited through the check() gate,
// tenant-scoped. Optional ?query= narrows the graph to the entities whose name or
// facts contain it, with their neighbours, so a fact can be found in a scope too
// large for one page; ?limit= caps node count (default 300, at most 500) so the
// graph stays legible.
//
// The selected scope (the org root when none is given) is shown with every scope below
// it: each scope path is its own Graphiti group_id, and all of them go to the memory
// service as group_ids in one query. Past the per-read bound the response names the
// scopes it left out, as a memory query does.
const DEFAULT_GRAPH_NODES = 300;
const MAX_GRAPH_NODES = 500;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const query = url.searchParams.get("query")?.trim() || undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam >= 1
      ? Math.min(Math.floor(limitParam), MAX_GRAPH_NODES)
      : DEFAULT_GRAPH_NODES;
  // Same read-direction guard as the other scope-accepting routes (qa,
  // run-interactive, run-manager): normalize first so an empty/whitespace scope
  // can never survive as a non-ltree value, then discard a normalized-but-malformed
  // scope back to undefined rather than handing it to guardedMemory.graph()'s
  // check() call raw, where the `::ltree` cast throws before recordAudit() runs and
  // surfaces an unaudited raw 500. This is the read direction, so the remedy is
  // FALLBACK, not the write direction's REFUSE. Be precise about what that fallback
  // does: discarding to undefined serves the org-root aggregate view below, which is
  // WIDER than the single scope the caller asked for, not narrower. It is safe for
  // one reason, and the reason is not self-evident from this line: the fallback
  // target is still evaluated by check() under default deny, so the aggregate only
  // ever reaches a caller who could have gotten the identical view by omitting
  // ?scope= entirely; an ungranted caller gets 403 and the store is never reached
  // (pinned by the "org-root fallback still defaults to DENY" case in
  // graph-read-scope-leak.eval.test.ts). Do not read this fallback as
  // self-limiting: check() is the whole safety argument, so removing its `scope`
  // argument would open a real intra-tenant leak.
  let scope = normalizeScopePath(url.searchParams.get("scope") ?? undefined);
  if (scope && !isValidLtreePath(scope)) scope = undefined;

  // The selected scope and every registered scope below it; at org root, also the bare
  // org id, where content written without a scope lives.
  const shown = scope ?? orgRootPath(rc.org.id);
  const descendants = await descendantScopePaths(rc.org.id, shown);
  // A view of the selected scope alone would read as the whole subtree.
  if (descendants.partial && descendants.unsearched.length === 0) {
    return NextResponse.json({ error: "could not list the scopes below this one; try again" }, { status: 503 });
  }
  const groupIds = [...(scope ? [] : [rc.org.id]), shown, ...descendants.paths];

  try {
    const graph = await guardedMemory.graph(rc.ctx, { groupId: rc.org.id, query, limit, groupIds }, scope);
    return NextResponse.json({
      ...graph,
      ...(descendants.partial ? { partialScopeCoverage: true } : {}),
      ...(descendants.unsearched.length > 0 ? { unsearchedScopes: descendants.unsearched } : {}),
    }); // { nodes, edges, partialScopeCoverage?, unsearchedScopes? }
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    if (e instanceof MemoryServiceError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    throw e;
  }
}
