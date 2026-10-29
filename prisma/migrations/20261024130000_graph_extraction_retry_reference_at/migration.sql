-- The time a deferred graph extraction is dated at (scope v2 C7): the write's own occurredAt,
-- else the version's receivedAt. Graphiti's reference time decides which of two contradicting
-- facts is current, so a late retry must not date an older write as new.
--
-- Additive and backward compatible: one nullable column, no default, no backfill, no index
-- (catalog-only change). Existing rows keep NULL, which the retry pass reads as today's
-- behaviour: the version's createdAt. Code deployed before this column ignores it.

-- AlterTable
ALTER TABLE "graph_extraction_retries" ADD COLUMN "referenceAt" TIMESTAMP(3);
