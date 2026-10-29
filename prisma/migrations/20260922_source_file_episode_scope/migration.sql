-- Item connector-reconnect-scope-strand-fix-20260922: record the Graphiti
-- group_id each connector episode was written under, so retiring it addresses
-- the partition it actually lives in rather than the source's current (mutable)
-- scopePath. Nullable and additive only -- existing rows get NULL and fall back
-- to the source's current scope, which is the pre-existing behavior, so no
-- backfill is attempted (there is no record of where those episodes were
-- written; DELETE /api/sources/:id's scope-set purge is what cleans them up).

-- No new index: the only query that reads this column is a distinct-by-source
-- lookup, already served by the existing source_files_sourceId_idx.

ALTER TABLE "source_files" ADD COLUMN "episodeScopePath" TEXT;
