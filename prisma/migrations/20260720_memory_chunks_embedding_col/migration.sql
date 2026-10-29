-- Repair: the pgvector `embedding` column from 20260616_memory_chunks was recorded
-- as applied but never landed on prod (column-missing → 42703 on every semantic
-- read/write). Add it + the ivfflat index idempotently. Additive + safe to re-run.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "memory_chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(384);

CREATE INDEX IF NOT EXISTS "memory_chunks_embedding_idx"
    ON "memory_chunks" USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
