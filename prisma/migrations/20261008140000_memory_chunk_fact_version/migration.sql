-- Marks which memory_chunks rows are versions of the fact their entityName names, at
-- the moment the row is stored: true from the memory_ingest path, false from every
-- other writer. The winner rule, the stale-read check and the based-write check read
-- only versions (services/memory/conflict.ts, fact-reads.ts, fact-update.ts).
--
-- Additive: one nullable column, no row changes. Existing rows stay null; a null row
-- counts as a version only when the change feed announced it as a fact, which the
-- readers decide at query time, so nothing is backfilled.

-- AlterTable
ALTER TABLE "memory_chunks" ADD COLUMN     "factVersion" BOOLEAN;
