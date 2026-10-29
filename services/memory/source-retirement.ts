/**
 * Retiring one connector source's ingested content from both memory stores.
 *
 * The rule this file enforces: a source's content lives in the scope it was
 * written under, and `Source.scopePath` is a mutable pointer that a reconnect
 * can move. So anything that makes a source's content stop being retrievable
 * has to cover every scope that source ever wrote to, not just the one it
 * points at now. That includes the change feed: each item a sync ingests is
 * announced with the item's text as the event summary, at the scope it was
 * written to.
 *
 * Imported by its own path rather than through `services/memory`'s barrel (the
 * same way `entity-scope` is), so the two source routes that need it do not pull
 * in every store implementation to get one helper.
 */

import { db } from "@/lib/db";
import { removingFromGraph } from "@/services/access";
import { connectorActorId } from "@/services/access/system-actors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { SourceType } from "@/lib/generated/prisma/enums";
import { retireBriefsFedBySource } from "./brief-retirement";
import { graphitiStore } from "./store";

/** The fields of a `Source` row this module needs to retire its content. */
export interface RetirableSource {
  id: string;
  orgId: string;
  scopePath: string;
}

export interface RetireSourceContentResult {
  retiredFacts: number;
  retiredChunks: number;
  /** Change events whose summary carried this source's item text and was cleared. */
  redactedChangeEvents: number;
  /** Briefs newly withdrawn because they could quote content that left their scope. */
  retiredBriefs: number;
  /** Every scope that was purged, the source's current one first. */
  scopePaths: string[];
}

/**
 * Every scope this source's content can be in: the ones its own sync records
 * captured at write time, plus the scope it points at now — which is where a
 * sync in flight is writing, and the only guess available for rows written
 * before `SourceFile.episodeScopePath` existed.
 */
export async function listIngestedScopePaths(source: RetirableSource): Promise<string[]> {
  const recorded = await db.sourceFile.findMany({
    where: { sourceId: source.id, episodeScopePath: { not: null } },
    select: { episodeScopePath: true },
    distinct: ["episodeScopePath"],
  });

  const paths = new Set<string>([source.scopePath]);
  for (const row of recorded) {
    if (row.episodeScopePath) paths.add(row.episodeScopePath);
  }
  return [...paths];
}

/**
 * Retire this source's own facts and chunks in every scope it ever wrote to,
 * clear the item text from the change events its sync wrote, then withdraw the
 * briefs that could quote that content and can no longer read it
 * (`brief-retirement.ts`). Briefs go last, so a store failure leaves them
 * readable alongside the content they were drawn from.
 *
 * Both stores are filtered on `source.id`, never on scope alone: `POST
 * /api/sources` accepts a caller-supplied `scopePath` and `Source` is unique on
 * (orgId, type, externalId), so one scope can legitimately hold a second
 * source's content and ordinary org memory besides (item
 * sources-delete-retention-provenance-marker-20260919). Content ingested before
 * that provenance marker existed carries no `source_id` and is not retired here
 * — the documented limit of that item, unchanged by this one.
 *
 * A store failure propagates immediately and leaves the remaining scopes
 * untouched. Every step is idempotent (0 facts/chunks/events the second time), so a
 * caller that has not yet moved or disconnected the source can surface the
 * error and have the whole operation retried.
 *
 * @param movedTo the scope a reconnect is moving the source to, or null when
 *   the source is being disconnected.
 */
export async function retireSourceContent(
  source: RetirableSource,
  movedTo: string | null,
): Promise<RetireSourceContentResult> {
  const scopePaths = await listIngestedScopePaths(source);
  return retireAt(source, scopePaths, movedTo, null);
}

/**
 * Retire this source's content at one scope only: its facts and chunks there,
 * the item text of the change events its sync wrote there, and the briefs that
 * could quote it. Content the source has at any other scope is untouched.
 *
 * For a sync run that a reconnect moved off `scopePath` while it ran. The sync
 * the reconnect fired can already be writing at the new scope, since Inngest's
 * per-source concurrency key serializes steps, not runs; the whole-source
 * `retireSourceContent` would wipe that run's content too.
 *
 * @param scopePath the scope to retire; the scope the run captured when it started.
 * @param movedTo the scope the source points at now, or null when it is gone.
 */
export async function retireSourceContentAtScope(
  source: RetirableSource,
  scopePath: string,
  movedTo: string | null,
): Promise<RetireSourceContentResult> {
  return retireAt(source, [scopePath], movedTo, scopePath);
}

/**
 * Purge both stores at each of `scopePaths`, then the change-event text, then
 * briefs. `eventScope` limits the change-event redaction to one scope; null
 * clears every event the source's sync wrote, wherever it is.
 */
async function retireAt(
  source: RetirableSource,
  scopePaths: string[],
  movedTo: string | null,
  eventScope: string | null,
): Promise<RetireSourceContentResult> {
  let retiredFacts = 0;
  let retiredChunks = 0;
  // The graph facts go with no Postgres row for the cache triggers to see, so the removal
  // epoch is moved around them (scopeCacheStamp()): no cached scan keeps serving them.
  if (scopePaths.length > 0) {
    await removingFromGraph(source.orgId, async () => {
      for (const scopePath of scopePaths) {
        const { removedCount } = await graphitiStore.removeGroupFacts({
          groupId: scopePath,
          sourceId: source.id,
        });
        retiredFacts += removedCount;

        const { count } = await db.memoryChunk.deleteMany({
          where: { orgId: source.orgId, scopePath, sourceId: source.id },
        });
        retiredChunks += count;
      }
    });
  }

  const redactedChangeEvents = await redactSyncChangeSummaries(source, eventScope);
  const retiredBriefs = await retireBriefsFedBySource(source, scopePaths, movedTo);

  return { retiredFacts, retiredChunks, redactedChangeEvents, retiredBriefs, scopePaths };
}

/**
 * Clear the summary on every change event this source's sync wrote, at
 * `scopePath` only when one is given, so the feed stops serving the item text
 * that summary was cut from.
 *
 * The events stay, with their scope, record id and op: an agent's cursor may
 * name one, and a deleted event would turn that cursor into an error. What a
 * reader of the old scope can still learn is that some episode id changed there,
 * which carries none of the content.
 *
 * Events are matched on the exact actor a sync writes as ({@link syncActorIdsOf}),
 * not on scope, so the clear reaches an event in a scope the sync records no longer
 * list.
 */
async function redactSyncChangeSummaries(source: RetirableSource, scopePath: string | null): Promise<number> {
  const { count } = await db.changeEvent.updateMany({
    where: {
      orgId: source.orgId,
      actorId: { in: syncActorIdsOf(source.id) },
      summary: { not: "" },
      ...(scopePath === null ? {} : { scopePath }),
    },
    data: { summary: "" },
  });
  return count;
}

/**
 * Every actor id the sync of source `sourceId` can have written change events as,
 * `<type>-sync:<sourceId>` (`connectorActorId`). The type is not always at hand, so
 * every connector type's is listed; source ids are unique across types, so only
 * this source's sync can match.
 */
export function syncActorIdsOf(sourceId: string): string[] {
  return Object.values(SourceType).map((type) => connectorActorId({ type, id: sourceId }));
}

/**
 * Remove what one connector ingest wrote at `scopePath` after its source was
 * disconnected or moved under it: the source's facts and chunks at that scope.
 *
 * For a memory ingest job that found its source gone when it checked again after
 * its last write. The disconnect or reconnect has already retired the source at
 * that scope, so anything of the source still there landed late. The caller must
 * have found the source connected at `scopePath` in `orgId` before writing, which
 * is what makes `scopePath` the source's own scope rather than one an event named.
 */
export async function retireLateSourceWrite(input: {
  orgId: string;
  sourceId: string;
  scopePath: string;
}): Promise<void> {
  await removingFromGraph(input.orgId, async () => {
    await graphitiStore.removeGroupFacts({ groupId: input.scopePath, sourceId: input.sourceId });
    await db.memoryChunk.deleteMany({
      where: { orgId: input.orgId, scopePath: input.scopePath, sourceId: input.sourceId },
    });
  });
}

/**
 * Remove the one pgvector row stored for a connector ingest that was then refused
 * because its source had no connection. Matched on id, org and source together, so
 * a refused event can never reach another org's row or a row written without that
 * source.
 */
export async function dropRefusedSourceRow(input: { orgId: string; sourceId: string; chunkId: string }): Promise<void> {
  await db.memoryChunk.deleteMany({ where: { id: input.chunkId, orgId: input.orgId, sourceId: input.sourceId } });
}

/**
 * Whether one of the `memory_chunks` rows a synced connector file recorded is no longer
 * stored: deleted as a fact or erased with a person, since its sync deletes them only
 * after it retired the file's episodes. Bound to the org and the source, as the delete is.
 */
export async function someSourceFileChunkGone(input: {
  orgId: string;
  sourceId: string;
  chunkIds: string[];
}): Promise<boolean> {
  if (input.chunkIds.length === 0) return false;
  const stored = await db.memoryChunk.count({
    where: { id: { in: input.chunkIds }, orgId: input.orgId, sourceId: input.sourceId },
  });
  return stored < new Set(input.chunkIds).size;
}

/**
 * Delete the `memory_chunks` rows one synced connector file recorded, in the
 * caller's transaction so the file's own record of them is cleared with them.
 *
 * For a connector sync replacing or removing a file it wrote: the ids come from
 * that file's sync record, and the delete is bound to the org and the source as
 * well, so a stale or wrong id can never reach another source's or org's row.
 */
export async function deleteSourceFileChunks(
  tx: Pick<Prisma.TransactionClient, "memoryChunk">,
  input: { orgId: string; sourceId: string; chunkIds: string[] },
): Promise<void> {
  if (input.chunkIds.length === 0) return;
  await tx.memoryChunk.deleteMany({
    where: { id: { in: input.chunkIds }, orgId: input.orgId, sourceId: input.sourceId },
  });
}
