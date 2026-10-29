// Uploaded files: the record of each one, its raw copy in Vercel Blob, and every way an
// upload is removed.
//
// The rule this file enforces: an upload's raw file is kept until the upload is removed,
// because it has no other home and an export of memory hands it back. Every removal, by
// the person who removes it or by a person erasure, goes the same way: the transaction
// that removes what the removal removes also marks the upload's row removed, then the
// blob is deleted, then the row. A blob delete that fails leaves its row marked, and the
// next removal in the org (or `scripts/blob-orphans.ts`) finishes it, so a marked row is
// never served and never read as kept.
//
// A Drive file has no row here. Drive holds the file, so its blob is deleted as soon as
// it is extracted (lib/inngest/connector-drive-files.ts).
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { deletePrivateBlob, readPrivateBlob } from "@/lib/blob-storage";
import {
  check,
  flattenSql,
  readableScopePaths,
  recordAppliedChange,
  removingFromGraph,
  withinReadableScopesSql,
  type AccessContext,
} from "@/services/access";
import { recordDocumentRemoved } from "./content-change-event";
import type { RemoveChunkFactsResult } from "@/types/memory";
import { dropEpisodePointers } from "./episode-pointers";
import { graphitiStore } from "./store";

/** An upload as a reader of its listing sees it. The blob URL is never in it. */
export interface UploadSummary {
  id: string;
  filename: string;
  fileType: string;
  scopePath: string;
  createdAt: Date;
}

/** What the upload route records before it queues the file's extraction. */
export interface NewUpload {
  orgId: string;
  scopePath: string;
  filename: string;
  fileType: string;
  blobUrl: string;
  actorId: string;
}

/** Record an upload whose raw file is stored at `blobUrl`. */
export async function recordUpload(upload: NewUpload): Promise<{ id: string }> {
  return db.uploadedFile.create({ data: upload, select: { id: true } });
}

/** Record the id the upload's document change event carries: its extraction job's event id. */
export async function recordUploadDocument(orgId: string, uploadId: string, documentId: string): Promise<void> {
  await db.uploadedFile.updateMany({ where: { orgId, id: uploadId }, data: { documentId } });
}

/**
 * Discard an upload whose extraction could not be queued: no job will ever read it and the
 * person was told it failed, so it was never kept. Nothing was extracted from it.
 */
export async function discardUnqueuedUpload(orgId: string, uploadId: string): Promise<void> {
  await db.uploadedFile.updateMany({ where: { orgId, id: uploadId }, data: { removedAt: new Date() } });
  await deleteRemovedUploads(orgId);
}

/**
 * Whether the upload is still kept: recorded in `orgId` and not marked removed. With
 * `lock`, inside a transaction, it takes a share lock on the row, so a removal that marks it
 * waits for that transaction and then sees what it wrote.
 */
export async function uploadIsKept(
  reader: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  uploadId: string,
  { lock = false }: { lock?: boolean } = {},
): Promise<boolean> {
  const kept = await reader.$queryRaw<unknown[]>`
    SELECT 1 FROM uploaded_files WHERE id = ${uploadId} AND "orgId" = ${orgId} AND "removedAt" IS NULL
    ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}
  `;
  return kept.length > 0;
}

/** A kept upload's filename and when it was made, for a job extracting its text; null once it is removed. */
export function keptUploadOrigin(
  orgId: string,
  uploadId: string,
): Promise<{ filename: string; createdAt: Date } | null> {
  return db.uploadedFile.findFirst({
    where: { orgId, id: uploadId, removedAt: null },
    select: { filename: true, createdAt: true },
  });
}

/** The kept uploads the caller may read, newest first. Empty for a caller with no read grant. */
export async function listReadableUploads(ctx: AccessContext): Promise<UploadSummary[]> {
  const readable = await readableScopePaths(ctx);
  if (readable.length === 0) return [];
  const visible = withinReadableScopesSql(Prisma.raw('"scopePath"'), ctx.orgId, readable);
  const query = Prisma.sql`
    SELECT id, filename, "fileType", "scopePath", "createdAt" FROM uploaded_files
    WHERE "orgId" = ${ctx.orgId} AND "removedAt" IS NULL AND ${visible}
    ORDER BY "createdAt" DESC, id
  `;
  return db.$queryRaw<UploadSummary[]>(...flattenSql(query));
}

/**
 * The raw file of one kept upload, if the caller may read its scope. Null when there is
 * no such upload in the caller's org, it was removed, the caller may not read it, or its
 * blob is gone: the caller is not told which, so a hidden upload looks like an absent one.
 * The read is decided and audited by `check()` at the upload's own stored scope.
 */
export async function readUploadFile(
  ctx: AccessContext,
  uploadId: string,
): Promise<{ filename: string; fileType: string; body: ReadableStream<Uint8Array> } | null> {
  const upload = await keptUpload(ctx.orgId, uploadId);
  if (!upload) return null;
  const decision = await check(ctx, { action: "memory.read", scope: upload.scopePath, target: `upload:${upload.id}` });
  if (!decision.allowed) return null;
  const body = await readPrivateBlob(upload.blobUrl);
  return body ? { filename: upload.filename, fileType: upload.fileType, body } : null;
}

/**
 * Remove one upload, if the caller may delete in its scope: what the graph extracted from
 * its passages, then its passages and its document's `delete` event in one transaction with
 * the mark, then its raw file, then its row. Returns false, removing nothing, when there is
 * no such kept upload in the caller's org or the caller may not remove it, which the caller
 * is not told apart.
 *
 * Each passage's graph episodes carry its row id (lib/inngest/file-ingest.ts,
 * ingestFileEpisodes) and are retired by it, as `HybridMemoryStore.removeFact` retires a
 * fact's: first, so a graph failure throws while the upload is still kept and a retry finds
 * it again; and again once the passages are gone, for episodes its job wrote meanwhile. A job
 * that writes after that finds its passages gone and retires its own. Episodes written before
 * passages were stamped are not found this way (services/memory/file-episode-stamps.ts
 * retires or stamps them).
 */
export async function removeUpload(
  ctx: AccessContext,
  uploadId: string,
): Promise<{ removed: boolean; passages: number }> {
  const upload = await keptUpload(ctx.orgId, uploadId);
  if (!upload) return { removed: false, passages: 0 };
  const decision = await check(ctx, {
    action: "memory.delete",
    scope: upload.scopePath,
    target: `upload:${upload.id}`,
  });
  if (!decision.allowed) return { removed: false, passages: 0 };

  const stored = await db.memoryChunk.findMany({
    where: { orgId: ctx.orgId, uploadId: upload.id },
    select: { id: true, scopePath: true },
  });
  await retirePassageEpisodes(ctx.orgId, stored);

  const deleted = await db.$transaction(async (tx) => {
    const marked = await tx.uploadedFile.updateMany({
      where: { orgId: ctx.orgId, id: upload.id, removedAt: null },
      data: { removedAt: new Date() },
    });
    // Removed by a concurrent request since it was read: that request owns the rest.
    if (marked.count === 0) return null;
    // The rows this delete removed, not the ones read before it: a passage stored in between
    // has its episodes retired below too.
    const removed = await tx.$queryRaw<{ id: string; scopePath: string | null }[]>`
      DELETE FROM memory_chunks WHERE "orgId" = ${ctx.orgId} AND "uploadId" = ${upload.id}
      RETURNING id, "scopePath"::text AS "scopePath"
    `;
    // The applied-delete row every other delete path writes, in the transaction that
    // removes the passages: it moves the org's removal epoch (scopeCacheStamp(),
    // services/access/check.ts), so a cached scan holding this file's text is not served
    // again, and it marks a brief over this scope as changed.
    await recordAppliedChange(
      {
        orgId: ctx.orgId,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        action: "memory.delete",
        scopePath: upload.scopePath,
        tag: `upload:${upload.id}`,
        runId: ctx.runId,
        origin: ctx.origin,
      },
      tx,
    );
    if (upload.documentId) {
      await recordDocumentRemoved(tx, {
        orgId: ctx.orgId,
        scopePath: upload.scopePath,
        documentId: upload.documentId,
        actorId: ctx.actor.id,
        actorType: ctx.actor.type,
        origin: ctx.origin,
        authorizedById: decision.auditLogId,
      });
    }
    return removed;
  });
  if (deleted === null) return { removed: false, passages: 0 };
  // The passages are gone, so the removal stands: a failure here is logged, not thrown.
  await retirePassageEpisodes(ctx.orgId, deleted).catch((e: unknown) =>
    console.error(
      `[uploads] upload ${upload.id} was removed, but retiring its graph episodes again failed; episodes its job wrote meanwhile may remain:`,
      e,
    ),
  );
  await deleteRemovedUploads(ctx.orgId);
  return { removed: true, passages: deleted.length };
}

/**
 * Retire the graph episodes of each passage, in the partition it was stored in: its scope,
 * or the bare org for an untagged one, which is where ingest wrote them. A connector record
 * that pointed at one of them (a Drive file's) drops the pointer, so the next sync of its
 * file does not fail on retiring an episode already gone.
 */
export async function retirePassageEpisodes(
  orgId: string,
  passages: { id: string; scopePath: string | null }[],
): Promise<void> {
  if (passages.length === 0) return;
  // Graph only: the removal epoch is moved around it (scopeCacheStamp()).
  await removingFromGraph(orgId, async () => {
    for (const { id, scopePath } of passages) {
      // A store that cannot say which episodes it retired (a test double, an older service) names none.
      const retired: RemoveChunkFactsResult | void = await graphitiStore.removeChunkFacts({
        groupId: scopePath ?? orgId,
        chunkId: id,
      });
      await dropEpisodePointers(orgId, retired?.episodeIds ?? []);
    }
  });
}

/**
 * Inside `tx`, mark removed every kept upload in the org whose filename names the person
 * (`filenameNamesPerson`, over the `filename` column) or a passage of which does
 * (`passageNamesPerson`, over a `memory_chunks` row). For a person erasure, in the
 * transaction before the one that removes those passages. A raw file cannot be redacted,
 * so the whole file goes; its passages that do not name the person stay. Returns how many
 * uploads it marked.
 */
export function markUploadsNamingPerson(
  tx: Prisma.TransactionClient,
  orgId: string,
  { filenameNamesPerson, passageNamesPerson }: { filenameNamesPerson: Prisma.Sql; passageNamesPerson: Prisma.Sql },
): Promise<number> {
  return tx.$executeRaw`
    UPDATE uploaded_files SET "removedAt" = ${sqlUtcNow}
    WHERE "orgId" = ${orgId} AND "removedAt" IS NULL
      AND (${filenameNamesPerson}
        OR id IN (
          SELECT "uploadId" FROM memory_chunks
          WHERE "orgId" = ${orgId} AND "uploadId" IS NOT NULL AND ${passageNamesPerson}
        ))
  `;
}

/**
 * Inside `tx`, mark one kept upload removed because a person erasure covers it: a file
 * uploaded before the erasure whose text is extracted after it (lib/inngest/file-ingest.ts,
 * storeFilePassages). Its raw file and row go with {@link deleteRemovedUploads}.
 */
export async function markUploadErased(tx: Prisma.TransactionClient, orgId: string, uploadId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE uploaded_files SET "removedAt" = ${sqlUtcNow}
    WHERE "orgId" = ${orgId} AND id = ${uploadId} AND "removedAt" IS NULL
  `;
}

/**
 * Delete the raw file, then the row, of every upload in the org marked removed. A blob
 * already gone deletes as a success, so this is safe to repeat. Returns how many it deleted.
 */
export async function deleteRemovedUploads(orgId: string): Promise<number> {
  const owed = await db.uploadedFile.findMany({
    where: { orgId, removedAt: { not: null } },
    select: { id: true, blobUrl: true },
  });
  for (const { id, blobUrl } of owed) {
    await deletePrivateBlob(blobUrl);
    await db.uploadedFile.deleteMany({ where: { orgId, id } });
  }
  return owed.length;
}

/** The blob URLs of every upload still kept, in every org: the blobs no sweep may delete. */
export async function keptUploadBlobUrls(): Promise<Set<string>> {
  const rows = await db.uploadedFile.findMany({ where: { removedAt: null }, select: { blobUrl: true } });
  return new Set(rows.map((row) => row.blobUrl));
}

/**
 * Of a file's passages, stored in `scopePath` (or the bare org), retire the graph episodes
 * of each one in `chunkIds` that is no longer stored. For the file-ingest job, after its graph
 * write: a removal that ran before the episodes landed found nothing of them to retire.
 */
export async function retireEpisodesOfDeletedFilePassages(
  orgId: string,
  scopePath: string | null,
  chunkIds: string[],
): Promise<void> {
  if (chunkIds.length === 0) return;
  const kept = new Set(
    (await db.memoryChunk.findMany({ where: { orgId, id: { in: chunkIds } }, select: { id: true } })).map((c) => c.id),
  );
  await retirePassageEpisodes(
    orgId,
    chunkIds.filter((id) => !kept.has(id)).map((id) => ({ id, scopePath })),
  );
}

function keptUpload(orgId: string, uploadId: string) {
  return db.uploadedFile.findFirst({ where: { orgId, id: uploadId, removedAt: null } });
}
