// The first workflow the multi-agent engine runs (item
// multi-agent-workflow-pilot-20260919's spec, "First workflow: handoff brief"):
// drafter -> checker -> human approver -> deliver, on top of the existing Handoff
// agent (lib/handoff-agent.ts, services/agents/runner.ts's runHandoffAgent) rather
// than replacing it. The route (app/api/agents/:id/handoff) keeps working exactly as
// it does today; this is an additive, opt-in path a caller chooses explicitly.
import { db } from "@/lib/db";
import { createBrief } from "@/services/memory/create-brief";
import type { WorkflowRun } from "@/lib/generated/prisma/client";
import { creditsFor } from "@/services/billing/plans";
import {
  runHandoffAgent,
  drawioLinkFromMermaid,
  type HandoffAgentOptions,
  type HandoffBrief,
} from "@/services/agents/runner";
import { deriveHandoffCharts } from "@/services/agents/derive-artifacts";
import { recordArtifactUsage } from "@/services/billing";
import { boundCitations, type BriefCitationInput } from "@/services/memory/brief-citations";
import {
  startWorkflowRun,
  runWorkflowStep,
  reserveWorkflowCredits,
  settleWorkflowCredits,
  isWorkflowRunStopped,
  mintWorkflowRoleCapability,
  checkEvidenceInScope,
  recordWorkflowApproval,
  recordWorkflowAudit,
  type EvidenceItem,
} from "./engine";

const HANDOFF_WORKFLOW_KEY = "handoff-brief";

/** One credit reserved per model-calling step attempt (drafter). The checker here
 *  is a pure function (no model call), so it costs nothing — see this module's
 *  header comment in engine.ts for why a real per-workflow-type price still needs
 *  benchmark data before it ships (spec's "Billing hook" section). */
const STEP_CREDIT_ESTIMATE = 1;

export interface HandoffWorkflowInput {
  orgId: string;
  /** Internal User.id of the grant creator — the same person who becomes this
   *  run's approver (spec: "the person who created the grant approves delivery"). */
  requestedBy: string;
  scopePath: string;
  granteeName: string;
  granteeRole?: string;
  context?: string;
  agentRow: HandoffAgentOptions["agentRow"];
  /** A stable id for "this request" — the grant id is the natural choice, since a
   *  grant is what a handoff briefing is always for. */
  requestFingerprint: string;
}

export async function startHandoffBriefRun(input: HandoffWorkflowInput): Promise<{ run: WorkflowRun; isNew: boolean }> {
  return startWorkflowRun({
    orgId: input.orgId,
    workflowKey: HANDOFF_WORKFLOW_KEY,
    requestedBy: input.requestedBy,
    scopePath: input.scopePath,
    requestFingerprint: input.requestFingerprint,
    budgetCredits: creditsFor("handoff"),
  });
}

/** Drive a run through drafting/checking rounds until it either reaches
 *  `awaiting_approval` or terminates (stopped/failed/over_budget). Safe to call
 *  repeatedly on the same run (an Inngest retry, a resumed heartbeat) — every
 *  drafter/checker attempt is a real (run, role, round) step, so re-entering this
 *  function after a crash resumes rather than re-executing finished rounds. */
export async function driveHandoffBriefRun(
  runId: string,
  input: Omit<HandoffWorkflowInput, "requestFingerprint">,
): Promise<WorkflowRun> {
  let run = await db.workflowRun.findUniqueOrThrow({ where: { id: runId } });

  for (;;) {
    if (await isWorkflowRunStopped(run)) {
      return db.workflowRun.update({ where: { id: run.id }, data: { status: "stopped" } });
    }
    if (run.status === "awaiting_approval" || run.status === "delivered") return run;
    if (run.status === "failed" || run.status === "stopped" || run.status === "over_budget") return run;

    run = await db.workflowRun.update({ where: { id: run.id }, data: { status: "drafting" } });

    const reserved = await reserveWorkflowCredits(run.id, STEP_CREDIT_ESTIMATE);
    if (!reserved) {
      return db.workflowRun.update({
        where: { id: run.id },
        data: { status: "over_budget", failureReason: "drafter step would exceed the run's credit budget" },
      });
    }

    const capability = await mintWorkflowRoleCapability(run, "drafter");
    const draftStep = await runWorkflowStep({
      run,
      role: "drafter",
      round: run.round,
      execute: async () => {
        const brief = await runHandoffAgent({
          agentRow: input.agentRow,
          granteeName: input.granteeName,
          granteeRole: input.granteeRole,
          context: input.context,
          orgId: input.orgId,
          capabilityToken: capability.token,
          memoryScope: input.scopePath,
        });
        // The agent records which retrieved facts each section cites
        // (`brief.citations`, stored with the delivered brief), but the checker
        // does not verify claims against them yet (see this module's header and
        // engine.ts's header comment), so the coarse evidence entry below stays
        // the one this run actually checks. What it proves: the
        // drafter could not have read outside `scopePath`, because its capability
        // token was minted scoped to exactly that path and every read went
        // through check() (services/access/check.ts), which enforces it.
        const evidence: EvidenceItem[] = [{ sourceId: `scope:${input.scopePath}`, scopePath: input.scopePath }];
        return { output: brief, evidence, costCredits: STEP_CREDIT_ESTIMATE, capabilityId: capability.capabilityId };
      },
    });
    await settleWorkflowCredits(run.id, STEP_CREDIT_ESTIMATE, draftStep.costCredits);
    await recordWorkflowAudit({
      orgId: input.orgId,
      runId: run.id,
      role: "drafter",
      action: "workflow.draft",
      target: input.scopePath,
      decision: "allow",
      reason: "drafter produced a brief",
    });

    run = await db.workflowRun.update({ where: { id: run.id }, data: { status: "checking" } });

    const evidence = (draftStep.evidence ?? []) as unknown as EvidenceItem[];
    const verdict = checkEvidenceInScope(run.scopePath, evidence);
    const checkStep = await runWorkflowStep({
      run,
      role: "checker",
      round: run.round,
      execute: async () => ({ output: verdict, evidence, verdict: verdict.verdict, reasons: verdict.reasons }),
    });
    await recordWorkflowAudit({
      orgId: input.orgId,
      runId: run.id,
      role: "checker",
      action: "workflow.check",
      target: input.scopePath,
      decision: checkStep.verdict === "pass" ? "allow" : "deny",
      reason: checkStep.verdict === "pass" ? "checker passed" : (checkStep.reasons as unknown as string[]).join("; "),
    });

    if (checkStep.verdict === "pass") {
      return db.workflowRun.update({ where: { id: run.id }, data: { status: "awaiting_approval" } });
    }

    // Round cap: escalate to the approver with the checker's open reasons attached
    // rather than looping forever or silently delivering (spec's round-cap rule).
    if (run.round + 1 >= run.roundCap) {
      return db.workflowRun.update({
        where: { id: run.id },
        data: { status: "awaiting_approval", round: run.round + 1 },
      });
    }
    run = await db.workflowRun.update({ where: { id: run.id }, data: { round: { increment: 1 } } });
  }
}

/** Record a real human decision. This is the ONLY function in this module that
 *  creates a WorkflowApproval row — deliverHandoffBriefRun() below hard-requires
 *  one with decision "approved" and refuses otherwise (guarantee 8). */
export async function decideHandoffBriefRun(params: {
  runId: string;
  approverId: string;
  decision: "approved" | "rejected";
  reason?: string;
}): Promise<WorkflowRun> {
  const run = await db.workflowRun.findUniqueOrThrow({ where: { id: params.runId } });
  if (run.status !== "awaiting_approval") {
    throw new Error(`run ${params.runId} is not awaiting approval (status=${run.status})`);
  }
  if (await isWorkflowRunStopped(run)) {
    throw new Error(`run ${params.runId} was stopped; refusing to record a decision`);
  }
  await recordWorkflowApproval(params);
  if (params.decision === "rejected") {
    return db.workflowRun.update({
      where: { id: run.id },
      data: { status: "failed", failureReason: params.reason ?? "rejected by approver" },
    });
  }
  return run; // still awaiting_approval in status terms until deliverHandoffBriefRun() runs
}

/** Persist the approved draft as a real Brief (same table/shape the existing route
 *  writes to) and mark the run delivered. Refuses outright without a real,
 *  "approved" WorkflowApproval row — no code path here can synthesize one. */
export async function deliverHandoffBriefRun(
  runId: string,
  orgId: string,
): Promise<{ brief: { id: string }; run: WorkflowRun }> {
  const approval = await db.workflowApproval.findUnique({ where: { runId } });
  if (!approval || approval.decision !== "approved") {
    throw new Error(`refusing to deliver run ${runId}: no real approval record on file`);
  }
  const run = await db.workflowRun.findUniqueOrThrow({ where: { id: runId } });
  if (await isWorkflowRunStopped(run)) {
    throw new Error(`run ${runId} was stopped; refusing delivery`);
  }
  if (run.status === "delivered" && run.briefId) {
    return { brief: { id: run.briefId }, run }; // idempotent re-delivery attempt
  }

  const draftStep = await db.workflowRunStep.findFirstOrThrow({
    where: { runId, role: "drafter" },
    orderBy: { round: "desc" },
  });
  // The drafter's stored output is runHandoffAgent's return value, citations included;
  // a run drafted before citations existed has none, and its brief is stored without them.
  const result = draftStep.output as unknown as HandoffBrief & { citations?: BriefCitationInput[] };

  const grantorInput = await db.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { requestedBy: true } });

  const brief = await createBrief(
    {
      orgId,
      type: "handoff",
      scopePath: run.scopePath,
      title: result.title,
      summary: result.summary,
      sections: result.sections,
      diagram: result.diagram ?? null,
      diagramUrl: result.diagram ? drawioLinkFromMermaid(result.diagram) : null,
      charts: deriveHandoffCharts(result) as unknown as object,
    },
    // The workflow writes the brief on behalf of the person who requested it.
    { actorType: "human", actorId: grantorInput.requestedBy, origin: "agent-run" },
    boundCitations(result.citations ?? [], result.sections.length),
  );

  await recordArtifactUsage({
    orgId,
    artifactType: "handoff",
    briefId: brief.id,
    scopePath: run.scopePath,
    actorId: grantorInput.requestedBy,
  });

  const delivered = await db.workflowRun.update({
    where: { id: run.id },
    data: { status: "delivered", deliveredAt: new Date(), briefId: brief.id },
  });

  await recordWorkflowAudit({
    orgId,
    runId: run.id,
    role: "approver",
    action: "workflow.deliver",
    target: run.scopePath,
    decision: "allow",
    reason: `delivered brief ${brief.id}, approved by ${approval.approverId}`,
  });

  return { brief, run: delivered };
}
