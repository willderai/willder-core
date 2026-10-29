-- The version a fact version was written to replace (memory_ingest's `baseVersion`), stored
-- with the row so a based write is judged stale only against versions of the same fact, not
-- every newer row under the same entity name (services/memory/fact-update.ts).
--
-- Additive: one nullable column with no default; no existing row, column or index changes.
-- No index of its own: the lookup is already bounded by (orgId, entityName, createdAt). Rows
-- stored before it read as naming no base, which is right for every row already announced:
-- its outcome is in fact_edges.

ALTER TABLE "memory_chunks" ADD COLUMN "baseVersionId" TEXT;
