// The change feed's history, read by an org admin rather than served to an agent
// (the audit Timeline).
//
// services/memory/change-feed.ts serves one agent what changed since its own
// cursor. This file answers a different question -- what was written in a scope
// during a window -- for GET /api/audit/timeline, and moves no cursor.
//
// The one rule this file enforces: a window listing never carries a change's
// summary. The summary is fact text; it is read one change at a time through
// readChangeInScope(), after the caller has passed an audited memory.read check
// on that change's own scope. Like the feed, nothing here returns `seq`.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { flattenSql, isAuditOrigin, pathCovers, scopeContainsSql, type AuditOrigin } from "@/services/access";
import { isConnectorSyncActor } from "@/services/audit/actor-names";
import { FACT_RECORD_TYPE, type ChangeOp } from "./change-events";

/** One write in a window, without its text. */
export interface ChangeHistoryEntry {
  id: string;
  scopePath: string;
  recordType: string;
  recordId: string;
  op: ChangeOp;
  actorId: string;
  /** Null on an event written before the writer's type was recorded. */
  actorType: string | null;
  /** Null on an event written before origins were recorded. */
  origin: AuditOrigin | null;
  createdAt: Date;
}

export interface ChangeWindowQuery {
  orgId: string;
  /** The scope to list within, already validated as inside the org. */
  scope: string;
  from: Date;
  to: Date;
  /** Most entries returned; one more is read to report whether the window was cut. */
  limit: number;
}

/** The changes written within `scope` during a window, oldest first. */
export async function listChangesInWindow(
  q: ChangeWindowQuery,
): Promise<{ entries: ChangeHistoryEntry[]; truncated: boolean }> {
  const containment = scopeContainsSql(Prisma.raw('"scopePath"'), q.scope, {
    relation: "within",
    mode: "ltree",
  });
  const query = Prisma.sql`
    SELECT "id", "scopePath", "recordType", "recordId", "op", "actorId", "actorType", "origin", "createdAt"
    FROM "change_events"
    WHERE "orgId" = ${q.orgId}
      AND "createdAt" >= ${q.from} AND "createdAt" <= ${q.to}
      AND ${containment}
    ORDER BY "seq"
    LIMIT ${q.limit + 1}
  `;
  const rows = await db.$queryRaw<(Omit<ChangeHistoryEntry, "origin"> & { origin: string | null })[]>(
    ...flattenSql(query),
  );
  return {
    entries: rows.slice(0, q.limit).map((row) => ({ ...row, origin: isAuditOrigin(row.origin) ? row.origin : null })),
    truncated: rows.length > q.limit,
  };
}

/**
 * The fact most recently written anywhere in `orgId`, without its text; null when none
 * has been. The first-run checklist reads it to say who wrote the org's memory and where
 * it came in. The caller authorizes first: this reads the whole org, so it is for a
 * caller already allowed to see the org's change history.
 */
export async function latestFactWrite(orgId: string): Promise<ChangeHistoryEntry | null> {
  const row = await db.changeEvent.findFirst({
    where: { orgId, recordType: FACT_RECORD_TYPE, op: "create" },
    orderBy: { seq: "desc" },
    select: {
      id: true,
      scopePath: true,
      recordType: true,
      recordId: true,
      op: true,
      actorId: true,
      actorType: true,
      origin: true,
      createdAt: true,
    },
  });
  return row && { ...row, origin: isAuditOrigin(row.origin) ? row.origin : null };
}

/** One change with its text, for the Timeline's detail panel. */
export interface ChangeDetail extends ChangeHistoryEntry {
  summary: string;
  /** The visible `memory.write`/`memory.delete` allow row that authorized this change,
   * or null when no single authorization produced it. */
  authorizedById: string | null;
}

/**
 * The changes each of `auditRowIds` authorized, oldest first, keyed by audit row id.
 *
 * `GET /api/audit` renders this as a visible row's `changeIds`. It reads the link from the
 * change event, which is where it is stored: `audit_log` is append-only, and the row is
 * written when the write is authorized, before the change it produces exists.
 *
 * A list, not one id: one authorization can produce two changes. Correcting a fact is
 * audited as a single `memory.delete` decision (app/api/memory/facts/[id]/route.ts) that
 * supersedes the old version and writes the new one, and a row that named only one of them
 * would hide the other.
 *
 * A row that authorized no landed change is absent from the map rather than present with an
 * empty list, so a caller cannot mistake "no change" for "a change with no id".
 *
 * Connector-sync writes are left out. A sync write records the connect that authorized the
 * source (`Source.connectAuthorizationId`), which is a standing authority rather than a
 * decision that produced one change: listing its changes here would grow one audit row's
 * payload without limit as the source keeps syncing, and would say something false -- that
 * the person who connected the source performed those writes. The sync write still answers
 * who authorized it, from its own side: `GET /api/audit/timeline/:changeId` returns the
 * connect row as `authorizedById` with `authorizationKind: "connect"`.
 */
export async function changeIdsByAuthorizingRow(
  orgId: string,
  auditRowIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (auditRowIds.length === 0) return new Map();
  const events = await db.changeEvent.findMany({
    where: { orgId, authorizedById: { in: [...auditRowIds] } },
    select: { id: true, actorId: true, authorizedById: true },
    orderBy: { seq: "asc" },
  });
  const byRow = new Map<string, string[]>();
  for (const e of events) {
    if (e.authorizedById === null || isConnectorSyncActor(e.actorId)) continue;
    byRow.set(e.authorizedById, [...(byRow.get(e.authorizedById) ?? []), e.id]);
  }
  return byRow;
}

/**
 * One change by id, or null when it is not in `orgId` or not within `scope`.
 *
 * The caller authorizes `scope` first; the containment test here is what keeps
 * an id from another scope from being read through that authorization. One
 * null for every miss, so an id cannot be used to probe what exists.
 */
export async function readChangeInScope(orgId: string, scope: string, id: string): Promise<ChangeDetail | null> {
  const change = await db.changeEvent.findFirst({
    where: { orgId, id },
    select: {
      id: true,
      scopePath: true,
      recordType: true,
      recordId: true,
      op: true,
      actorId: true,
      actorType: true,
      origin: true,
      summary: true,
      authorizedById: true,
      createdAt: true,
    },
  });
  if (change === null || !pathCovers(scope, change.scopePath)) return null;
  return { ...change, origin: isAuditOrigin(change.origin) ? change.origin : null };
}

/** The change that wrote a version, as a link from another version's detail. */
export interface VersionChange {
  id: string;
  summary: string;
}

/**
 * The change that wrote each of `recordIds`, keyed by record id: its latest `create` or
 * `update` event within `scope`.
 *
 * The Timeline's detail panel names the versions a change replaced or was replaced by, and
 * a reader follows those to the change that wrote each one. A version stored outside
 * `scope`, or written by no recorded change, is absent from the map: the panel then names
 * it by id alone. Like readChangeInScope(), the caller authorizes `scope` first, since the
 * summary is fact text.
 */
export async function changesThatWroteRecords(
  orgId: string,
  scope: string,
  recordIds: readonly string[],
): Promise<Map<string, VersionChange>> {
  if (recordIds.length === 0) return new Map();
  const events = await db.changeEvent.findMany({
    where: { orgId, recordId: { in: [...recordIds] }, op: { in: ["create", "update"] } },
    select: { id: true, recordId: true, scopePath: true, summary: true },
    orderBy: { seq: "asc" },
  });
  const byRecord = new Map<string, VersionChange>();
  for (const e of events) {
    if (pathCovers(scope, e.scopePath)) byRecord.set(e.recordId, { id: e.id, summary: e.summary });
  }
  return byRecord;
}
