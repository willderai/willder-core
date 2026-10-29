-- Real run-correlation id on audit_log. Root cause:
-- runCopyAgent (and runResearchAgent) stamp every run of the
-- same agent under one shared, static actorId (e.g. COPY_AGENT_ID), so two
-- overlapping runs of that agent could never be told apart by actorId + time
-- window alone; every route-level mitigation only closed the specific door a
-- given probe demonstrated. Nullable: a human actor's row has no run, and
-- existing rows predate this column with no way to recover which run (if any)
-- they belonged to, so this is additive-only, no backfill. Written once at
-- check()/recordAudit()'s create() call alongside every other field on the row
-- (see services/access/check.ts) -- never an UPDATE of an already-written row,
-- so audit_log stays genuinely append-only.
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "runId" TEXT;

CREATE INDEX IF NOT EXISTS "audit_log_orgId_runId_idx" ON "audit_log"("orgId", "runId");
