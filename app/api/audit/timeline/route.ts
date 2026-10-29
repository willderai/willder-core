// GET /api/audit/timeline — the audit page's Timeline mode: what was
// written in a scope during a window, who read it first and how long that took,
// and which reads were denied.
//
// Same gate as the audit table (access.manage). The response carries ids, times
// and scopes, never fact text: a change's text is read one at a time through
// GET /api/audit/timeline/:changeId, which is an audited memory.read.
//
// Query: `scope` (defaults to the org root), `from` and `to` (ISO timestamps;
// default the last 24 hours, at most 31 days apart).
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check, isValidLtreePath, orgRootPath, pathCovers } from "@/services/access";
import { queryTimelineReads } from "@/services/access/audit-query";
import { changeWriterType, resolveActorNames, resolveUserNames, fallbackAgentName } from "@/services/audit/actor-names";
import { buildTimeline, laneKey, parseWindow } from "@/services/audit/timeline";
import { listChangesInWindow } from "@/services/memory/change-history";

export const dynamic = "force-dynamic";

const MAX_TIMELINE_WRITES = 1000;
const MAX_TIMELINE_READS = 5000;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:timeline" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const root = orgRootPath(rc.org.id);
  const scope = url.searchParams.get("scope") || root;
  if (!isValidLtreePath(scope) || !pathCovers(root, scope)) {
    return NextResponse.json({ error: "scope must be a scope path inside this organization" }, { status: 400 });
  }

  const window = parseWindow(url.searchParams.get("from"), url.searchParams.get("to"), new Date());
  if ("error" in window) return NextResponse.json({ error: window.error }, { status: 400 });
  const { from, to } = window;

  const [changes, reads] = await Promise.all([
    listChangesInWindow({ orgId: rc.org.id, scope, from, to, limit: MAX_TIMELINE_WRITES }),
    queryTimelineReads({ orgId: rc.org.id, scope, from, to, limit: MAX_TIMELINE_READS }),
  ]);

  const writerIds = changes.entries.map((c) => c.actorId);
  const humanReaderIds = reads.rows.filter((r) => r.actorType === "human").map((r) => r.actorId);
  const userNames = await resolveUserNames([...new Set([...writerIds, ...humanReaderIds])]);
  const writerType = (c: (typeof changes.entries)[number]) => changeWriterType(c, userNames);
  // Agents and system writers (a connector sync) are both named by actor id.
  const nonHumanLanes = new Map<string, { actorType: string; actorId: string }>();
  for (const c of changes.entries) {
    const actorType = writerType(c);
    if (actorType !== "human") nonHumanLanes.set(laneKey(actorType, c.actorId), { actorType, actorId: c.actorId });
  }
  for (const r of reads.rows) {
    if (r.actorType !== "human") nonHumanLanes.set(laneKey(r.actorType, r.actorId), r);
  }
  const agentNames = await resolveActorNames(rc.org.id, [
    ...new Set([...nonHumanLanes.values()].map((l) => l.actorId)),
  ]);

  const names = new Map<string, string>();
  for (const [id, name] of Object.entries(userNames)) names.set(laneKey("human", id), name);
  for (const [key, { actorId }] of nonHumanLanes) names.set(key, agentNames[actorId] ?? fallbackAgentName(actorId));

  const timeline = buildTimeline({
    writes: changes.entries.map((c) => ({
      id: c.id,
      at: c.createdAt,
      actorType: writerType(c),
      actorId: c.actorId,
      origin: c.origin,
      scopePath: c.scopePath,
      op: c.op,
      recordType: c.recordType,
      recordId: c.recordId,
    })),
    reads: reads.rows,
    names,
  });

  return NextResponse.json({
    scope,
    from: from.toISOString(),
    to: to.toISOString(),
    timeline,
    truncated: { writes: changes.truncated, reads: reads.truncated },
  });
}
