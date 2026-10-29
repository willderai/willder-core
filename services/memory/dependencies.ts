// The dependency graph's read side: what rests on a record, and which records in a scope rest on something that
// has since moved on.
//
// A dependency is recorded in two places, and this file reads both as one relation:
//
//   - `brief_citations`: a brief cites the fact a section of it quoted (brief-citations.ts);
//   - `fact_edges` of kind `derivedFrom` or `dependsOn` between two records (edges.ts),
//     read only when the record at each end is placed inside the scope: stored there (a
//     fact, a rule, an unretired brief) or announced there by the change feed. A declared share's
//     `derivedFrom` edge names a scope, not a record (services/access/derived-writes.ts),
//     so it is never one, even after the scope it names is deleted.
//
// A source has moved on when a `supersedes` edge points at it, or when the change feed
// recorded it updated, superseded, deleted or revoked after the dependent was built.
//
// The one rule this file enforces: every id returned sits inside a scope the caller was
// just allowed to read, and an erased record answers exactly as one never recorded. Each
// public function makes one audited `check()` on the scope it is asked about; every query
// filters edges (both ends), briefs and change events to that scope; a brief's citation
// names the fact its own text quoted, which its reader is shown with the brief; a retired brief
// reads as absent, as on every brief read (brief-retirement.ts); and a relation with an end
// that reads as erased (`versionsReadingAsErased`, versions.ts) is left out before any
// bound or count (`liveRows`), so an erased record is never named, not as a dependent, a
// source or a replacement, and never moves a list's length or its `truncated`.
//
// What this reads is what was recorded. A brief whose cited fact changed text in the
// graph store without a change event, or whose connected source re-synced an item, is
// stale by GET /api/briefs/:id/staleness (brief-staleness.ts), which asks the memory
// service; this list does not, so it can answer for a whole scope from Postgres alone.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { ChangeOp, FactEdgeKind } from "@/lib/generated/prisma/enums";
import {
  AccessDeniedError,
  check,
  flattenSql,
  orgRootPath,
  scopeContainsSql,
  type AccessContext,
} from "@/services/access";
import { FACT_RECORD_TYPE } from "./change-events";
import { CONVENTION_RECORD_TYPE } from "./conventions";
import { erasedByIdSql, loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { versionsReadingAsErased } from "./versions";

/** How one record rests on another: a brief citing a fact, or a recorded edge. */
export type DependencyKind = "cites" | Extract<FactEdgeKind, "derivedFrom" | "dependsOn">;

/** One relation between two records, as a reader is shown it. */
export interface DependencyEdge {
  /** The newer or dependent record: the brief, the replacement, the derived record. */
  fromId: string;
  /** The record it rests on or replaced. */
  toId: string;
  kind: DependencyKind | "supersedes";
  /** Scope of the `from` record. */
  scopePath: string;
  createdAt: Date;
}

/** Every relation touching one record, inside one scope. */
export interface RecordEdges {
  /** Relations whose `from` is the record: what it cites, rests on or replaced. */
  outgoing: DependencyEdge[];
  /** Relations whose `to` is the record: what cites it, rests on it or replaced it. */
  incoming: DependencyEdge[];
  /** Whether a query hit {@link MAX_ROWS_PER_QUERY}, so older relations are missing. */
  truncated: boolean;
}

/** A record a change to one record invalidates, with the relations that lead to it. */
export interface Invalidated {
  recordId: string;
  /** Relations between the changed record and this one. */
  distance: number;
  /** The relations walked, nearest the changed record first. */
  path: DependencyEdge[];
}

/** The records a change invalidates, and whether the walk saw every relation. */
export interface WhatToChange {
  items: Invalidated[];
  /** Whether a step of the walk hit a row bound, or the item bound stopped it. */
  truncated: boolean;
}

/** Why a source no longer says what its dependent was built from. */
export type StaleReason =
  /** A newer version replaced it. A replacement that reads as erased is not counted. */
  | { kind: "superseded"; at: Date; byId: string }
  /** The change feed recorded it changed, superseded, deleted or revoked after the dependent was built. */
  | { kind: "changed"; at: Date; op: ChangeOp };

/** One dependent record resting on one source that moved on after it was built. */
export interface StaleDependency {
  /** The dependent record: a brief, or a record with a `derivedFrom`/`dependsOn` edge. */
  recordId: string;
  /** The record it rests on. */
  sourceId: string;
  kind: DependencyKind;
  reason: StaleReason;
}

/** A stale record worth refreshing, with what rests on it. */
export interface Recommendation {
  recordId: string;
  /** How many records in the scope cite or rest on this one. */
  dependents: number;
  /** How many of its sources moved on. */
  staleSources: number;
  /** The source that moved on most recently, and why. */
  latest: Omit<StaleDependency, "recordId">;
}

/** The stale records in one scope, and which to refresh first. */
export interface StaleReport {
  stale: StaleDependency[];
  recommend: Recommendation[];
  /** Whether a query hit {@link MAX_ROWS_PER_QUERY}, so the lists may be incomplete. */
  truncated: boolean;
}

/** Default size of a recommendation list. */
export const DEFAULT_RECOMMENDATIONS = 3;
/** Most recommendations one call returns. */
export const MAX_RECOMMENDATIONS = 20;
/**
 * Most rows one query returns, newest first. A query that finds more says so. Only rows a
 * reader may be shown count: a relation with an end that reads as erased is left out first.
 */
export const MAX_ROWS_PER_QUERY = 500;
/**
 * Rows the second and last read of one query asks for, when rows found to read as erased
 * after the first left it under the bound. An id an erasure removed or redacted is left out
 * in SQL and never costs a second read; only a stored copy whose text names an erased
 * person (one a restore put back before its re-apply ran) is found after a read.
 */
export const SECOND_READ_ROWS = 4 * (MAX_ROWS_PER_QUERY + 1);
/** How far `whatToChange` follows relations from the changed record. */
export const MAX_WALK_DEPTH = 8;
/** Most invalidated records `whatToChange` returns. */
export const MAX_INVALIDATED = 200;

/** Change operations on a source that leave what was built from it stale. */
const STALING_OPS: readonly ChangeOp[] = ["update", "supersede", "delete", "revoke"];
/** Change-feed record types whose `recordId` is a record a dependency can name. */
const SOURCE_RECORD_TYPES = [FACT_RECORD_TYPE, CONVENTION_RECORD_TYPE];

/** Rows from a bounded query, and whether the bound cut any off. */
interface Bounded<T> {
  rows: T[];
  truncated: boolean;
}

// ── Public, authorized ───────────────────────────────────────────────────────

/**
 * Every relation touching `recordId` inside `scopePath`, in both directions. A record
 * outside the scope, or one that reads as erased, has none, the same as an id never issued.
 *
 * @throws AccessDeniedError when `ctx` may not read `scopePath`.
 */
export async function edgesOf(ctx: AccessContext, recordId: string, scopePath: string): Promise<RecordEdges> {
  const read = await authorizedRead(ctx, scopePath);
  // An erased record has no relations, however many were recorded: answered before any is read.
  if ((await read.erased([recordId])).has(recordId)) return { outgoing: [], incoming: [], truncated: false };
  const [outgoing, incoming] = await Promise.all([
    relations(read, { fromIds: [recordId] }),
    relations(read, { toIds: [recordId] }),
  ]);
  return { outgoing: outgoing.rows, incoming: incoming.rows, truncated: outgoing.truncated || incoming.truncated };
}

/**
 * The records a change to `recordId` invalidates: everything that cites it or rests on
 * it, directly or through other records, nearest first.
 *
 * @throws AccessDeniedError when `ctx` may not read `scopePath`.
 */
export async function whatToChange(ctx: AccessContext, recordId: string, scopePath: string): Promise<WhatToChange> {
  const read = await authorizedRead(ctx, scopePath);
  if ((await read.erased([recordId])).has(recordId)) return { items: [], truncated: false };
  return walkDependents(recordId, (ids) => relations(read, { toIds: ids, dependenciesOnly: true }));
}

/**
 * The records in `scopePath` resting on a source that moved on after they were built,
 * and the few most worth refreshing: the most depended on, then the most recently
 * invalidated.
 *
 * @throws AccessDeniedError when `ctx` may not read `scopePath`.
 */
export async function staleReport(
  ctx: AccessContext,
  scopePath: string,
  limit = DEFAULT_RECOMMENDATIONS,
): Promise<StaleReport> {
  const read = await authorizedRead(ctx, scopePath);
  const derivations = await relations(read, { dependenciesOnly: true });
  if (derivations.rows.length === 0) return { stale: [], recommend: [], truncated: derivations.truncated };

  const sourceIds = [...new Set(derivations.rows.map((d) => d.toId))];
  const [replacements, changes] = await Promise.all([supersedesInto(read, sourceIds), sourceChanges(read, sourceIds)]);
  const stale = staleDependencies(derivations.rows, replacements.rows, changes.rows);
  const dependents = await dependentCounts(read, [...new Set(stale.map((s) => s.recordId))]);
  return {
    stale,
    recommend: rankStale(stale, dependents.counts, limit),
    truncated: derivations.truncated || replacements.truncated || changes.truncated || dependents.truncated,
  };
}

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * Breadth-first walk from `rootId` along the relations that point at it, so the result
 * is ordered by distance. Within one distance the most recently recorded relation comes
 * first, ties by the dependent's id. A record reachable by several paths is listed once,
 * by its shortest path. `truncated` is set when a fetch was cut off, or when the item or
 * depth bound stopped the walk with records still unvisited.
 *
 * @param fetchDependents returns the dependency relations whose `toId` is in `ids`.
 */
export async function walkDependents(
  rootId: string,
  fetchDependents: (ids: string[]) => Promise<Bounded<DependencyEdge>>,
  limits: { depth: number; items: number } = { depth: MAX_WALK_DEPTH, items: MAX_INVALIDATED },
): Promise<WhatToChange> {
  const items: Invalidated[] = [];
  const pathTo = new Map<string, DependencyEdge[]>([[rootId, []]]);
  let frontier = [rootId];
  let truncated = false;

  for (let distance = 1; distance <= limits.depth && frontier.length > 0; distance++) {
    const fetched = await fetchDependents(frontier);
    truncated ||= fetched.truncated;
    const next: string[] = [];
    for (const edge of byRecency(fetched.rows)) {
      if (pathTo.has(edge.fromId)) continue;
      if (items.length >= limits.items) return { items, truncated: true };
      const path = [...pathTo.get(edge.toId)!, edge];
      pathTo.set(edge.fromId, path);
      items.push({ recordId: edge.fromId, distance, path });
      next.push(edge.fromId);
    }
    frontier = next;
  }
  // The depth bound stopped the walk with records still to visit: say so when any of them
  // has a dependent the walk never reached.
  if (frontier.length > 0 && !truncated) {
    const beyond = await fetchDependents(frontier);
    truncated = beyond.truncated || beyond.rows.some((edge) => !pathTo.has(edge.fromId));
  }
  return { items, truncated };
}

/**
 * Each derivation whose source moved on, with why. A replacement wins over a change
 * event, because it names a newer version: the newest direct one, which may itself have
 * been replaced since (the chain is not followed). Among replacements and among change
 * events the latest wins, ties by id. A replacement counts whenever it was recorded: a
 * brief that cites a version already replaced quotes something no longer current. A
 * change event counts only after the dependent was built.
 */
export function staleDependencies(
  derivations: readonly DependencyEdge[],
  replacements: readonly { id: string; fromId: string; toId: string; createdAt: Date }[],
  changes: readonly { id: string; recordId: string; op: ChangeOp; createdAt: Date }[],
): StaleDependency[] {
  const stale: StaleDependency[] = [];
  for (const derivation of derivations) {
    if (derivation.kind === "supersedes") continue;
    const replacement = latest(replacements.filter((r) => r.toId === derivation.toId));
    const change = latest(
      changes.filter(
        (c) => c.recordId === derivation.toId && STALING_OPS.includes(c.op) && c.createdAt > derivation.createdAt,
      ),
    );
    const reason: StaleReason | null = replacement
      ? { kind: "superseded", at: replacement.createdAt, byId: replacement.fromId }
      : change
        ? { kind: "changed", at: change.createdAt, op: change.op }
        : null;
    if (reason) stale.push({ recordId: derivation.fromId, sourceId: derivation.toId, kind: derivation.kind, reason });
  }
  return stale;
}

/**
 * One recommendation per stale record, ordered by how much rests on it, then by how
 * recently it went stale, then by id so equal candidates come back in one order; the
 * first `limit`, clamped to 1..{@link MAX_RECOMMENDATIONS}.
 */
export function rankStale(
  stale: readonly StaleDependency[],
  dependents: ReadonlyMap<string, number>,
  limit: number,
): Recommendation[] {
  const byRecord = new Map<string, StaleDependency[]>();
  for (const item of stale) byRecord.set(item.recordId, [...(byRecord.get(item.recordId) ?? []), item]);
  const recommendations = [...byRecord].map(([recordId, items]): Recommendation => {
    const { recordId: _recordId, ...newest } = [...items].sort(
      (a, b) => b.reason.at.getTime() - a.reason.at.getTime() || compareIds(a.sourceId, b.sourceId),
    )[0]!;
    return {
      recordId,
      dependents: dependents.get(recordId) ?? 0,
      staleSources: new Set(items.map((i) => i.sourceId)).size,
      latest: newest,
    };
  });
  const bound = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RECOMMENDATIONS)
    : DEFAULT_RECOMMENDATIONS;
  return recommendations
    .sort(
      (a, b) =>
        b.dependents - a.dependents ||
        b.latest.reason.at.getTime() - a.latest.reason.at.getTime() ||
        compareIds(a.recordId, b.recordId),
    )
    .slice(0, bound);
}

// ── Internal queries, scope-filtered, not authorized ─────────────────────────

/** One authorized read: the org, the scope `check()` allowed, and which ids read as erased. */
interface ScopedRead {
  orgId: string;
  scopePath: string;
  /** Which of `ids` read as erased; the org's suppression list is loaded once per read. */
  erased: (ids: readonly string[]) => Promise<Set<string>>;
}

async function authorizedRead(ctx: AccessContext, scopePath: string): Promise<ScopedRead> {
  const decision = await check(ctx, { action: "memory.read", scope: scopePath });
  if (!decision.allowed) throw new AccessDeniedError(decision);
  const orgId = ctx.orgId;
  let filter: Promise<ErasedContentFilter> | undefined;
  return {
    orgId,
    scopePath,
    erased: async (ids) =>
      ids.length === 0 ? new Set() : versionsReadingAsErased(orgId, ids, (filter ??= loadErasedContentFilter(orgId))),
  };
}

/** What `relations` is asked for: one end fixed, or neither, and which kinds. */
interface RelationFilter {
  fromIds?: string[];
  toIds?: string[];
  /** Only citations and `derivedFrom`/`dependsOn` edges, never `supersedes`. */
  dependenciesOnly?: boolean;
}

/**
 * Citations and edges recorded inside `scopePath`, newest first, each source bounded.
 * A citation belongs to its brief's scope and is left out when the brief is retired. An
 * edge is read only when the records at both ends are placed inside the scope
 * ({@link placedWithin}), whatever scope the edge row itself carries: so a retired brief,
 * a record stored only in a sibling scope, and a declared share's edge (whose `to` is a
 * scope) are all left out.
 */
async function relations(read: ScopedRead, filter: RelationFilter): Promise<Bounded<DependencyEdge>> {
  const [citations, edges] = await Promise.all([citationsInScope(read, filter), edgesInScope(read, filter)]);
  return {
    rows: byRecency([...citations.rows, ...edges.rows]),
    truncated: citations.truncated || edges.truncated,
  };
}

async function citationsInScope(read: ScopedRead, filter: RelationFilter): Promise<Bounded<DependencyEdge>> {
  if (filter.fromIds?.length === 0 || filter.toIds?.length === 0) return { rows: [], truncated: false };
  const { orgId, scopePath } = read;
  const within = scopeContainsSql(Prisma.raw('b."scopePath"'), scopePath, { relation: "within", mode: "text" });
  const fromIds = filter.fromIds ? Prisma.sql`AND b."id" IN (${Prisma.join(filter.fromIds)})` : Prisma.empty;
  const toIds = filter.toIds ? Prisma.sql`AND c."factId" IN (${Prisma.join(filter.toIds)})` : Prisma.empty;
  // One row per brief and fact, however many sections cite it: the dependency is the
  // brief on the fact, not the section.
  return liveRows(read, (limit) =>
    db.$queryRaw<DependencyEdge[]>(
      ...flattenSql(Prisma.sql`
        SELECT b."id" AS "fromId", c."factId" AS "toId", 'cites' AS "kind", b."scopePath", MIN(c."createdAt") AS "createdAt"
        FROM "brief_citations" c
        JOIN "briefs" b ON b."id" = c."briefId"
        WHERE b."orgId" = ${orgId}
          AND ${within}
          AND NOT EXISTS (SELECT 1 FROM "brief_retirements" r WHERE r."briefId" = b."id")
          AND ${readableEnds(orgId, ['c."factId"'])}
          ${fromIds}
          ${toIds}
        GROUP BY b."id", c."factId", b."scopePath"
        ORDER BY MIN(c."createdAt") DESC, b."id" ASC, c."factId" ASC
        LIMIT ${limit}
      `),
    ),
  );
}

async function edgesInScope(read: ScopedRead, filter: RelationFilter): Promise<Bounded<DependencyEdge>> {
  if (filter.fromIds?.length === 0 || filter.toIds?.length === 0) return { rows: [], truncated: false };
  const { orgId, scopePath } = read;
  const within = scopeContainsSql(Prisma.raw('e."scopePath"'), scopePath, { relation: "within", mode: "text" });
  const fromIds = filter.fromIds ? Prisma.sql`AND e."fromId" IN (${Prisma.join(filter.fromIds)})` : Prisma.empty;
  const toIds = filter.toIds ? Prisma.sql`AND e."toId" IN (${Prisma.join(filter.toIds)})` : Prisma.empty;
  const kinds = filter.dependenciesOnly
    ? Prisma.sql`e."kind" IN ('derivedFrom', 'dependsOn')`
    : Prisma.sql`e."kind" IN ('derivedFrom', 'dependsOn', 'supersedes')`;
  return liveRows(read, (limit) =>
    db.$queryRaw<DependencyEdge[]>(
      ...flattenSql(Prisma.sql`
        SELECT e."fromId", e."toId", e."kind"::text AS "kind", e."scopePath", e."createdAt"
        FROM "fact_edges" e
        WHERE e."orgId" = ${orgId}
          AND ${kinds}
          AND ${within}
          AND ${placedWithin(Prisma.raw('e."fromId"'), orgId, scopePath)}
          AND ${placedWithin(Prisma.raw('e."toId"'), orgId, scopePath)}
          AND ${readableEnds(orgId, ['e."fromId"', 'e."toId"'])}
          ${fromIds}
          ${toIds}
        ORDER BY e."createdAt" DESC, e."id" ASC
        LIMIT ${limit}
      `),
    ),
  );
}

/**
 * The record whose id is in `idColumn` is placed inside `scopePath`: a fact, rule or
 * unretired brief stored there, or a fact or rule the change feed announced there (a
 * version whose row a correction or deletion removed is still known by its events). A
 * scope's id or path is none of these, nor is a record stored only in another scope.
 * `idColumn` is a fixed identifier from this file, never caller input.
 */
function placedWithin(idColumn: Prisma.Sql, orgId: string, scopePath: string): Prisma.Sql {
  const text = (column: string, includeUntagged = false) =>
    scopeContainsSql(Prisma.raw(column), scopePath, { relation: "within", mode: "text", includeUntagged });
  const atRoot = scopePath === orgRootPath(orgId);
  return Prisma.sql`(
    EXISTS (SELECT 1 FROM "memory_chunks" m WHERE m."orgId" = ${orgId} AND m."id" = ${idColumn} AND ${text('m."scopePath"', atRoot)})
    OR EXISTS (SELECT 1 FROM "conventions" r WHERE r."orgId" = ${orgId} AND r."id" = ${idColumn} AND ${text('r."scopePath"')})
    OR EXISTS (
      SELECT 1 FROM "briefs" pb WHERE pb."orgId" = ${orgId} AND pb."id" = ${idColumn} AND ${text('pb."scopePath"')}
        AND NOT EXISTS (SELECT 1 FROM "brief_retirements" pr WHERE pr."briefId" = pb."id")
    )
    OR EXISTS (
      SELECT 1 FROM "change_events" ev
      WHERE ev."orgId" = ${orgId} AND ev."recordId" = ${idColumn}
        AND ev."recordType" IN (${Prisma.join(SOURCE_RECORD_TYPES)})
        AND ${scopeContainsSql(Prisma.raw('ev."scopePath"'), scopePath, { relation: "within", mode: "ltree" })}
    )
  )`;
}

/**
 * `supersedes` edges inside `scopePath` pointing at any of `ids`, whose replacement (the
 * `from` end, named to the reader as `byId`) is placed inside the scope too. A replacement
 * that reads as erased is left out before the newest is picked, so a live one behind it is
 * still named, and an erased one's id or time never surfaces. `ids` are sources the caller
 * already read as live, so only the replacement end is checked here.
 */
async function supersedesInto(
  read: ScopedRead,
  ids: string[],
): Promise<Bounded<{ id: string; fromId: string; toId: string; createdAt: Date }>> {
  const { orgId, scopePath } = read;
  const within = scopeContainsSql(Prisma.raw('e."scopePath"'), scopePath, { relation: "within", mode: "text" });
  return liveRows(read, (limit) =>
    db.$queryRaw<{ id: string; fromId: string; toId: string; createdAt: Date }[]>(
      ...flattenSql(Prisma.sql`
        SELECT e."id", e."fromId", e."toId", e."createdAt"
        FROM "fact_edges" e
        WHERE e."orgId" = ${orgId}
          AND e."kind" = 'supersedes'
          AND e."toId" IN (${Prisma.join(ids)})
          AND ${within}
          AND ${placedWithin(Prisma.raw('e."fromId"'), orgId, scopePath)}
          AND ${readableEnds(orgId, ['e."fromId"'])}
        ORDER BY e."createdAt" DESC, e."id" ASC
        LIMIT ${limit}
      `),
    ),
  );
}

/** Change events inside `scopePath` on any of `ids` that could leave a dependent stale. */
async function sourceChanges(
  { orgId, scopePath }: ScopedRead,
  ids: string[],
): Promise<Bounded<{ id: string; recordId: string; op: ChangeOp; createdAt: Date }>> {
  // ltree containment: change_events is served by its GiST index, as change-feed.ts reads it.
  const within = scopeContainsSql(Prisma.raw('"scopePath"'), scopePath, { relation: "within", mode: "ltree" });
  const ops = Prisma.join(STALING_OPS.map((op) => Prisma.sql`${op}::"ChangeOp"`));
  return bounded(
    await db.$queryRaw<{ id: string; recordId: string; op: ChangeOp; createdAt: Date }[]>(
      ...flattenSql(Prisma.sql`
        SELECT "id", "recordId", "op", "createdAt"
        FROM "change_events"
        WHERE "orgId" = ${orgId}
          AND "recordType" IN (${Prisma.join(SOURCE_RECORD_TYPES)})
          AND "recordId" IN (${Prisma.join(ids)})
          AND "op" IN (${ops})
          AND ${within}
        ORDER BY "createdAt" DESC, "id" ASC
        LIMIT ${MAX_ROWS_PER_QUERY + 1}
      `),
    ),
  );
}

/** How many records inside the scope cite or rest on each of `ids`, leaving out those that read as erased. */
async function dependentCounts(
  read: ScopedRead,
  ids: string[],
): Promise<{ counts: Map<string, number>; truncated: boolean }> {
  if (ids.length === 0) return { counts: new Map(), truncated: false };
  const found = await relations(read, { toIds: ids, dependenciesOnly: true });
  const dependents = new Map<string, Set<string>>();
  for (const edge of found.rows) {
    dependents.set(edge.toId, (dependents.get(edge.toId) ?? new Set()).add(edge.fromId));
  }
  return { counts: new Map([...dependents].map(([id, from]) => [id, from.size])), truncated: found.truncated };
}

/** No end in `columns` is an id an erasure removed or redacted. */
function readableEnds(orgId: string, columns: readonly string[]): Prisma.Sql {
  return Prisma.join(
    columns.map((column) => Prisma.sql`NOT ${erasedByIdSql(orgId, Prisma.raw(column))}`),
    " AND ",
  );
}

/**
 * The rows of `query` without any row that has an end reading as erased, newest first and
 * bounded to {@link MAX_ROWS_PER_QUERY}: the bound and `truncated` count only rows the
 * reader may be shown, so an erased relation answers as one never recorded. `query` returns
 * at most `limit` rows and leaves out those an erasure removed or redacted by id
 * ({@link readableEnds}). When rows found to read as erased after the first read leave it
 * under the bound, a second read reaches {@link SECOND_READ_ROWS} rows; a query still cut
 * short then says `truncated`.
 */
async function liveRows<T extends { createdAt: Date | string; fromId: string; toId: string }>(
  read: ScopedRead,
  query: (limit: number) => Promise<T[]>,
): Promise<Bounded<T>> {
  let found: Bounded<T> = { rows: [], truncated: false };
  for (const limit of [MAX_ROWS_PER_QUERY + 1, SECOND_READ_ROWS]) {
    const rows = await query(limit);
    const erased = await read.erased(rows.flatMap((row) => [row.fromId, row.toId]));
    const live = rows.filter((row) => !erased.has(row.fromId) && !erased.has(row.toId));
    found = {
      rows: dated(live.slice(0, MAX_ROWS_PER_QUERY)),
      truncated: live.length > MAX_ROWS_PER_QUERY || rows.length === limit,
    };
    // The query ran out of rows, or the rows the reader may be shown alone pass the bound:
    // either way, reading further cannot change the answer.
    if (rows.length < limit || live.length > MAX_ROWS_PER_QUERY) break;
  }
  return found;
}

/**
 * The first {@link MAX_ROWS_PER_QUERY} of a query that asked for one row more, and whether
 * that extra row existed, so a caller is told about the cut instead of being handed a full
 * page that looks complete.
 */
function bounded<T extends { createdAt: Date | string }>(rows: T[]): Bounded<T> {
  return { rows: dated(rows.slice(0, MAX_ROWS_PER_QUERY)), truncated: rows.length > MAX_ROWS_PER_QUERY };
}

/** node-postgres returns timestamps as Date; a driver that returns strings would otherwise compare as strings. */
function dated<T extends { createdAt: Date | string }>(rows: T[]): (T & { createdAt: Date })[] {
  return rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }));
}

/** Newest first, ties by the dependent's id then the source's, so equal timestamps sort one way. */
function byRecency<T extends { createdAt: Date; fromId: string; toId: string }>(edges: readonly T[]): T[] {
  return [...edges].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || compareIds(a.fromId, b.fromId) || compareIds(a.toId, b.toId),
  );
}

function latest<T extends { createdAt: Date; id: string }>(rows: readonly T[]): T | undefined {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(a.id, b.id))[0];
}

/** Code-unit order, so the result does not depend on the runtime's locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
