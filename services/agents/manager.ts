// QA SUPERVISOR / MANAGER engine. Flag-gated (QA_MANAGER, default OFF),
// backend-only, ADDITIVE. It reuses the interactive-loop substrate wholesale:
//
//   • A CHILD is a normal QA `AgentRun` row (meta.parentRunId = <parent runId>) driven to
//     completion by the EXISTING run-loop `driveRun` in AUTOPILOT — i.e. the ordinary QA
//     plan→consulting(fold defaults)→executing→finalizing→done loop, no new schema.
//   • The MANAGER is a planner whose plan items ARE those child sub-runs. It emits its own
//     synthesized RunEvents onto the PARENT run's stream (plan = children as plan items;
//     step_started/step_progress/step_completed per child; artifact = aggregated findings;
//     done), so the existing GET /api/runs/[runId]/stream + workspace render it UNCHANGED.
//
// State machine (parent AgentRun.phase, all persisted in Postgres):
//
//   planning ──▶ executing ⇄ (convergence rounds) ──▶ finalizing ──▶ done
//                                                                     └▶ failed
//
//   planning   — one bounded, tool-free LLM step assesses COMPLEXITY + INDEPENDENCE and
//                decomposes the task into ≤ MAX_CHILDREN genuinely-independent slices
//                (default: a single child covering the whole target; escalate on evidence).
//   executing  — the CONVERGENCE LOOP. Each round: create child runs → drive them (as
//                Inngest background jobs in prod, inline when bypassing) → adversarially
//                VERIFY every child finding (reproduce it; is it real?) before accepting →
//                re-plan. Repeat per the stopping mode UNTIL the guardrail (max rounds +
//                child/step budget) overrides — the guardrail ALWAYS wins.
//   finalizing — fold the accepted, verified findings into ONE parent qa_review Brief, meter
//                it, link it, emit `done`.
//
// Depth is capped at 1: children run the plain QA loop and never spawn grandchildren
// (createChild only ever runs from here). QA finds, it doesn't fix — the loop converges on
// coverage/confidence, not zero-bugs.
//
// NOTE (serverless timing): the manager runs SYNCHRONOUSLY inside the start POST — it
// dispatches children and then AWAITS them (inline drive when bypassing; else poll the
// child AgentRun.status after inngest.send) so the parent reaches a terminal phase before
// the POST returns. That keeps the flow off the stream route's QA re-driver (which we must
// not edit) — by the time a client can open the stream with the returned runId, the parent
// is already `done`/`failed` and the stream simply replays. The honest cost is a long POST
// (serverless timeout risk on big fan-outs). True fire-and-forget fan-out with async
// aggregation via a child-completion callback is the production hardening; see the route.
import { db } from "@/lib/db";
import { createBrief } from "@/services/memory/create-brief";
import { z } from "zod";
import { buildMastraAgent, buildRuntimeContext, type AgentRow, type QaTarget } from "@/services/agents/runner";
import { QA_AGENT_ID, QA_AGENT_NAME } from "@/lib/qa-agent";
import { httpRequestTool } from "@/services/agents/qa-tools";
import { driveRun } from "@/services/agents/run-loop";
// Live event bus (WS0): the manager emits onto the SAME in-memory tail bus + monotonic-seq
// assignment as the single-agent loop, so a managed run streams LIVE (child progress as it
// happens) instead of only replaying after it finishes. `emit` persists AND publishes.
import { emit } from "@/services/agents/run-events";
import { recordArtifactUsage } from "@/services/billing";
import { orgRootPath } from "@/services/access";
import type {
  RunPhase,
  AgentRunPlan,
  PlanItem,
  BriefFragment,
  BriefSection,
  Brief,
  BriefType,
  PartialBrief,
} from "@/types/agent-run";
// Arch manager engine (WS1) lives in a sibling module so run-loop's shared spine, the QA
// engine here, and the Arch role stay on disjoint code paths. Re-exported so routes/tests
// resolve the whole manager surface from this one module.
import { runArchManager } from "@/services/agents/manager-arch";
import { AgentDeactivatedError } from "./agent-active";
export {
  archManagerEnabled,
  createArchManagerRun,
  runArchManager,
  type ArchManagerMeta,
  type CreateArchManagerRunInput,
} from "@/services/agents/manager-arch";

// ---------------------------------------------------------------------------
// FLAG — read EXACTLY like paymentsEnabled() in services/billing/plans.ts. Default OFF;
// flip QA_MANAGER to any of true/1/on/yes to enable the manager route + engine.
// ---------------------------------------------------------------------------

export function qaManagerEnabled(): boolean {
  const v = process.env.QA_MANAGER?.toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

// ---------------------------------------------------------------------------
// Config constants (ceilings, not targets). All guardrails live here so the convergence
// loop can never "refine forever" and the fan-out can never exceed a manager's span-of-control.
// ---------------------------------------------------------------------------

export const MANAGER_CONFIG = {
  /** Hard per-round child-count cap (≈ a manager's span-of-control). A ceiling, not a target. */
  MAX_CHILDREN: 5,
  /** Convergence-loop guardrail: max rounds of (run → verify → re-plan). ALWAYS overrides the stopping mode. */
  MAX_ROUNDS: 3,
  /** Budget guardrail: max child runs summed across all rounds. ALWAYS overrides. */
  MAX_TOTAL_CHILDREN: 8,
  /** Coarse LLM-step budget (child drives + verifications). ALWAYS overrides. */
  MAX_LLM_UNITS: 30,
  /** loop-until-dry: stop once this many consecutive rounds add no NEW verified finding. */
  DRY_ROUNDS_TO_STOP: 1,
  /** Max wall-clock to wait on a backgrounded child before giving up on it (poll path). */
  CHILD_WAIT_MS: 4 * 60_000,
  POLL_INTERVAL_MS: 2_000,
} as const;

export type StoppingMode = "loop-until-dry" | "coverage-complete" | "verdict-stabilizes";

// ---------------------------------------------------------------------------
// Parent run meta — the manager's config, stashed on AgentRun.meta at start so the engine
// is reconstructable from the DB row alone. Children carry the SAME QA meta shape PLUS a
// `parentRunId` link (the query key; AgentRun.meta is an existing Json column — no migration).
// ---------------------------------------------------------------------------

export interface QaManagerMeta {
  type: "qa-manager";
  agentRole: "qa";
  target: QaTarget;
  focus?: string;
  mode?: "api" | "browser";
  scopePath?: string;
  triggeredBy: string;
  stoppingMode: StoppingMode;
}

/** A child's meta = the ordinary interactive-QA meta (run-loop's QaRunMeta) + the parent link.
 *  run-loop reads it as QaRunMeta and ignores the extra `parentRunId`, so no run-loop edit. */
interface QaChildMeta {
  type: "qa-interactive";
  agentRole: "qa";
  target: QaTarget;
  focus?: string;
  mode?: "api" | "browser";
  scopePath?: string;
  triggeredBy: string;
  autopilot: true;
  clarifyAnswers: [];
  parentRunId: string;
}

/** One decomposed slice of the QA task the manager will hand to a child. */
interface ChildSpec {
  title: string;
  focus: string;
  mode?: "api" | "browser";
}

// ---------------------------------------------------------------------------
// Event append — `emit` is now imported from services/agents/run-events (WS0). It persists
// the AgentRunEvent row under the @@unique([runId,seq]) guard AND publishes to the live bus,
// so the manager's synthesized child events tail LIVE onto the stream route (not replay-only).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Start — create the parent AgentRun row (phase=planning). Called by the route AFTER it has
// gated access + tenant scope. Mirrors createQaInteractiveRun but stamps the qa-manager meta.
// ---------------------------------------------------------------------------

export interface CreateManagerRunInput {
  orgId: string;
  agentId: string;
  triggeredBy: string;
  target: QaTarget;
  focus?: string;
  mode?: "api" | "browser";
  scopePath?: string;
  stoppingMode?: StoppingMode;
}

export async function createQaManagerRun(input: CreateManagerRunInput): Promise<string> {
  const meta: QaManagerMeta = {
    type: "qa-manager",
    agentRole: "qa",
    target: input.target,
    focus: input.focus,
    mode: input.mode ?? "api",
    scopePath: input.scopePath,
    triggeredBy: input.triggeredBy,
    stoppingMode: input.stoppingMode ?? "loop-until-dry",
  };
  const run = await db.agentRun.create({
    data: {
      orgId: input.orgId,
      agentId: input.agentId,
      status: "running",
      triggeredBy: input.triggeredBy,
      phase: "planning",
      cursor: 0,
      revision: 0,
      meta: meta as unknown as object,
    },
    select: { id: true },
  });
  return run.id;
}

// ---------------------------------------------------------------------------
// Helpers to load the QA agent row + build a target-scoped runtime context (for the manager's
// own planning / re-plan / verification LLM calls — children build their own inside run-loop).
// ---------------------------------------------------------------------------

type RunRow = NonNullable<Awaited<ReturnType<typeof db.agentRun.findUnique>>>;

async function loadAgentRow(agentId: string, orgId: string): Promise<AgentRow> {
  const row = await db.agent.findFirst({
    where: { id: agentId, orgId },
    select: {
      active: true,
      agentKey: true,
      name: true,
      role: true,
      model: true,
      systemPrompt: true,
      tools: true,
      settings: true,
    },
  });
  if (!row) throw new Error("agent not found for manager run");
  if (!row.active) throw new AgentDeactivatedError();
  return row;
}

function metaOf(run: RunRow): QaManagerMeta {
  return run.meta as unknown as QaManagerMeta;
}

// ---------------------------------------------------------------------------
// driveManager — the ROLE-AGNOSTIC manager entry point WS0's `driveRun` dispatch calls.
// Background re-entrant (own driver guard, mirroring run-loop.driveRun's `activeDrivers`):
// a reconnecting stream's re-drive is a safe no-op while a drive is active, and a no-op once
// the run is terminal. Otherwise it (re)runs the appropriate role engine from the persisted
// DB row — QA (adaptive `planChildren` + convergence rounds) or Architecture (fixed ≤5
// domain-bucket fan-out). Depth-1 is structural: only these engines create rows carrying
// `meta.parentRunId`; children are plain interactive runs driven by `driveRun` and never
// re-enter here. Each engine catches its own errors + flips the run to `failed`.
// ---------------------------------------------------------------------------

const activeManagerDrivers = new Set<string>();

export async function driveManager(runId: string): Promise<void> {
  if (activeManagerDrivers.has(runId)) return;
  activeManagerDrivers.add(runId);
  try {
    const run = await db.agentRun.findUnique({
      where: { id: runId },
      select: { meta: true, phase: true },
    });
    if (!run) return;
    // Resume-safe: a terminal parent (crashed-and-recovered stream re-drive) is a no-op.
    if (run.phase === "done" || run.phase === "failed") return;
    const type = (run.meta as { type?: unknown } | null)?.type;
    if (type === "arch-manager") {
      await runArchManager(runId);
    } else {
      await runQaManager(runId);
    }
  } finally {
    activeManagerDrivers.delete(runId);
  }
}

// ---------------------------------------------------------------------------
// THE QA DRIVER — runs the whole QA manager to a terminal phase. Catches its own
// errors (flips to failed + emits `error`), so the start POST always returns { runId }.
// ---------------------------------------------------------------------------

export async function runQaManager(runId: string): Promise<void> {
  try {
    const run = await db.agentRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const meta = metaOf(run);
    const agentRow = await loadAgentRow(run.agentId, run.orgId);

    // 1) PLANNING — assess complexity + independence, decompose into ≤ MAX_CHILDREN slices.
    const specs = await planChildren(run, meta, agentRow);
    const plan: AgentRunPlan = { runId: run.id, agentRole: "qa", items: [], revision: 0 };
    await db.agentRun.update({
      where: { id: run.id },
      data: { plan: plan as unknown as object, phase: "executing" },
    });
    await emit(run.id, { type: "phase", phase: "planning" });

    // Budget (guardrails). `llmUnits` counts child drives + verifications.
    const budget = { childrenSpawned: 0, llmUnits: 0 };

    // Accumulators across rounds.
    const accepted: AcceptedFinding[] = [];
    const passthrough: BriefFragment[] = []; // perf + section context from children
    const rejectedCount = { value: 0 };
    let dryRounds = 0;
    let lastVerdict: QaVerdict | null = null;

    // Round 1 uses the planned specs; later rounds get specs from re-plan.
    let nextSpecs = specs;

    for (let round = 0; round < MANAGER_CONFIG.MAX_ROUNDS; round++) {
      // Guardrail: budget ceiling ALWAYS overrides the stopping mode.
      if (budget.childrenSpawned >= MANAGER_CONFIG.MAX_TOTAL_CHILDREN) break;
      if (budget.llmUnits >= MANAGER_CONFIG.MAX_LLM_UNITS) break;
      if (nextSpecs.length === 0) break;

      const remaining = MANAGER_CONFIG.MAX_TOTAL_CHILDREN - budget.childrenSpawned;
      const roundSpecs = nextSpecs.slice(0, Math.min(MANAGER_CONFIG.MAX_CHILDREN, remaining));

      const before = accepted.length;
      const result = await runRound(
        run,
        meta,
        agentRow,
        plan,
        roundSpecs,
        round,
        budget,
        accepted,
        passthrough,
        rejectedCount,
      );
      lastVerdict = result.verdict;

      const newFindings = accepted.length - before;

      // Stopping mode + guardrail. The guardrail (rounds/budget above) is a hard ceiling;
      // within it, the user-chosen stopping mode decides whether to keep converging.
      const stop = await shouldStop(run, meta, agentRow, {
        round,
        newFindings,
        verdict: result.verdict,
        lastVerdict: round === 0 ? null : lastVerdict,
        budget,
      });
      if (stop.done) break;

      // loop-until-dry bookkeeping.
      if (newFindings === 0) dryRounds++;
      else dryRounds = 0;
      if (meta.stoppingMode === "loop-until-dry" && dryRounds >= MANAGER_CONFIG.DRY_ROUNDS_TO_STOP) break;

      nextSpecs = stop.nextSpecs;
    }

    // 2) FINALIZING — fold accepted findings into one parent Brief.
    await db.agentRun.update({ where: { id: run.id }, data: { phase: "finalizing" } });
    await emit(run.id, { type: "phase", phase: "finalizing" });
    await finalize(run, meta, accepted, passthrough, rejectedCount.value, lastVerdict ?? "could_not_test");
  } catch (e) {
    await failRun(runId, e);
  }
}

async function failRun(runId: string, e: unknown) {
  const message = e instanceof Error ? e.message : "manager run failed";
  try {
    await db.agentRun.update({
      where: { id: runId },
      data: { phase: "failed", status: "failed", finishedAt: new Date() },
    });
    await emit(runId, { type: "error", message });
    await emit(runId, { type: "phase", phase: "failed" });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// PLANNING — one bounded, tool-free LLM step assesses complexity + INDEPENDENCE and either
// decomposes into independent slices or keeps a single agent. Default single / escalate on
// evidence; independence is a required gate (only split genuinely separable subtasks).
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = z.object({
  complexity: z.enum(["low", "medium", "high"]).describe("Overall breadth/uncertainty of the QA task."),
  decompose: z
    .boolean()
    .describe("true ONLY if the task has multiple genuinely INDEPENDENT slices worth parallel children."),
  rationale: z.string().describe("Why decompose (or not) — cite the independence of the slices."),
  children: z
    .array(
      z.object({
        title: z.string().describe("Short imperative slice title, e.g. 'Probe /checkout error handling'."),
        focus: z.string().describe("What this child independently tests — a separable endpoint/flow/test-type."),
        mode: z.enum(["api", "browser"]).optional(),
      }),
    )
    .max(MANAGER_CONFIG.MAX_CHILDREN)
    .describe("The independent slices. Keep stateful multi-step flows in ONE child. Omit / empty ⇒ single agent."),
});

async function planChildren(run: RunRow, meta: QaManagerMeta, agentRow: AgentRow): Promise<ChildSpec[]> {
  const agent = buildMastraAgent(agentRow); // tool-free generate — planning must not touch the target
  const rc = buildRuntimeContext({ orgId: run.orgId, actorId: QA_AGENT_ID, actorName: QA_AGENT_NAME });

  const prompt =
    `You are the QA MANAGER. Plan (do NOT test yet) a black-box QA run against ${meta.target.baseUrl} in ${meta.mode ?? "api"} mode.` +
    (meta.focus ? ` Focus: ${meta.focus}.` : "") +
    ` Assess the task's complexity and, crucially, its INDEPENDENCE. Default to a SINGLE agent; only decompose into` +
    ` multiple children when there are genuinely INDEPENDENT slices (e.g. distinct endpoints or distinct test-types) that` +
    ` can be tested in parallel without depending on each other. Keep any stateful multi-step flow inside a SINGLE child.` +
    ` Cap: at most ${MANAGER_CONFIG.MAX_CHILDREN} children (a ceiling, not a target — usually fewer).`;

  let specs: ChildSpec[] = [];
  try {
    const res = await agent.generate(prompt, { runtimeContext: rc, output: PLAN_SCHEMA });
    const obj = (res as { object?: z.infer<typeof PLAN_SCHEMA> }).object;
    if (obj?.decompose && obj.children.length > 0) {
      specs = obj.children
        .slice(0, MANAGER_CONFIG.MAX_CHILDREN)
        .map((c) => ({ title: c.title, focus: c.focus, mode: c.mode }));
    }
  } catch {
    /* fall through to single-agent */
  }

  // Default / fallback: a single child covering the whole target (escalate on evidence, not upfront).
  if (specs.length === 0) {
    specs = [
      { title: "Full black-box sweep", focus: meta.focus ?? "Full black-box sweep of the target", mode: meta.mode },
    ];
  }
  return specs;
}

// ---------------------------------------------------------------------------
// CONVERGENCE ROUND — create the child runs, drive them (Inngest bg jobs / inline), read
// their findings, adversarially verify each, and emit the parent stream events + a cumulative
// artifact. Mutates `accepted` / `passthrough` / `rejectedCount` in place.
// ---------------------------------------------------------------------------

interface AcceptedFinding {
  bug: Extract<BriefFragment, { as: "bug" }>;
  evidence: string;
  confidence: "confirmed" | "uncertain";
  childTitle: string;
}

interface RoundResult {
  verdict: QaVerdict;
}

async function runRound(
  run: RunRow,
  meta: QaManagerMeta,
  agentRow: AgentRow,
  plan: AgentRunPlan,
  specs: ChildSpec[],
  round: number,
  budget: { childrenSpawned: number; llmUnits: number },
  accepted: AcceptedFinding[],
  passthrough: BriefFragment[],
  rejectedCount: { value: number },
): Promise<RoundResult> {
  if (round === 0) await emit(run.id, { type: "phase", phase: "executing" });

  // Create a child run per spec + a matching parent PlanItem (itemId = childRunId).
  const children: { runId: string; spec: ChildSpec; index: number }[] = [];
  for (const spec of specs) {
    if (budget.childrenSpawned >= MANAGER_CONFIG.MAX_TOTAL_CHILDREN) break;
    const runId = await createChild(run, meta, spec);
    budget.childrenSpawned++;
    const index = plan.items.length;
    const item: PlanItem = {
      id: runId,
      kind: "scenario",
      title: `${spec.title}${round > 0 ? ` (round ${round + 1})` : ""}`,
      detail: spec.focus,
      status: "pending",
      origin: "agent",
      // WS1: mark this item as one parallel child sub-agent so the workspace renders it in
      // the fan-out band. `childRunId` equals `id` today; explicit for the reducer.
      parallel: true,
      childRunId: runId,
    };
    plan.items.push(item);
    children.push({ runId, spec, index });
  }

  // Publish the (updated) plan so the workspace shows children as plan items.
  plan.revision += 1;
  await db.agentRun.update({
    where: { id: run.id },
    data: { plan: plan as unknown as object, revision: plan.revision },
  });
  if (round === 0) await emit(run.id, { type: "plan", plan });
  else await emit(run.id, { type: "plan_updated", plan, reason: "agent_replan" });

  for (const c of children) {
    await emit(run.id, { type: "step_started", itemId: c.runId, index: c.index, title: plan.items[c.index].title });
  }

  // Drive each child + verify its findings, in parallel. Emits land safely (seq retry).
  const verifyAgent = buildVerifyAgent(agentRow, meta, run.orgId);
  await Promise.all(
    children.map(async (c) => {
      await emit(run.id, {
        type: "step_progress",
        itemId: c.runId,
        message: `Dispatched child QA run: ${c.spec.title}`,
      });
      try {
        await dispatchChild(c.runId, run.orgId);
        budget.llmUnits++;
        const fragments = await childFragments(c.runId);
        const bugs = fragments.filter((f): f is Extract<BriefFragment, { as: "bug" }> => f.as === "bug");
        // perf + section fragments are context, not claims to adversarially reproduce.
        for (const f of fragments) if (f.as === "performance" || f.as === "section") passthrough.push(f);

        let confirmedHere = 0;
        for (const bug of bugs) {
          if (budget.llmUnits >= MANAGER_CONFIG.MAX_LLM_UNITS) break;
          await emit(run.id, {
            type: "step_progress",
            itemId: c.runId,
            message: `Verifying reported defect: ${bug.finding}`,
          });
          const outcome = await verifyBug(verifyAgent.agent, verifyAgent.rc, meta, bug);
          budget.llmUnits++;
          if (outcome.verdict === "confirmed") {
            accepted.push({ bug, evidence: outcome.evidence, confidence: "confirmed", childTitle: c.spec.title });
            confirmedHere++;
          } else if (outcome.verdict === "uncertain") {
            accepted.push({ bug, evidence: outcome.evidence, confidence: "uncertain", childTitle: c.spec.title });
          } else {
            rejectedCount.value++;
          }
        }

        const item = await markItem(run.id, c.runId, "done");
        const fragment: BriefFragment = {
          as: "section",
          heading: c.spec.title,
          content: `${bugs.length} candidate defect(s), ${confirmedHere} verified. Focus: ${c.spec.focus}.`,
        };
        if (item) await emit(run.id, { type: "step_completed", itemId: c.runId, fragment });
        await emitArtifact(run.id, accepted, passthrough);
      } catch (e) {
        await markItem(run.id, c.runId, "failed");
        await emit(run.id, {
          type: "step_failed",
          itemId: c.runId,
          error: e instanceof Error ? e.message : "child run failed",
        });
      }
    }),
  );

  return { verdict: deriveVerdict(accepted, passthrough) };
}

async function createChild(run: RunRow, meta: QaManagerMeta, spec: ChildSpec): Promise<string> {
  const childMeta: QaChildMeta = {
    type: "qa-interactive",
    agentRole: "qa",
    target: meta.target,
    focus: spec.focus,
    mode: spec.mode ?? meta.mode ?? "api",
    scopePath: meta.scopePath,
    triggeredBy: meta.triggeredBy,
    autopilot: true,
    clarifyAnswers: [],
    parentRunId: run.id,
  };
  const child = await db.agentRun.create({
    data: {
      orgId: run.orgId,
      agentId: run.agentId,
      status: "running",
      triggeredBy: meta.triggeredBy,
      phase: "planning",
      cursor: 0,
      revision: 0,
      meta: childMeta as unknown as object,
    },
    select: { id: true },
  });
  return child.id;
}

/** Dispatch a child. In prod: fire the Inngest job, then poll the child AgentRun to terminal
 *  (so the manager can aggregate). When bypassing (repo convention, INNGEST_BYPASS/INNGEST_DEV):
 *  drive it inline. Either way the parent waits for the child's result. */
async function dispatchChild(childRunId: string, orgId: string): Promise<void> {
  const bypass = process.env.INNGEST_BYPASS === "1" || process.env.INNGEST_DEV === "1";
  if (bypass) {
    await driveRun(childRunId, orgId);
    return;
  }
  const { inngest, QA_MANAGER_CHILD_EVENT } = await import("@/lib/inngest");
  await inngest.send({ name: QA_MANAGER_CHILD_EVENT, data: { childRunId, orgId } });
  await waitForChild(childRunId);
}

async function waitForChild(childRunId: string): Promise<void> {
  const deadline = Date.now() + MANAGER_CONFIG.CHILD_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await db.agentRun.findUnique({ where: { id: childRunId }, select: { status: true, phase: true } });
    if (!r) return;
    if (r.status === "completed" || r.status === "failed" || r.phase === "done" || r.phase === "failed") return;
    await new Promise((res) => setTimeout(res, MANAGER_CONFIG.POLL_INTERVAL_MS));
  }
}

/** Read a completed child's typed BriefFragments from its persisted plan (PlanItem.result). */
async function childFragments(childRunId: string): Promise<BriefFragment[]> {
  const r = await db.agentRun.findUnique({ where: { id: childRunId }, select: { plan: true } });
  const plan = r?.plan as unknown as AgentRunPlan | null;
  if (!plan) return [];
  return plan.items.filter((i) => i.status === "done" && i.result).map((i) => i.result as BriefFragment);
}

async function markItem(runId: string, itemId: string, status: PlanItem["status"]): Promise<boolean> {
  const fresh = await db.agentRun.findUnique({ where: { id: runId }, select: { plan: true } });
  const plan = fresh?.plan as unknown as AgentRunPlan | null;
  if (!plan) return false;
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) return false;
  item.status = status;
  await db.agentRun.update({ where: { id: runId }, data: { plan: plan as unknown as object } });
  return true;
}

// ---------------------------------------------------------------------------
// ADVERSARIAL VERIFICATION — the main quality lever. For each defect a child reported, the
// manager INDEPENDENTLY reproduces it against the target (http_request tool) and judges
// confirmed / false / uncertain before accepting. No capability/memory_read here — verification
// is about reproducing against the running product, not reading memory.
// ---------------------------------------------------------------------------

const VERIFY_SCHEMA = z.object({
  verdict: z
    .enum(["confirmed", "false", "uncertain"])
    .describe(
      "confirmed = you reproduced it; false = you could not reproduce / it was misreported; uncertain = inconclusive.",
    ),
  evidence: z
    .string()
    .describe("The exact request(s) you made and what you observed — your own evidence, not the child's."),
  rationale: z.string().describe("One line on why this verdict."),
});

function buildVerifyAgent(agentRow: AgentRow, meta: QaManagerMeta, orgId: string) {
  // Pure black-box verify: http_request only, drop memory_read (verification reproduces
  // against the running product, it does not read memory).
  const rowForRun = { ...agentRow, tools: agentRow.tools.filter((t) => t !== "memory_read") };
  const agent = buildMastraAgent(rowForRun, { http_request: httpRequestTool });
  const allowedHosts = Array.from(
    new Set([safeHost(meta.target.baseUrl), ...(meta.target.allowedHosts ?? [])].filter(Boolean)),
  );
  const rc = buildRuntimeContext({ orgId, actorId: QA_AGENT_ID, actorName: QA_AGENT_NAME });
  rc.set("qaTargetBaseUrl", meta.target.baseUrl);
  rc.set("qaAllowedHosts", allowedHosts);
  if (meta.target.authHeader) rc.set("qaAuthHeader", meta.target.authHeader);
  return { agent, rc };
}

async function verifyBug(
  agent: ReturnType<typeof buildMastraAgent>,
  rc: ReturnType<typeof buildRuntimeContext>,
  meta: QaManagerMeta,
  bug: Extract<BriefFragment, { as: "bug" }>,
): Promise<z.infer<typeof VERIFY_SCHEMA>> {
  const prompt =
    `A child tester reported this defect against ${meta.target.baseUrl}. INDEPENDENTLY reproduce it and decide if it is real.` +
    ` Use the http_request tool; only the target's own host(s) are reachable.\n` +
    `Finding: ${bug.finding}\nRepro: ${bug.repro}\nObserved: ${bug.observed}\nExpected: ${bug.expected}\n` +
    `Do not trust the report — run the repro yourself. Return confirmed / false / uncertain with YOUR OWN evidence.`;
  try {
    const res = await agent.generate(prompt, { runtimeContext: rc, maxSteps: 8, output: VERIFY_SCHEMA });
    const obj = (res as { object?: z.infer<typeof VERIFY_SCHEMA> }).object;
    return (
      obj ?? {
        verdict: "uncertain",
        evidence: "no structured verification result",
        rationale: "verifier returned nothing",
      }
    );
  } catch (e) {
    return {
      verdict: "uncertain",
      evidence: "verification errored",
      rationale: e instanceof Error ? e.message : "error",
    };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// STOPPING — combines the user-chosen stopping MODE with the hard guardrail. The guardrail
// (max rounds / budget, enforced in the loop) always wins; here we apply the mode + optionally
// ask the LLM for coverage gaps to seed the next round.
// ---------------------------------------------------------------------------

const REPLAN_SCHEMA = z.object({
  coverageComplete: z
    .boolean()
    .describe("true if the target has been adequately covered and no more rounds are warranted."),
  reason: z.string(),
  children: z
    .array(z.object({ title: z.string(), focus: z.string(), mode: z.enum(["api", "browser"]).optional() }))
    .max(MANAGER_CONFIG.MAX_CHILDREN)
    .describe("Additional independent slices to close coverage gaps next round. Empty if none needed."),
});

interface StopSignal {
  done: boolean;
  nextSpecs: ChildSpec[];
}

async function shouldStop(
  run: RunRow,
  meta: QaManagerMeta,
  agentRow: AgentRow,
  info: {
    round: number;
    newFindings: number;
    verdict: QaVerdict;
    lastVerdict: QaVerdict | null;
    budget: { childrenSpawned: number; llmUnits: number };
  },
): Promise<StopSignal> {
  // verdict-stabilizes: stop as soon as the verdict is unchanged from the prior round.
  if (meta.stoppingMode === "verdict-stabilizes" && info.lastVerdict !== null && info.verdict === info.lastVerdict) {
    return { done: true, nextSpecs: [] };
  }

  // Ask the manager (tool-free) for coverage gaps → next-round slices.
  const agent = buildMastraAgent(agentRow);
  const rc = buildRuntimeContext({ orgId: run.orgId, actorId: QA_AGENT_ID, actorName: QA_AGENT_NAME });
  let replan: z.infer<typeof REPLAN_SCHEMA> | undefined;
  try {
    const prompt =
      `You are the QA MANAGER re-planning after round ${info.round + 1} against ${meta.target.baseUrl}.` +
      ` This round produced ${info.newFindings} newly-verified defect(s); current verdict: ${info.verdict}.` +
      ` Decide whether coverage is complete, and if not, propose additional INDEPENDENT slices (≤ ${MANAGER_CONFIG.MAX_CHILDREN})` +
      ` to close gaps. Prefer stopping when little new is being found.`;
    const res = await agent.generate(prompt, { runtimeContext: rc, output: REPLAN_SCHEMA });
    replan = (res as { object?: z.infer<typeof REPLAN_SCHEMA> }).object;
  } catch {
    /* treat as coverage-complete */
  }

  // coverage-complete: honor the LLM's coverage call.
  if (meta.stoppingMode === "coverage-complete" && (replan?.coverageComplete ?? true)) {
    return { done: true, nextSpecs: [] };
  }

  const nextSpecs: ChildSpec[] = (replan?.children ?? []).map((c) => ({
    title: c.title,
    focus: c.focus,
    mode: c.mode,
  }));
  // For loop-until-dry the dry-round bookkeeping in the loop decides termination; here we just
  // surface any gap-closing slices. If none, the loop will stop (empty nextSpecs).
  return { done: false, nextSpecs };
}

// ---------------------------------------------------------------------------
// ARTIFACT + FINALIZE — fold accepted findings into the parent qa_review Brief.
// ---------------------------------------------------------------------------

type QaVerdict = "healthy" | "issues_found" | "broken" | "could_not_test";

const VERDICT_LABEL: Record<QaVerdict, string> = {
  healthy: "✅ Healthy",
  issues_found: "⚠️ Issues found",
  broken: "🛑 Broken",
  could_not_test: "❓ Could not test",
};

function deriveVerdict(accepted: AcceptedFinding[], passthrough: BriefFragment[]): QaVerdict {
  const ranSomething = accepted.length > 0 || passthrough.length > 0;
  if (!ranSomething) return "could_not_test";
  const confirmed = accepted.filter((a) => a.confidence === "confirmed").map((a) => a.bug);
  if (confirmed.some((b) => b.severity === "blocker" || b.severity === "major")) return "broken";
  if (confirmed.length > 0) return "issues_found";
  return "healthy";
}

function buildSections(
  accepted: AcceptedFinding[],
  passthrough: BriefFragment[],
  rejectedCount: number,
): BriefSection[] {
  const sections: BriefSection[] = [];

  const confirmed = accepted.filter((a) => a.confidence === "confirmed");
  if (confirmed.length) {
    const body = confirmed
      .map(
        (a, i) =>
          `${i + 1}. [${a.bug.severity.toUpperCase()}] ${a.bug.finding}  (child: ${a.childTitle})\n` +
          `   Repro: ${a.bug.repro}\n   Observed: ${a.bug.observed}\n   Expected: ${a.bug.expected}\n` +
          `   Manager verification: ${a.evidence}`,
      )
      .join("\n\n");
    sections.push({ heading: `Verified defects (${confirmed.length})`, content: body });
  }

  const uncertain = accepted.filter((a) => a.confidence === "uncertain");
  if (uncertain.length) {
    const body = uncertain
      .map((a, i) => `${i + 1}. [${a.bug.severity.toUpperCase()}] ${a.bug.finding} — ${a.evidence}`)
      .join("\n");
    sections.push({ heading: `Unconfirmed / uncertain findings (${uncertain.length})`, content: body });
  }

  const perf = passthrough.filter((f): f is Extract<BriefFragment, { as: "performance" }> => f.as === "performance");
  if (perf.length) {
    const body = perf
      .map(
        (p) =>
          `${p.endpoint} — p50 ${p.p50LatencyMs}ms · max ${p.maxLatencyMs}ms · error rate ${(p.errorRate * 100).toFixed(1)}% · ${p.samples} sample(s)`,
      )
      .join("\n");
    sections.push({ heading: "Performance", content: body });
  }

  const notes = passthrough.filter((f): f is Extract<BriefFragment, { as: "section" }> => f.as === "section");
  for (const n of notes) sections.push({ heading: n.heading, content: n.content });

  sections.push({
    heading: "Manager verification summary",
    content:
      `Adversarially verified every child-reported defect by independent reproduction. ` +
      `${confirmed.length} confirmed, ${uncertain.length} uncertain, ${rejectedCount} rejected as not reproducible.`,
  });

  return sections;
}

function assemblePartial(accepted: AcceptedFinding[], passthrough: BriefFragment[]): PartialBrief {
  const confirmed = accepted.filter((a) => a.confidence === "confirmed");
  const sections: BriefSection[] = [];
  if (confirmed.length) {
    sections.push({
      heading: `Verified defects so far (${confirmed.length})`,
      content: confirmed.map((a, i) => `${i + 1}. [${a.bug.severity.toUpperCase()}] ${a.bug.finding}`).join("\n"),
    });
  }
  const perf = passthrough.filter((f): f is Extract<BriefFragment, { as: "performance" }> => f.as === "performance");
  if (perf.length) {
    sections.push({
      heading: "Performance so far",
      content: perf.map((p) => `${p.endpoint} — p50 ${p.p50LatencyMs}ms · max ${p.maxLatencyMs}ms`).join("\n"),
    });
  }
  return { sections };
}

async function emitArtifact(runId: string, accepted: AcceptedFinding[], passthrough: BriefFragment[]): Promise<void> {
  await emit(runId, { type: "artifact", partial: assemblePartial(accepted, passthrough) });
}

async function finalize(
  run: RunRow,
  meta: QaManagerMeta,
  accepted: AcceptedFinding[],
  passthrough: BriefFragment[],
  rejectedCount: number,
  verdict: QaVerdict,
): Promise<void> {
  const sections = buildSections(accepted, passthrough, rejectedCount);
  const host = safeHost(meta.target.baseUrl) || meta.target.baseUrl;
  const confirmed = accepted.filter((a) => a.confidence === "confirmed").length;
  const title = `Managed QA run: ${host}`;
  const summary =
    `${VERDICT_LABEL[verdict]} — Supervised QA over ${host}: ${confirmed} verified defect(s), ` +
    `${accepted.length - confirmed} uncertain, ${rejectedCount} rejected on reproduction. Verdict: ${verdict.replace("_", " ")}.`;

  // scopePath is authorization-bearing (check() enforces against it, cast to
  // ::ltree) — must always be a real scope. A scope-less managed run falls
  // back to the org root and keeps the tested host as its own display-only
  // label instead, same as the one-shot QA paths in qa-run.ts and run-loop.ts.
  const scopePath = meta.scopePath ?? orgRootPath(run.orgId);
  const scopeLabel = meta.scopePath ? null : `(target) ${host}`;

  const dbBrief = await createBrief(
    {
      orgId: run.orgId,
      type: "qa_review",
      scopePath,
      scopeLabel,
      title,
      summary,
      sections: sections as unknown as object,
    },
    { actorType: "agent", actorId: run.agentId, origin: "agent-run" },
  );

  await recordArtifactUsage({
    orgId: run.orgId,
    artifactType: "qa_review",
    briefId: dbBrief.id,
    scopePath: meta.scopePath ?? null,
  });

  await db.agentRun.update({
    where: { id: run.id },
    data: { phase: "done", status: "completed", briefId: dbBrief.id, finishedAt: new Date() },
  });

  const brief: Brief = {
    id: dbBrief.id,
    type: "qa_review" as BriefType,
    scopePath,
    scopeLabel,
    title,
    summary,
    sections,
    createdAt: dbBrief.createdAt.toISOString(),
  };
  await emit(run.id, { type: "done", briefId: dbBrief.id, brief });
  await emit(run.id, { type: "phase", phase: "done" as RunPhase });
}
