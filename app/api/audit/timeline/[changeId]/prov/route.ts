// GET /api/audit/timeline/:changeId/prov?scope=<path>: one change's four answers -- who
// wrote it (and for a connector sync, who it wrote for), from what source, who read it, and
// what it replaced -- as a W3C PROV-JSON document (services/audit/prov.ts).
//
// Same gates as GET /api/audit/timeline/:changeId, the detail it mirrors: access.manage for
// the audit page, then an audited check() of memory.read on the scope, and the change must
// lie inside that scope. Every miss is the same 404. Each answer comes from the same source
// the API already answers it from: the writer's type from the rule the Timeline lanes it by,
// the writer, source and lineage from the detail route's resolvers, the authorizing row from
// the audit log, and the readers from the Timeline's first-sight rule over the 31 days after
// the write.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check, isValidLtreePath, orgRootPath, pathCovers } from "@/services/access";
import { queryAuditLog, queryTimelineReads } from "@/services/access/audit-query";
import {
  authorizationKindOf,
  changeWriterType,
  connectorSourceId,
  fallbackAgentName,
  resolveActorNames,
  resolveConnectorSource,
  resolveUserNames,
} from "@/services/audit/actor-names";
import { type ChangeAnswers, type ProvActor, changeToProvJson } from "@/services/audit/prov";
import { buildTimeline, laneKey } from "@/services/audit/timeline";
import { readChangeInScope } from "@/services/memory/change-history";
import { readVersionLineage } from "@/services/memory/versions";
import type { ActorType } from "@/types/memory";

export const dynamic = "force-dynamic";

/** How long after the write reads are looked for: the Timeline's widest window. */
const READ_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_READS = 5000;

export async function GET(req: Request, { params }: { params: Promise<{ changeId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:timeline:prov" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const orgId = rc.org.id;
  const root = orgRootPath(orgId);
  const scope = new URL(req.url).searchParams.get("scope") || root;
  if (!isValidLtreePath(scope) || !pathCovers(root, scope)) {
    return NextResponse.json({ error: "scope must be a scope path inside this organization" }, { status: 400 });
  }

  const { changeId } = await params;
  const decision = await check(rc.ctx, { action: "memory.read", scope, target: `change:${changeId}` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const change = await readChangeInScope(orgId, scope, changeId);
  if (!change) return NextResponse.json({ error: "no such change in this scope" }, { status: 404 });

  const from = change.createdAt;
  const to = new Date(Math.min(from.getTime() + READ_WINDOW_MS, Date.now()));
  const [authorizingRow, source, lineage, reads] = await Promise.all([
    change.authorizedById
      ? queryAuditLog({ orgId, ids: [change.authorizedById], page: 1, pageSize: 1 }).then((p) => p.entries[0] ?? null)
      : null,
    resolveConnectorSource(orgId, change.actorId),
    readVersionLineage(orgId, change.recordId),
    // Reads of the change's own scope and its ancestors: every scope that can cover it.
    queryTimelineReads({ orgId, scope: change.scopePath, from, to, limit: MAX_READS }),
  ]);

  // Names for every actor the answers mention, resolved the way the Timeline resolves them.
  const humanCandidates = [
    change.actorId,
    ...(authorizingRow?.actorType === "human" ? [authorizingRow.actorId] : []),
    ...reads.rows.filter((r) => r.actorType === "human").map((r) => r.actorId),
  ];
  const userNames = await resolveUserNames([...new Set(humanCandidates)]);
  const writerType = changeWriterType(change, userNames);
  const agentIds = [
    ...new Set([
      ...(writerType === "human" ? [] : [change.actorId]),
      ...(authorizingRow?.actorType === "agent" ? [authorizingRow.actorId] : []),
      ...reads.rows.filter((r) => r.actorType === "agent").map((r) => r.actorId),
    ]),
  ];
  const agentNames = await resolveActorNames(orgId, agentIds);
  const actor = (actorType: ActorType, actorId: string): ProvActor => ({
    actorType,
    actorId,
    name: actorType === "human" ? (userNames[actorId] ?? actorId) : (agentNames[actorId] ?? fallbackAgentName(actorId)),
  });

  const writer = actor(writerType, change.actorId);
  const names = new Map<string, string>([[laneKey(writer.actorType, writer.actorId), writer.name]]);
  const timeline = buildTimeline({
    writes: [
      {
        id: change.id,
        at: change.createdAt,
        actorType: writer.actorType,
        actorId: change.actorId,
        origin: change.origin,
        scopePath: change.scopePath,
        op: change.op,
        recordType: change.recordType,
        recordId: change.recordId,
      },
    ],
    reads: reads.rows,
    names,
  });
  const readsById = new Map(reads.rows.map((r) => [r.id, r]));
  const readers = timeline.sightings
    .filter((s) => s.writeId === change.id)
    .map((s) => {
      const read = readsById.get(s.readId)!;
      return {
        readId: s.readId,
        at: s.at,
        reader: actor(read.actorType === "human" ? "human" : "agent", read.actorId),
      };
    });

  const authorizationKind = authorizationKindOf(change, writerType, authorizingRow);
  const sourceId = connectorSourceId(change.actorId);
  const answers: ChangeAnswers = {
    change: {
      id: change.id,
      op: change.op,
      at: change.createdAt.toISOString(),
      recordType: change.recordType,
      recordId: change.recordId,
      scopePath: change.scopePath,
    },
    author: {
      writer,
      authorizedById: change.authorizedById,
      authorizationKind,
      authority:
        authorizingRow && (authorizationKind === "connect" || authorizationKind === "accepted")
          ? actor(authorizingRow.actorType === "human" ? "human" : "agent", authorizingRow.actorId)
          : null,
    },
    source: source && sourceId ? { id: sourceId, name: source.name, type: source.type } : null,
    readers,
    readersTruncated: reads.truncated,
    replaced: { replacesIds: lineage.supersedesIds, replacedById: lineage.supersededById },
  };

  return NextResponse.json(changeToProvJson(answers), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
