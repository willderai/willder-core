-- A change event names the visible audit row that authorized it, so the audit
-- trail can expose a change identifier on a row a reader is actually shown.
--
-- The confirmed-applied rows (`memory.write.applied`, `memory.delete.applied`)
-- carry `visibility: "never"` in services/audit/audit-actions.ts, so no audit
-- reader returns them. This column is the link that lets `GET /api/audit` answer
-- "which change did this authorization produce" from the visible
-- `memory.write`/`memory.delete` allow row instead.
--
-- Additive and reversible: one nullable column and one index. No existing row
-- changes, and every event written before this column existed reads as "unknown".
ALTER TABLE "change_events" ADD COLUMN "authorizedById" TEXT;

CREATE INDEX "change_events_orgId_authorizedById_idx"
  ON "change_events"("orgId", "authorizedById");
