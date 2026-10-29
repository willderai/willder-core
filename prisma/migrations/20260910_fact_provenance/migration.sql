-- Decision-context coherence, v1. App-state (Postgres) above the Graphiti
-- graph: links a confirmed fact to the PR/commit/file it was recorded from and tracks
-- a staleness flag when that source moves. Same shape as fact_disputes
-- (20260713_fact_disputes) — governance state referencing a Graphiti edge uuid, not a
-- new engine. See docs/willder_conflict_resolution.md.
--
-- Includes the (orgId, scopePath) btree index from the start (20260908's
-- scope_index_completeness_btree fixed the same gap on 5 other scopePath-bearing
-- tables after the fact; no reason to reintroduce it here).

CREATE TYPE "FactSourceType" AS ENUM ('pr', 'commit', 'file');

CREATE TYPE "FactProvenanceStatus" AS ENUM ('fresh', 'potentially_stale');

CREATE TABLE "fact_provenance" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "graphitiFactUuid" TEXT NOT NULL,
    "sourceType" "FactSourceType" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "recordedRevision" TEXT,
    "ownerId" TEXT NOT NULL,
    "status" "FactProvenanceStatus" NOT NULL DEFAULT 'fresh',
    "flaggedAt" TIMESTAMP(3),
    "flaggedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fact_provenance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fact_provenance_orgId_idx" ON "fact_provenance"("orgId");
CREATE INDEX "fact_provenance_orgId_scopePath_idx" ON "fact_provenance"("orgId", "scopePath");
CREATE INDEX "fact_provenance_orgId_graphitiFactUuid_idx" ON "fact_provenance"("orgId", "graphitiFactUuid");
CREATE INDEX "fact_provenance_orgId_sourceType_sourceRef_idx" ON "fact_provenance"("orgId", "sourceType", "sourceRef");
CREATE INDEX "fact_provenance_orgId_status_idx" ON "fact_provenance"("orgId", "status");

ALTER TABLE "fact_provenance" ADD CONSTRAINT "fact_provenance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
