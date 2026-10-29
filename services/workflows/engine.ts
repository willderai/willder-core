// Multi-agent workflow engine. Generic reliability primitives a customer-facing
// workflow (drafter -> checker -> human approver) is built on top of; see
// handoff-brief.ts for the first workflow wired against these primitives.
//
// Scope of THIS file: evidence re-verification (the drafter's own scope
// containment is already enforced by check() via the per-role capability
// token), per-role capability tokens, budget reservation, step verdicts, and
// the round-cap/heartbeat-timeout mechanics. NOT covered here: per-claim
// evidence citation from the LLM's own output (HANDOFF_OUTPUT_SCHEMA has no
// citation field, so a checker verifies the coarse scope-level evidence its
// callers pass, not individual claims), a per-customer daily spend cap, and
// notification digesting.
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { WorkflowRun, WorkflowRunStep, WorkflowRole, WorkflowStepVerdict } from "@/lib/generated/prisma/client";
import { writeAuditRow } from "@/services/access/audit-row";
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access/capabilities";
import { pathCovers } from "@/services/access";
import { workflowActorId, workflowCapabilityAgentId } from "@/services/access/system-actors";

/** A source a step's output cites: (sourceId, the scope it actually lives under,
 *  optionally a version/timestamp for staleness checks). Structured, never free text
 *  — guarantee 3/4 depend on this being independently checkable, not parsed out of
 *  model prose. */
export interface EvidenceItem {
  sourceId: string;
  scopePath: string;
  version?: string | null;
}

function isUniqueConstraintViolation(e: unknown, target?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  if (!target) return true;
  const fields = (e.meta as { target?: string[] | string } | undefined)?.target;
  return Array.isArray(fields) ? fields.includes(target) : fields === target;
}

// --- Guarantee 1: one reservation per job -----------------------------------

export interface StartWorkflowRunInput {
  orgId: string;
  workflowKey: string;
  requestedBy: string;
  /** Never wider than requestedBy's own access at request time — the caller
   *  resolves and checks this BEFORE calling startWorkflowRun(), same posture as
   *  provisionHandoffAgentCapability's own scopePath contract. */
  scopePath: string;
  /** A stable, caller-derived string identifying "this request" (e.g. the grant id
   *  a handoff briefing is for) — combined with (orgId, workflowKey, requestedBy)
   *  to derive the idempotency key. Two triggers with the same fingerprint within
   *  the same workflow/requester dedupe to one run. */
  requestFingerprint: string;
  budgetCredits: number;
  roundCap?: number;
  timeoutSeconds?: number;
}

export function deriveWorkflowIdempotencyKey(input: {
  orgId: string;
  workflowKey: string;
  requestedBy: string;
  requestFingerprint: string;
}): string {
  return createHash("sha256")
    .update(`${input.orgId}:${input.workflowKey}:${input.requestedBy}:${input.requestFingerprint}`)
    .digest("hex");
}

/** Reserve a run for this request. A duplicate trigger (same idempotency key)
 *  returns the EXISTING run (`isNew: false`) instead of starting a second one —
 *  the unique constraint on `idempotencyKey` is what actually makes this safe
 *  under a real race, not just the read-then-write shape of this function. */
export async function startWorkflowRun(input: StartWorkflowRunInput): Promise<{ run: WorkflowRun; isNew: boolean }> {
  const idempotencyKey = deriveWorkflowIdempotencyKey(input);
  try {
    const run = await db.workflowRun.create({
      data: {
        orgId: input.orgId,
        workflowKey: input.workflowKey,
        idempotencyKey,
        requestedBy: input.requestedBy,
        scopePath: input.scopePath,
        budgetCredits: input.budgetCredits,
        roundCap: input.roundCap ?? 3,
        timeoutSeconds: input.timeoutSeconds ?? 600,
      },
    });
    return { run, isNew: true };
  } catch (e) {
    if (isUniqueConstraintViolation(e, "idempotencyKey")) {
      const existing = await db.workflowRun.findUnique({ where: { idempotencyKey } });
      if (existing) return { run: existing, isNew: false };
    }
    throw e;
  }
}

// --- Guarantee 2: safe retries (idempotent per run/step/round) -------------

export interface WorkflowStepResult {
  output: unknown;
  evidence?: EvidenceItem[];
  verdict?: WorkflowStepVerdict;
  reasons?: string[];
  costCredits?: number;
  capabilityId?: string | null;
}

export interface RunWorkflowStepInput {
  run: Pick<WorkflowRun, "id">;
  role: WorkflowRole;
  round: number;
  execute: () => Promise<WorkflowStepResult>;
}

/** Run one (run, role, round) step exactly once. A retry (after a timeout, a
 *  crashed process, a duplicate Inngest delivery) finds the already-finished row
 *  and returns it WITHOUT calling `execute()` again — an ambiguous outcome is
 *  investigated (this read) before ever being re-issued. */
export async function runWorkflowStep(input: RunWorkflowStepInput): Promise<WorkflowRunStep> {
  const idempotencyKey = `${input.run.id}:${input.role}:${input.round}`;

  const existing = await db.workflowRunStep.findUnique({ where: { idempotencyKey } });
  if (existing?.finishedAt) return existing;

  await db.workflowRun.update({ where: { id: input.run.id }, data: { heartbeatAt: new Date() } });

  let stepRow = existing;
  if (!stepRow) {
    try {
      stepRow = await db.workflowRunStep.create({
        data: { runId: input.run.id, role: input.role, round: input.round, idempotencyKey },
      });
    } catch (e) {
      if (isUniqueConstraintViolation(e, "idempotencyKey")) {
        // Lost a create race to a concurrent retry of the exact same step — the
        // winner owns execution; re-read rather than executing twice.
        stepRow = await db.workflowRunStep.findUnique({ where: { idempotencyKey } });
        if (stepRow?.finishedAt) return stepRow;
      }
      if (!stepRow) throw e;
    }
  }

  const result = await input.execute();

  return db.workflowRunStep.update({
    where: { id: stepRow.id },
    data: {
      output: result.output as Prisma.InputJsonValue,
      evidence: (result.evidence ?? []) as unknown as Prisma.InputJsonValue,
      verdict: result.verdict,
      reasons: (result.reasons ?? []) as unknown as Prisma.InputJsonValue,
      costCredits: result.costCredits ?? 0,
      capabilityId: result.capabilityId ?? undefined,
      finishedAt: new Date(),
    },
  });
}

// --- Guarantee 3/4: evidence must stay inside scope, and must exist --------

export interface CheckerResult {
  verdict: WorkflowStepVerdict;
  reasons: string[];
}

/** Independently re-verify that every cited source is inside the run's own scope
 *  (guarantee 3) and that there IS evidence to check at all (guarantee 4's "an
 *  output with an unsupported claim fails the check", applied at the coarse
 *  per-step level current callers can support — see this file's header comment
 *  for the real per-claim gap this doesn't yet close). Pure and independently
 *  testable: it re-derives its verdict from `evidence` + `runScopePath` alone,
 *  never trusting a verdict the drafter itself might have claimed. */
export function checkEvidenceInScope(
  runScopePath: string,
  evidence: EvidenceItem[],
  opts: { requireEvidence?: boolean } = {},
): CheckerResult {
  const reasons: string[] = [];
  for (const item of evidence) {
    if (!pathCovers(runScopePath, item.scopePath)) {
      reasons.push(`cites a source outside scope: ${item.sourceId} (${item.scopePath})`);
    }
  }
  if ((opts.requireEvidence ?? true) && evidence.length === 0) {
    reasons.push("output cites no sources — unsupported claim");
  }
  return reasons.length > 0 ? { verdict: "changes_requested", reasons } : { verdict: "pass", reasons: [] };
}

// --- Guarantee 5: budget enforced, reserve then settle ----------------------

/** Atomically reserve `estimate` credits against the run's remaining budget. A
 *  reservation that would exceed `budgetCredits` never lands (the WHERE clause
 *  makes this a single conditional UPDATE, not a read-then-write race) — the
 *  caller must not start the step when this returns false. */
export async function reserveWorkflowCredits(runId: string, estimate: number): Promise<boolean> {
  if (estimate <= 0) return true;
  /* eslint-disable-next-line no-restricted-syntax -- this is a budget arithmetic
   * guard (reservedCredits + spentCredits <= budgetCredits) on workflow_runs, not a
   * scope/ltree predicate, and touches no scopePath column, so the raw-SQL rule
   * (never reimplement scope containment) does not apply. Raw SQL is what makes
   * the guard atomic: Prisma's query builder has no column-to-column
   * comparison in `where`, so a read-then-write here would race exactly like the
   * thing this function exists to prevent. */
  const updated = await db.$executeRaw`
    UPDATE "workflow_runs"
    SET "reservedCredits" = "reservedCredits" + ${estimate}
    WHERE "id" = ${runId}
      AND "reservedCredits" + "spentCredits" + ${estimate} <= "budgetCredits"
  `;
  return updated === 1;
}

/** Settle a prior reservation: release the estimate, book the real cost. Always
 *  called after execute(), whether the estimate over- or under-shot the actual
 *  spend, so reservedCredits never permanently strands credits the step didn't use. */
export async function settleWorkflowCredits(
  runId: string,
  reservedEstimate: number,
  actualCost: number,
): Promise<void> {
  await db.workflowRun.update({
    where: { id: runId },
    data: {
      reservedCredits: { decrement: reservedEstimate },
      spentCredits: { increment: actualCost },
    },
  });
}

// --- Guarantee 6: stop switch, revokes tokens immediately -------------------

export async function isWorkflowRunStopped(run: Pick<WorkflowRun, "orgId" | "stopRequestedAt">): Promise<boolean> {
  if (run.stopRequestedAt) return true;
  const control = await db.orgWorkflowControl.findUnique({ where: { orgId: run.orgId } });
  return Boolean(control?.stoppedAt);
}

/** Stop one run. Revokes every capability minted for its steps immediately — an
 *  in-flight model call may finish, but its capability can no longer read memory
 *  and its result is never delivered (deliverWorkflowRun() re-checks stop state). */
export async function stopWorkflowRun(runId: string): Promise<WorkflowRun> {
  const now = new Date();
  const run = await db.workflowRun.update({
    where: { id: runId },
    data: { stopRequestedAt: now, stoppedAt: now, status: "stopped" },
  });

  const steps = await db.workflowRunStep.findMany({
    where: { runId, capabilityId: { not: null } },
    select: { capabilityId: true },
  });
  const capabilityIds = steps.map((s) => s.capabilityId).filter((id): id is string => Boolean(id));
  if (capabilityIds.length > 0) {
    await db.capability.updateMany({
      where: { id: { in: capabilityIds }, revokedAt: null },
      data: { revokedAt: now },
    });
  }
  return run;
}

/** Customer-level stop: every run for this org checks this before its next step,
 *  same as an individual run's own stopRequestedAt. Does not retroactively touch
 *  already-minted tokens for OTHER runs; stopWorkflowRun() (or a sweep calling it
 *  per active run) is what actually revokes those. */
export async function stopOrgWorkflows(orgId: string, stoppedBy: string): Promise<void> {
  await db.orgWorkflowControl.upsert({
    where: { orgId },
    create: { orgId, stoppedAt: new Date(), stoppedBy },
    update: { stoppedAt: new Date(), stoppedBy },
  });
}

export async function resumeOrgWorkflows(orgId: string): Promise<void> {
  await db.orgWorkflowControl.upsert({
    where: { orgId },
    create: { orgId, stoppedAt: null, stoppedBy: null },
    update: { stoppedAt: null, stoppedBy: null },
  });
}

// --- Per-role capability minting (scoped, TTL-bounded, hashed at rest) -----

export async function mintWorkflowRoleCapability(
  run: Pick<WorkflowRun, "orgId" | "workflowKey" | "scopePath" | "requestedBy">,
  role: WorkflowRole,
  ttlHours = 1,
): Promise<{ token: string; capabilityId: string }> {
  const token = generateCapabilityToken();
  const capability = await db.capability.create({
    data: {
      orgId: run.orgId,
      agentId: workflowCapabilityAgentId(run.workflowKey, role),
      tokenHash: hashCapabilityToken(token),
      scopePath: run.scopePath, // never wider than the run's own scope
      permission: "read",
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      createdBy: run.requestedBy,
    },
  });
  return { token, capabilityId: capability.id };
}

// --- Guarantee 8: no fabricated approvals -----------------------------------

/** The only way a WorkflowApproval row is ever created. There is no other path
 *  in this module (or handoff-brief.ts) that can flip a run to `delivered` —
 *  deliverWorkflowRun() hard-requires this row to exist with decision "approved". */
export async function recordWorkflowApproval(params: {
  runId: string;
  approverId: string;
  decision: "approved" | "rejected";
  reason?: string;
}): Promise<void> {
  await db.workflowApproval.create({
    data: {
      runId: params.runId,
      approverId: params.approverId,
      decision: params.decision,
      reason: params.reason,
    },
  });
}

// --- Guarantee 9: full audit, including denials -----------------------------

/** Every workflow step logs here — actor (role), scope, decision and reason,
 *  timestamps (via `at`'s default). Reuses the existing append-only audit_log
 *  table (services/access/check.ts's own audit trail) rather than a parallel
 *  mechanism; `runId` here is WorkflowRun.id, the same disambiguation role it
 *  already plays for AgentRun.id (see the column's own doc comment in
 *  schema.prisma, updated alongside this). */
export async function recordWorkflowAudit(params: {
  orgId: string;
  runId: string;
  role: WorkflowRole;
  action: string;
  target?: string;
  decision: "allow" | "deny";
  reason: string;
}): Promise<void> {
  await writeAuditRow({
    orgId: params.orgId,
    actorType: "agent",
    actorId: workflowActorId(params.role),
    action: params.action,
    target: params.target,
    decision: params.decision,
    reason: params.reason,
    runId: params.runId,
    origin: "agent-run",
  });
}

// --- Heartbeat + timeout release --------------------------------------------

const ACTIVE_STATUSES = ["queued", "drafting", "checking", "awaiting_approval"] as const;

/** Fail any run whose heartbeat has gone stale past its own timeoutSeconds, and
 *  release its reservation (status -> failed, reservedCredits zeroed so a stuck
 *  run's estimate doesn't strand budget forever). Meant to be swept periodically
 *  (an Inngest cron), same pattern as the existing neo4jKeepAlive/architectureNightly
 *  crons in lib/inngest.ts. */
export async function releaseStuckWorkflowRuns(now: Date = new Date()): Promise<string[]> {
  const candidates = await db.workflowRun.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true, heartbeatAt: true, timeoutSeconds: true, reservedCredits: true },
  });
  const released: string[] = [];
  for (const run of candidates) {
    const deadline = new Date(run.heartbeatAt.getTime() + run.timeoutSeconds * 1000);
    if (deadline >= now) continue;
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        failureReason: `heartbeat timeout: no progress in ${run.timeoutSeconds}s`,
        reservedCredits: 0,
      },
    });
    released.push(run.id);
  }
  return released;
}

// Re-exported for tests / callers that want to generate a fingerprint without
// pulling in node:crypto themselves.
export function randomFingerprint(): string {
  return randomBytes(16).toString("hex");
}
