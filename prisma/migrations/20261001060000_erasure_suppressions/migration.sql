-- What an erased person can still be recognized by, so a connector re-sync does
-- not write them back (services/memory/erasure-suppression.ts). A new,
-- self-contained table: no change to any existing row.

-- CreateTable
CREATE TABLE "erasure_suppressions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "wordCount" INTEGER,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erasure_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erasure_suppressions_orgId_kind_digest_key" ON "erasure_suppressions"("orgId", "kind", "digest");

-- AddForeignKey
ALTER TABLE "erasure_suppressions" ADD CONSTRAINT "erasure_suppressions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

