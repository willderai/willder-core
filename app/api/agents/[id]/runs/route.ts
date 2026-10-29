// GET /api/agents/[id]/runs: run history for one agent, searchable and filterable.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { encodeListCursor, parseListCursor } from "@/lib/list-cursor";
import { readSearchParam } from "@/lib/list-search";
import { readableScopePaths } from "@/services/access";
import {
  listVisibleRuns,
  MAX_RUN_SEARCH_LENGTH,
  publicRunMeta,
  RUN_STATUSES,
  type RunStatusFilter,
} from "@/services/agents/run-visibility";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/agents/:id/runs?limit=&status=&order=&q=&cursor= — one page of an agent's runs.
 *
 * `status` is running, completed or failed; `order` is desc (newest first, the
 * default) or asc; `q` matches the campaign, contact or prospect name a run shows;
 * `cursor` is the `nextCursor` of the previous page. The response is
 * `{ runs, total, nextCursor }`: `total` is how many runs match in all, and
 * `nextCursor` is null on the last page.
 *
 * Access: only runs whose scope (the org root for a scope-less run) the caller holds
 * a read grant covering are listed or counted (services/agents/run-visibility.ts).
 * That rule is applied in the query before the filter, search and limit, so a page
 * is never shortened, and `total` never raised, by a run the caller cannot read. No
 * run's QA target credential is returned.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  const agent = await db.agent.findFirst({ where: { id, orgId: rc.org.id }, select: { id: true } });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  const requested = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Number.isNaN(requested) || requested < 1 ? DEFAULT_LIMIT : Math.min(requested, MAX_LIMIT);

  const status = url.searchParams.get("status");
  if (status !== null && !RUN_STATUSES.includes(status as RunStatusFilter)) {
    return NextResponse.json({ error: `status must be one of ${RUN_STATUSES.join(", ")}` }, { status: 400 });
  }
  const order = url.searchParams.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") {
    return NextResponse.json({ error: "order must be asc or desc" }, { status: 400 });
  }
  const searched = readSearchParam(url.searchParams, MAX_RUN_SEARCH_LENGTH);
  if ("error" in searched) return NextResponse.json({ error: searched.error }, { status: 400 });
  const { search } = searched;
  const after = parseListCursor(url.searchParams.get("cursor"));
  if (after && "error" in after) return NextResponse.json({ error: after.error }, { status: 400 });

  const readable = await readableScopePaths(rc.ctx);
  const { runs, total, nextCursor } = await listVisibleRuns(rc.org.id, readable, agent.id, {
    limit,
    order,
    status: (status as RunStatusFilter | null) ?? undefined,
    search: search || undefined,
    after: after ?? undefined,
  });

  return NextResponse.json({
    runs: runs.map((run) => ({ ...run, meta: publicRunMeta(run.meta) })),
    total,
    nextCursor: nextCursor ? encodeListCursor(nextCursor) : null,
  });
}
