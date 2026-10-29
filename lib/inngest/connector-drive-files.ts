// Syncing one Google Drive file into memory, and retiring one that left the
// folder.
//
// A Drive file is downloaded, stored privately as a blob, extracted into
// several chunks, and ingested as several episodes -- so, unlike a text item,
// a failure can land between two of its own writes.
//
// The rules it enforces: every episode and chunk is recorded as it is
// written and the file's checksum only at the very end, so a partially
// written file is never mistaken for a synced one and its content stays
// retirable by the next sync; and the raw blob is deleted as soon as it has
// been extracted, so no later edit, removal, disconnect or erasure has a raw
// copy of the file left to miss.
import { createId } from "@paralleldrive/cuid2";
import { db } from "@/lib/db";
import { graphitiStore, pgvectorStore } from "@/services/memory";
import type { IngestInput } from "@/types/memory";
import type { DriveFile } from "@/services/connectors/gdrive";
import { recordSourceItemChange } from "@/services/memory/content-change-event";
import { recordReplacements } from "@/services/memory/edges";
import { loadErasedPersonMatcher } from "@/services/memory/erasure-suppression";
import { deleteSourceFileChunks, someSourceFileChunkGone } from "@/services/memory/source-retirement";
import { stopReason, type ConnectorSyncOutcome } from "./source-state";
import { connectorActorId, isWrittenAt, retireRecordedEpisode } from "./connector-records";

/** One previously-synced Drive file, as stored in `SourceFile`. */
export interface DriveSyncFile {
  externalFileId: string;
  checksum: string;
  /** Graphiti episodes the file's last ingest wrote, one per extracted chunk. */
  episodeIds: string[];
  /** `memory_chunks` rows written alongside those episodes. */
  chunkIds: string[];
  /** The group the episodes were written to; null for a legacy row. */
  episodeScopePath: string | null;
}

/**
 * Make one synced Drive file's stored content stop being retrievable: delete
 * each of its Graphiti episodes from the group it was written to, then its raw
 * `memory_chunks` rows, announcing each episode as `op` on the change feed.
 *
 * A Drive file is several episodes, not one, so a failure can land between two
 * of them. Each deleted episode leaves `episodeIds` in the same transaction as
 * its event, and the chunks leave together in one final transaction, so a retry
 * resumes with only what is still live instead of re-deleting an episode that
 * is already gone, which `retireEpisode` would rightly report as a failure.
 * Each delete goes through `retireRecordedEpisode`, so a failure between one
 * episode's graph delete and the transaction that records it is resumed too.
 *
 * The chunk delete is bound to this org and this source as well as the stored
 * ids: the ids come from our own record, but the row they name must still
 * belong to the source being retired.
 *
 * @returns each episode this call retired, with the scope it was removed from.
 */
async function retireDriveFileContent(
  source: { id: string; orgId: string; scopePath: string; connectAuthorizationId: string | null },
  stored: DriveSyncFile,
  op: "supersede" | "delete",
): Promise<RetiredEpisode[]> {
  const where = { sourceId_externalFileId: { sourceId: source.id, externalFileId: stored.externalFileId } };
  const actorId = connectorActorId({ id: source.id, type: "gdrive" });
  const remaining = [...stored.episodeIds];
  const retired: RetiredEpisode[] = [];
  // Its passages are deleted only after every episode, so one already gone was removed as a
  // fact or erased: its episodes went by its chunk id (connector-records.ts, retireEpisode).
  const passageGone = () =>
    someSourceFileChunkGone({ orgId: source.orgId, sourceId: source.id, chunkIds: stored.chunkIds });
  for (const episodeId of stored.episodeIds) {
    const retiredFrom = await retireRecordedEpisode(
      { sourceId: source.id, externalFileId: stored.externalFileId, episodeIds: { has: episodeId } },
      { episodeId, scopePath: stored.episodeScopePath },
      source.scopePath,
      passageGone,
    );
    remaining.splice(remaining.indexOf(episodeId), 1);
    await db.$transaction(async (tx) => {
      await tx.sourceFile.update({ where, data: { episodeIds: remaining, episodeRetireStartedAt: null } });
      await recordSourceItemChange(tx, {
        orgId: source.orgId,
        scopePath: retiredFrom,
        episodeId,
        op,
        actorId,
        authorizedById: source.connectAuthorizationId,
      });
    });
    retired.push({ episodeId, scopePath: retiredFrom });
  }
  await db.$transaction(async (tx) => {
    await deleteSourceFileChunks(tx, { orgId: source.orgId, sourceId: source.id, chunkIds: stored.chunkIds });
    await tx.sourceFile.update({ where, data: { chunkIds: [], episodeScopePath: null } });
  });
  return retired;
}

/** One episode a sync removed from the graph, and the scope it was removed from. */
interface RetiredEpisode {
  episodeId: string;
  scopePath: string;
}

/**
 * The checksum a Drive file's row holds while a sync is still writing it.
 * A listed file's change key is never empty, so a pending row is never skipped.
 */
const PENDING_DRIVE_CHECKSUM = "";

/**
 * Process one new or edited Drive file: download and extract the current
 * version, retire the content its previous sync wrote, then ingest the current
 * version and record the new checksum with every episode and chunk the ingest
 * produced. An unchanged checksum, which covers the file's name as well as its
 * content (`DriveFile.checksum`), is skipped before any of that.
 *
 * The current version is extracted before anything is retired, so a download or
 * extraction failure leaves the previous version searchable rather than leaving
 * the file with no content. The raw blob lives only for the extraction: it is
 * deleted right after, whether the extraction succeeded or not. A failure counts
 * as this one file failing, except a rejected sign-in (`credentialFailed`), which
 * throws: every later file would fail the same way, so the run stops there.
 *
 * This is `syncOneTextItem`'s retire-then-ingest order for a file. It runs the
 * ingest inside the sync step rather than handing the file to `fileIngest`,
 * because only the step that writes the episodes learns their ids, and a later
 * edit or deletion can only retire what was recorded. Episode and chunk ids are
 * recorded as they are written and the checksum last, so a failed retire or
 * ingest is retried by the next sync, which first retires whatever the failed
 * attempt wrote; a completed retire has already dropped its pointers, so that
 * retry does not address the deleted episodes again.
 *
 * A row written before `episodeIds` existed has nothing recorded to retire. Its
 * old content stays until the source is disconnected, whose purge is per source
 * rather than per episode.
 *
 * An edit records what replaced each retired episode, in the transaction that
 * records the new episodes: the file's new version, named by its first episode
 * (`recordReplacements`). The parts of the two versions do not correspond one to
 * one, since extraction splits each version where its own paragraphs fall, so the
 * first episode stands for the whole new version, and the file's other new
 * episodes name nothing they replaced. An edit whose ingest never lands, or that
 * writes to another scope than the old episodes were removed from, names no
 * replacement.
 *
 * `downloadFile`/`put`/`del` are passed in rather than imported here so the
 * caller's single dynamic `import()`, done once before the loop, is reused. `put`
 * and `del` are `lib/blob-storage.ts`'s `putPrivateBlob` and `deletePrivateBlob`;
 * `put` fixes access:'private' and a unique pathname, which are not this
 * function's to choose, so they are not parameters.
 */
export async function processDriveFile(
  source: { id: string; orgId: string; name: string; scopePath: string; connectAuthorizationId: string | null },
  file: DriveFile,
  token: string,
  deps: {
    downloadFile: (file: DriveFile, token: string) => Promise<Blob>;
    put: (pathname: string, body: Buffer) => Promise<{ url: string }>;
    del: (url: string) => Promise<void>;
  },
): Promise<ConnectorSyncOutcome> {
  const existing = await db.sourceFile.findUnique({
    where: { sourceId_externalFileId: { sourceId: source.id, externalFileId: file.id } },
  });
  if (existing && isWrittenAt(existing, source.scopePath)) {
    if (existing.checksum === file.checksum) return "skipped";
    // A row stored before the change key held the name holds the bare content
    // version. The same content is still current: re-ingesting it would only
    // supersede identical episodes, or, for a row from before `episodeIds`,
    // serve the file twice, since that row's content cannot be retired. Its key
    // moves to the current form, so a later rename is seen. A name that now names
    // an erased person is not skipped: it retires below, as any file's does.
    const namesErasedPerson =
      existing.checksum === file.contentVersion ? await loadErasedPersonMatcher(source.orgId) : null;
    if (namesErasedPerson && !namesErasedPerson(file.name)) {
      await db.sourceFile.update({
        where: { sourceId_externalFileId: { sourceId: source.id, externalFileId: file.id } },
        data: { checksum: file.checksum },
      });
      return "skipped";
    }
  }

  const actorId = connectorActorId({ id: source.id, type: "gdrive" });
  try {
    const retirePrevious = () =>
      existing
        ? retireDriveFileContent(source, { ...existing, externalFileId: file.id }, "supersede")
        : Promise.resolve([]);
    const where = { sourceId_externalFileId: { sourceId: source.id, externalFileId: file.id } };
    const namesErasedPerson = await loadErasedPersonMatcher(source.orgId);
    if (namesErasedPerson(file.name)) {
      // Not even downloaded. Recorded as seen, with nothing written, so the
      // same version is skipped next time and an edit or a rename is checked again.
      await retirePrevious();
      const nothing = { checksum: file.checksum, episodeIds: [], chunkIds: [], episodeScopePath: null };
      await db.sourceFile.upsert({
        where,
        create: { sourceId: source.id, externalFileId: file.id, ...nothing },
        update: { ...nothing, episodeId: null, syncedAt: new Date() },
      });
      return "skipped";
    }

    const extracted = await extractDriveFile(source, file, token, deps);
    const retired = await retirePrevious();
    // A passage naming an erased person is left out; the rest of the file is kept.
    const chunks = extracted.chunks.filter((chunk) => !namesErasedPerson(chunk));

    // Passages are stored under no fact name. They are not versions of a fact named
    // like the file, which the store marks on its own (`factVersion`,
    // services/memory/conflict.ts); without the name, no reader matching rows by name
    // alone takes them for one either. The name labels the graph episodes only.
    const passages: IngestInput[] = chunks.map((chunk) => ({
      groupId: source.orgId,
      content: chunk,
      source: "document",
      actorType: "extraction",
      origin: "connector-sync",
      actorId,
      actorName: source.name,
      scopePath: source.scopePath,
      // Lets DELETE /api/sources/:id purge exactly this source's content.
      sourceId: source.id,
    }));
    // Each passage's row id, chosen now: its graph episode is written first and carries it,
    // as every write stamps its episodes, so deleting the passage as a fact, or erasing a
    // person it names, retires what the graph extracted from it (`removeChunkFacts`).
    const chunkIds = passages.map(() => createId());
    const episodes = passages.map((passage, i) => ({
      ...passage,
      name: chunks.length === 1 ? file.name : `${file.name} (part ${i + 1}/${chunks.length})`,
      readableId: chunkIds[i],
    }));
    // The caller checked the source before the download and extraction, which
    // can take long enough for a disconnect or a reconnect to land. Ask again
    // right before each of the two writes. A stop after the graph write leaves
    // its episodes recorded below, so the run's own retirement after a
    // disconnect, or the next sync after a move, retires them.
    const stopBeforeGraph = await stopReason(source);
    if (stopBeforeGraph) return stopBeforeGraph;
    // Record what this attempt writes as it is written, so a failure partway
    // through leaves content a later sync can still retire. The checksum
    // stays pending until the last write lands: a pending row never matches a
    // listing, so the next sync retires this attempt's content and ingests
    // the file again, even if the file was reverted to a checksum seen before.
    const episodeIds = await graphitiStore.ingestBulk(episodes);
    await db.$transaction(async (tx) => {
      const recorded = {
        checksum: PENDING_DRIVE_CHECKSUM,
        episodeIds,
        chunkIds: [],
        episodeScopePath: source.scopePath,
      };
      await tx.sourceFile.upsert({
        where,
        create: { sourceId: source.id, externalFileId: file.id, ...recorded },
        update: { ...recorded, episodeId: null },
      });
      for (const episodeId of episodeIds) {
        await recordSourceItemChange(tx, {
          orgId: source.orgId,
          scopePath: source.scopePath,
          episodeId,
          op: "create",
          actorId,
          title: file.name,
          authorizedById: source.connectAuthorizationId,
        });
      }
      const [newVersion] = episodeIds;
      if (newVersion !== undefined) {
        await recordReplacements(
          tx,
          retired.map((old) => ({
            orgId: source.orgId,
            replacementId: newVersion,
            replacementScopePath: source.scopePath,
            replacedId: old.episodeId,
            replacedScopePath: old.scopePath,
            actor: { type: "extraction", id: actorId },
          })),
        );
      }
    });
    const stopBeforeChunks = await stopReason(source);
    if (stopBeforeChunks) return stopBeforeChunks;
    // allSettled, not all: a chunk still being written when another fails must
    // be recorded before this attempt reports failure, or it is never retired.
    const chunkWrites = await Promise.allSettled(
      passages.map(async (passage, i) => {
        const { episodeId: chunkId } = await pgvectorStore.ingest(passage, { id: chunkIds[i] });
        await db.sourceFile.update({ where, data: { chunkIds: { push: chunkId } } });
      }),
    );
    const failedWrite = chunkWrites.find((write) => write.status === "rejected");
    if (failedWrite) throw failedWrite.reason;
    await db.sourceFile.update({ where, data: { checksum: file.checksum, syncedAt: new Date() } });
    return "synced";
  } catch (e) {
    // A rejected sign-in fails every later file too: it ends the run,
    // which retires nothing and stores the fix (`sourceSync`'s catch).
    if (credentialFailed(e)) throw e;
    console.error(`[sourceSync] drive file ${file.id} failed for source ${source.id}:`, e);
    return "failed";
  }
}

/** True for `DriveRequestError.credentialFailed`, read by shape: tests replace the Drive connector whole. */
function credentialFailed(e: unknown): boolean {
  return e instanceof Error && (e as Error & { credentialFailed?: unknown }).credentialFailed === true;
}

/**
 * Download one Drive file, store it as a private blob for the memory service to
 * read, extract it, and delete the blob, whether the extraction succeeded or not.
 */
async function extractDriveFile(
  source: { id: string; orgId: string },
  file: DriveFile,
  token: string,
  deps: Parameters<typeof processDriveFile>[3],
): Promise<{ chunks: string[] }> {
  const blob = await deps.downloadFile(file, token);
  const { url } = await deps.put(
    `sources/${source.orgId}/${source.id}/${file.id}-${file.name}`,
    Buffer.from(await blob.arrayBuffer()),
  );
  try {
    return await graphitiStore.extractFile({ url, fileType: file.fileType, filename: file.name });
  } finally {
    await deps.del(url);
  }
}

/**
 * Retire one previously-synced Drive file that no longer appears in the
 * folder listing (deleted, moved out, or no longer shared), then drop its
 * record. `retireVanishedTextItem` for a file: a failed retirement keeps the
 * row, so the next sync still sees the file as vanished and retries it.
 */
export async function retireVanishedDriveFile(
  source: { id: string; orgId: string; scopePath: string; connectAuthorizationId: string | null },
  stale: DriveSyncFile,
): Promise<ConnectorSyncOutcome> {
  try {
    await retireDriveFileContent(source, stale, "delete");
    await db.sourceFile.delete({
      where: { sourceId_externalFileId: { sourceId: source.id, externalFileId: stale.externalFileId } },
    });
    return "retired";
  } catch (e) {
    console.error(
      `[sourceSync] retiring vanished drive file ${stale.externalFileId} failed for source ${source.id}:`,
      e,
    );
    return "failed";
  }
}
