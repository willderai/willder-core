-- One pgvector row per fact within a scope for the write-through ingest path
-- (services/memory/ingest-content-key.ts).
-- Additive: a nullable column and a unique index that ignores nulls, so every
-- existing row and every other writer is untouched.

-- AlterTable
ALTER TABLE "memory_chunks" ADD COLUMN "contentKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "memory_chunks_orgId_contentKey_key" ON "memory_chunks"("orgId", "contentKey");
