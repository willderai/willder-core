-- Record every episode and chunk a Drive file sync writes, so an edited or
-- vanished file's old content can be retired. A Drive file is extracted into
-- several chunks, each ingested as its own Graphiti episode and its own
-- memory_chunks row, so the single `episodeId` column the text connectors use
-- cannot hold it. Additive with constant defaults: existing rows read as empty
-- lists, and no backfill is possible (Drive rows never recorded their episodes;
-- DELETE /api/sources/:id's per-source purge still covers them).

ALTER TABLE "source_files" ADD COLUMN "episodeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "source_files" ADD COLUMN "chunkIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
