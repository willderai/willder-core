-- Passage embeddings for long memory rows (services/memory/passages.ts).
--
-- The embedding model reads only the first 512 tokens of a text, so a row longer than
-- that is also stored as overlapping passages, each embedded on its own. A passage holds
-- no text, only its position among its row's passages and its embedding, and it is
-- reachable only through its row: vector search can find a row by its best passage, and
-- serves the row.
-- Deleting a row (a fact delete, a person erasure, a source retirement) deletes its
-- passages through the foreign key below.
--
-- Additive: a new table and its indexes, nothing else. Rows stored before it have no
-- passages and are searched as before until scripts/backfill-passage-embeddings.ts gives
-- them some.
--
-- One transaction. Adding the foreign key waits for every write already open on
-- memory_chunks; a deploy stopped during that wait must leave nothing behind, so that
-- `prisma migrate resolve --rolled-back` and the next deploy can apply it cleanly.

BEGIN;

-- CreateTable
CREATE TABLE "memory_chunk_passages" (
    "chunkId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "embedding" vector(384) NOT NULL,

    CONSTRAINT "memory_chunk_passages_pkey" PRIMARY KEY ("chunkId","ordinal")
);

-- AddForeignKey
ALTER TABLE "memory_chunk_passages" ADD CONSTRAINT "memory_chunk_passages_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "memory_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Vector search finds the passages nearest a query through this index (cosine, the
-- `<=>` operator the store uses). HNSW, unlike the IVFFlat index on memory_chunks, needs
-- no training data, so building it on an empty table costs it no recall. pgvector 0.5.0
-- or later; iterative scans, which the store uses when present, need 0.8.0.
CREATE INDEX "memory_chunk_passages_embedding_idx" ON "memory_chunk_passages" USING hnsw ("embedding" vector_cosine_ops);

COMMIT;
