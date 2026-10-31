// What a person erasure removes beyond the records that name the person: every version
// written in place of one it removes, and everything a removed version left behind.
//
// A version that replaced another (a person's correction, an update based on it, an upstream
// edit of a connector item) is linked to it by a `supersedes` edge from the new version to the
// old (services/memory/edges.ts). A version an agent based on a person's rule copy replaced
// nothing, and is linked by a `derivedFrom` edge instead (services/memory/person-rule-copy.ts). A correction made through PATCH /api/memory/facts/:id is
// linked a second way, which also holds for one stored in another scope than the fact (no edge
// is recorded then) and for one made before edges were: its removal of the fact and its new text
// are announced naming the one audit row that authorized both (`authorizedById`, since
// 2026-10-05). The new version's own text need not name anyone: "Based in Denver" corrects a
// fact filed under Dana Whitfield, and is about her only through that link. An erasure that
// matched text alone removed the fact and kept its correction.
//
// THE ONE RULE: a version written in place of a version an erasure removes is removed with it,
// and so is every version written in place of that one, whatever its own text says. "Written
// in place of" means announced after it on the change feed (`writtenAfter`): a conflict's or a
// stale write's winner was stored before the version it beat, holds nothing from it, and stays.
// The feed's order is used because it survives the version's own row, and so reads the same on
// every retry of a request.
//
// What a removed version leaves behind goes with it (`removeGraphCopies`, `removeVersions`):
//  - a fact's `memory_chunks` row, with its passages;
//  - its graph copy: the episodes stamped with the row's id, and, for a correction, every graph
//    record filed under the correction's own name (services/memory/correction-names.ts);
//  - a connector item's version: its graph episodes' facts, a Drive file's passages, and the
//    sync record's pointers to them, so a later sync does not try to retire them again;
//  - the text of every change event about it, blanked; the events stay, as an erasure leaves
//    every event, so the feed keeps its order;
// and its id goes on the org's suppression list (services/memory/erasure-suppression.ts), so a
// copy a restored backup puts back is never served and `reapplyErasures` removes it again.
//
// Every step of an erasure records the ids of the versions it removes in the transaction that
// removes them (`markVersionsErased`). The walk starts from those ids, found again through the
// edges that name them, so a request sent again after a failure reaches the same versions even
// though the records that named the person are already gone.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { namesOneCorrection } from "./correction-names";
import { FACT_RECORD_TYPE } from "./change-events";
import { erasedVersionsAmong, markApplied, recordErasedVersions, versionIdEntry } from "./erasure-suppression";
import type { GraphPersonErasureResult } from "./graphiti-store";
import type { IngestInput } from "@/types/memory";
import { graphitiStore } from "./store";
import { forgetErasedVersions } from "./task-start-served";

/**
 * Most versions one walk may reach, the erased ones it starts from included. A version is
 * replaced at most once (services/memory/edges.ts), so a walk is a set of chains and an org
 * reaches this only with a pathological history. Past it the walk throws rather than stop
 * short: an erasure that left a replacement behind would report itself complete.
 */
export const MAX_LINEAGE_VERSIONS = 10_000;

/** Most replacements in one chain: corrections of corrections, edits of edits. */
export const MAX_LINEAGE_DEPTH = 1_000;

/** A walk reached one of its bounds. Nothing was removed by the walk itself; send the request again once the history is smaller, or raise the bound. */
export class ErasureLineageTooLargeError extends Error {
  constructor(bound: "versions" | "depth", limit: number) {
    super(
      bound === "versions"
        ? `This erasure reaches more than ${limit} versions through their replacements; it stopped before removing them so as not to report a partial erasure as complete.`
        : `This erasure follows a chain of more than ${limit} replacements; it stopped before removing them so as not to report a partial erasure as complete.`,
    );
    this.name = "ErasureLineageTooLargeError";
  }
}

/** The slice of a Prisma client or transaction the walk reads through. */
type LineageReader = Pick<Prisma.TransactionClient, "$queryRaw" | "erasureSuppression">;

/** The bounds of one walk; the defaults are {@link MAX_LINEAGE_VERSIONS} and {@link MAX_LINEAGE_DEPTH}. */
export interface LineageBounds {
  maxVersions?: number;
  maxDepth?: number;
}

/** One link into a version the walk has reached, with where each end sits in the feed. */
interface ReplacementEdge {
  fromId: string;
  toId: string;
  /** `seq` of the `create` event that announced the version, null when none did. */
  fromSeq: bigint | null;
  toSeq: bigint | null;
}

/**
 * Whether the replacement in `edge` was announced after the version it replaced, or when the
 * feed cannot say (a version announced before the feed existed, or a graph fact a brief
 * correction overruled): then it is taken as written in its place, erring toward erasure.
 */
function writtenAfter(edge: ReplacementEdge): boolean {
  return edge.fromSeq === null || edge.toSeq === null || edge.fromSeq > edge.toSeq;
}

/**
 * Every version in `orgId` written in place of one of `erased`, and in place of those, to the
 * end of each chain, without the erased versions themselves. Cycle-safe: a version is visited
 * once, so a cycle in the edges (which services/memory/edges.ts never writes) ends the chain.
 *
 * @throws ErasureLineageTooLargeError past either bound.
 */
export async function versionsWrittenInPlaceOf(
  reader: LineageReader,
  orgId: string,
  erased: readonly string[],
  { maxVersions = MAX_LINEAGE_VERSIONS, maxDepth = MAX_LINEAGE_DEPTH }: LineageBounds = {},
): Promise<string[]> {
  const visited = new Set(erased);
  const found: string[] = [];
  let frontier = [...visited];
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= maxDepth) throw new ErasureLineageTooLargeError("depth", maxDepth);
    // A `supersedes` edge, or a `derivedFrom` edge from a version kept beside a person's rule copy
    // (services/memory/person-rule-copy.ts), written from that copy though it replaced nothing, or
    // a person's correction announced under the authorization its removal of the replaced
    // version was announced under. A declared share's `derivedFrom` edge names a scope, which is
    // never in the frontier. Only a PATCH correction shares one:
    // both its events are a person's, while a connector's events share its connect row and are
    // announced as the sync's.
    const edges = await reader.$queryRaw<ReplacementEdge[]>`
      SELECT r."fromId", r."toId",
        (SELECT c.seq FROM change_events c WHERE c."orgId" = ${orgId} AND c."recordType" = ${FACT_RECORD_TYPE}
           AND c.op = 'create' AND c."recordId" = r."fromId") AS "fromSeq",
        (SELECT c.seq FROM change_events c WHERE c."orgId" = ${orgId} AND c."recordType" = ${FACT_RECORD_TYPE}
           AND c.op = 'create' AND c."recordId" = r."toId") AS "toSeq"
      FROM (
        SELECT e."fromId", e."toId", e."createdAt" AS at, e.id AS tie
        FROM fact_edges e
        WHERE e."orgId" = ${orgId} AND e.kind IN ('supersedes', 'derivedFrom') AND e."toId" = ANY (${frontier}::text[])
        UNION ALL
        SELECT created."recordId", removal."recordId", created."createdAt", created.id
        FROM change_events removal
        JOIN change_events created
          ON created."orgId" = removal."orgId" AND created."authorizedById" = removal."authorizedById"
        WHERE removal."orgId" = ${orgId} AND removal."recordType" = ${FACT_RECORD_TYPE} AND removal.op = 'supersede'
          AND removal."actorType" = 'human' AND removal."authorizedById" IS NOT NULL
          AND removal."recordId" = ANY (${frontier}::text[])
          AND created."recordType" = ${FACT_RECORD_TYPE} AND created.op = 'create' AND created."actorType" = 'human'
          AND created."recordId" <> removal."recordId"
      ) r
      ORDER BY r.at, r.tie
    `;
    const next: string[] = [];
    for (const edge of edges) {
      if (visited.has(edge.fromId) || !writtenAfter(edge)) continue;
      visited.add(edge.fromId);
      if (visited.size > maxVersions) throw new ErasureLineageTooLargeError("versions", maxVersions);
      found.push(edge.fromId);
      next.push(edge.fromId);
    }
    frontier = next;
  }
  return found;
}

/**
 * The versions an erasure in `orgId` removed that something replaced: where the walk starts.
 * Read from the links and the suppression list, so it holds after the records that named the
 * person are gone, and holds for every erasure in the org: a version written in place of one an
 * earlier erasure removed, while that erasure ran, is removed by the next one.
 */
export async function erasedVersionsWithReplacements(reader: LineageReader, orgId: string): Promise<string[]> {
  const replaced = await reader.$queryRaw<{ id: string }[]>`
    SELECT "toId" AS id FROM fact_edges WHERE "orgId" = ${orgId} AND kind IN ('supersedes', 'derivedFrom')
    UNION
    SELECT "recordId" FROM change_events
    WHERE "orgId" = ${orgId} AND "recordType" = ${FACT_RECORD_TYPE} AND op = 'supersede'
      AND "actorType" = 'human' AND "authorizedById" IS NOT NULL
  `;
  const erased = await erasedVersionsAmong(
    reader,
    orgId,
    replaced.map((r) => r.id),
  );
  return [...erased].sort();
}

/** The versions written in place of a version an erasure removed that no erasure has removed yet: what erasure still owes. */
export async function replacementsToErase(
  reader: LineageReader,
  orgId: string,
  bounds?: LineageBounds,
): Promise<string[]> {
  const erased = await erasedVersionsWithReplacements(reader, orgId);
  const replacements = await versionsWrittenInPlaceOf(reader, orgId, erased, bounds);
  const done = await erasedVersionsAmong(reader, orgId, replacements);
  return replacements.filter((id) => !done.has(id));
}

/** A version's `memory_chunks` row, as removing its graph copy needs it. */
interface StoredChunk {
  id: string;
  /** Null for an untagged row, whose graph copy lives in the org's own group. */
  scopePath: string | null;
  entityName: string | null;
}

/** A connector item's sync record whose current version is being removed. */
interface SyncedItem {
  id: string;
  sourceId: string;
  /** A text item's one episode, or null for a Drive file. */
  episodeId: string | null;
  /** A Drive file's episodes, one per passage. */
  episodeIds: string[];
  /** A Drive file's passages in `memory_chunks`. */
  chunkIds: string[];
  /** The group the episodes were written to; null for a record from before it was kept. */
  episodeScopePath: string | null;
  sourceScopePath: string;
}

/** What is still stored of some versions: their chunk rows, and the sync records whose current version is one of them. */
export interface StoredCopies {
  chunks: StoredChunk[];
  items: SyncedItem[];
}

/**
 * What is still stored of `versionIds` in `orgId`. A Drive file's version is named by its
 * first episode (services/memory/edges.ts), and any of its episodes finds the whole file, so
 * the passages it was extracted into are removed together.
 */
export async function storedCopiesOf(
  orgId: string,
  versionIds: readonly string[],
  reader: Pick<Prisma.TransactionClient, "$queryRaw"> = db,
): Promise<StoredCopies> {
  if (versionIds.length === 0) return { chunks: [], items: [] };
  const ids = [...versionIds];
  // One after the other: inside a transaction, a client runs one statement at a time.
  const chunks = await reader.$queryRaw<StoredChunk[]>`
      SELECT id, "scopePath", "entityName" FROM memory_chunks WHERE "orgId" = ${orgId} AND id = ANY (${ids}::text[])
    `;
  const items = await reader.$queryRaw<SyncedItem[]>`
      SELECT f.id, f."sourceId", f."episodeId", f."episodeIds", f."chunkIds", f."episodeScopePath",
             s."scopePath" AS "sourceScopePath"
      FROM source_files f JOIN sources s ON s.id = f."sourceId"
      WHERE s."orgId" = ${orgId} AND (f."episodeId" = ANY (${ids}::text[]) OR f."episodeIds" && ${ids}::text[])
    `;
  return { chunks, items };
}

/** Every episode a sync record still points at. */
const episodesOf = (item: SyncedItem): string[] => [...(item.episodeId ? [item.episodeId] : []), ...item.episodeIds];

/**
 * Remove the graph copies of `copies`, before their rows go, so a failure here leaves the rows
 * a retry finds them by:
 *  - a chunk's episodes stamped with its id (`removeChunkFacts`), at the scope it was stored in;
 *  - for a correction, every graph record filed under its own name, which is how a person's
 *    write stored before 2026-10-13 is found in the graph: the ingest job wrote its episodes
 *    before its row then, so they carry no row id. The memory service's person erasure does this
 *    by name, org-wide; the name
 *    is that one correction's (services/memory/correction-names.ts), so nothing else matches it.
 *    A name in `ownedNames` is erased the same way: the caller is removing every version filed
 *    under it;
 *  - a connector item's episodes' facts (`removeEpisode`), in the group they were written to.
 *    One already gone is not an error.
 *
 * @returns what the memory service reported removing by name, empty when nothing was removed by
 *   name; the other two removals report no counts.
 */
export async function removeGraphCopies(
  orgId: string,
  copies: StoredCopies,
  { ownedNames = [] }: { ownedNames?: readonly string[] } = {},
): Promise<Partial<GraphPersonErasureResult>> {
  const counts: Partial<GraphPersonErasureResult> = {};
  const owned = new Set(ownedNames);
  for (const chunk of copies.chunks) {
    await graphitiStore.removeChunkFacts({ groupId: chunk.scopePath ?? orgId, chunkId: chunk.id });
    if (namesOneCorrection(chunk.entityName) || (chunk.entityName !== null && owned.has(chunk.entityName))) {
      const named = await graphitiStore.erasePerson({ orgId, emails: [], names: [chunk.entityName!], entityIds: [] });
      // Only what the memory service reported as a count is added, as the person erasure's own step does.
      for (const key of ["episodes", "nodes", "edges", "summaries"] as const) {
        const value: unknown = named[key];
        if (Number.isInteger(value) && (value as number) >= 0) counts[key] = (counts[key] ?? 0) + (value as number);
      }
    }
  }
  for (const item of copies.items) {
    for (const episodeId of episodesOf(item)) {
      await graphitiStore.removeEpisode({ groupId: item.episodeScopePath ?? item.sourceScopePath, episodeId });
    }
  }
  return counts;
}

/**
 * Inside `tx`: put `versionIds` on the org's suppression list by their ids, as removed by
 * `requestId`, blank the text of every fact change event about them, and delete the task-start
 * log's rows naming them (services/memory/task-start-served.ts).
 *
 * @returns how many summaries were blanked.
 */
export async function markVersionsErased(
  tx: Prisma.TransactionClient,
  orgId: string,
  requestId: string,
  versionIds: readonly string[],
): Promise<number> {
  if (versionIds.length === 0) return 0;
  await recordErasedVersions(tx, orgId, requestId, versionIds);
  await forgetErasedVersions(tx, orgId, versionIds);
  return tx.$executeRaw`
    UPDATE change_events SET summary = ''
    WHERE "orgId" = ${orgId} AND "recordType" = ${FACT_RECORD_TYPE} AND "recordId" = ANY (${[...versionIds]}::text[])
      AND summary <> ''
  `;
}

/**
 * Inside `tx`: remove the rows of `versionIds` and of their sync records' current versions
 * (`copies`, read before their graph copies went), and mark every one of them erased
 * ({@link markVersionsErased}). A sync record keeps its checksum, so an unchanged item is
 * skipped on the next sync and stays erased; a changed one is checked again.
 *
 * @returns how many `memory_chunks` rows went, and how many summaries were blanked.
 */
export async function removeVersions(
  tx: Prisma.TransactionClient,
  orgId: string,
  requestId: string,
  versionIds: readonly string[],
  copies: StoredCopies,
): Promise<{ chunks: number; summariesBlanked: number }> {
  const passages = copies.items.flatMap((item) => item.chunkIds.map((id) => ({ id, sourceId: item.sourceId })));
  let chunks = 0;
  if (versionIds.length > 0) {
    chunks +=
      await tx.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId} AND id = ANY (${[...versionIds]}::text[])`;
  }
  if (passages.length > 0) {
    // Bound to the source as well as the ids, as a sync's own retirement is.
    chunks += await tx.$executeRaw`
      DELETE FROM memory_chunks AS c
      USING unnest(${passages.map((p) => p.id)}::text[], ${passages.map((p) => p.sourceId)}::text[]) AS p(id, "sourceId")
      WHERE c."orgId" = ${orgId} AND c.id = p.id AND c."sourceId" = p."sourceId"
    `;
  }
  if (copies.items.length > 0) {
    await tx.$executeRaw`
      UPDATE source_files AS f
      SET "episodeId" = NULL, "episodeIds" = '{}', "chunkIds" = '{}', "episodeScopePath" = NULL, "episodeRetireStartedAt" = NULL
      FROM sources AS s
      WHERE f."sourceId" = s.id AND s."orgId" = ${orgId} AND f.id = ANY (${copies.items.map((i) => i.id)}::text[])
    `;
  }
  const marked = [...new Set([...versionIds, ...copies.items.flatMap(episodesOf)])];
  const summariesBlanked = await markVersionsErased(tx, orgId, requestId, marked);
  return { chunks, summariesBlanked };
}

/**
 * Whether the ingest `input` is a correction of a version an erasure removed: a correction made
 * before an erasure whose queued job runs after it, which the erasure could not reach because it
 * was not stored yet. Its job checks before it writes anything and again after.
 */
export async function correctsErasedVersion(input: Pick<IngestInput, "groupId" | "correctionOf">): Promise<boolean> {
  const corrected = input.correctionOf?.factId;
  if (corrected === undefined) return false;
  return (await erasedVersionsAmong(db, input.groupId, [corrected])).has(corrected);
}

/**
 * Remove what the ingest job of a correction of an erased version stored, `versionId`, as the
 * erasure would have: its graph copy, its row and the text of its events, and mark it erased.
 * Nothing was announced yet, so nothing else names it.
 */
export async function withdrawCorrectionOfErased(
  input: Pick<IngestInput, "groupId" | "correctionOf">,
  versionId: string,
): Promise<void> {
  const copies = await storedCopiesOf(input.groupId, [versionId]);
  await removeGraphCopies(input.groupId, copies);
  const requestId = `correction-of-erased:${input.correctionOf?.factId ?? versionId}`;
  await db.$transaction(async (tx) => {
    await removeVersions(tx, input.groupId, requestId, [versionId], copies);
    // Removed in this transaction, so applied: the org still reads as having carried out every erasure.
    await markApplied(tx, input.groupId, requestId, { entries: [versionIdEntry(input.groupId, versionId)] });
  });
}
