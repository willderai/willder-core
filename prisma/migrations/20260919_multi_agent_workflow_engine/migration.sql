-- Multi-agent workflow engine (item multi-agent-workflow-pilot-20260919). All new
-- tables; no columns added to a table already serving live traffic. See
-- prisma/schema.prisma's own comment block above these models for the guarantee
-- each column exists to satisfy.

CREATE TYPE "WorkflowRunStatus" AS ENUM (
    'queued',
    'drafting',
    'checking',
    'awaiting_approval',
    'delivered',
    'stopped',
    'failed',
    'over_budget'
);

CREATE TYPE "WorkflowRole" AS ENUM ('drafter', 'checker', 'approver');

CREATE TYPE "WorkflowStepVerdict" AS ENUM ('pass', 'changes_requested');

CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'queued',
    "round" INTEGER NOT NULL DEFAULT 0,
    "roundCap" INTEGER NOT NULL DEFAULT 3,
    "budgetCredits" INTEGER NOT NULL,
    "reservedCredits" INTEGER NOT NULL DEFAULT 0,
    "spentCredits" INTEGER NOT NULL DEFAULT 0,
    "stopRequestedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 600,
    "briefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_runs_idempotencyKey_key" ON "workflow_runs"("idempotencyKey");
CREATE INDEX "workflow_runs_orgId_status_idx" ON "workflow_runs"("orgId", "status");

CREATE TABLE "workflow_run_steps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "role" "WorkflowRole" NOT NULL,
    "round" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "verdict" "WorkflowStepVerdict",
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "output" JSONB,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "costCredits" INTEGER NOT NULL DEFAULT 0,
    "capabilityId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_run_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_run_steps_idempotencyKey_key" ON "workflow_run_steps"("idempotencyKey");
CREATE INDEX "workflow_run_steps_runId_round_idx" ON "workflow_run_steps"("runId", "round");

CREATE TABLE "workflow_approvals" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_approvals_runId_key" ON "workflow_approvals"("runId");

CREATE TABLE "org_workflow_controls" (
    "orgId" TEXT NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "stoppedBy" TEXT,

    CONSTRAINT "org_workflow_controls_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "org_workflow_controls" ADD CONSTRAINT "org_workflow_controls_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
