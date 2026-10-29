// A graph fact is served only while a stored source behind it still exists and no erasure
// covers it, checked at the moment it is served.
//
// Postgres and the graph are not one snapshot. Deleting or erasing a `memory_chunks` row,
// or disconnecting a source, retires the graph's copy afterwards, by a call that can fail,
// time out, or (for an erasure, which finds episodes by name) miss an episode entirely. A
// read that trusted the graph would serve the copy for as long as it survives. So no read
// relies on that cleanup: every graph answer the guarded store hands out passes through
// `sourceCheckedReads` (services/memory/source-checked-reads.ts), which reads the sources back from Postgres and leaves out
// whatever they no longer support. A vector-store row is a `memory_chunks` row its own
// query just read and filtered, so it is never rechecked here.
//
// THE RULE, per graph fact, edge or resolved fact:
//
// - Stamped (`chunkIds`, the write path's link to the rows it was distilled from): served
//   only while at least one of those rows exists and is not suppressed by an erasure
//   (services/memory/erasure-suppression.ts: by its text, the entity it is filed under, its
//   id and its write time), and its own text is not suppressed as of the newest such row's
//   write time. Several ingests can assert one graph fact; it is backed while any is.
// - Unstamped (an episode written before the stamp existed, a connector item, an entity
//   seed): dropped when the suppression list covers its text or any of its episodes by id,
//   with no write time (it is treated as old, which it is). Otherwise served ONLY when one
//   of two things still stands behind it in Postgres:
//     1. its `sourceId` names a connected source of this org whose synced-file record still
//        lists one of the fact's episodes (`sourceEventIds`): the item it came from is still
//        synced; or
//     2. it is a direct write still stored in Postgres: a `memory_chunks` row of this org
//        with exactly its text, written by no connector (`sourceId` null), in the same graph
//        partition the fact was read from, that no erasure suppresses (judged as of that
//        row's write time). Whether that version is still the current one is the
//        supersession record's to say, after this check (services/memory/superseded-facts.ts):
//        a read drops a superseded version there, while the graph view keeps showing it,
//        marked superseded, since seeing the conflict is that view's point.
//   Anything else is dropped, not labelled: a label does not keep deleted text from being
//   read.
//
// Cost: one statement per graph call (the chunks by primary key, the synced files by
// `source_files.sourceId`, the direct-write texts by an equality probe on md5 of the text,
// `memory_chunks_direct_content_md5_idx`), plus the
// org's suppression list, loaded in parallel. No statement when a call returned no graph
// fact. Never one per fact.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { flattenSql } from "@/services/access/scope-containment";
import type { MemoryFact } from "@/types/memory";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { toGid } from "./graphiti-store";

/** What a graph answer carries that its sources are checked by. */
export interface GraphItem {
  fact: string;
  chunkIds?: readonly string[];
  sourceId?: string;
  sourceEventIds?: readonly string[];
  /** "semantic" for a vector-store row, which is not rechecked; anything else is the graph's. */
  store?: string;
}

/** Whether `item` came from the graph, the only store whose answers are rechecked here. */
export function isGraphItem(item: GraphItem): boolean {
  return item.store === undefined || item.store === "graph";
}

interface SourceRow {
  kind: "chunk" | "file" | "direct";
  /** A chunk's id, or a source's id for a "file" row. */
  id: string;
  content: string | null;
  written_at: Date | null;
  entity_name: string | null;
  /** The episode a synced file still lists, for a "file" row. */
  episode: string | null;
  /** The stored row's scope, for a "direct" row. */
  scope_path: string | null;
}

/** What a graph call holds about the sources behind its answers. */
export interface GraphSources {
  /** Whether `item`, read from graph partition `group` (when known), may be served. */
  supports(item: GraphItem, group?: string | null): boolean;
}

const SUPPORTS_ALL: GraphSources = { supports: () => true };

/**
 * Read back the sources of every graph item in `items`, in one statement, with the org's
 * suppression list. Call only after check() has allowed the read the items came from.
 */
export async function loadGraphSources(orgId: string, items: readonly GraphItem[]): Promise<GraphSources> {
  const graphItems = items.filter(isGraphItem);
  if (graphItems.length === 0) return SUPPORTS_ALL;
  const chunkIds = [...new Set(graphItems.flatMap((f) => f.chunkIds ?? []))];
  const unstamped = graphItems.filter((f) => !f.chunkIds?.length);
  const sourceIds = [
    ...new Set(unstamped.flatMap((f) => (f.sourceId && f.sourceEventIds?.length ? [f.sourceId] : []))),
  ];
  const episodes = [...new Set(unstamped.flatMap((f) => (f.sourceId ? (f.sourceEventIds ?? []) : [])))];
  const texts = [...new Set(unstamped.map((f) => f.fact))];

  const erasedLoad = loadErasedContentFilter(orgId);
  erasedLoad.catch(() => {});
  const rows = await db.$queryRaw<SourceRow[]>(
    ...flattenSql(graphSourcesSql(orgId, chunkIds, sourceIds, episodes, texts)),
  );
  return sourcesFrom(orgId, rows, await erasedLoad);
}

/** Most stored rows one text is matched against: a text stored more often adds nothing to the answer. */
const DIRECT_ROWS_PER_TEXT = 20;

/**
 * The one statement a graph call makes: the chunks named, by primary key; the episodes the
 * named sources' synced files still list, by `source_files.sourceId`; and the stored
 * direct-write rows holding an unstamped item's exact text, by `memory_chunks_direct_content_md5_idx`
 * (one btree equality probe per text). The exact-text match beside it rules out an md5
 * collision, and is written as `texteq(...)`, not `=`, so the planner cannot serve it from the
 * content trigram index instead (pg_trgm's GIN class takes `=` too, and the planner preferred it).
 * Exported so the realdb test can read its plan.
 */
export function graphSourcesSql(
  orgId: string,
  chunkIds: string[],
  sourceIds: string[],
  episodes: string[],
  texts: string[],
): Prisma.Sql {
  return Prisma.sql`
      SELECT 'chunk' AS kind, c."id", c."content", c."createdAt" AS written_at, c."entityName" AS entity_name, NULL::text AS episode, NULL::text AS scope_path
      FROM "memory_chunks" c
      WHERE c."orgId" = ${orgId} AND c."id" = ANY(${chunkIds}::text[])
      UNION ALL
      SELECT 'file', s."id", NULL, f."syncedAt", NULL, ep.episode, NULL
      FROM "sources" s
      JOIN "source_files" f ON f."sourceId" = s."id"
      CROSS JOIN LATERAL unnest(array_append(f."episodeIds", f."episodeId")) AS ep(episode)
      WHERE s."orgId" = ${orgId} AND s."id" = ANY(${sourceIds}::text[]) AND ep.episode = ANY(${episodes}::text[])
      UNION ALL
      SELECT 'direct', d."id", d."content", d."createdAt", d."entityName", NULL, d."scopePath"
      FROM unnest(${texts}::text[]) AS t(text)
      CROSS JOIN LATERAL (
        SELECT c."id", c."content", c."createdAt", c."entityName", c."scopePath"
        FROM "memory_chunks" c
        WHERE c."orgId" = ${orgId} AND pg_catalog.md5(c."content") = pg_catalog.md5(t.text) AND pg_catalog.texteq(c."content", t.text) AND c."sourceId" IS NULL
        LIMIT ${DIRECT_ROWS_PER_TEXT}
      ) d
    `;
}

/** The rule above, given the rows read back and the suppression list. Exported for unit tests. */
export function sourcesFrom(orgId: string, rows: readonly SourceRow[], erased: ErasedContentFilter): GraphSources {
  // Each live, unsuppressed chunk by id, with its write time.
  const liveChunks = new Map<string, Date | null>();
  // `${sourceId}\0${episode}` for each episode a synced file of this org's source still lists.
  const liveEpisodes = new Set<string>();
  // Exact text → the graph partitions an unsuppressed direct write of it is stored in.
  const directGroups = new Map<string, Set<string>>();
  for (const row of rows) {
    const writtenAt = row.written_at === null ? null : new Date(row.written_at);
    if (row.kind === "file") {
      if (row.episode !== null) liveEpisodes.add(`${row.id}\u0000${row.episode}`);
      continue;
    }
    if (erased(row.content ?? "", writtenAt, row.entity_name, row.id)) continue;
    if (row.kind === "chunk") {
      liveChunks.set(row.id, writtenAt);
    } else if (row.content !== null) {
      if (!directGroups.has(row.content)) directGroups.set(row.content, new Set());
      directGroups.get(row.content)!.add(toGid(row.scope_path ?? orgId));
    }
  }
  const episodeErased = (item: GraphItem, writtenAt: Date | null) =>
    (item.sourceEventIds ?? []).some((episode) => erased("", writtenAt, null, episode));

  return {
    supports(item, group) {
      if (!isGraphItem(item)) return true;
      if (item.chunkIds?.length) {
        let newest: Date | null | undefined;
        for (const id of item.chunkIds) {
          if (!liveChunks.has(id)) continue;
          const at = liveChunks.get(id)!;
          if (newest === undefined || (at !== null && (newest === null || at > newest))) newest = at;
        }
        if (newest === undefined) return false;
        return !erased(item.fact, newest) && !episodeErased(item, newest);
      }
      if (erased(item.fact, null) || episodeErased(item, null)) return false;
      const synced =
        item.sourceId !== undefined &&
        (item.sourceEventIds ?? []).some((episode) => liveEpisodes.has(`${item.sourceId}\u0000${episode}`));
      if (synced) return true;
      return group != null && (directGroups.get(item.fact)?.has(group) ?? false);
    },
  };
}

/**
 * `facts` as `sources` lets them be served, in order, each read from `groupOf(fact)`. A
 * graph copy that may not be served gives its place to the first stored row of the same
 * text the hybrid dedup kept it over (`MemoryFact.displacedCopies`,
 * services/memory/hybrid-store.ts), and that field is never served.
 */
export function servedFacts(
  facts: readonly MemoryFact[],
  sources: GraphSources,
  groupOf: (fact: MemoryFact) => string | null | undefined,
): MemoryFact[] {
  return facts.flatMap((fact) => {
    const served = sources.supports(fact, groupOf(fact))
      ? fact
      : (fact.displacedCopies?.find((copy) => sources.supports(copy, groupOf(copy))) ?? null);
    if (served === null) return [];
    if (served.displacedCopies === undefined) return [served];
    const { displacedCopies: _displaced, ...rest } = served;
    return [rest];
  });
}
