-- An equality index on a direct write's exact text, for the serve-time source check's
-- direct-write leg (services/memory/graph-fact-sources.ts graphSourcesSql): an unstamped
-- graph fact is served only while a memory_chunks row of its org with exactly its text,
-- written by no connector, is still stored. That leg looked each text up through the
-- content trigram index, one GIN probe per text (about 3 ms each at 100k rows, and far
-- more on a corpus of near-identical sentences). A btree on md5 of the text turns each
-- lookup into one equality probe; the query keeps `content = $text` beside the md5 match,
-- so a hash collision can never stand in for the text.
--
-- md5 rather than the text itself: a btree entry is capped at about 2.7 kB, and a stored
-- chunk can be longer. Partial on "sourceId" IS NULL: only direct writes are looked up.
--
-- Additive: one index, nothing else. One transaction, as in
-- 20261017190000_memory_chunks_content_trigram: the build holds writes to memory_chunks
-- while it runs, and a deploy stopped during it leaves nothing behind.

BEGIN;

-- CreateIndex
CREATE INDEX "memory_chunks_direct_content_md5_idx" ON "memory_chunks" ("orgId", pg_catalog.md5("content")) WHERE "sourceId" IS NULL;

COMMIT;
