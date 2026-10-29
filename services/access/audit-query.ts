// The audit trail's data-access seam, shared by the access.manage-gated audit
// readers: GET /api/audit, GET /api/audit/actors,
// GET /api/agents/:id/runs/:runId/audit, GET /api/audit/timeline and
// GET /api/audit/export.
//
// Every one of them needs raw SQL, because the row-visibility rule they all
// apply (services/audit/visibility.ts) matches an `access.manage` row's
// `target` against markers containing `_` -- a LIKE wildcard -- so it can only
// be expressed correctly with a `LIKE ... ESCAPE` clause, which Prisma's typed
// `where` API cannot emit at all. GET /api/audit additionally needs one for its
// scope-containment predicate.
//
// The eslint rule bans a raw db.$queryRaw off the Prisma client outside
// services/access/** and services/memory/** for exactly this reason, so these
// queries live here rather than inline in their route files.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import type { TimeRange } from "@/lib/date-range";
import { sqlUtcAt } from "@/lib/sql-utc-now";
import { orgRootPath } from "./org-root";
import { escapeLikePrefix, flattenSql } from "./scope-containment";
import { isAuditOrigin, type AuditOrigin } from "./origin";
import { GROUP_ID_TARGET_PREFIX } from "@/services/audit/audit-target";
import { visibleAuditRowSql } from "@/services/audit/visibility";

export type AuditLogRow = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  metadata: Record<string, string> | null;
  at: Date;
};

export interface AuditLogQuery {
  orgId: string;
  /** Only "allow"/"deny" narrow the query; anything else means no filter. */
  decision?: string | null;
  scope?: string | null;
  /** Both must be present (not just truthy -- actorId="" is a real persisted
   * identity, see the caller) for the actor filter to apply at all. */
  actorId?: string | null;
  actorType?: string | null;
  /**
   * Exactly these row ids, when the caller already knows which rows it wants.
   *
   * It narrows, it never widens: the visibility rule and the scope filter still apply, so
   * an id names a row only if that row would have been returned by paging to it anyway. A
   * present-but-empty list matches nothing, which is a caller asking for no rows rather
   * than a filter to ignore.
   *
   * It exists because a change can be authorized by a row far older than the rows being
   * read (a connector sync's connect row, which may predate them by months), and paging or
   * narrowing the date range back to it is pointless when the id is already in hand.
   */
  ids?: readonly string[] | null;
  /**
   * Rows recorded from `from` (inclusive) to `to` (exclusive); either end may be open.
   * Like every other filter it narrows the page and both counts.
   */
  range?: TimeRange | null;
  /**
   * Text the row must contain, case-insensitively and literally (`%` and `_` are
   * ordinary characters): in its action, target, reason or token id, or in the name
   * or email of the person, or the name of the agent, it was recorded for. See
   * {@link auditTextMatchSql} for exactly what is searched and what never is.
   */
  search?: string | null;
  /** Newest first ("desc", the default) or oldest first ("asc"). */
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}

/** What queryAuditLog returns: one page, the filtered total behind it, and the
 * per-decision counts at the same scope and actor regardless of `decision`. */
export interface AuditLogPage {
  /** Rows matching every filter, `decision` included, across all pages. */
  total: number;
  /** Allowed and denied rows matching every filter except `decision`, so a
   * summary beside a decision-filtered list still shows both numbers. */
  counts: { allowed: number; denied: number };
  entries: AuditLogRow[];
}

/**
 * One page of an org's visible audit rows, filtered by decision, scope, actor,
 * search text and date range. Every filter is part of the WHERE clause, after the visibility rule
 * and before the limit and the counts, so a row the screen may not show is never
 * listed, counted, or able to shorten a page.
 */
export async function queryAuditLog(q: AuditLogQuery): Promise<AuditLogPage> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"orgId" = ${q.orgId}`,
    // Row visibility: which AuditLog rows an audit-adjacent screen may show at
    // all, independent of the scope containment below. Owned by
    // services/audit/visibility.ts, the single home for that rule -- this
    // query takes its SQL form rather than restating the action list, so
    // per-consumer copies cannot drift apart.
    visibleAuditRowSql(),
  ];
  // Containment: see targetWithinScopeSql for why this is escaped raw SQL, and
  // targetWithinScopeOrUntaggedSql for why one scope is matched twice.
  if (q.scope) conditions.push(targetWithinScopeOrUntaggedSql(q.orgId, q.scope));
  if (q.actorId != null && q.actorType != null) {
    conditions.push(Prisma.sql`"actorId" = ${q.actorId} AND "actorType" = ${q.actorType}`);
  }
  if (q.ids != null) {
    conditions.push(
      q.ids.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`"id" IN (${Prisma.join(
            q.ids.map((id) => Prisma.sql`${id}`),
            ", ",
          )})`,
    );
  }
  const search = q.search?.trim();
  if (search) conditions.push(auditTextMatchSql(q.orgId, search));
  // `at` holds UTC wall-clock time with no zone; sqlUtcAt compares the bound the same way
  // whatever the database session's TimeZone is (lib/sql-utc-now.ts).
  if (q.range?.from) conditions.push(Prisma.sql`"at" >= ${sqlUtcAt(q.range.from)}`);
  if (q.range?.to) conditions.push(Prisma.sql`"at" < ${sqlUtcAt(q.range.to)}`);

  const decision = q.decision === "allow" || q.decision === "deny" ? q.decision : null;
  // The counts ignore the decision filter; only the page applies it. One scan
  // yields both counts, and the filtered total is one of them or their sum,
  // since `decision` has exactly these two values.
  const countQuery = Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE "decision" = 'allow')::int AS "allowed",
      COUNT(*) FILTER (WHERE "decision" = 'deny')::int AS "denied"
    FROM "audit_log"
    WHERE ${Prisma.join(conditions, " AND ")}
  `;
  const entryConditions = decision
    ? [...conditions, Prisma.sql`"decision" = ${decision}::"AuditDecision"`]
    : conditions;
  // The id breaks ties between rows recorded in the same instant, so paging never
  // shows one row twice or skips one.
  const direction = q.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const entriesQuery = Prisma.sql`
    SELECT "id", "actorType", "actorId", "action", "target", "decision", "reason", "metadata", "at"
    FROM "audit_log"
    WHERE ${Prisma.join(entryConditions, " AND ")}
    ORDER BY "at" ${direction}, "id" ${direction}
    LIMIT ${q.pageSize}
    OFFSET ${(q.page - 1) * q.pageSize}
  `;

  const [countRows, entries] = await Promise.all([
    db.$queryRaw<{ allowed: number; denied: number }[]>(...flattenSql(countQuery)),
    db.$queryRaw<AuditLogRow[]>(...flattenSql(entriesQuery)),
  ]);
  const counts = { allowed: countRows[0]?.allowed ?? 0, denied: countRows[0]?.denied ?? 0 };
  const total =
    decision === "allow" ? counts.allowed : decision === "deny" ? counts.denied : counts.allowed + counts.denied;
  return { total, counts, entries };
}

/**
 * Rows containing `search` in what the audit log shows of them: the action, the
 * target, the recorded reason, the capability token id, the raw actor id, or the
 * display name behind that id or behind the person it records as triggering the
 * action. A person matches by the name or email of a user who belongs, or belonged,
 * to this org; an agent by the name of one of this org's agents. Names are resolved inside the org, because agent keys repeat across orgs
 * ("research-agent" exists in every one) and another org's agent name must never
 * select this org's rows.
 *
 * The rest of `metadata` is never searched: it is not shown, and a row's metadata
 * can carry values a reader of the log should not be able to confirm by guessing.
 *
 * Every leg is an escaped `ILIKE ... ESCAPE`, so `%` and `_` in the search are
 * literal characters, and every value is a bound parameter.
 */
function auditTextMatchSql(orgId: string, search: string): Prisma.Sql {
  const pattern = `%${escapeLikePrefix(search)}%`;
  const contains = (column: Prisma.Sql) => Prisma.sql`${column} ILIKE ${pattern} ESCAPE '\\'`;
  const people = Prisma.sql`
      SELECT u."id" FROM "users" u
      WHERE (${contains(Prisma.sql`u."name"`)} OR ${contains(Prisma.sql`u."email"`)})
        AND (u."orgId" = ${orgId}
          OR EXISTS (SELECT 1 FROM "org_memberships" m WHERE m."userId" = u."id" AND m."orgId" = ${orgId}))`;
  return Prisma.sql`(
    ${contains(Prisma.sql`"action"`)}
    OR ${contains(Prisma.sql`"target"`)}
    OR ${contains(Prisma.sql`"reason"`)}
    OR ${contains(Prisma.sql`"actorId"`)}
    OR ${contains(Prisma.sql`"metadata"->>'capabilityId'`)}
    OR ("actorType" = 'human' AND "actorId" IN (${people}))
    OR "metadata"->>'triggeredBy' IN (${people})
    OR ("actorType" = 'agent' AND "actorId" IN (
      SELECT a."agentKey" FROM "agents" a WHERE a."orgId" = ${orgId} AND ${contains(Prisma.sql`a."name"`)}))
  )`;
}

/**
 * Rows whose `target` falls within `scope`, a scope path or the untagged
 * partition counterpart of one. An audit row's target is
 * `${targetPath}` or `${targetPath}/${req.target}` (recordAudit,
 * services/access/check.ts), `targetPath` being the requested scope's exact
 * path or a dot-descendant of it, so the three legs are: exact match,
 * dot-descendant, slash-tagged suffix on the exact scope. That is the relation
 * scope-containment.ts's scopeContainsSql() encodes for a plain scope column,
 * written out here because a target needs two suffix separators (`.` and `/`).
 *
 * Escaped LIKE, never Prisma's `startsWith`: that compiles to an unescaped
 * `LIKE`, and `_` -- a wildcard -- is in every scope path this product mints,
 * so a bare prefix match leaks a sibling scope differing only at an `_`
 * position.
 */
function targetWithinScopeSql(scope: string): Prisma.Sql {
  const escaped = escapeLikePrefix(scope);
  return Prisma.sql`(
    "target" = ${scope}
    OR "target" LIKE ${`${escaped}.%`} ESCAPE '\\'
    OR "target" LIKE ${`${escaped}/%`} ESCAPE '\\'
  )`;
}

/**
 * Rows whose `target` falls within `scope` under either name for it.
 *
 * A partition is named in one of two namespaces (services/audit/audit-target.ts):
 * the scope path `org_<orgId>[.<sub>]` and the untagged group_id partition
 * `<orgId>[.<sub>]` at the same place in the tree. A write-effect row names the
 * partition a write really executed against, which is the untagged one whenever
 * the caller passed no scope, so a filter matching scope paths only would hide
 * the row recording that a write authorized at a scope landed beside it.
 *
 * The untagged counterpart is derived from this org's own root path, never by
 * stripping an `org_` prefix off the request: `?scope=` is caller-supplied text,
 * and a path outside this org's tree has no counterpart to match.
 */
function targetWithinScopeOrUntaggedSql(orgId: string, scope: string): Prisma.Sql {
  const root = orgRootPath(orgId);
  const insideOrg = scope === root || scope.startsWith(`${root}.`);
  if (!insideOrg) return targetWithinScopeSql(scope);
  const untagged = `${GROUP_ID_TARGET_PREFIX}${orgId}${scope.slice(root.length)}`;
  return Prisma.sql`(${targetWithinScopeSql(scope)} OR ${targetWithinScopeSql(untagged)})`;
}

/** One distinct actor that appears in an org's visible audit trail. */
export type AuditActor = {
  actorType: string;
  actorId: string;
};

/**
 * The distinct (actorType, actorId) pairs in an org's visible audit trail, for
 * GET /api/audit/actors' identity picker.
 *
 * `SELECT DISTINCT`, not a client-side dedupe: Prisma resolves `findMany`'s
 * `distinct` in the client process, emitting no DISTINCT/GROUP BY/LIMIT, so
 * Postgres would return every visible audit_log row in the org on each page
 * load. The dedupe has to stay server-side; a bare LIMIT would drop real
 * identities from the picker.
 */
export async function queryAuditActors(orgId: string): Promise<AuditActor[]> {
  const query = Prisma.sql`
    SELECT DISTINCT "actorType", "actorId"
    FROM "audit_log"
    WHERE "orgId" = ${orgId} AND ${visibleAuditRowSql()}
  `;
  return db.$queryRaw<AuditActor[]>(...flattenSql(query));
}

/** One row of a single agent run's audit trail, as that route presents it. */
export type RunAuditEntry = {
  id: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  at: Date;
};

export interface RunAuditEntryQuery {
  orgId: string;
  /** The identity the run's rows are actually stamped under -- resolved by the
   * caller, which is the only place that knows a run's role/agentKey/meta. */
  actorId: string;
  /** The run's own window: `startedAt`, and `finishedAt` or "now" for a run
   * still in progress. Both bounds inclusive, matching the window the caller
   * documents. */
  from: Date;
  to: Date;
  /** Most rows returned. */
  limit: number;
  /** The last row of the previous page (its `at` and `id`); this page starts strictly after it. */
  after?: { at: Date; id: string };
}

/**
 * One page of the visible audit rows one agent run produced, oldest first, for
 * GET /api/agents/:id/runs/:runId/audit.
 *
 * `actorType` is fixed to "agent": a run's rows are always written by the agent
 * executing it, never a human or the extraction pipeline.
 */
export async function queryRunAuditEntries(q: RunAuditEntryQuery): Promise<RunAuditEntry[]> {
  const after = q.after ? Prisma.sql`AND ("at", "id") > (${q.after.at}, ${q.after.id})` : Prisma.empty;
  const query = Prisma.sql`
    SELECT "id", "action", "target", "decision", "reason", "at"
    FROM "audit_log"
    WHERE "orgId" = ${q.orgId}
      AND "actorType" = 'agent'
      AND "actorId" = ${q.actorId}
      AND ${visibleAuditRowSql()}
      AND "at" >= ${q.from} AND "at" <= ${q.to}
      ${after}
    ORDER BY "at" ASC, "id" ASC
    LIMIT ${q.limit}
  `;
  return db.$queryRaw<RunAuditEntry[]>(...flattenSql(query));
}

/** One read attempt in a timeline window. */
export type TimelineReadRow = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  at: Date;
  /** `metadata.origin` when it is a known origin; null on a row written before origins
   * were recorded. */
  origin: AuditOrigin | null;
};

export interface TimelineReadQuery {
  orgId: string;
  /** The scope the timeline shows, already validated as inside the org. */
  scope: string;
  from: Date;
  to: Date;
  /** Most rows returned; one more is read to report whether the window was cut. */
  limit: number;
}

/**
 * The read attempts (`memory.read`, `memory.entity`) in one window, for the
 * audit Timeline (GET /api/audit/timeline), oldest first.
 *
 * A read of an ancestor scope covers the timeline's scope too (an agent holding
 * the org root is served a team scope's changes), so rows naming one of
 * `scope`'s ancestors exactly are included alongside rows within it. Ancestors
 * are matched by equality on the target's scope half, never by a LIKE prefix.
 */
export async function queryTimelineReads(
  q: TimelineReadQuery,
): Promise<{ rows: TimelineReadRow[]; truncated: boolean }> {
  const ancestors = ancestorScopePaths(q.scope);
  const coversScope =
    ancestors.length === 0
      ? targetWithinScopeSql(q.scope)
      : Prisma.sql`(${targetWithinScopeSql(q.scope)} OR split_part("target", '/', 1) IN (${Prisma.join(ancestors)}))`;
  const query = Prisma.sql`
    SELECT "id", "actorType", "actorId", "action", "target", "decision", "at",
           "metadata"->>'origin' AS "origin"
    FROM "audit_log"
    WHERE "orgId" = ${q.orgId}
      AND "action" IN ('memory.read', 'memory.entity')
      AND "at" >= ${q.from} AND "at" <= ${q.to}
      AND ${coversScope}
    ORDER BY "at" ASC
    LIMIT ${q.limit + 1}
  `;
  const rows = await db.$queryRaw<(Omit<TimelineReadRow, "origin"> & { origin: string | null })[]>(
    ...flattenSql(query),
  );
  return {
    rows: rows.slice(0, q.limit).map((row) => ({ ...row, origin: isAuditOrigin(row.origin) ? row.origin : null })),
    truncated: rows.length > q.limit,
  };
}

/** `a.b.c` -> `["a", "a.b"]`: every proper ancestor of an ltree path. */
function ancestorScopePaths(scope: string): string[] {
  const labels = scope.split(".");
  return labels.slice(1).map((_, i) => labels.slice(0, i + 1).join("."));
}

/** One audit row as the export reads it: every column but the org, which the query fixes. */
export type AuditExportDbRow = {
  id: string;
  at: Date;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  metadata: unknown;
  runId: string | null;
  chainSeq: number | null;
  prevHash: string | null;
  rowHash: string | null;
};

export interface AuditExportQuery {
  orgId: string;
  /** Inclusive. */
  from: Date;
  /** Exclusive, so consecutive ranges never return a row twice. */
  to: Date;
  /** Resume strictly after this row in (at, id) order; null for the first page. */
  after: { at: Date; id: string } | null;
  limit: number;
}

/**
 * Every audit row an org recorded in `[from, to)`, oldest first, for GET /api/audit/export.
 *
 * Unlike the screens above, the export does not apply the row-visibility rule: that rule
 * hides internal rows from a person reading a page, while an export is the evidence copy
 * an auditor replays, and a row missing from it would read as a gap in the log. Ordered
 * by (at, id), a total order, so a keyset cursor resumes exactly where the last page
 * stopped even when rows share a timestamp.
 */
export async function queryAuditExportRows(q: AuditExportQuery): Promise<AuditExportDbRow[]> {
  const after = q.after ? Prisma.sql`AND ("at", "id") > (${q.after.at}, ${q.after.id})` : Prisma.empty;
  const query = Prisma.sql`
    SELECT "id", "at", "actorType", "actorId", "action", "target", "decision", "reason",
           "metadata", "runId", "chainSeq", "prevHash", "rowHash"
    FROM "audit_log"
    WHERE "orgId" = ${q.orgId}
      AND "at" >= ${q.from} AND "at" < ${q.to}
      ${after}
    ORDER BY "at" ASC, "id" ASC
    LIMIT ${q.limit}
  `;
  return db.$queryRaw<AuditExportDbRow[]>(...flattenSql(query));
}
