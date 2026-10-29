// ARCHITECTURE MANAGER engine (docs/design_manager_fanout.md §3 "Architecture" + WS1).
// Flag-gated (ARCH_MANAGER, default OFF), backend-only, ADDITIVE. Sibling of the QA manager
// in manager.ts; both reuse the interactive-loop substrate wholesale via run-loop's `driveRun`.
//
//   • A CHILD is a normal architecture-interactive `AgentRun` row (meta.parentRunId = parent)
//     driven to completion by the EXISTING run-loop `driveRun` in AUTOPILOT — the ordinary
//     arch plan→consulting(fold defaults)→executing→finalizing loop, no new schema. Each child
//     is PROMPT-STEERED to plan only a subset of ARCH_DOMAINS (§3 MVV: no run-loop edit).
//   • The MANAGER is a planner whose plan items ARE those child sub-runs. It emits synthesized
//     RunEvents onto the PARENT run's stream through the SHARED live bus (WS0 `emit`), so the
//     workspace renders per-child progress LIVE, then folds every child's BriefFragment[] into
//     ONE architecture_plan Brief (reusing run-loop's `foldArchFragments`) after one
//     manager-level contradiction reconciliation pass.
//
// Decomposition: the 8 ARCH_DOMAINS map to ≤5 INDEPENDENT child buckets that keep coupled
// domains together (data-model+api, backend+services) — a fixed grouping, not a free LLM split,
// because arch domains interdepend (§3). Single round (no convergence loop); Arch finds a plan,
// it doesn't converge on coverage. Depth is capped at 1: children are plain interactive runs
// with no manager meta and never spawn grandchildren.
import { db } from "@/lib/db";
import { createBrief } from "@/services/memory/create-brief";
import { z } from "zod";
import { emit } from "@/services/agents/run-events";
import {
  driveRun,
  foldArchFragments,
  ARCH_CONTRADICTION_SCHEMA,
  type ArchDomain,
  type ArchRunMeta,
} from "@/services/agents/run-loop";
import { buildMastraAgent, buildRuntimeContext, type AgentRow } from "@/services/agents/runner";
import { ARCHITECTURE_AGENT_ID, ARCHITECTURE_AGENT_NAME } from "@/lib/architecture-agent";
import { recordArtifactUsage } from "@/services/billing";
import type {
  AgentRunPlan,
  PlanItem,
  BriefFragment,
  Brief,
  BriefType,
  Contradiction,
  RunPhase,
} from "@/types/agent-run";
import { AgentDeactivatedError } from "./agent-active";

// ---------------------------------------------------------------------------
// FLAG — read EXACTLY like qaManagerEnabled() in manager.ts. Default OFF; flip ARCH_MANAGER
// to true/1/on/yes to enable the arch manager route + engine. QA ships independently.
// ---------------------------------------------------------------------------

export function archManagerEnabled(): boolean {
  const v = process.env.ARCH_MANAGER?.toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

// ---------------------------------------------------------------------------
// Config — the fixed ≤5 domain-bucket grouping. A CEILING (5), not a target: buckets whose
// domains memory has nothing for collapse to fewer sections inside the child, so "fan-out"
// degrades gracefully. Coupled domains share a bucket so no child depends on a sibling.
// ---------------------------------------------------------------------------

const ARCH_MANAGER_CONFIG = {
  /** Wall-clock ceiling waiting on a backgrounded child (poll path). */
  CHILD_WAIT_MS: 6 * 60_000,
  POLL_INTERVAL_MS: 2_000,
} as const;

const ARCH_DOMAIN_LABEL: Record<ArchDomain, string> = {
  requirements: "Requirements",
  "user-flow": "User flow",
  "data-model": "Data model",
  api: "API",
  backend: "Backend",
  services: "Services & dependencies",
  decisions: "Decisions to make",
  "execution-plan": "Execution plan",
};

/** The ≤5 independent child buckets (§3). Coupled domains stay in one child. */
const ARCH_CHILD_BUCKETS: { title: string; domains: ArchDomain[] }[] = [
  { title: "Requirements", domains: ["requirements"] },
  { title: "Data model & API", domains: ["data-model", "api"] },
  { title: "Backend & services", domains: ["backend", "services"] },
  { title: "User flow", domains: ["user-flow"] },
  { title: "Decisions & execution plan", domains: ["decisions", "execution-plan"] },
];

// ---------------------------------------------------------------------------
// Parent run meta — the arch manager's config stashed on AgentRun.meta so the engine is
// reconstructable from the DB row alone. Children carry an ordinary ArchRunMeta + parentRunId.
// ---------------------------------------------------------------------------

export interface ArchManagerMeta {
  type: "arch-manager";
  agentRole: "architecture";
  /** REQUIRED — the memory scope the plan is grounded in (children inherit it). */
  scopePath: string;
  /** The user's free-text ask, e.g. "plan the billing service rearchitecture". */
  prompt: string;
  /** Optional extra framing, passed through to every child. */
  context?: string;
  /** Internal user id who started the run — re-mints the scoped capability in each child. */
  triggeredBy: string;
}

export interface CreateArchManagerRunInput {
  orgId: string;
  agentId: string;
  triggeredBy: string;
  scopePath: string;
  prompt: string;
  context?: string;
}

export async function createArchManagerRun(input: CreateArchManagerRunInput): Promise<string> {
  const meta: ArchManagerMeta = {
    type: "arch-manager",
    agentRole: "architecture",
    scopePath: input.scopePath,
    prompt: input.prompt,
    context: input.context,
    triggeredBy: input.triggeredBy,
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
type RunRow = NonNullable<Awaited<ReturnType<typeof db.agentRun.findUnique>>>;

function metaOf(run: RunRow): ArchManagerMeta {
  return run.meta as unknown as ArchManagerMeta;
}

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
  if (!row) throw new Error("agent not found for arch manager run");
  if (!row.active) throw new AgentDeactivatedError();
  return row;
}

// ---------------------------------------------------------------------------
// THE ARCH DRIVER — plan (fixed buckets) → execute (drive ≤5 children in parallel) → finalize
// (fold + one contradiction pass). Single round. Catches its own errors + flips to failed.
// Called only via manager.driveManager (which provides the re-entrancy guard).
// ---------------------------------------------------------------------------

export async function runArchManager(runId: string): Promise<void> {
  try {
    const run = await db.agentRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const meta = metaOf(run);
    // Before any child is created: fails the run if its agent has been deactivated.
    await loadAgentRow(run.agentId, run.orgId);

    // 1) PLANNING — the fixed ≤5 domain-bucket decomposition. Each bucket becomes a child run
    // + a matching parent PlanItem marked `parallel` (itemId = childRunId) for the fan-out band.
    await emit(run.id, { type: "phase", phase: "planning" });
    const plan: AgentRunPlan = { runId: run.id, agentRole: "architecture", items: [], revision: 0 };
    const children: { childRunId: string; bucket: (typeof ARCH_CHILD_BUCKETS)[number]; index: number }[] = [];
    for (const bucket of ARCH_CHILD_BUCKETS) {
      const childRunId = await createArchChild(run, meta, bucket);
      const index = plan.items.length;
      const item: PlanItem = {
        id: childRunId,
        kind: "section",
        title: bucket.title,
        detail: `Plan the ${bucket.domains.map((d) => ARCH_DOMAIN_LABEL[d]).join(" + ")} domain(s).`,
        status: "pending",
        origin: "agent",
        parallel: true,
        childRunId,
      };
      plan.items.push(item);
      children.push({ childRunId, bucket, index });
    }
    plan.revision += 1;
    await db.agentRun.update({
      where: { id: run.id },
      data: { plan: plan as unknown as object, revision: plan.revision, phase: "executing" },
    });
    await emit(run.id, { type: "plan", plan });
    await emit(run.id, { type: "phase", phase: "executing" });
    for (const c of children) {
      await emit(run.id, { type: "step_started", itemId: c.childRunId, index: c.index, title: c.bucket.title });
    }

    // 2) EXECUTING — drive all children in parallel; collect their fragments keyed by bucket
    // index so the fold sees them in deterministic domain order regardless of finish order.
    const collected: (BriefFragment[] | undefined)[] = new Array(children.length);
    await Promise.all(
      children.map(async (c) => {
        await emit(run.id, {
          type: "step_progress",
          itemId: c.childRunId,
          message: `Dispatched architecture child: ${c.bucket.title}`,
        });
        try {
          await dispatchChild(c.childRunId, run.orgId);
          const fragments = await childFragments(c.childRunId);
          collected[c.index] = fragments;
          await markItem(run.id, c.childRunId, "done");
          await emit(run.id, {
            type: "step_completed",
            itemId: c.childRunId,
            fragment: {
              as: "section",
              heading: c.bucket.title,
              content: `${fragments.length} fragment(s) planned for ${c.bucket.domains
                .map((d) => ARCH_DOMAIN_LABEL[d])
                .join(", ")}.`,
            },
          });
        } catch (e) {
          collected[c.index] = [];
          await markItem(run.id, c.childRunId, "failed");
          await emit(run.id, {
            type: "step_failed",
            itemId: c.childRunId,
            error: e instanceof Error ? e.message : "architecture child run failed",
          });
        }
      }),
    );
    const allFragments: BriefFragment[] = collected.flatMap((f) => f ?? []);

    // 3) FINALIZING — one manager-level contradiction pass, then fold into ONE brief.
    await db.agentRun.update({ where: { id: run.id }, data: { phase: "finalizing" } });
    await emit(run.id, { type: "phase", phase: "finalizing" });
    await finalize(run, meta, allFragments);
  } catch (e) {
    await failRun(runId, e);
  }
}

async function failRun(runId: string, e: unknown) {
  const message = e instanceof Error ? e.message : "arch manager run failed";
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
// Child creation — an ordinary architecture-interactive run PROMPT-STEERED to a domain subset
// (§3 MVV — no run-loop change; the typed `domains?` on ArchRunMeta is the deferred fast-follow).
// autopilot: true so the child never pauses for clarification (children run headless).
// ---------------------------------------------------------------------------

async function createArchChild(
  run: RunRow,
  meta: ArchManagerMeta,
  bucket: (typeof ARCH_CHILD_BUCKETS)[number],
): Promise<string> {
  const domainList = bucket.domains.map((d) => ARCH_DOMAIN_LABEL[d]).join(", ");
  const steer =
    `\n\nMANAGER DIRECTIVE: For THIS run, plan ONLY the following architecture domain(s): ${domainList}.` +
    ` Omit every other domain entirely — sibling agents own them. Produce only the sections/diagram/` +
    `decisions/milestones that belong to these domain(s).`;
  const childMeta: ArchRunMeta = {
    type: "architecture-interactive",
    agentRole: "architecture",
    scopePath: meta.scopePath,
    prompt: `${meta.prompt}${steer}`,
    context: meta.context,
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

/** Dispatch a child to a terminal phase. Bypass (repo convention) drives inline; else fire the
 *  shared child Inngest job (drives ANY interactive child via driveRun) then poll to terminal. */
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
  const deadline = Date.now() + ARCH_MANAGER_CONFIG.CHILD_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await db.agentRun.findUnique({ where: { id: childRunId }, select: { status: true, phase: true } });
    if (!r) return;
    if (r.status === "completed" || r.status === "failed" || r.phase === "done" || r.phase === "failed") return;
    await new Promise((res) => setTimeout(res, ARCH_MANAGER_CONFIG.POLL_INTERVAL_MS));
  }
}

/** Read a completed child's typed BriefFragments from its persisted plan (PlanItem.result). */
async function childFragments(childRunId: string): Promise<BriefFragment[]> {
  const r = await db.agentRun.findUnique({ where: { id: childRunId }, select: { plan: true } });
  const plan = r?.plan as unknown as AgentRunPlan | null;
  if (!plan) return [];
  return plan.items.filter((i) => i.status === "done" && i.result).map((i) => i.result as BriefFragment);
}

async function markItem(runId: string, itemId: string, status: PlanItem["status"]): Promise<void> {
  const fresh = await db.agentRun.findUnique({ where: { id: runId }, select: { plan: true } });
  const plan = fresh?.plan as unknown as AgentRunPlan | null;
  if (!plan) return;
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = status;
  await db.agentRun.update({ where: { id: runId }, data: { plan: plan as unknown as object } });
}

// ---------------------------------------------------------------------------
// Manager-level contradiction pass — the Arch analogue of QA's adversarial verify, but lighter:
// reconcile (don't reproduce). One tool-free LLM step over the UNION of child section content,
// flagging genuine cross-child contradictions. Best-effort; a failure yields no contradictions.
// ---------------------------------------------------------------------------

async function contradictionPass(
  run: RunRow,
  meta: ArchManagerMeta,
  fragments: BriefFragment[],
): Promise<Contradiction[]> {
  const sections = fragments.filter((f): f is Extract<BriefFragment, { as: "section" }> => f.as === "section");
  if (sections.length < 2) return [];
  const agentRow = await loadAgentRow(run.agentId, run.orgId);
  const agent = buildMastraAgent(agentRow); // tool-free reconciliation — no memory reads
  const rc = buildRuntimeContext({
    orgId: run.orgId,
    actorId: ARCHITECTURE_AGENT_ID,
    actorName: ARCHITECTURE_AGENT_NAME,
  });
  const union = sections.map((s) => `## ${s.heading}\n${s.content}`).join("\n\n");
  const prompt =
    `You are the ARCHITECTURE MANAGER reconciling ${sections.length} domain sections that ` +
    `independent child agents produced for "${meta.prompt}" (scope ${meta.scopePath}). Identify ` +
    `genuine CONTRADICTIONS across the sections — a claim in one that conflicts with another ` +
    `(e.g. the API assumes an entity the data model omits). Reconcile, do NOT re-plan or reproduce ` +
    `the work. Return an empty list if the sections are consistent.\n\n${union}`;
  try {
    const res = await agent.generate(prompt, { runtimeContext: rc, output: ARCH_CONTRADICTION_SCHEMA });
    const obj = (res as { object?: z.infer<typeof ARCH_CONTRADICTION_SCHEMA> }).object;
    return (obj?.contradictions ?? []).map((c) => ({ factA: c.factA, factB: c.factB, note: c.note }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FINALIZE — fold child fragments (+ manager contradictions) into ONE architecture_plan Brief
// via run-loop's shared `foldArchFragments`, meter it ONCE (children skipped the meter, §2),
// link it, emit done. The SOLE meter for the whole managed run.
// ---------------------------------------------------------------------------

async function finalize(run: RunRow, meta: ArchManagerMeta, fragments: BriefFragment[]): Promise<void> {
  const contradictions = await contradictionPass(run, meta, fragments);
  const contradictionFragments: BriefFragment[] = contradictions.map((c) => ({
    as: "contradiction",
    factA: c.factA,
    factB: c.factB,
    note: c.note,
  }));

  // Fold reuses the single-agent path's logic; give it an ArchRunMeta view of the manager meta.
  const archMeta: ArchRunMeta = {
    type: "architecture-interactive",
    agentRole: "architecture",
    scopePath: meta.scopePath,
    prompt: meta.prompt,
    context: meta.context,
    triggeredBy: meta.triggeredBy,
  };
  const { sections, diagram, diagramUrl, milestones, decisions, charts, title, summary } = foldArchFragments(
    [...fragments, ...contradictionFragments],
    archMeta,
  );

  const dbBrief = await createBrief(
    {
      orgId: run.orgId,
      type: "architecture_plan",
      scopePath: meta.scopePath,
      title,
      summary,
      sections: sections as unknown as object,
      diagram,
      diagramUrl,
      milestones: milestones.length ? (milestones as unknown as object) : undefined,
      charts: charts as unknown as object,
      decisions: decisions.length ? (decisions as unknown as object) : undefined,
    },
    { actorType: "agent", actorId: run.agentId, origin: "agent-run" },
  );

  // The SOLE meter for the managed run — children skipped it (run-loop isChildRun guard, §2).
  await recordArtifactUsage({
    orgId: run.orgId,
    artifactType: "architecture_plan",
    briefId: dbBrief.id,
    scopePath: meta.scopePath,
  });

  await db.agentRun.update({
    where: { id: run.id },
    data: { phase: "done", status: "completed", briefId: dbBrief.id, finishedAt: new Date() },
  });

  const brief: Brief = {
    id: dbBrief.id,
    type: "architecture_plan" as BriefType,
    scopePath: meta.scopePath,
    title,
    summary,
    sections,
    diagram,
    diagramUrl,
    milestones: milestones.length ? milestones : null,
    contradictions: contradictions.length ? contradictions : null,
    charts,
    decisions: decisions.length ? decisions : null,
    createdAt: dbBrief.createdAt.toISOString(),
  };
  await emit(run.id, { type: "done", briefId: dbBrief.id, brief });
  await emit(run.id, { type: "phase", phase: "done" as RunPhase });
}
