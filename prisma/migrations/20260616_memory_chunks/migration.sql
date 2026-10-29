-- pgvector chunk store for long-form semantic memory.
-- Stores raw content + BGE-384 embeddings for docs, chat history, and any
-- content that benefits from semantic search without requiring graph traversal.
-- Access control is enforced at the application layer (GuardedMemoryStore / check()).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "memory_chunks" (
    "id"         TEXT NOT NULL,
    "orgId"      TEXT NOT NULL,
    "content"    TEXT NOT NULL,
    "source"     TEXT NOT NULL DEFAULT 'text',
    "actorType"  TEXT NOT NULL DEFAULT 'extraction',
    "actorName"  TEXT,
    "scopePath"  TEXT,
    "embedding"  vector(384),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_chunks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "memory_chunks"
    ADD CONSTRAINT "memory_chunks_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "memory_chunks_orgId_idx" ON "memory_chunks"("orgId");

-- IVFFlat index for fast ANN cosine search. lists=100 is good up to ~1M rows.
CREATE INDEX "memory_chunks_embedding_idx"
    ON "memory_chunks" USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
