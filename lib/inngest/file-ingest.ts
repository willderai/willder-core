// The file-ingest job: extract a PDF/DOCX/image blob into chunks and store
// them, and the store writes it shares with an upload extracted without Blob
// storage. The rules this file keeps: an upload's passages carry its upload id,
// and its raw blob is left where it is, kept until the upload is removed
// (services/memory/uploads.ts), as a person erasure that covers its text removes
// it, even one recorded after the upload and before its extraction; and a
// connector job writes only while its source is still connected at the scope
// the event carried, and retires what it wrote if that stopped being true mid-run.
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { graphitiStore, pgvectorStore } from "@/services/memory";
import { recordDocumentIngested, type IngestedDocument } from "@/services/memory/content-change-event";
import { retireLateSourceWrite } from "@/services/memory/source-retirement";
import { erasureCovers } from "@/services/memory/export-erasure";
import {
  holdOffListings,
  loadErasedContentFilter,
  type ErasedContentFilter,
} from "@/services/memory/erasure-suppression";
import {
  deleteRemovedUploads,
  keptUploadOrigin,
  markUploadErased,
  retireEpisodesOfDeletedFilePassages,
  uploadIsKept,
} from "@/services/memory/uploads";
import type { AuditOrigin } from "@/services/access/origin";
import { inngest } from "./client";
import { ingestSourceIsConnected } from "./source-state";

export const FILE_INGEST_EVENT = "memory/file.ingest.requested";

export interface FileIngestInput {
  groupId: string;
  blobUrl: string;
  filename: string;
  fileType: "pdf" | "docx" | "image";
  actorId: string;
  actorName?: string;
  /** Override actor type (default: "human" for manual upload). Drive sync uses "extraction". */
  actorType?: "human" | "agent" | "extraction";
  /** The entry point the upload came in through. */
  origin: AuditOrigin;
  /** ltree scope path to tag extracted episodes with. */
  scopePath?: string;
  /**
   * The connector Source.id, so a later DELETE /api/sources/:id can purge
   * exactly this source's own content. Never set for a direct user upload — an
   * upload must stay unmarked so a connector source's disconnect can never
   * reach it, even when they share a scopePath.
   *
   * Only Drive sync ever set it, and Drive sync now ingests in its own step
   * (`processDriveFile` below) instead of sending this event. It stays so an
   * event sent before that change and still queued keeps its scope check and
   * provenance marker; it can go once no such event can be in flight.
   */
  sourceId?: string;
  /**
   * The audit row of the `memory.write` allow decision that gated the upload
   * (`AccessDecision.auditLogId`), carried onto the file's document event so the visible
   * audit log names the change it authorized. Absent on an event queued before it was
   * carried; that document then records no authorization rather than a guessed one.
   */
  authorizedById?: string;
  /**
   * The upload's record (`UploadedFile.id`), stamped on every passage so removing the
   * upload removes exactly them. Absent on an event queued before uploads were recorded.
   */
  uploadId?: string;
}

/** Who stored a file's extracted text and where: everything its store writes need. */
export type ExtractedFile = Omit<FileIngestInput, "blobUrl" | "fileType">;

/** Thrown inside a passage write to roll it back: the upload it is for was removed. */
class UploadRemovedError extends Error {}

/** Thrown inside a passage write to roll it back: an erasure was listed after its passages were judged. */
class ErasureListedError extends Error {}

/** How many times a passage write is judged again after an erasure listed during it. */
const WRITE_ATTEMPTS = 3;

/** What became of a file's passages: how many were stored, and what became of its upload. */
export interface StoredPassages {
  /**
   * "stored": every passage. "upload-removed": none; the upload was removed first.
   * "upload-erased": an erasure covers the upload, so it was removed, raw file and all, and
   * only its passages that name no erased person were stored, as the erasure leaves them.
   */
  outcome: "stored" | "upload-removed" | "upload-erased";
  stored: number;
  /**
   * With "stored", each passage's `memory_chunks` id, in the order of the chunks given: the
   * stamp its graph episode carries (`ingestFileEpisodes`), so removing the passage, or its
   * upload, retires what the graph extracted from it.
   */
  chunkIds?: string[];
}

/**
 * Store each extracted passage as a pgvector row, so the file's text is searchable as
 * soon as this resolves, before the graph has extracted anything from it.
 *
 * An upload's passages are written in one transaction with a check, under a share lock
 * on its row, that it is still kept. A removal marks that row before it deletes the
 * upload's passages, so whichever commits second sees the other: passages that commit
 * first are deleted by the removal, and a write that comes second finds the mark.
 *
 * An upload's passages are judged against the org's person erasures as written when the
 * file was uploaded (services/memory/export-erasure.ts, passageWrittenAt), since they hold
 * its text. A file uploaded before an erasure and extracted after it had no passage for the
 * erasure to find it by, so it is found here: a passage that names an erased person is not
 * stored, and the upload is marked removed in the same transaction and its raw file deleted,
 * as the erasure would have done (services/memory/uploads.ts, markUploadsNamingPerson). The
 * judgment is made again inside that transaction, after it holds off any new listing
 * (holdOffListings), and the write starts over if an erasure was listed in between. A listing
 * it does not see is dated after the transaction, so the reads that check the suppression list
 * take these passages for old copies of the erased person, and the erasure's own passes,
 * which all come after its listing, find them. An upload with no text is judged by its
 * filename alone.
 *
 * Every passage is stored or none is (`PgvectorMemoryStore.ingestAll`), so a retry after
 * a failure, the job's own or a person uploading again, stores each passage once. With
 * `announceAs`, the file is announced as one document under that id in the same
 * transaction as its passages, unless an erasure covers its upload.
 *
 * Stored under no fact name. A passage is not a version of a fact named like the file,
 * and `ingestAll` already marks it as none (`factVersion`, services/memory/conflict.ts);
 * leaving the name off as well keeps any reader that matches rows by name alone from
 * taking it for one. The filename stays the graph episode's label (`ingestFileEpisodes`)
 * and the document event's title (`announceFile`).
 */
export async function storeFilePassages(
  file: ExtractedFile,
  chunks: string[],
  announceAs?: string,
): Promise<StoredPassages> {
  const { uploadId } = file;
  if (!uploadId) {
    const chunkIds = await writePassages(
      file,
      chunks,
      announceAs === undefined ? undefined : (tx) => recordDocumentIngested(documentOf(file), announceAs, tx),
    );
    return { outcome: "stored", stored: chunks.length, chunkIds };
  }
  for (let attempt = 1; ; attempt++) {
    // Read first too, so an upload whose row is already gone is not met by the foreign key.
    const upload = await keptUploadOrigin(file.groupId, uploadId);
    if (!upload) return { outcome: "upload-removed", stored: 0 };
    const judged = judgeUploadPassages(await loadErasedContentFilter(file.groupId), upload, chunks);
    let chunkIds: string[];
    try {
      chunkIds = await writePassages(file, judged.kept, async (tx) => {
        if (!(await uploadIsKept(tx, file.groupId, uploadId, { lock: true }))) throw new UploadRemovedError();
        await holdOffListings(tx, file.groupId);
        const now = judgeUploadPassages(await loadErasedContentFilter(file.groupId, tx), upload, chunks);
        if (now.kept.length !== judged.kept.length || now.erased !== judged.erased) throw new ErasureListedError();
        if (judged.erased) await markUploadErased(tx, file.groupId, uploadId);
        else if (announceAs !== undefined) await recordDocumentIngested(documentOf(file), announceAs, tx);
      });
    } catch (e) {
      if (e instanceof UploadRemovedError) return { outcome: "upload-removed", stored: 0 };
      if (e instanceof ErasureListedError && attempt < WRITE_ATTEMPTS) continue;
      throw e;
    }
    if (!judged.erased) return { outcome: "stored", stored: chunks.length, chunkIds };
    // The upload is erased without this delete: a marked upload is never served, and a raw
    // file left by a failure here is deleted by the next removal in the org or by
    // scripts/blob-orphans.ts. Thrown, it would fail the step, whose retry finds the upload
    // already removed and could not delete it either.
    await deleteRemovedUploads(file.groupId).catch((e: unknown) =>
      console.error(`[file-ingest] upload ${uploadId}: erased, its raw file is still to be deleted`, e),
    );
    return { outcome: "upload-erased", stored: judged.kept.length };
  }
}

/**
 * The passages of an upload no erasure covers, and whether one covers the upload: by a
 * passage, each judged as written when the file was uploaded, or by its filename.
 */
function judgeUploadPassages(
  erased: ErasedContentFilter,
  upload: { filename: string; createdAt: Date },
  chunks: string[],
): { kept: string[]; erased: boolean } {
  const kept = chunks.filter((chunk) => !erased(chunk, upload.createdAt));
  const byName = erasureCovers(erased, {
    type: "upload",
    filename: upload.filename,
    createdAt: upload.createdAt.toISOString(),
  });
  return { kept, erased: byName || kept.length < chunks.length };
}

/**
 * Store `chunks` as one file's passages, running `sameTransaction` in their transaction.
 * With no chunks, `sameTransaction` still runs, in a transaction of its own. Resolves to
 * each passage's row id, in the order of `chunks`.
 */
async function writePassages(
  file: ExtractedFile,
  chunks: string[],
  sameTransaction?: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<string[]> {
  if (chunks.length === 0) {
    if (sameTransaction) await db.$transaction(sameTransaction);
    return [];
  }
  return pgvectorStore.ingestAll(
    chunks.map((chunk) => ({
      groupId: file.groupId,
      content: chunk,
      source: "document",
      actorType: file.actorType ?? "human",
      origin: file.origin,
      actorId: file.actorId,
      actorName: file.actorName,
      scopePath: file.scopePath,
      sourceId: file.sourceId,
      uploadId: file.uploadId,
    })),
    sameTransaction,
  );
}

/**
 * Extract every passage into the graph in one bulk call, each episode labelled with the
 * filename and stamped with its passage's row id (`chunkIds`, from `storeFilePassages`), as
 * every other write stamps its episodes. The stamp is how a removal finds them: deleting a
 * passage (`HybridMemoryStore.removeFact`), its upload (`removeUpload`) or a person erasure
 * retires the episodes stamped with it (`removeChunkFacts`). Without it they kept answering
 * graph reads after the passage was gone. `chunkIds` is absent only for a job step memoized
 * before passages returned their ids; those episodes stay unstamped, as older ones are
 * (the W3c backfill retires or stamps them).
 */
async function ingestFileEpisodes(file: ExtractedFile, chunks: string[], chunkIds?: string[]): Promise<void> {
  const stamps = chunkIds?.length === chunks.length ? chunkIds : undefined;
  await graphitiStore.ingestBulk(
    chunks.map((chunk, i) => ({
      groupId: file.groupId,
      content: chunk,
      source: "document" as const,
      name: chunks.length === 1 ? file.filename : `${file.filename} (part ${i + 1}/${chunks.length})`,
      actorType: file.actorType ?? "human",
      origin: file.origin,
      actorId: file.actorId,
      actorName: file.actorName,
      scopePath: file.scopePath,
      sourceId: file.sourceId,
      readableId: stamps?.[i],
    })),
  );
}

/**
 * After a graph write, retire the episodes of every passage in `chunkIds` deleted meanwhile:
 * its removal ran before they landed, so it found nothing of them to retire.
 */
function retireEpisodesOfDeletedPassages(file: ExtractedFile, chunkIds: string[] | undefined): Promise<void> {
  return retireEpisodesOfDeletedFilePassages(file.groupId, file.scopePath ?? null, chunkIds ?? []);
}

/** The file as its change-feed event names it. */
function documentOf(file: ExtractedFile): IngestedDocument {
  return {
    orgId: file.groupId,
    scopePath: file.scopePath,
    actorId: file.actorId,
    actorType: file.actorType ?? "human",
    origin: file.origin,
    filename: file.filename,
    authorizedById: file.authorizedById,
  };
}

/** Whether the job may still write for this file: always, unless it is an upload since removed. */
async function uploadStillKept(file: ExtractedFile): Promise<boolean> {
  return !file.uploadId || uploadIsKept(db, file.groupId, file.uploadId);
}

/**
 * Announce the file on the change feed as one document named `documentId`. Resolves false,
 * announcing nothing, for an upload already removed. The announcement for an upload is
 * written in one transaction with a check, under a share lock on its row, that it is still
 * kept, as `storeFilePassages` does: a removal writes the document's `delete` event in the
 * transaction that marks the row, so a `create` either commits before that `delete` or
 * finds the mark and is not written.
 */
async function announceFile(file: ExtractedFile, documentId: string): Promise<boolean> {
  const { uploadId } = file;
  if (!uploadId) {
    await recordDocumentIngested(documentOf(file), documentId);
    return true;
  }
  return db.$transaction(async (tx) => {
    if (!(await uploadIsKept(tx, file.groupId, uploadId, { lock: true }))) return false;
    await recordDocumentIngested(documentOf(file), documentId, tx);
    return true;
  });
}

/**
 * The graph half of the job for a file whose passages `storeFilePassages` already
 * stored and announced, run inline instead of as queued steps: the graph episodes, then
 * node dedup. For a direct upload only; a connector file needs the job's source checks
 * between its writes.
 */
export async function extractFileGraph(file: ExtractedFile, chunks: string[], chunkIds?: string[]): Promise<void> {
  await ingestFileEpisodes(file, chunks, chunkIds);
  await retireEpisodesOfDeletedPassages(file, chunkIds);
  await graphitiStore.dedupeNodes(file.groupId);
}

/**
 * Whether a file-ingest job may write. A direct upload names no source and
 * always may. A connector job may only while its source is still connected at
 * the scope the event carried, and never without a scope.
 */
function fileJobSourceIsCurrent(input: FileIngestInput): Promise<boolean> {
  return ingestSourceIsConnected(input);
}

/**
 * Remove what a connector file-ingest job wrote after its source moved or was
 * disconnected under it: the source's content in the scope the job wrote to.
 * Either way that scope must hold nothing of this source any more, since the
 * reconnect or the disconnect already retired it there, so purging by source
 * and scope removes only what landed late. Only called for a job with a source
 * and a scope, which is the only kind that can stop being current.
 */
async function retireFileJobContent(input: FileIngestInput): Promise<void> {
  const { sourceId, scopePath } = input;
  if (!sourceId || !scopePath) return;
  await retireLateSourceWrite({ orgId: input.groupId, sourceId, scopePath });
}

export const fileIngest = inngest.createFunction(
  {
    id: "memory-file-ingest",
    name: "Memory: extract and ingest file",
    retries: 2,
    triggers: [{ event: FILE_INGEST_EVENT }],
  },
  async ({ event, step, runId }) => {
    const input = event.data as FileIngestInput;

    // 1. Extract text chunks from the blob URL (PDF → pages, DOCX → sections, image → vision description).
    //    extractFile is on the concrete GraphitiMemoryStore, not the MemoryStore
    //    interface; the cast restores the return type step.run() widens.
    const { chunks } = (await step.run("extract", () =>
      graphitiStore.extractFile({ url: input.blobUrl, fileType: input.fileType, filename: input.filename }),
    )) as { chunks: string[] };

    // An upload with no text still goes on to the store step, which judges it by its filename.
    if (chunks.length === 0 && !input.uploadId) return { ingested: 0, filename: input.filename };

    // Connector-sync content carries the source's scope in the event payload,
    // copied by Drive sync when it sent the event. Only a Drive event sets
    // `sourceId` (see `FileIngestInput.sourceId`), and the source can move or
    // be disconnected while this job runs: a reconnect that narrows
    // `Source.scopePath` retires the old scope's content, and a disconnect
    // retires all of it, after which a write from this job would put the file
    // straight back (items reconnect-inflight-sync-scope-fix-20260922,
    // consent-bar12-holes-20261001). So the stored row is re-checked inside each
    // write step, right before it writes, and once more after the last write,
    // when anything this job wrote is purged again. That last check closes the
    // window between a check and its write: a retirement that ran before one of
    // these writes landed is followed by a check that sees it.
    //
    // A connector event with no scope to verify against is refused rather than
    // written: an absent scope must never widen to the org root.
    const superseded = { ingested: 0, superseded: true, filename: input.filename };

    // 2. Write raw chunks to pgvector immediately — makes content searchable right
    //    away while Graphiti's entity extraction (step 3) runs in the background.
    const stored = await step.run("pgvector-store-chunks", async () => {
      if (!(await fileJobSourceIsCurrent(input))) return "superseded";
      return storeFilePassages(input, chunks);
    });
    // An upload removed while this job runs: its removal deleted the passages already stored,
    // so the job writes nothing more for it.
    const uploadRemoved = { ingested: 0, uploadRemoved: true, filename: input.filename };
    if (stored === "superseded") return superseded;
    if (stored.outcome === "upload-removed") return uploadRemoved;
    // An upload an erasure covers: it is removed, so the graph gets no episodes of it and the
    // change feed no document, as for any removed upload; the passages that name no erased
    // person stay searchable, as the erasure leaves them.
    if (stored.outcome === "upload-erased")
      return { ingested: stored.stored, uploadErased: true, filename: input.filename };
    if (chunks.length === 0) return { ingested: 0, filename: input.filename };

    // 3. Bulk-ingest all chunks in a single add_episode_bulk call — much faster than
    //    N serial /ingest calls because graphiti batches the LLM extraction internally.
    //    Each episode carries its passage's id, so a removal retires it (removeUpload). An
    //    upload removed since its passages were stored gets no episodes. The graph write
    //    cannot share a transaction with that check, so a removal that lands during the
    //    write itself retired nothing yet: the job checks again after writing and retires
    //    what it wrote, as the memory_ingest job does for a deleted chunk.
    const graphWrite = await step.run("ingest-chunks-bulk", async () => {
      if (!(await fileJobSourceIsCurrent(input))) return "superseded";
      if (!(await uploadStillKept(input))) return "upload-removed";
      await ingestFileEpisodes(input, chunks, stored.chunkIds);
      await retireEpisodesOfDeletedPassages(input, stored.chunkIds);
      if (!(await uploadStillKept(input))) return "upload-removed";
      return "stored";
    });
    if (graphWrite === "upload-removed") return uploadRemoved;

    const stillCurrent =
      graphWrite === "stored" && (await step.run("verify-source-after-write", () => fileJobSourceIsCurrent(input)));
    if (!stillCurrent) {
      await step.run("retire-superseded-write", () => retireFileJobContent(input));
      return superseded;
    }

    // 4. Announce the file on the change feed, now that both stores hold it.
    //    Its id is this job's event id: the jobId an upload returned. The run id
    //    stands in only for an event
    //    delivered without one, which a sent event never is.
    const announced = await step.run("record-document-change", () => announceFile(input, event.id ?? runId));
    if (!announced) return uploadRemoved;

    // 5. Dedup: merge nodes where one name is a substring of another in the same
    //    group (e.g. "Marcus" → "Marcus Chen"). Runs after graph extraction settles.
    const deduped = await step.run("dedup-nodes", () => graphitiStore.dedupeNodes(input.groupId));

    return { ingested: chunks.length, deduped, filename: input.filename };
  },
);
