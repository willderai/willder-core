-- The session each write was made in, so a claim is judged by the evidence its own session
-- recorded (services/memory/claim-status.ts) rather than by every capture of its task.
--
-- Additive: one nullable column, nothing existing changes. Events written before it stay null,
-- and a claim with no session is served as proposed, never as tested or verified.

-- AlterTable
ALTER TABLE "change_events" ADD COLUMN "sessionKey" TEXT;

-- Who recorded a rule, and in which session: its create event, looked up by the rule's id when
-- the task-start block decides whether the rule is settled. A fact's create event already has
-- the unique index that keeps it to one (20261007220000_fact_create_event_once).
CREATE INDEX "change_events_convention_create_idx" ON "change_events"("orgId", "recordId")
  WHERE "recordType" = 'convention' AND "op" = 'create';
