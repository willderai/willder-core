-- The task-start block leaves out a write whose fact version a later removal took out
-- of storage (services/memory/task-start.ts). A removal is now a delete or a supersede
-- with no `supersedes` edge (a correction, a connector edit), so the per-candidate
-- lookup asks for either op. The partial index on delete events alone could not serve
-- it; this one covers both and replaces it. Deletes and supersedes stay a small share
-- of events. An index only: no row changes.
--
-- Partial, so schema.prisma cannot declare it; like the gist indexes, it lives here.

-- DropIndex
DROP INDEX "change_events_orgId_recordId_delete_idx";

-- CreateIndex
CREATE INDEX "change_events_orgId_recordId_removal_idx" ON "change_events"("orgId", "recordId") WHERE "op" IN ('delete', 'supersede');
