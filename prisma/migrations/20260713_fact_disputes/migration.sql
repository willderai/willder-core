-- UC9 fact governance ("pull requests for memory", docs/willder_conflict_resolution.md).
-- App-state (Postgres) above the Graphiti graph: tracks the governance state of a
-- disputed edge. Created only for the same-tier-contradiction case; the auto-merge
-- case (provenance outranks) invalidates-and-appends directly in Neo4j and never
-- lands a row here. See docs/willder_database.md (fact_disputes).

CREATE TYPE "ActorType" AS ENUM ('human', 'agent', 'extraction');

CREATE TYPE "FactDisputeStatus" AS ENUM (
    'disputed',
    'resolved_proposer',
    'resolved_existing',
    'resolved_reconciled',
    'rejected'
);

CREATE TABLE "fact_disputes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "graphitiFactUuid" TEXT NOT NULL,
    "proposerActorType" "ActorType" NOT NULL,
    "proposerActorId" TEXT NOT NULL,
    "existingActorType" "ActorType" NOT NULL,
    "existingActorId" TEXT NOT NULL,
    "status" "FactDisputeStatus" NOT NULL DEFAULT 'disputed',
    "resolvedValue" TEXT,
    "resolverId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_disputes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fact_disputes_orgId_idx" ON "fact_disputes"("orgId");
CREATE INDEX "fact_disputes_orgId_status_idx" ON "fact_disputes"("orgId", "status");

ALTER TABLE "fact_disputes" ADD CONSTRAINT "fact_disputes_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
