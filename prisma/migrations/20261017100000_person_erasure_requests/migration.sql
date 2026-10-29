-- POST /api/access/erasure answers at once and erases in a background job: on a large org the
-- erasure scans every chunk and change event several times, which took longer than the
-- caller's connection stayed open. This table is the request's state, read by
-- GET /api/access/erasure/:requestId (services/memory/person-erasure-requests.ts).
--
-- Additive: one enum and one new table; no existing row or column changes. Like
-- erasure_suppressions it stays writable while an org deletion is open: an erasure only
-- removes.
--
-- The person the request names is kept only while it runs: the job clears
-- "identifierKind"/"identifierValue" in the transaction that writes the erasure's
-- `person.erased` audit row, and when the request fails.

-- CreateEnum
CREATE TYPE "PersonErasureStatus" AS ENUM ('running', 'done', 'failed');

-- CreateTable
CREATE TABLE "person_erasure_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requesterRole" "UserRole" NOT NULL,
    "origin" TEXT NOT NULL,
    "identifierKind" TEXT,
    "identifierValue" TEXT,
    "status" "PersonErasureStatus" NOT NULL DEFAULT 'running',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "person_erasure_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "person_erasure_requests_orgId_idx" ON "person_erasure_requests"("orgId");

-- AddForeignKey
ALTER TABLE "person_erasure_requests" ADD CONSTRAINT "person_erasure_requests_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
