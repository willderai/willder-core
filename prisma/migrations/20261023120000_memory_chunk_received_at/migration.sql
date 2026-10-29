-- When the server received the write that stored a fact version (services/memory/received-at.ts,
-- services/memory/conflict.ts).
--
-- Two writes of one fact conflict when they land within the contention window. A version was
-- dated by its storing transaction's start ("createdAt"), which comes after the embedding call,
-- so one write whose embedding took longer than the window was recorded as a later update of a
-- write sent at the same moment: no supersede, and the losing writer never told
-- in one measured run. "receivedAt" is taken on the database's clock at the request's
-- entry, and the window is judged by it.
--
-- Additive and backward compatible: one nullable column, no default, no backfill, no index.
-- Adding a nullable column without a default changes only the catalog (no table rewrite), so
-- the ACCESS EXCLUSIVE lock is held for an instant. Every existing row keeps NULL, which every
-- reader takes as "createdAt" (COALESCE), so no decision already made about a stored version
-- reads differently. Code deployed before this column ignores it; code deployed after it
-- writes it only on rows it marks a fact version.

-- AlterTable
ALTER TABLE "memory_chunks" ADD COLUMN "receivedAt" TIMESTAMP(3);
