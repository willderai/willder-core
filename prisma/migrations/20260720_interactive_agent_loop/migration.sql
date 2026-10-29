-- Interactive agent loop substrate (docs/design_interactive_agent_loop.md).
-- ADDITIVE + backward-compatible: existing one-shot architecture/qa runs keep working.
-- A null "phase" marks a legacy one-shot run.

-- 1. Interactive-loop state on the existing agent_runs row (§7). All nullable/defaulted.
ALTER TABLE "agent_runs"
  ADD COLUMN "phase" TEXT,
  ADD COLUMN "plan" JSONB,
  ADD COLUMN "cursor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pendingInput" JSONB,
  ADD COLUMN "appliedEditIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "briefId" TEXT;

-- 2. Append-only replay log = the DB-backed resumable stream.
CREATE TABLE "agent_run_events" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_run_events_runId_seq_key" ON "agent_run_events"("runId", "seq");
CREATE INDEX "agent_run_events_runId_seq_idx" ON "agent_run_events"("runId", "seq");

ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Chart specs + architecture decision artifacts on the Brief (chart-gen §C.1, §0.1).
ALTER TABLE "briefs"
  ADD COLUMN "charts" JSONB,
  ADD COLUMN "decisions" JSONB;
