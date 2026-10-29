-- Briefs withdrawn because a source they could have drawn from was moved out of
-- their scope or disconnected (services/memory/brief-retirement.ts). A new,
-- self-contained table: no change to any existing row.

-- CreateTable
CREATE TABLE "brief_retirements" (
    "briefId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_retirements_pkey" PRIMARY KEY ("briefId")
);

-- AddForeignKey
ALTER TABLE "brief_retirements" ADD CONSTRAINT "brief_retirements_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
