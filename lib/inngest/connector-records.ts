// What a connector sync has already written, and how it takes it back.
//
// Every connector -- Slack, Figma, PostHog, GitHub, Drive -- records what it
// synced in `SourceFile` and must be able to retire that content again when
// the upstream item is edited or deleted. This file holds the record shapes,
// the pure diff that decides what a sync has to do (`planConnectorSync`), and
// the episode retirement both the text-item and the Drive path go through.
//
// The one rule it enforces: an episode is deleted from the group it was
// actually written to, and a store that reports it was not deleted is an
// error, never a silent no-op. See `retireEpisode`.
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { graphitiStore } from "@/services/memory";

/** The actor a connector's sync writes and announces its items as. Defined with the
 *  product's other reserved actor ids, so no agent token can be minted under it. */
export { connectorActorId } from "@/services/access/system-actors";

/** One previously-synced connector item, as stored in `SourceFile`. */
export interface ConnectorSyncFile {
  externalFileId: string;
  checksum: string;
  episodeId: string | null;
  /** The Graphiti group this item's episode was written under, as recorded at
   *  write time. Null for a row written before the column existed, or one whose
   *  episode has already been retired. */
  episodeScopePath: string | null;
}

/**
 * An episode to delete, addressed the only way a Graphiti episode can be: by
 * its id AND the group it was written to. `scopePath` is null only for a legacy
 * row that never recorded one, in which case the caller falls back to the
 * source's current scope and cannot be sure the two agree.
 *
 * Keeping the pair in one type is the point: passing a bare episode id lets a
 * caller silently address it under whatever scope is convenient.
 */
export interface RetirableEpisode {
  episodeId: string;
  scopePath: string | null;
}

export interface ConnectorSyncIngestPlanItem<T> {
  item: T;
  /** The stale episode to retire before ingesting this item's new content —
   *  set only when this externalFileId was already synced with a DIFFERENT
   *  checksum (an edit) and that prior sync captured a real episode id. Null
   *  for a brand-new item (nothing to retire) or one whose prior sync never
   *  captured an episode id (nothing retirable). */
  previousEpisode: RetirableEpisode | null;
}

export interface ConnectorSyncPlan<T> {
  /** New or edited items — need a fresh ingest. */
  toIngest: ConnectorSyncIngestPlanItem<T>[];
  /** Previously-synced files no longer present upstream (deleted, or the
   *  channel/file is no longer reachable) — their episode must be retired and
   *  the record dropped, so the content stops being retrievable. For an
   *  incremental listing, only the ones the connector confirmed gone. */
  toRetire: ConnectorSyncFile[];
  skippedCount: number;
}

/**
 * Decide, from what's already stored vs. what a fresh upstream listing just
 * returned, which items need a new ingest (with the stale episode to retire
 * first, if any), which previously-synced items have vanished upstream and
 * need retiring outright, and how many are unchanged. Pure and DB-free on
 * purpose. Comparing ONE item against its own prior record (skip or
 * re-ingest) never notices an item disappear from the upstream listing, so a
 * deleted Slack message/Figma comment's episode lives forever, and an edited
 * one gets a second, contradicting episode alongside the first. This function
 * is the decision logic that closes both gaps; sourceSync just executes its
 * output.
 *
 * An item is unchanged only when it was also written at `scopePath`, the scope
 * this run writes to (see `isWrittenAt`).
 *
 * `gone` is for an incremental listing, one that returns only what changed
 * since the last sync. Absence from such a listing proves nothing, so only the
 * records the connector confirmed gone upstream are retired. Without it the
 * listing is taken as everything upstream holds, and whatever it lacks is gone.
 */
export function planConnectorSync<T extends { id: string; checksum: string }>(
  existingFiles: ConnectorSyncFile[],
  freshItems: T[],
  scopePath: string,
  gone?: readonly string[],
): ConnectorSyncPlan<T> {
  const existingByExternalId = new Map(existingFiles.map((f) => [f.externalFileId, f]));
  const freshIds = new Set(freshItems.map((item) => item.id));

  const toIngest: ConnectorSyncIngestPlanItem<T>[] = [];
  for (const item of freshItems) {
    const existing = existingByExternalId.get(item.id);
    if (existing?.checksum === item.checksum && isWrittenAt(existing, scopePath)) continue; // unchanged, skip
    toIngest.push({
      item,
      previousEpisode: existing?.episodeId
        ? { episodeId: existing.episodeId, scopePath: existing.episodeScopePath }
        : null,
    });
  }

  const goneIds = gone ? new Set(gone) : null;
  const toRetire = existingFiles.filter(
    (f) => !freshIds.has(f.externalFileId) && (goneIds === null || goneIds.has(f.externalFileId)),
  );

  return { toIngest, toRetire, skippedCount: freshItems.length - toIngest.length };
}

/**
 * Whether a synced item's record says its content is at `scopePath`.
 *
 * A record pinned to another scope is one a sync started before a reconnect
 * moved the source wrote there after the reconnect's purge. That content is
 * retired with the old scope, so the item has to be written again at the new
 * one, not skipped as unchanged. A record with no scope (written before the
 * column existed, or with nothing ingested) cannot say, and counts as here.
 */
export function isWrittenAt(record: { episodeScopePath: string | null }, scopePath: string): boolean {
  return record.episodeScopePath === null || record.episodeScopePath === scopePath;
}

/** The memory store answered a delete with not-found for the group on record. */
class EpisodeNotRemovedError extends Error {}

/**
 * Delete one episode from the group it was actually written to, and fail when
 * the store reports it was not deleted.
 *
 * `removeEpisode` maps the memory service's 404 onto `{ removed: false }`. A
 * caller that ignores that result while addressing the episode under the
 * source's CURRENT `scopePath` breaks after a reconnect moves the scope:
 * already-ingested episodes stay in the group they were written to, so every
 * delete aims at a group the episode was never in, 404s, and reads as a safe
 * no-op — upstream-deleted content stays retrievable, and an edit leaves two
 * contradicting episodes.
 *
 * Addressing the group recorded for the episode makes `removed: false` mean what
 * it says — the episode is not in the partition we have on record for it — which
 * is an error, not a no-op. The per-item callers turn that into a `failed` outcome
 * that leaves the sync record intact, so the next sync retries it.
 *
 * `resuming` says an earlier attempt already started this delete and may have
 * finished it before failing to record so. Only then, and only for an episode
 * whose group is recorded, is `removed: false` the earlier attempt's work: the
 * episode is not in the one partition it was written to. A legacy row has no
 * recorded group, so its not-found stays ambiguous and stays an error.
 *
 * `retiredByChunk`, for a record whose group is recorded, says whether one of the item's
 * stored passages is gone, deleted as a fact or erased with a person. Such a removal
 * retires the passage's episodes by its chunk id (`removeChunkFacts`) and drops the
 * pointers it is told of (services/memory/episode-pointers.ts); one it was not told of, or
 * one whose pointer drop failed after the retirement, is the episode found gone here. Then,
 * too, not-found is that removal's work, not a scope the record got wrong.
 *
 * @returns the scope the episode was removed from, which is where its readers are.
 */
async function retireEpisode(
  episode: RetirableEpisode,
  currentScopePath: string,
  resuming = false,
  retiredByChunk?: () => Promise<boolean>,
): Promise<string> {
  const groupId = episode.scopePath ?? currentScopePath;
  const { removed } = await graphitiStore.removeEpisode({ groupId, episodeId: episode.episodeId });
  if (removed || (resuming && episode.scopePath)) return groupId;
  if (episode.scopePath && retiredByChunk && (await retiredByChunk())) return groupId;
  const fallback = episode.scopePath
    ? ""
    : " — this row predates SourceFile.episodeScopePath, so its episode was looked for under the source's current scope; " +
      "disconnect the source to purge content left in a scope it no longer points at";
  throw new EpisodeNotRemovedError(
    `memory service reported episode ${episode.episodeId} not removed from group ${groupId}${fallback}`,
  );
}

/**
 * Delete one recorded episode so that a failure after the delete can be resumed.
 * The `SourceFile` row that points at the episode (`where`) is marked before the
 * graph delete, and the caller clears the mark in the transaction that drops the
 * pointer and announces the change. If that transaction fails, the next sync
 * finds the mark and finishes the retirement instead of failing forever on an
 * episode that is already gone; the change event is written only by the
 * transaction that finally commits, so it is announced once.
 *
 * The row has one mark, so it may point at only one episode being retired at a
 * time: a caller retiring several deletes and records them one after another.
 *
 * @returns the scope the episode was removed from.
 */
export async function retireRecordedEpisode(
  where: Prisma.SourceFileWhereInput,
  episode: RetirableEpisode,
  currentScopePath: string,
  retiredByChunk?: () => Promise<boolean>,
): Promise<string> {
  const row = await db.sourceFile.findFirst({ where, select: { episodeRetireStartedAt: true } });
  const resuming = row?.episodeRetireStartedAt != null;
  if (resuming) return retireEpisode(episode, currentScopePath, true);

  await db.sourceFile.updateMany({ where, data: { episodeRetireStartedAt: new Date() } });
  try {
    return await retireEpisode(episode, currentScopePath, false, retiredByChunk);
  } catch (e) {
    // This attempt's own not-found means nothing was deleted, so a retry must not
    // read the mark as an earlier delete. Any other failure may have landed after
    // the delete did, so the mark stays.
    if (e instanceof EpisodeNotRemovedError) {
      await db.sourceFile.updateMany({ where, data: { episodeRetireStartedAt: null } });
    }
    throw e;
  }
}
