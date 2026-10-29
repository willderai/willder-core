/**
 * Counting what one connector source has left in the stores that hold its records,
 * scope by scope, so a person can check that disconnecting it removed what it
 * brought in.
 *
 * The rule this file enforces: the answer is counts only, never a record's text, and
 * it covers every scope the source's records are in, not only the one the source
 * points at now. A reconnect moves `Source.scopePath` while what was already ingested
 * stays where it was written (see source-retirement.ts), so a count of the current
 * scope alone would read zero over records left behind in an earlier one.
 *
 * What is counted, by store:
 * - Postgres: `memory_chunks` rows stamped with the source and how many of them hold
 *   an embedding, the source's sync records (`source_files`), and the change events
 *   its sync wrote that still carry the item's text as their summary;
 * - the graph (memory service): episodes, facts, the facts' embedding vectors and the
 *   verbatim nodes behind them, plus, at the source's own scope, entities nothing links
 *   to and facts whose episodes are all gone (`GraphitiMemoryStore.sourceRecords`).
 *
 * Two things a disconnect also does are not counted, because neither leaves a record
 * that names the source: the entity summaries it clears (an entity carries no source
 * stamp, so a summary still quoting the source cannot be told from one that never
 * did), and the briefs it withdraws (`brief-retirement.ts`), which a brief without a
 * provenance row is withdrawn by on scope and time alone.
 *
 * The caller authorizes every scope in the answer before returning it.
 */

import { db } from "@/lib/db";
import { orgRootPath } from "@/services/access/org-root";
import { syncActorIdsOf, type RetirableSource } from "./source-retirement";
import { toGid } from "./graphiti-store";
import { graphitiStore } from "./store";

/** What one source has at one scope. Every field is a count. */
export interface SourceRecordCounts {
  scopePath: string;
  /** `memory_chunks` rows stamped with the source. */
  chunks: number;
  /** Of those rows, the ones holding an embedding. */
  chunkEmbeddings: number;
  /** The source's per-item sync records. */
  syncRecords: number;
  /** Change events by the source's sync whose summary still carries the item's text. */
  feedSummaries: number;
  /** Graph episodes stamped with the source. */
  episodes: number;
  /** Graph facts stamped with the source or citing one of its episodes. */
  facts: number;
  /** Of those facts, the ones carrying an embedding vector. */
  factEmbeddings: number;
  /** Verbatim Fact, Decision and Passage nodes behind those facts. */
  verbatimNodes: number;
  /** Entities nothing links to; counted at the source's own scope only. */
  orphans: number;
  /** Facts with no source stamp whose episodes are all gone; counted at the source's own scope only. */
  danglingFacts: number;
}

const COUNT_FIELDS = [
  "chunks",
  "chunkEmbeddings",
  "syncRecords",
  "feedSummaries",
  "episodes",
  "facts",
  "factEmbeddings",
  "verbatimNodes",
  "orphans",
  "danglingFacts",
] as const satisfies readonly (keyof SourceRecordCounts)[];

/** Whether a scope's row counts anything at all. */
export function holdsRecords(row: SourceRecordCounts): boolean {
  return COUNT_FIELDS.some((field) => row[field] > 0);
}

/**
 * Whether a scope's row counts anything another disconnect of the source would retire:
 * everything but `orphans`. An orphaned entity carries no source stamp, so once the
 * source's episodes are gone no retirement can attribute it to the source any more;
 * keeping the source's row would not get it removed.
 */
export function holdsRetirableRecords(row: SourceRecordCounts): boolean {
  return COUNT_FIELDS.some((field) => field !== "orphans" && row[field] > 0);
}

/**
 * The scope each graph group id stands for, among the org's scopes. toGid is one-to-one, so
 * a group names at most one scope. A group no scope names is placed at the org root: only a
 * caller who can read the whole org gets that answer.
 */
function groupScopes(orgId: string, paths: string[]): (groupId: string) => string {
  const root = orgRootPath(orgId);
  const byGroup = new Map(paths.map((path) => [toGid(path), path]));
  return (groupId) => byGroup.get(groupId) ?? root;
}

/**
 * Count `source`'s records in every store, one row per scope that holds any, and
 * always one for the scope the source points at now, first. A row missing its
 * scope (a chunk written without one) is counted at the org root, the scope every
 * caller who could have read it can read.
 */
export async function countSourceRecords(source: RetirableSource): Promise<SourceRecordCounts[]> {
  const root = orgRootPath(source.orgId);
  const rows = new Map<string, SourceRecordCounts>();
  const at = (scopePath: string | null): SourceRecordCounts => {
    const key = scopePath ?? root;
    let row = rows.get(key);
    if (!row) {
      row = {
        scopePath: key,
        chunks: 0,
        chunkEmbeddings: 0,
        syncRecords: 0,
        feedSummaries: 0,
        episodes: 0,
        facts: 0,
        factEmbeddings: 0,
        verbatimNodes: 0,
        orphans: 0,
        danglingFacts: 0,
      };
      rows.set(key, row);
    }
    return row;
  };
  at(source.scopePath);

  const [chunks, syncRecords, feedSummaries, graph, scopes] = await Promise.all([
    db.$queryRaw<{ scopePath: string | null; chunks: number; embeddings: number }[]>`
      SELECT "scopePath", count(*)::int AS "chunks", count("embedding")::int AS "embeddings"
      FROM "memory_chunks"
      WHERE "orgId" = ${source.orgId} AND "sourceId" = ${source.id}
      GROUP BY "scopePath"
    `,
    db.sourceFile.groupBy({ by: ["episodeScopePath"], where: { sourceId: source.id }, _count: { _all: true } }),
    db.changeEvent.groupBy({
      by: ["scopePath"],
      where: { orgId: source.orgId, actorId: { in: syncActorIdsOf(source.id) }, summary: { not: "" } },
      _count: { _all: true },
    }),
    graphitiStore.sourceRecords({ orgId: source.orgId, sourceId: source.id, scopePaths: [source.scopePath] }),
    db.scope.findMany({ where: { orgId: source.orgId }, select: { path: true } }),
  ]);

  for (const c of chunks) {
    at(c.scopePath).chunks += c.chunks;
    at(c.scopePath).chunkEmbeddings += c.embeddings;
  }
  // A sync record written before its scope was recorded belongs to the scope the source pointed at.
  for (const r of syncRecords) at(r.episodeScopePath ?? source.scopePath).syncRecords += r._count._all;
  for (const e of feedSummaries) at(e.scopePath).feedSummaries += e._count._all;
  const scopeOfGroup = groupScopes(
    source.orgId,
    scopes.map((s) => s.path),
  );
  for (const g of graph) {
    const row = at(scopeOfGroup(g.groupId));
    row.episodes += g.episodes;
    row.facts += g.facts;
    row.factEmbeddings += g.factEmbeddings;
    row.verbatimNodes += g.verbatimNodes;
    row.orphans += g.orphans;
    row.danglingFacts += g.danglingFacts;
  }

  const [current, ...others] = rows.values();
  return [current!, ...others.filter(holdsRecords).sort((a, b) => a.scopePath.localeCompare(b.scopePath))];
}
