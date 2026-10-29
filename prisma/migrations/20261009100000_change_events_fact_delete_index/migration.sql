-- The task-start block leaves out a write whose fact version a later delete removed
-- (services/memory/task-start.ts). It asks, per served candidate, whether a delete
-- event exists for that record in the org. Without this index that lookup scans every
-- change event; deletes are a small share of events, so a partial index on them keeps
-- the lookup to an index probe. An index only: no row changes.
--
-- Partial, so schema.prisma cannot declare it; like the gist indexes, it lives here.

-- CreateIndex
CREATE INDEX "change_events_orgId_recordId_delete_idx" ON "change_events"("orgId", "recordId") WHERE "op" = 'delete';
