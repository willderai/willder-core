-- A stored fact version is announced once: at most one `create` event per
-- (org, fact version). services/memory/fact-change-event.ts inserts the event with
-- ON CONFLICT DO NOTHING against this index, so a replayed or concurrent
-- announcement writes nothing, and the lookup it replaces no longer scans the org's
-- whole feed while holding the org's change-feed lock.
--
-- Additive: one new index, no column or row changes. Partial, and limited to facts:
-- other ops on a fact (`delete`, `supersede`) and other record types (a source
-- connect and reconnect racing to `create`) may repeat. Prisma's schema cannot declare
-- a partial index, and `migrate diff` does not report one, so it lives here only.
--
-- Fails, and changes nothing, if the table already holds two `create` events for one
-- fact version. Find them before deploying with:
--   SELECT "orgId", "recordId", COUNT(*) FROM "change_events"
--   WHERE "recordType" = 'fact' AND "op" = 'create'
--   GROUP BY 1, 2 HAVING COUNT(*) > 1;

-- CreateIndex
CREATE UNIQUE INDEX "change_events_fact_create_once_key" ON "change_events"("orgId", "recordId")
WHERE "recordType" = 'fact' AND "op" = 'create';
