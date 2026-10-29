-- A brief's staleness check asks whether a source it read replaced or removed an item
-- after the brief was generated (services/memory/brief-staleness.ts). An index only:
-- no row changes.

-- CreateIndex
CREATE INDEX "change_events_orgId_actorId_createdAt_idx" ON "change_events"("orgId", "actorId", "createdAt");
