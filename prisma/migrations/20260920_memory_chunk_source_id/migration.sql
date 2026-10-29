-- Item sources-delete-retention-provenance-marker-20260919: per-source
-- provenance marker on memory_chunks, nullable and additive only -- existing
-- rows get NULL (no known producing source), never backfilled here. See
-- No backfill is attempted.

ALTER TABLE "memory_chunks" ADD COLUMN "sourceId" TEXT;

CREATE INDEX "memory_chunks_orgId_sourceId_idx" ON "memory_chunks"("orgId", "sourceId");
