-- Generalized agent output document (v2 — UC6 Handoff, UC7 Architecture plans,
-- UC8's descoped QA fallback). One table, disambiguated by "type".
CREATE TYPE "BriefType" AS ENUM ('handoff', 'architecture_plan', 'qa_review');

CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "BriefType" NOT NULL,
    "granteeName" TEXT,
    "granteeRole" TEXT,
    "scopePath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "diagram" TEXT,
    "diagramUrl" TEXT,
    "googleDocUrl" TEXT,
    "milestones" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "briefs_orgId_idx" ON "briefs"("orgId");
CREATE INDEX "briefs_orgId_type_idx" ON "briefs"("orgId", "type");

ALTER TABLE "briefs" ADD CONSTRAINT "briefs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
