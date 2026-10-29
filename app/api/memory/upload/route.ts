import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { inngest, FILE_INGEST_EVENT, extractFileGraph, storeFilePassages } from "@/lib/inngest";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { isRateLimited, per } from "@/lib/rate-limit";
import { graphitiStore } from "@/services/memory";
import { discardUnqueuedUpload, recordUpload, recordUploadDocument } from "@/services/memory/uploads";
import type { ExtractedFile, FileIngestInput } from "@/lib/inngest";

// POST /api/memory/upload — upload a binary file (PDF/DOCX/image) to Vercel Blob,
// then fire an Inngest job that extracts text chunks and ingests them into memory.
//
// Accepts multipart/form-data with a single "file" field.
// Max size: ~20 MB (enforced client-side; Vercel Blob itself supports up to 500 MB
// but the Next.js route body sits between; for larger files use client-side upload).
//
// Uses Blob when BLOB_READ_WRITE_TOKEN is set (Vercel dashboard → Storage → Blob →
// your store → Settings → Read/write token); without it the file is extracted inline.

const FILE_TYPE_MAP: Record<string, FileIngestInput["fileType"]> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
};

function fileTypeFromName(filename: string): FileIngestInput["fileType"] | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPE_MAP[ext] ?? null;
}

// Same ceiling as the client's own MAX_BINARY_MB (components/memory/upload-button.tsx)
// and app/api/agents/attachments/extract's MAX_BYTES.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * What a person is told when an inline upload fails. The cause (an extraction or store
 * error, which can name internal hosts) is logged on the server, never returned.
 */
const INLINE_UPLOAD_FAILED =
  "The file could not be read or stored, and nothing from it was saved. Upload the file again; if it fails again, ask your administrator to check that the memory service is running.";

/** POST /api/memory/upload: accept one file for extraction and ingest into a scope the caller can write. */
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (isRateLimited(`memory:upload:${rc.org.id}`, 20, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  // check() (below) cannot gate this: the scope it evaluates lives inside the multipart
  // body, so no pre-parse authorization check is possible. This cap bounds the cost of
  // parsing instead: an authenticated member with no write grant is still denied after
  // formData(), but never after more than MAX_UPLOAD_BYTES of multipart parsing. A
  // missing, non-numeric, or negative Content-Length is refused outright rather than
  // falling through to formData() (Number(null) is 0, which passes Number.isFinite and
  // would slip an absent header past this gate). Content-Length is client-reported, not
  // a guarantee of the true body size: an understated-but-numeric value passes this
  // gate and formData() then parses the full body anyway.
  const contentLengthHeader = req.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `content-length header missing or invalid, or request exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
      },
      { status: 413 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }

  const fileType = fileTypeFromName(file.name);
  if (!fileType) {
    return NextResponse.json({ error: `unsupported file type: .${file.name.split(".").pop()}` }, { status: 400 });
  }

  // Resolve + enforce scope the same way the text-upload path (POST /api/memory/ingest)
  // does, via the shared write-direction helper: an absent scope falls back to the org
  // root, same as ingest/route.ts's `scope ?? orgRootPath(...)`, but an explicit,
  // malformed scope is refused rather than silently widened. scopePath must reach both
  // ingest legs as a real path: pgvector-store.ts/graphiti-store.ts each treat undefined
  // as the MOST permissive value (org-wide), not as the org-root default.
  const rawScope = formData.get("scope");
  let scopePath: string;
  try {
    scopePath = await resolveCallerScopePath(
      rc.ctx,
      typeof rawScope === "string" ? rawScope : undefined,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.write", field: "scope" },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }

  const decision = await check(rc.ctx, { action: "memory.write", scope: scopePath, target: "file-upload" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const actorName = rc.user.name ?? rc.user.email.split("@")[0];

  // Without Blob storage (a self-hosted install with no BLOB_READ_WRITE_TOKEN), extract
  // the bytes inline through the memory service and run the file-ingest job's own store
  // writes. Before this responds, the passages are stored and the file is announced as
  // one document under the returned jobId, in one transaction, or neither happens and an
  // upload again starts clean. The graph episodes follow after the response; their
  // failure leaves the passages searchable and is logged under the same id.
  // extractBytes lives on GraphitiMemoryStore (graphiti-store.ts), never on `memory`
  // (the HybridMemoryStore facade): call it on `graphitiStore`, the same raw singleton
  // lib/inngest/file-ingest.ts's fileIngest job uses for extractFile.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const documentId = randomUUID();
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const contentB64 = buffer.toString("base64");
      const { chunks } = await graphitiStore.extractBytes({ contentB64, fileType, filename: file.name });
      if (chunks.length > 0) {
        const extracted = {
          groupId: rc.org.id,
          filename: file.name,
          actorId: rc.user.id,
          actorName,
          scopePath,
          origin: rc.ctx.origin,
          authorizedById: decision.auditLogId,
        } satisfies ExtractedFile;
        const { chunkIds } = await storeFilePassages(extracted, chunks, documentId);
        after(() =>
          extractFileGraph(extracted, chunks, chunkIds).catch((e: unknown) =>
            console.error(
              `Upload ${documentId} (${file.name}): graph extraction failed; its passages stay searchable`,
              e,
            ),
          ),
        );
      }
      return NextResponse.json({ jobId: documentId, chunks: chunks.length }, { status: 202 });
    } catch (e) {
      console.error(`Upload ${documentId} (${file.name}): nothing stored`, e);
      return NextResponse.json({ error: INLINE_UPLOAD_FAILED }, { status: 502 });
    }
  }

  // Production path: upload to Vercel Blob, record the upload, then let the Inngest job
  // handle extraction. putPrivateBlob, not the SDK directly: the wrapper fixes
  // access:'private' and a random pathname suffix for every caller, so the raw document is
  // never a public URL and a second upload of the same filename is a new blob; see
  // lib/blob-storage.ts. The raw file is kept until the upload is removed, because export
  // needs it: services/memory/uploads.ts.
  const { putPrivateBlob, deletePrivateBlob } = await import("@/lib/blob-storage");
  let blobUrl: string;
  try {
    const blob = await putPrivateBlob(`memory/${rc.org.id}/${file.name}`, file);
    blobUrl = blob.url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "blob upload failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  let uploadId: string;
  try {
    ({ id: uploadId } = await recordUpload({
      orgId: rc.org.id,
      scopePath,
      filename: file.name,
      fileType,
      blobUrl,
      actorId: rc.user.id,
    }));
  } catch (e) {
    // Unrecorded, the blob could never be found to remove, so it goes now.
    await deletePrivateBlob(blobUrl);
    throw e;
  }

  let ids: string[];
  try {
    ({ ids } = await inngest.send({
      name: FILE_INGEST_EVENT,
      data: {
        groupId: rc.org.id,
        blobUrl,
        filename: file.name,
        fileType,
        actorId: rc.user.id,
        actorName,
        scopePath,
        origin: rc.ctx.origin,
        authorizedById: decision.auditLogId,
        uploadId,
      } satisfies FileIngestInput,
    }));
  } catch (e) {
    // No job will ever extract it and the person is told the upload failed, so it was
    // never kept.
    await discardUnqueuedUpload(rc.org.id, uploadId);
    throw e;
  }
  await recordUploadDocument(rc.org.id, uploadId, ids[0]!);

  return NextResponse.json({ jobId: ids[0], uploadId }, { status: 202 });
}
