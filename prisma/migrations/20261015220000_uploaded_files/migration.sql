-- Uploaded files keep their raw copy in Vercel Blob until they are removed
-- (services/memory/uploads.ts): one row per upload naming its blob, and each extracted
-- passage names the upload it came from, so removing the upload removes exactly them.
--
-- Additive: one new table and one nullable column; no existing row changes. Rows go with
-- their org; a passage outlives its upload's row with the column set to NULL.

-- AlterTable
ALTER TABLE "memory_chunks" ADD COLUMN     "uploadId" TEXT;

-- CreateTable
CREATE TABLE "uploaded_files" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "documentId" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_files_blobUrl_key" ON "uploaded_files"("blobUrl");

-- CreateIndex
CREATE INDEX "uploaded_files_orgId_scopePath_idx" ON "uploaded_files"("orgId", "scopePath");

-- CreateIndex
CREATE INDEX "memory_chunks_orgId_uploadId_idx" ON "memory_chunks"("orgId", "uploadId");

-- AddForeignKey
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "uploaded_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

