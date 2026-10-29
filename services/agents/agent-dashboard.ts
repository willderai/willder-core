// The agents dashboard's numbers: run counts, the roster of agents, per-agent daily
// activity and the cross-agent run feed (GET /api/agents/dashboard,
// GET /api/agents/roster, GET /api/agents/activity).
//
// The one rule this file enforces: every run it counts, lists or charts is a run the
// caller may read (runVisibleUnderSql, services/agents/run-visibility.ts), and that
// rule is in the WHERE clause before any count, filter, sort or limit. A count taken
// over every run in the org tells a member how much agent activity sits in scopes they
// hold no grant on. Connected agents (capability tokens with no Agent row) come from
// the token table, which only an access manager may list, so the caller decides
// whether they are included and this file never widens that.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { escapeLikePrefix, flattenSql } from "@/services/access";
import { runAbandonedSql, utcTimestamp } from "@/services/agents/abandoned-runs";
import { visibleAuditRowSql } from "@/services/audit/visibility";
import { runVisibleUnderSql } from "@/services/agents/run-visibility";

/** Days in the dashboard's week window and in each sparkline. */
export const ACTIVITY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs in one window by outcome. Every field counts the same set of visible runs. */
export interface RunCounts {
  total: number;
  completed: number;
  failed: number;
  /** Running and still being driven. */
  running: number;
  /** Running but paused on a question to a person. */
  waiting: number;
  /** Running with no activity for longer than a live run goes quiet (abandoned-runs.ts). */
  stalled: number;
}

/** Visible runs started in the last 24 hours and in the last seven days. */
export async function countVisibleRunWindows(
  orgId: string,
  readablePaths: string[],
  now: Date,
): Promise<{ day: RunCounts; week: RunCounts }> {
  const zero: RunCounts = { total: 0, completed: 0, failed: 0, running: 0, waiting: 0, stalled: 0 };
  if (readablePaths.length === 0) return { day: zero, week: { ...zero } };
  const dayStart = new Date(now.getTime() - DAY_MS);
  const weekStart = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
  const abandoned = runAbandonedSql(now);
  const outcome = (since: Date, prefix: string) => Prisma.sql`
    COUNT(*) FILTER (WHERE "startedAt" >= ${utcTimestamp(since)})::int AS ${Prisma.raw(`"${prefix}_total"`)},
    COUNT(*) FILTER (WHERE "startedAt" >= ${utcTimestamp(since)} AND "status" = 'completed')::int AS ${Prisma.raw(`"${prefix}_completed"`)},
    COUNT(*) FILTER (WHERE "startedAt" >= ${utcTimestamp(since)} AND "status" = 'failed')::int AS ${Prisma.raw(`"${prefix}_failed"`)},
    COUNT(*) FILTER (WHERE "startedAt" >= ${utcTimestamp(since)} AND "status" = 'running' AND NOT ${abandoned} AND "phase" IS DISTINCT FROM 'paused')::int AS ${Prisma.raw(`"${prefix}_running"`)},
    COUNT(*) FILTER (WHERE "startedAt" >= ${utcTimestamp(since)} AND "status" = 'running' AND NOT ${abandoned} AND "phase" = 'paused')::int AS ${Prisma.raw(`"${prefix}_waiting"`)},
    COUNT(*) FILTER (WHERE "startedAt" >= ${utcTimestamp(since)} AND ${abandoned})::int AS ${Prisma.raw(`"${prefix}_stalled"`)}`;
  const rows = await query<Record<string, number>[]>(Prisma.sql`
    SELECT ${outcome(dayStart, "day")}, ${outcome(weekStart, "week")}
    FROM "agent_runs"
    WHERE "orgId" = ${orgId} AND "startedAt" >= ${utcTimestamp(weekStart)} AND ${runVisibleUnderSql(orgId, readablePaths)}`);
  const row = rows[0] ?? {};
  const read = (prefix: string): RunCounts => ({
    total: row[`${prefix}_total`] ?? 0,
    completed: row[`${prefix}_completed`] ?? 0,
    failed: row[`${prefix}_failed`] ?? 0,
    running: row[`${prefix}_running`] ?? 0,
    waiting: row[`${prefix}_waiting`] ?? 0,
    stalled: row[`${prefix}_stalled`] ?? 0,
  });
  return { day: read("day"), week: read("week") };
}

/** One day of an agent's activity, oldest day first in every series. */
export interface DayActivity {
  /** Runs started that day, or token calls for a connected agent. */
  total: number;
  /** Of those, the runs that failed, or the calls that were denied. */
  failed: number;
}

/** An empty seven-day series. */
export function emptySeries(): DayActivity[] {
  return Array.from({ length: ACTIVITY_DAYS }, () => ({ total: 0, failed: 0 }));
}

/**
 * Visible runs per agent per day over the last seven days. Day 6 is the last 24
 * hours, day 0 the oldest, so a series reads left to right in time. Every id in
 * `agentIds` gets a series, zeroed where nothing is visible.
 */
export async function dailyVisibleRuns(
  orgId: string,
  readablePaths: string[],
  agentIds: string[],
  now: Date,
): Promise<Map<string, DayActivity[]>> {
  const series = new Map(agentIds.map((id) => [id, emptySeries()]));
  if (agentIds.length === 0 || readablePaths.length === 0) return series;
  const weekStart = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
  const rows = await query<{ agentId: string; ago: number; total: number; failed: number }[]>(Prisma.sql`
    SELECT "agentId",
      FLOOR(EXTRACT(EPOCH FROM (${utcTimestamp(now)} - "startedAt")) / 86400)::int AS "ago",
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE "status" = 'failed')::int AS "failed"
    FROM "agent_runs"
    WHERE "orgId" = ${orgId} AND "agentId" IN (${Prisma.join(agentIds)})
      AND "startedAt" >= ${utcTimestamp(weekStart)} AND "startedAt" <= ${utcTimestamp(now)}
      AND ${runVisibleUnderSql(orgId, readablePaths)}
    GROUP BY 1, 2`);
  for (const row of rows) placeDay(series.get(row.agentId), row);
  return series;
}

/** Adds one grouped row to its series; `ago` is whole days before now. */
export function placeDay(target: DayActivity[] | undefined, row: { ago: number; total: number; failed: number }) {
  if (!target || row.ago < 0 || row.ago >= ACTIVITY_DAYS) return;
  const day = target[ACTIVITY_DAYS - 1 - row.ago];
  day.total += row.total;
  day.failed += row.failed;
}

/** What an agent on the roster is doing, by the rule in {@link rosterStatusSql}. */
export const ROSTER_STATUSES = ["running", "failing", "idle", "paused", "revoked"] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

export const ROSTER_KINDS = ["builtin", "custom", "connected"] as const;
export type RosterKind = (typeof ROSTER_KINDS)[number];

/** Agents per roster page. */
export const ROSTER_PAGE_SIZE = 12;

export const ROSTER_SORTS = ["name", "lastActive", "runs", "lastAllowed", "lastDenied"] as const;
export type RosterSort = (typeof ROSTER_SORTS)[number];

/**
 * Token use filters, for connected agents: `denied` had a call refused in the last
 * seven days; `unused` holds a live token with no allowed call in the last thirty,
 * so the token is a candidate to revoke.
 */
export const ROSTER_USES = ["denied", "unused"] as const;
export type RosterUse = (typeof ROSTER_USES)[number];

/** How far back `unused` looks for an allowed call. */
const UNUSED_TOKEN_DAYS = 30;

export interface RosterQuery {
  /** Include agents known only by their capability tokens. Only for an access manager. */
  includeConnected: boolean;
  kind?: RosterKind;
  status?: RosterStatus;
  use?: RosterUse;
  /** Case-insensitive substring of the agent's name or key. */
  search?: string;
  sort: RosterSort;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}

/** One agent as the roster lists it. */
export interface RosterRow {
  kind: RosterKind;
  /** The Agent row id, or the token's agent id for a connected agent. */
  id: string;
  /** The id audit rows and tokens name it by: the agent key, or the token's agent id. */
  key: string;
  name: string;
  /** The Agent row's role; null for a connected agent. */
  role: string | null;
  status: RosterStatus;
  /** Visible runs, or token calls for a connected agent, in the sparkline's seven days. */
  activity: number;
  /** The newest visible run's status; null for a connected agent or one with no visible run. */
  lastRunStatus: string | null;
  lastRunId: string | null;
  /** When it last ran (a visible run) or last presented a token. */
  lastActiveAt: Date | null;
  /**
   * A connected agent's newest allowed and newest denied token call, each on its
   * own so a recent refusal is never hidden behind an older success; null for the
   * org's own agents and for one with no such call.
   */
  lastAllowedAt: Date | null;
  lastDeniedAt: Date | null;
  /** A connected agent's live token scopes, widest permission and live token count; empty and null for the org's own agents. */
  scopes: string[];
  permission: string | null;
  liveTokens: number | null;
}

/**
 * One page of the roster: the org's Agent rows plus, for an access manager, every
 * agent id that holds capability tokens but has no Agent row (an MCP client, a
 * Claude Code session, a Routine). Search, filters, sort, paging and the total all
 * run in one query, after the run visibility rule.
 *
 * Status: a built-in or custom agent is `paused` when switched off, `running` while
 * a visible run is live, `failing` when its newest visible run failed, else `idle`.
 * A connected agent is `revoked` with no live token, `failing` when its newest
 * token call was denied, else `idle`; its token calls cannot say whether it is
 * working right now, so it is never shown as running.
 *
 * A connected agent's calls are read newest first per decision through the audit
 * index on (orgId, actorType, actorId, decision, at), so each lookup stops at its
 * first visible row however long the agent's history is.
 */
export async function listRoster(
  orgId: string,
  readablePaths: string[],
  q: RosterQuery,
  now: Date,
): Promise<{ rows: RosterRow[]; total: number }> {
  const visible = runVisibleUnderSql(orgId, readablePaths);
  const weekStart = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
  const visibleRuns = Prisma.sql`
    SELECT "agentId", "id", "status"::text AS "status", "startedAt", ${runAbandonedSql(now)} AS "abandoned"
    FROM "agent_runs" WHERE "orgId" = ${orgId} AND ${visible}`;
  const ownAgents = Prisma.sql`
    SELECT
      CASE WHEN a."role" = 'custom' THEN 'custom' ELSE 'builtin' END AS "kind",
      a."id", a."agentKey" AS "key", a."name", a."role"::text AS "role", a."active",
      (SELECT COUNT(*) FROM vr WHERE vr."agentId" = a."id"
        AND vr."startedAt" >= ${utcTimestamp(weekStart)} AND vr."startedAt" <= ${utcTimestamp(now)})::int AS "activity",
      latest."status" AS "lastRunStatus", latest."id" AS "lastRunId", latest."startedAt" AS "lastActiveAt",
      EXISTS (SELECT 1 FROM vr WHERE vr."agentId" = a."id" AND vr."status" = 'running' AND NOT vr."abandoned") AS "live",
      NULL::text AS "lastDecision", NULL::timestamp AS "lastAllowedAt", NULL::timestamp AS "lastDeniedAt",
      ARRAY[]::text[] AS "scopes", NULL::text AS "permission", NULL::int AS "liveTokens"
    FROM "agents" a
    LEFT JOIN LATERAL (
      SELECT vr."id", vr."status", vr."startedAt" FROM vr WHERE vr."agentId" = a."id"
      ORDER BY vr."startedAt" DESC, vr."id" DESC LIMIT 1
    ) latest ON TRUE
    WHERE a."orgId" = ${orgId}`;
  // A token names its agent by key, or by id for one minted before keys were
  // canonical (GET /api/access/capabilities): either way it is that Agent row's.
  // The live tokens' scopes, read to show them: no containment is decided here.
  // eslint-disable-next-line no-restricted-syntax -- lists scope paths for display; it is not a scope predicate.
  const liveScopes = Prisma.sql`COALESCE(ARRAY_AGG(DISTINCT c."scopePath" ORDER BY c."scopePath")
        FILTER (WHERE c."revokedAt" IS NULL AND c."expiresAt" > ${utcTimestamp(now)}), ARRAY[]::text[])`;
  const live = Prisma.sql`c."revokedAt" IS NULL AND c."expiresAt" > ${utcTimestamp(now)}`;
  const tokenHolders = Prisma.sql`
    SELECT c."agentId", ${liveScopes} AS "scopes",
      MAX(CASE c."permission" WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END) FILTER (WHERE ${live}) AS "permissionRank",
      COUNT(*) FILTER (WHERE ${live})::int AS "liveTokens"
    FROM "capabilities" c
    WHERE c."orgId" = ${orgId}
      AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."orgId" = ${orgId} AND (a."agentKey" = c."agentId" OR a."id" = c."agentId"))
    GROUP BY c."agentId"`;
  const lastCall = (decision: "allow" | "deny") => Prisma.sql`(
      SELECT l."at" FROM "audit_log" l
      WHERE l."orgId" = ${orgId} AND l."actorType" = 'agent' AND l."actorId" = t."agentId"
        AND l."decision" = ${decision}::"AuditDecision" AND ${visibleAuditRowSql()}
      ORDER BY l."at" DESC LIMIT 1)`;
  const connected = Prisma.sql`
    SELECT 'connected' AS "kind", t."agentId" AS "id", t."agentId" AS "key", t."agentId" AS "name",
      NULL::text AS "role", TRUE AS "active",
      (SELECT COUNT(*) FROM "audit_log" l WHERE l."orgId" = ${orgId} AND l."actorType" = 'agent'
        AND l."actorId" = t."agentId" AND l."at" >= ${utcTimestamp(weekStart)} AND ${visibleAuditRowSql()})::int AS "activity",
      t."scopes", t."permissionRank", t."liveTokens",
      ${lastCall("allow")} AS "lastAllowedAt",
      ${lastCall("deny")} AS "lastDeniedAt"
    FROM (${tokenHolders}) t`;
  // The newest call decides the status; a refusal at the same instant as a success counts as the newer.
  const connectedRows = Prisma.sql`
    SELECT "kind", "id", "key", "name", "role", "active", "activity",
      NULL::text AS "lastRunStatus", NULL::text AS "lastRunId",
      GREATEST("lastAllowedAt", "lastDeniedAt") AS "lastActiveAt",
      FALSE AS "live",
      CASE WHEN "lastDeniedAt" IS NOT NULL AND ("lastAllowedAt" IS NULL OR "lastDeniedAt" >= "lastAllowedAt") THEN 'deny'
        WHEN "lastAllowedAt" IS NOT NULL THEN 'allow' END AS "lastDecision",
      "lastAllowedAt", "lastDeniedAt", "scopes",
      CASE "permissionRank" WHEN 3 THEN 'admin' WHEN 2 THEN 'write' WHEN 1 THEN 'read' END AS "permission",
      "liveTokens"
    FROM (${connected}) calls`;
  const status = Prisma.sql`CASE
      WHEN "kind" = 'connected' AND "liveTokens" = 0 THEN 'revoked'
      WHEN "kind" = 'connected' AND "lastDecision" = 'deny' THEN 'failing'
      WHEN "kind" = 'connected' THEN 'idle'
      WHEN NOT "active" THEN 'paused'
      WHEN "live" THEN 'running'
      WHEN "lastRunStatus" = 'failed' THEN 'failing'
      ELSE 'idle' END`;

  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q.kind) conditions.push(Prisma.sql`"kind" = ${q.kind}`);
  if (q.status) conditions.push(Prisma.sql`"status" = ${q.status}`);
  if (q.use === "denied") {
    conditions.push(Prisma.sql`"lastDeniedAt" >= ${utcTimestamp(weekStart)}`);
  } else if (q.use === "unused") {
    const unusedSince = new Date(now.getTime() - UNUSED_TOKEN_DAYS * DAY_MS);
    conditions.push(Prisma.sql`"kind" = 'connected' AND "liveTokens" > 0
      AND ("lastAllowedAt" IS NULL OR "lastAllowedAt" < ${utcTimestamp(unusedSince)})`);
  }
  const search = q.search?.trim();
  if (search) {
    const pattern = `%${escapeLikePrefix(search)}%`;
    conditions.push(Prisma.sql`("name" ILIKE ${pattern} ESCAPE '\\' OR "key" ILIKE ${pattern} ESCAPE '\\')`);
  }
  const direction = q.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const byTime = (column: "lastActiveAt" | "lastAllowedAt" | "lastDeniedAt") =>
    Prisma.sql`${Prisma.raw(`"${column}"`)} ${direction} NULLS LAST, "name" ASC, "id" ASC`;
  const orderBy =
    q.sort === "lastActive"
      ? byTime("lastActiveAt")
      : q.sort === "lastAllowed"
        ? byTime("lastAllowedAt")
        : q.sort === "lastDenied"
          ? byTime("lastDeniedAt")
          : q.sort === "runs"
            ? Prisma.sql`"activity" ${direction}, "name" ASC, "id" ASC`
            : Prisma.sql`LOWER("name") ${direction}, "id" ${direction}`;

  const union = q.includeConnected ? Prisma.sql`(${ownAgents}) UNION ALL (${connectedRows})` : ownAgents;
  const rows = await query<(RosterRow & { full: number })[]>(Prisma.sql`
    WITH vr AS (${visibleRuns}),
    roster AS (SELECT u.*, ${status} AS "status" FROM (${union}) u)
    SELECT "kind", "id", "key", "name", "role", "status", "activity", "lastRunStatus", "lastRunId",
      "lastActiveAt", "lastAllowedAt", "lastDeniedAt", "scopes", "permission", "liveTokens", COUNT(*) OVER ()::int AS "full"
    FROM roster
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY ${orderBy}
    LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`);
  // A page past the end has no row to carry the window count, so count it on its own.
  const total =
    rows[0]?.full ??
    (q.page > 1
      ? ((
          await query<{ n: number }[]>(Prisma.sql`
            WITH vr AS (${visibleRuns}),
            roster AS (SELECT u.*, ${status} AS "status" FROM (${union}) u)
            SELECT COUNT(*)::int AS n FROM roster WHERE ${Prisma.join(conditions, " AND ")}`)
        )[0]?.n ?? 0)
      : 0);
  return { rows: rows.map(({ full: _full, ...row }) => row), total };
}

/** A run in the activity feed, with the agent it belongs to. */
export interface ActivityRun {
  id: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  status: string;
  /** True for a running run nothing is driving any more (abandoned-runs.ts). */
  stalled: boolean;
  phase: string | null;
  meta: unknown;
  /** The message of the run's last `error` event, the one its workspace shows, or null. */
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ActivityQuery {
  limit: number;
  /** The last run of the previous page: the feed continues strictly after it. */
  before?: { startedAt: Date; id: string };
  status?: "running" | "completed" | "failed";
}

/**
 * Visible runs across every agent, newest first, one page at a time. Ordered by
 * time, so it pages with a cursor (the last row's start time and id) rather than an
 * offset: a run that starts while someone reads never shifts the next page.
 */
export async function listVisibleActivity(
  orgId: string,
  readablePaths: string[],
  q: ActivityQuery,
  now: Date,
): Promise<{ runs: ActivityRun[]; hasMore: boolean }> {
  if (readablePaths.length === 0) return { runs: [], hasMore: false };
  const conditions = [Prisma.sql`"agent_runs"."orgId" = ${orgId}`, runVisibleUnderSql(orgId, readablePaths)];
  if (q.status) conditions.push(Prisma.sql`"agent_runs"."status"::text = ${q.status}`);
  if (q.before) {
    conditions.push(
      Prisma.sql`("agent_runs"."startedAt", "agent_runs"."id") < (${utcTimestamp(q.before.startedAt)}, ${q.before.id})`,
    );
  }
  const rows = await query<ActivityRun[]>(Prisma.sql`
    SELECT "agent_runs"."id", "agent_runs"."agentId", a."name" AS "agentName", a."role"::text AS "agentRole",
      "agent_runs"."status"::text AS "status", ${runAbandonedSql(now)} AS "stalled", "agent_runs"."phase",
      "agent_runs"."meta", "agent_runs"."startedAt", "agent_runs"."finishedAt",
      (SELECT e."payload"->>'message' FROM "agent_run_events" e
        WHERE e."runId" = "agent_runs"."id" AND e."type" = 'error' ORDER BY e."seq" DESC LIMIT 1) AS "error"
    FROM "agent_runs" JOIN "agents" a ON a."id" = "agent_runs"."agentId" AND a."orgId" = "agent_runs"."orgId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY "agent_runs"."startedAt" DESC, "agent_runs"."id" DESC
    LIMIT ${q.limit + 1}`);
  return { runs: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

/**
 * Run one composed query against `agent_runs` and the tables it joins. The reason
 * this file holds raw SQL is run-visibility.ts's: a run's scope lives in its `meta`
 * JSON, so only SQL can apply the visibility rule before a count or a limit.
 */
// eslint-disable-next-line no-restricted-syntax -- an extension of the agent-runs access seam (run-visibility.ts): meta.scopePath is not queryable through the typed layer.
const query = <T>(sql: Prisma.Sql) => db.$queryRaw<T>(...flattenSql(sql));
