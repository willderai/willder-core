-- CreateTable
CREATE TABLE "fact_version_reads" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_version_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fact_version_reads_versionId_idx" ON "fact_version_reads"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "fact_version_reads_orgId_agentId_versionId_key" ON "fact_version_reads"("orgId", "agentId", "versionId");

-- AddForeignKey
ALTER TABLE "fact_version_reads" ADD CONSTRAINT "fact_version_reads_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_version_reads" ADD CONSTRAINT "fact_version_reads_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "memory_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

