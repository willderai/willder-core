-- Versions whose graph extraction failed after the write was acknowledged, kept until a later
-- attempt extracts them (services/memory/graph-extraction-retry.ts). On 2026-10-16 the extraction
-- model's provider refused every call for a day, and each failed extraction on the request
-- path was logged and dropped.
--
-- Additive: one new table, nothing existing changes. A row holds the ingest's settings, not its
-- text; deleting or erasing the version's memory_chunks row removes it (ON DELETE CASCADE).
-- Like every other content table, it refuses writes for an org whose deletion is open
-- (org_deletion_refuse_write, 20261016200000_org_deletions).

-- CreateTable
CREATE TABLE "graph_extraction_retries" (
    "chunkId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "job" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_extraction_retries_pkey" PRIMARY KEY ("chunkId")
);

-- CreateIndex
CREATE INDEX "graph_extraction_retries_nextAttemptAt_idx" ON "graph_extraction_retries"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "graph_extraction_retries_orgId_idx" ON "graph_extraction_retries"("orgId");

-- AddForeignKey
ALTER TABLE "graph_extraction_retries" ADD CONSTRAINT "graph_extraction_retries_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "memory_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An org being deleted gains no owed extraction, and a pass cannot move one of its rows.
CREATE TRIGGER "org_deletion_refuse_write" AFTER INSERT OR UPDATE ON "graph_extraction_retries"
  FOR EACH ROW EXECUTE FUNCTION "org_deletion_refuse_write"();
