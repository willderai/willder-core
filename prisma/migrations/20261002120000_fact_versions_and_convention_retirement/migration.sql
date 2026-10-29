-- Conflicting writes record a winner and keep both versions readable
-- (services/memory/conflict.ts, services/memory/versions.ts).
--
-- Additive and reversible: four nullable columns and two indexes. No existing row
-- changes, and every column reads as "unknown" on rows written before it existed.

-- memory_chunks: who wrote a version, and the contention key two versions of one
-- fact share.
ALTER TABLE "memory_chunks" ADD COLUMN "actorId" TEXT;
ALTER TABLE "memory_chunks" ADD COLUMN "entityName" TEXT;

CREATE INDEX "memory_chunks_orgId_entityName_createdAt_idx"
  ON "memory_chunks"("orgId", "entityName", "createdAt");

-- conventions: the version that won the race this one lost, and retirement.
ALTER TABLE "conventions" ADD COLUMN "supersededById" TEXT;
ALTER TABLE "conventions" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "conventions" ADD COLUMN "retiredBy" TEXT;

CREATE INDEX "conventions_orgId_scopePath_retiredAt_idx"
  ON "conventions"("orgId", "scopePath", "retiredAt");
