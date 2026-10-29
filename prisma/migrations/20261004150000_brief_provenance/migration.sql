-- The connected sources a brief's generating run read from, so retiring a
-- source withdraws only the briefs that read it (services/memory/brief-retirement.ts).
-- A new, self-contained table: no change to any existing row. A brief created
-- before this table, or by a run that does not record its reads, has no row and
-- keeps the scope-and-time rule.

-- CreateTable
CREATE TABLE "brief_provenance" (
    "briefId" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_provenance_pkey" PRIMARY KEY ("briefId")
);

-- AddForeignKey
ALTER TABLE "brief_provenance" ADD CONSTRAINT "brief_provenance_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An admin's ruling that a withdrawn brief did not draw from the source that
-- withdrew it; that source no longer retires the brief.

-- CreateTable
CREATE TABLE "brief_retirement_waivers" (
    "briefId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_retirement_waivers_pkey" PRIMARY KEY ("briefId","sourceId")
);

-- AddForeignKey
ALTER TABLE "brief_retirement_waivers" ADD CONSTRAINT "brief_retirement_waivers_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
