// The final export an org deletion makes for its owner: the whole org in the export
// format (docs/export-format.md), stored as a private blob the owner can download
// during the 7 days, and deleted with everything else at the end of them, or at once
// when the deletion is cancelled.
//
// The one rule: the export exists only while its deletion is pending. A copy stored
// after the deletion was cancelled or started is deleted by the call that stored it,
// and every blob under the org's export prefix goes with the org.
import { db } from "@/lib/db";
import { deletePrivateBlob, listPrivateBlobs, putPrivateBlob, readPrivateBlob } from "@/lib/blob-storage";
import type { OrgDeletion } from "@/lib/generated/prisma/client";
import { exportWholeOrg } from "@/services/memory/org-export";

/** Where an org's final exports are stored: one prefix per org, cleared with the org. */
export function exportPrefix(orgId: string): string {
  return `exports/${orgId}/`;
}

/** Where one deletion's export is stored, under its org's prefix. */
function deletionExportPrefix(deletion: Pick<OrgDeletion, "id" | "orgId">): string {
  return `${exportPrefix(deletion.orgId)}${deletion.id}/`;
}

/**
 * Make and store the final export of a pending deletion, once. A deletion that already
 * has its export, or is no longer pending, is left as it is. A failure is recorded on
 * the deletion and thrown, so the job that called this retries it.
 */
export async function produceFinalExport(deletionId: string, now: Date = new Date()): Promise<void> {
  const deletion = await db.orgDeletion.findUnique({ where: { id: deletionId } });
  if (!deletion || deletion.status !== "pending" || deletion.exportUrl !== null) return;

  let bytes = 0;
  let url: string;
  try {
    const lines = exportWholeOrg(deletion.orgId, deletion.id, deletion.trigger === "clerk" ? "webhook" : "app", now);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await lines.next();
        if (next.done) {
          controller.close();
          return;
        }
        const chunk = encoder.encode(next.value);
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      async cancel() {
        await lines.return(undefined);
      },
    });
    ({ url } = await putPrivateBlob(`${deletionExportPrefix(deletion)}final-export.jsonl`, body));
  } catch (error) {
    await db.orgDeletion.updateMany({
      where: { id: deletion.id, status: "pending", exportUrl: null },
      data: { exportError: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }

  const recorded = await db.orgDeletion.updateMany({
    where: { id: deletion.id, status: "pending", exportUrl: null },
    data: { exportUrl: url, exportBytes: bytes, exportedAt: now, exportError: null },
  });
  // Cancelled, started or exported by another run while this one was writing: this copy
  // is not the deletion's, so it does not stay.
  if (recorded.count === 0) await deletePrivateBlob(url);
}

/**
 * Delete every stored copy of a cancelled deletion's export, the recorded one and any a
 * run stored but died before recording, and forget it. Returns how many were deleted.
 */
export async function discardFinalExport(deletion: Pick<OrgDeletion, "id" | "orgId">): Promise<number> {
  const urls = new Set((await listPrivateBlobs(deletionExportPrefix(deletion))).map((blob) => blob.url));
  const recorded = await db.orgDeletion.findUnique({ where: { id: deletion.id }, select: { exportUrl: true } });
  if (recorded?.exportUrl) urls.add(recorded.exportUrl);
  for (const url of urls) await deletePrivateBlob(url);
  await db.orgDeletion.updateMany({
    where: { id: deletion.id, status: "cancelled" },
    data: { exportUrl: null, exportBytes: null },
  });
  return urls.size;
}

/**
 * The final export's body, for a download while its deletion is pending, or null when
 * there is none to give: not made yet, or the deletion was cancelled, started or done.
 */
export async function finalExportBody(deletion: OrgDeletion): Promise<ReadableStream<Uint8Array> | null> {
  if (deletion.status !== "pending" || deletion.exportUrl === null) return null;
  return readPrivateBlob(deletion.exportUrl);
}
