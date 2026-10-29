-- The dependency graph between facts (services/memory/edges.ts): one row per directed
-- edge, recorded once. A new, self-contained table: no change to any existing row.

-- CreateEnum
CREATE TYPE "FactEdgeKind" AS ENUM ('derivedFrom', 'supersedes', 'dependsOn', 'ownedBy', 'deliveredTo', 'causedBy');

-- CreateTable
CREATE TABLE "fact_edges" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" "FactEdgeKind" NOT NULL,
    "scopePath" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fact_edges_orgId_toId_kind_idx" ON "fact_edges"("orgId", "toId", "kind");

-- CreateIndex
CREATE INDEX "fact_edges_orgId_scopePath_kind_idx" ON "fact_edges"("orgId", "scopePath", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "fact_edges_orgId_fromId_toId_kind_key" ON "fact_edges"("orgId", "fromId", "toId", "kind");

-- AddForeignKey
ALTER TABLE "fact_edges" ADD CONSTRAINT "fact_edges_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
