-- A person erasure request whose job never finished stayed "running" forever, keeping the
-- person's identifier. A scheduled sweep now queues such a request's job once more and records
-- when here, then fails the request if it is still running long after
-- (services/memory/person-erasure-requests.ts, sweepStuckPersonErasures).
--
-- Additive: one nullable column; no existing row changes.

-- AlterTable
ALTER TABLE "person_erasure_requests" ADD COLUMN "retriedAt" TIMESTAMP(3);
