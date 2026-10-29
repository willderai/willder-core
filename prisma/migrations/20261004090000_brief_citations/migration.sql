-- The facts a brief quoted, so its staleness check can say which of them changed
-- (services/memory/brief-citations.ts).
--
-- Additive: one new table. The live "briefs" table and its queries are unchanged, and a
-- brief generated before this table existed simply has no citations.
CREATE TABLE "brief_citations" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "sectionIndex" INTEGER NOT NULL,
    "factId" TEXT NOT NULL,
    "factText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_citations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brief_citations_briefId_sectionIndex_factId_key" ON "brief_citations"("briefId", "sectionIndex", "factId");

CREATE INDEX "brief_citations_briefId_idx" ON "brief_citations"("briefId");

ALTER TABLE "brief_citations" ADD CONSTRAINT "brief_citations_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
