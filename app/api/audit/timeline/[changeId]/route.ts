// GET /api/audit/timeline/:changeId?scope=<path> — one change's text and
// citation, for the Timeline's detail panel: who wrote it and the person it acted
// for, the connected source it came from, and the versions it replaced or was
// replaced by, each with the change that wrote it. Each answer comes from
// the same resolver memory_query and GET /api/memory/versions/:id use, so the panel
// says what an agent is told.
//
// Reading a change's text is reading memory, so beyond the audit page's own
// access.manage gate this is an audited check() of memory.read on the scope the
// timeline shows, and the change must lie inside that scope. Every miss returns
// the same 404, so an id cannot be used to probe another scope.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check, isValidLtreePath, orgRootPath, pathCovers } from "@/services/access";
import { queryAuditLog } from "@/services/access/audit-query";
import {
  authorizationKindOf,
  changeWriterType,
  connectorSourceId,
  fallbackAgentName,
  resolveActorNames,
  resolveConnectorSource,
  resolveUserNames,
} from "@/services/audit/actor-names";
import { changesThatWroteRecords, readChangeInScope } from "@/services/memory/change-history";
import { readVersionLineage } from "@/services/memory/versions";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ changeId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:timeline:change" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const root = orgRootPath(rc.org.id);
  const scope = new URL(req.url).searchParams.get("scope") || root;
  if (!isValidLtreePath(scope) || !pathCovers(root, scope)) {
    return NextResponse.json({ error: "scope must be a scope path inside this organization" }, { status: 400 });
  }

  const { changeId } = await params;
  const decision = await check(rc.ctx, { action: "memory.read", scope, target: `change:${changeId}` });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  const change = await readChangeInScope(rc.org.id, scope, changeId);
  if (!change) return NextResponse.json({ error: "no such change in this scope" }, { status: 404 });

  // The memory.read decision above covers this scope, and the change lies inside it.
  const [userNames, source, lineage, authorizingRow] = await Promise.all([
    resolveUserNames([change.actorId]),
    resolveConnectorSource(rc.org.id, change.actorId),
    readVersionLineage(rc.org.id, change.recordId),
    change.authorizedById
      ? queryAuditLog({ orgId: rc.org.id, ids: [change.authorizedById], page: 1, pageSize: 1 }).then(
          (p) => p.entries[0] ?? null,
        )
      : null,
  ]);
  const writerIsPerson = change.actorId in userNames;
  const writer =
    userNames[change.actorId] ??
    (await resolveActorNames(rc.org.id, [change.actorId]))[change.actorId] ??
    fallbackAgentName(change.actorId);
  const authorizationKind = authorizationKindOf(change, changeWriterType(change, userNames), authorizingRow);

  // The person the writer acted for, read from the row that authorized it: for content a
  // person accepted, that person; for an agent's own write, the person who issued the
  // token it presented (`triggeredBy`, services/access/delegation.ts); for a connector
  // sync, the person who connected the source. A person writing their own content acts
  // for themselves, so their write names no one else.
  const actingForId = !authorizingRow
    ? null
    : authorizationKind === "accepted"
      ? authorizingRow.actorId
      : writerIsPerson
        ? null
        : authorizationKind === "connect"
          ? authorizingRow.actorType === "human"
            ? authorizingRow.actorId
            : null
          : (authorizingRow.metadata?.triggeredBy ?? null);
  const actingFor = actingForId ? ((await resolveUserNames([actingForId]))[actingForId] ?? actingForId) : null;

  const lineageIds = [...lineage.supersedesIds, ...(lineage.supersededById ? [lineage.supersededById] : [])];
  const writtenBy = await changesThatWroteRecords(rc.org.id, scope, lineageIds);
  const version = (id: string) => ({ id, change: writtenBy.get(id) ?? null });
  const sourceId = connectorSourceId(change.actorId);

  return NextResponse.json({
    id: change.id,
    op: change.op,
    recordType: change.recordType,
    recordId: change.recordId,
    scopePath: change.scopePath,
    summary: change.summary,
    writer,
    actingFor,
    source: source && sourceId ? { ...source, id: sourceId } : null,
    replacedById: lineage.supersededById,
    replacesIds: lineage.supersedesIds,
    // The same versions, each with the change in this scope that wrote it, so the panel can
    // link to it. `change` is null for a version outside this scope or with no recorded change.
    replacedBy: lineage.supersededById ? version(lineage.supersededById) : null,
    replaces: lineage.supersedesIds.map(version),
    // The visible audit row this change was authorized by. Null when the product
    // recorded no authorization for it (the supersede of a version that lost a
    // concurrent write, which the server decides with no decision of its own; a change
    // written before the column existed).
    authorizedById: change.authorizedById,
    // What that row is, so a reader is never left to assume it is a decision about this
    // one write. "direct": the `memory.write`/`memory.delete` allow row `check()` wrote
    // for this very write, whose actor is `writer`. "connect": the `memory.write` allow
    // row for the `sources:connect` that put this source in this scope, whose actor is
    // the person who connected it -- a connector sync runs no `check()` of its own, so
    // that connect is the authority it writes under, and the answer names two different
    // people: `writer` wrote the fact, the connect row's actor authorized the source to.
    // "accepted": the `memory.write` allow row of the person who accepted content another
    // writer produced (a brief they persisted, research findings they confirmed); that
    // person is `actingFor`, and `writer` is who produced the text.
    // Null alongside a null `authorizedById`.
    authorizationKind,
    at: change.createdAt.toISOString(),
  });
}
