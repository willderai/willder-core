-- Records when a stored chunk's content happened, when its writer says so through
-- memory_ingest's `occurredAt`; no other writer fills it today. The value is never later
-- than the moment the row is written (services/memory/pgvector-store.ts). A read dates
-- the chunk by it and serves the newest first within a provenance tier
-- (services/memory/guarded-store.ts).
-- "createdAt" stays the moment the row was stored: erasure and the conflict window
-- judge a row by when it was written, never by the time its writer claims.
--
-- Additive: one nullable column, no row changes. Existing rows stay null and are dated
-- by "createdAt" exactly as before, so nothing is backfilled.

-- AlterTable
ALTER TABLE "memory_chunks" ADD COLUMN     "occurredAt" TIMESTAMP(3);
