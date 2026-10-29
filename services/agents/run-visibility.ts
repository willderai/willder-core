// Who may see or steer an agent run.
//
// A run carries what its starter typed (prompt, context, focus, QA target) and, once
// finished, points at the brief it produced. Both live at a memory scope: the run's
// own `meta.scopePath`, or the org root for a run started without one (the same
// fallback the brief is stored under), and the brief's stored `scopePath`. The rule
// this file enforces: a caller sees or acts on a run only when check() allows
// `memory.read` on every one of those scopes, and a caller who fails gets the same
// answer as a run id that was never issued. Org membership alone is not enough.
import { Prisma, type Brief } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import {
  check,
  escapeLikePrefix,
  flattenSql,
  isValidLtreePath,
  orgRootPath,
  pathCovers,
  scopeContainsSql,
  type AccessContext,
} from "@/services/access";
import { isBriefRetired } from "@/services/memory/brief-retirement";
import { authorizeBrief } from "@/services/memory/briefs";
import { runAbandonedSql } from "@/services/agents/abandoned-runs";
import type { ListCursor } from "@/lib/list-cursor";

/** The fields of an AgentRun this file reads to decide visibility. */
interface RunScopeFields {
  meta: unknown;
  briefId: string | null;
}

/**
 * The scope a run was started at: `meta.scopePath`, or the org root when the run
 * has none. Null when the stored value is not a valid scope path, which callers
 * treat as unreadable rather than unscoped.
 */
export function runScopePath(orgId: string, meta: unknown): string | null {
  const stored = (meta as { scopePath?: unknown } | null)?.scopePath;
  const scope = stored ?? orgRootPath(orgId);
  return typeof scope === "string" && isValidLtreePath(scope) ? scope : null;
}

/**
 * Decide `memory.read` on the run's scope and, when it produced one, on its brief's
 * scope: one audited decision per distinct scope, stopping at the first refusal.
 * Returns null when the caller may not read the run, otherwise the brief (withdrawn
 * or not; null when the run has none). A withdrawn brief's scope is still decided,
 * so withdrawing a brief never widens who can see the run that produced it.
 */
async function authorizeRun(
  ctx: AccessContext,
  orgId: string,
  run: RunScopeFields,
): Promise<{ brief: Brief | null } | null> {
  const runScope = runScopePath(orgId, run.meta);
  if (!runScope) return null;

  const decision = await check(ctx, { action: "memory.read", scope: runScope });
  if (!decision.allowed) return null;
  if (!run.briefId) return { brief: null };

  const access = await authorizeBrief(ctx, run.briefId, {
    action: "memory.read",
    includeWithdrawn: true,
    decidedAt: { scope: runScope, decision },
  });
  if (access.status === "denied") return null;
  return { brief: access.status === "allowed" ? access.brief : null };
}

/** Whether the caller may read the run's scope and the scope of the brief it produced. */
export async function canReadRun(ctx: AccessContext, orgId: string, run: RunScopeFields): Promise<boolean> {
  return (await authorizeRun(ctx, orgId, run)) !== null;
}

const READABLE_RUN_FIELDS = { id: true, agentId: true, phase: true, meta: true, briefId: true } as const;

/** A run of this org the caller may read, or null when it is absent or hidden from them. */
export async function findReadableRun(ctx: AccessContext, orgId: string, runId: string) {
  const run = await db.agentRun.findFirst({ where: { id: runId, orgId }, select: READABLE_RUN_FIELDS });
  if (!run) return null;
  return (await canReadRun(ctx, orgId, run)) ? run : null;
}

/**
 * {@link findReadableRun}, plus the brief the run produced, from the same
 * decisions: reading the brief adds no audit row of its own. `brief` is null when
 * the run has none or it has been withdrawn, since a withdrawn brief's content is
 * no longer served.
 */
export async function findReadableRunWithBrief(ctx: AccessContext, orgId: string, runId: string) {
  const run = await db.agentRun.findFirst({ where: { id: runId, orgId }, select: READABLE_RUN_FIELDS });
  if (!run) return null;
  const allowed = await authorizeRun(ctx, orgId, run);
  if (!allowed) return null;
  const brief = allowed.brief && !(await isBriefRetired(allowed.brief.id)) ? allowed.brief : null;
  return { run, brief };
}

/**
 * Whether a run is visible to a caller holding read grants on `readablePaths`
 * (from readableScopePaths()). The browsing-view form of canReadRun: it filters a
 * list without one audited check() per row, and covers the run's own scope only,
 * since a list returns no brief.
 */
export function runVisibleUnder(readablePaths: string[], orgId: string, meta: unknown): boolean {
  const scope = runScopePath(orgId, meta);
  return scope !== null && readablePaths.some((granted) => pathCovers(granted, scope));
}

/**
 * `runVisibleUnder` as a SQL predicate over the `agent_runs` table, for the
 * places that need a COUNT or a per-agent latest row rather than a filtered
 * list: counting in TypeScript would mean reading every run in the org to
 * discard most of them, and counting without the predicate is the
 * sibling-existence leak this pair exists to prevent (a bare "42 runs" tells a
 * caller how much agent activity sits in scopes they hold no grant on).
 *
 * This is the SQL half of runVisibleUnder() above; the two are deliberately
 * side by side so neither can drift, and runs-visibility-sql-parity.realdb.test.ts
 * runs both over the same rows and asserts they agree.
 *
 * Containment goes through the shared scopeContainsSql() in text mode (escaped
 * LIKE). Never Prisma `startsWith` or a hand-written `LIKE scope || '.%'`: an
 * unescaped LIKE pattern treats the `_` in a path like `dept_sales` as "any
 * character", so a caller granted `dept_sales` would also count the sibling
 * `deptXsales` — a cross-scope read inside one tenant.
 *
 * The regular expression is isValidLtreePath()'s rule in SQL, so a `meta`
 * holding something that is not a scope path is excluded here as it is there.
 */
export function runVisibleUnderSql(orgId: string, readablePaths: string[]): Prisma.Sql {
  if (readablePaths.length === 0) return Prisma.sql`FALSE`;
  // runScopePath()'s fallback: a run started without a scope belongs to the org root.
  const scope = Prisma.sql`COALESCE("meta"->>'scopePath', ${orgRootPath(orgId)})`;
  const legs = [...new Set(readablePaths)].map((granted) =>
    scopeContainsSql(scope, granted, { relation: "within", mode: "text" }),
  );
  const within = legs.reduce((all, leg) => Prisma.sql`${all} OR ${leg}`);
  return Prisma.sql`(${scope} ~ ${LTREE_PATH_PATTERN} AND (${within}))`;
}

/** isValidLtreePath()'s label rule as a Postgres regular expression. */
const LTREE_PATH_PATTERN = "^[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$";

/** One agent's run summary as a caller may see it: only runs they can read. */
export interface VisibleRunSummary {
  /** How many of this agent's runs the caller may read. */
  runs: number;
  /** The most recent run the caller may read, or null when there is none. */
  lastRun: { id: string; status: string; startedAt: Date; finishedAt: Date | null } | null;
}

/**
 * Per-agent run counts and last run, over the runs the caller may read.
 *
 * The agent list and the single-agent view both show "runs total" and the last
 * run's status. Taken from the raw relation (`_count.runs`, or the newest row
 * before filtering) those are the org's numbers, not the caller's: they tell a
 * member how much agent activity happened in scopes they hold no grant on, and
 * whose run finished when. Both are derived here instead, so the figure shown
 * and the rows listed come from the same set.
 *
 * Returns an entry for every id in `agentIds`, zeroed where nothing is visible,
 * so a caller cannot tell "no readable runs" from "agent absent from the result".
 */
export async function summarizeVisibleRuns(
  orgId: string,
  readablePaths: string[],
  agentIds: string[],
): Promise<Map<string, VisibleRunSummary>> {
  const empty = (): VisibleRunSummary => ({ runs: 0, lastRun: null });
  const summaries = new Map(agentIds.map((id) => [id, empty()]));
  if (agentIds.length === 0 || readablePaths.length === 0) return summaries;

  const visible = runVisibleUnderSql(orgId, readablePaths);
  const mine = Prisma.sql`"orgId" = ${orgId} AND "agentId" IN (${Prisma.join(agentIds)}) AND ${visible}`;

  const [counts, latest] = await Promise.all([
    query<{ agentId: string; n: number }[]>(Prisma.sql`
      SELECT "agentId", COUNT(*)::int AS n FROM "agent_runs"
      WHERE ${mine} GROUP BY "agentId"`),
    // DISTINCT ON picks the newest visible run per agent in one pass, rather than
    // taking the newest run and then discarding it when it is not readable —
    // which would show "no runs yet" to a caller who has readable older ones.
    query<{ agentId: string; id: string; status: string; startedAt: Date; finishedAt: Date | null }[]>(Prisma.sql`
      SELECT DISTINCT ON ("agentId") "agentId", "id", "status"::text AS "status", "startedAt", "finishedAt"
      FROM "agent_runs" WHERE ${mine}
      ORDER BY "agentId", "startedAt" DESC, "id" DESC`),
  ]);

  for (const row of counts) summaries.set(row.agentId, { ...(summaries.get(row.agentId) ?? empty()), runs: row.n });
  for (const { agentId, ...run } of latest) {
    summaries.set(agentId, { ...(summaries.get(agentId) ?? empty()), lastRun: run });
  }
  return summaries;
}

/** A run as the single-agent view lists it; `meta` still holds the QA credential, so pass it through publicRunMeta(). */
export interface VisibleRecentRun {
  id: string;
  status: string;
  triggeredBy: string | null;
  meta: unknown;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * An agent's newest `limit` runs among those the caller may read.
 *
 * The visibility rule is applied before the limit, in SQL. Taking the newest
 * rows first and filtering them afterwards would let runs the caller cannot read
 * push readable ones out of the list, so the list would be shorter than the
 * count beside it exactly when hidden activity exists, which tells the caller
 * it does.
 */
export async function recentVisibleRuns(
  orgId: string,
  readablePaths: string[],
  agentId: string,
  limit: number,
): Promise<VisibleRecentRun[]> {
  if (readablePaths.length === 0) return [];
  return query<VisibleRecentRun[]>(Prisma.sql`
    SELECT "id", "status"::text AS "status", "triggeredBy", "meta", "startedAt", "finishedAt"
    FROM "agent_runs"
    WHERE "orgId" = ${orgId} AND "agentId" = ${agentId} AND ${runVisibleUnderSql(orgId, readablePaths)}
    ORDER BY "startedAt" DESC, "id" DESC
    LIMIT ${limit}`);
}

/** The run statuses a run list can be filtered to. */
export const RUN_STATUSES = ["running", "completed", "failed"] as const;
export type RunStatusFilter = (typeof RUN_STATUSES)[number];

/**
 * The `meta` keys a run search reads: the names the run history shows beside
 * each run. A search never reads the rest of `meta`, which holds the starter's
 * prompt and the QA target's credential: matching on those would let anyone who
 * can list a run confirm a guess at its secret one search at a time.
 */
const SEARCHABLE_RUN_META = ["campaignName", "contactName", "prospectContactName"] as const;

/** Longest search text a run list accepts. */
export const MAX_RUN_SEARCH_LENGTH = 100;

export interface RunListQuery {
  limit: number;
  /** Newest first ("desc") or oldest first ("asc"). */
  order: "asc" | "desc";
  status?: RunStatusFilter;
  /** Case-insensitive substring of a name the run shows; see SEARCHABLE_RUN_META. */
  search?: string;
  /** The last run of the previous page; this page starts strictly after it in `order`. */
  after?: ListCursor;
}

/**
 * One page of an agent's runs among those the caller may read, filtered and
 * searched, with how many runs match in all.
 *
 * Visibility is part of the WHERE clause, ahead of the filter, the search, the
 * limit and the count, so neither the page nor `total` can include, or be
 * shortened by, a run the caller cannot read: a filter or search must never
 * become a way to learn that hidden runs with some status or name exist.
 */
export async function listVisibleRuns(
  orgId: string,
  readablePaths: string[],
  agentId: string,
  options: RunListQuery,
): Promise<{ runs: VisibleRecentRun[]; total: number; nextCursor: ListCursor | null }> {
  if (readablePaths.length === 0) return { runs: [], total: 0, nextCursor: null };
  const conditions = [
    Prisma.sql`"orgId" = ${orgId}`,
    Prisma.sql`"agentId" = ${agentId}`,
    runVisibleUnderSql(orgId, readablePaths),
  ];
  if (options.status) conditions.push(Prisma.sql`"status"::text = ${options.status}`);
  const search = options.search?.trim();
  if (search) {
    const pattern = `%${escapeLikePrefix(search)}%`;
    const legs = SEARCHABLE_RUN_META.map((key) => Prisma.sql`"meta"->>${key} ILIKE ${pattern} ESCAPE '\\'`);
    conditions.push(Prisma.sql`(${Prisma.join(legs, " OR ")})`);
  }
  const where = Prisma.join(conditions, " AND ");
  const direction = options.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  // The cursor narrows the page, never the count: `total` is every matching run.
  const { after } = options;
  const past = after
    ? Prisma.sql`AND ("startedAt", "id") ${options.order === "asc" ? Prisma.sql`>` : Prisma.sql`<`} (${after.at}, ${after.id})`
    : Prisma.empty;

  // One row past the page says whether another page follows.
  const [rows, counted] = await Promise.all([
    query<VisibleRecentRun[]>(Prisma.sql`
      SELECT "id", "status"::text AS "status", "triggeredBy", "meta", "startedAt", "finishedAt"
      FROM "agent_runs" WHERE ${where} ${past}
      ORDER BY "startedAt" ${direction}, "id" ${direction}
      LIMIT ${options.limit + 1}`),
    query<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM "agent_runs" WHERE ${where}`),
  ]);
  const runs = rows.slice(0, options.limit);
  const last = runs[runs.length - 1];
  const nextCursor = rows.length > options.limit && last ? { at: last.startedAt, id: last.id } : null;
  return { runs, total: counted[0]?.n ?? 0, nextCursor };
}

/**
 * Runs in flight whose scope the caller holds a covering read grant on — the nav's agent
 * badge. A run whose driver died without finishing it is not in flight, so abandoned runs
 * (services/agents/abandoned-runs.ts) are left out before the sweep gets to them.
 * A count that cannot be run rejects rather than answering 0.
 */
export async function countVisibleRunningRuns(orgId: string, readablePaths: string[]): Promise<number> {
  if (readablePaths.length === 0) return 0;
  const rows = await query<{ n: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM "agent_runs"
    WHERE "orgId" = ${orgId} AND "status" = 'running' AND NOT ${runAbandonedSql(new Date())}
      AND ${runVisibleUnderSql(orgId, readablePaths)}`);
  return rows[0]?.n ?? 0;
}

/**
 * Run one composed query against `agent_runs`.
 *
 * Raw SQL normally belongs in services/access or services/memory (the lint rule
 * on $queryRaw): a raw query against a scoped model can bypass the access-control
 * seam. This file IS that seam for agent runs — it owns the rule about who may
 * see one — and raw SQL is what the rule needs here, because a run's scope lives
 * in its `meta` JSON rather than a column, so Prisma's typed `where` cannot ask
 * the containment question at all. The alternative is reading every run in the
 * organisation into memory to discard most of them.
 */
// eslint-disable-next-line no-restricted-syntax -- see the comment above: this module is the runs access seam, and meta.scopePath is not queryable through the typed layer.
const query = <T>(sql: Prisma.Sql) => db.$queryRaw<T>(...flattenSql(sql));

/**
 * A run's meta as it may leave the server: the QA target's `authHeader` is the
 * credential the run uses against the system under test. It stays stored because the
 * run loop and follow-up runs need it, and is never returned to any caller.
 */
export function publicRunMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return meta;
  const target = (meta as { target?: unknown }).target;
  if (!target || typeof target !== "object" || !("authHeader" in target)) return meta;
  const safeTarget: Record<string, unknown> = { ...target };
  delete safeTarget.authHeader;
  return { ...meta, target: safeTarget };
}
