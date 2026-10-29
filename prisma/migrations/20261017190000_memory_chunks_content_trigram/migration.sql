-- A trigram index on memory_chunks.content, for the text leg of vector search
-- (services/memory/pgvector-store.ts retrieve()): a read whose query quotes a stored row's
-- words finds that row through this index (a case-insensitive regular expression, `~*`,
-- which pg_trgm's GIN operator class serves) and serves it high
-- (services/memory/text-match-fusion.ts).
--
-- Additive: one extension and one index, nothing else. pg_trgm ships with Postgres's
-- contrib modules and is available on Neon.
--
-- One transaction. Building the index takes a lock that holds writes to memory_chunks for
-- as long as the build runs; a deploy stopped during it must leave nothing behind, so that
-- `prisma migrate resolve --rolled-back` and the next deploy can apply it cleanly.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "memory_chunks_content_trgm_idx" ON "memory_chunks" USING gin ("content" gin_trgm_ops);

COMMIT;
