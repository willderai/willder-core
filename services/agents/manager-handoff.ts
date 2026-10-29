// HANDOFF (BRIEFING) MANAGER engine — the ONE-SHOT analogue of the QA (manager.ts) and
// Architecture (manager-arch.ts) fan-out managers. Flag-gated (HANDOFF_MANAGER, default OFF),
// backend-only, ADDITIVE. The single-agent `runHandoffAgent` stays the DEFAULT.
//
// Handoff is NON-INTERACTIVE: unlike QA/Arch there is no AgentRun, no run-loop, no workspace,
// no live event stream — the route calls the runner synchronously and persists the returned
// HandoffBrief. So this manager is deliberately LIGHTER than its siblings: it fans a briefing
// out into ≤5 INDEPENDENT domain sub-agents, each a two-call memory retrieve→structure over the
// SAME scoped capability/memoryScope with a domain-focused prompt, then FOLDS the child
// fragments into ONE HandoffBrief the route persists exactly as the single-agent path does.
//
// Decomposition: a fixed ≤5 domain-bucket grouping (a CEILING, not a target). Depth is capped
// at 1 — children are plain retrieve→structure calls that never spawn their own children.
//
// METERING: there is NO double-metering caveat here (unlike manager-arch/manager, whose children
// are full AgentRuns that must skip the meter via run-loop's isChildRun guard). Handoff children
// never persist a Brief nor call recordArtifactUsage — they only return HandoffBrief fragments in
// memory. The ROUTE persists ONE folded brief and meters it ONCE, identical to the single-agent
// path, so the meter fires exactly once regardless of fan-out.
import {
  buildMastraAgent,
  buildRuntimeContext,
  HANDOFF_OUTPUT_SCHEMA,
  type HandoffAgentOptions,
  type HandoffBrief,
} from "@/services/agents/runner";
import { HANDOFF_AGENT_ID, HANDOFF_AGENT_NAME } from "@/lib/handoff-agent";

// ---------------------------------------------------------------------------
// FLAG — read EXACTLY like archManagerEnabled() in manager-arch.ts. Default OFF; flip
// HANDOFF_MANAGER to true/1/on/yes to enable the fan-out branch on the handoff route.
// ---------------------------------------------------------------------------

export function handoffManagerEnabled(): boolean {
  const v = process.env.HANDOFF_MANAGER?.toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

// ---------------------------------------------------------------------------
// Config — the fixed ≤5 domain buckets for onboarding a person. A CEILING (5), not a target:
// a bucket memory has nothing for yields an empty child that simply contributes no sections,
// so fan-out degrades gracefully. Each child is prompt-steered to ONLY its domain.
// ---------------------------------------------------------------------------

export const HANDOFF_MANAGER_CONFIG = {
  /** Hard child-count cap (≈ a manager's span-of-control). A ceiling, not a target. */
  MAX_CHILDREN: 5,
  /** Per-child memory-retrieval step budget (mirrors runHandoffAgent's maxSteps). */
  CHILD_MAX_STEPS: 12,
} as const;

export interface HandoffBucket {
  title: string;
  /** What this child should retrieve + write — folded into the domain-steer prompt. */
  focus: string;
}

/** The ≤5 independent onboarding domains. Order here is the fold's section order. */
export const HANDOFF_BUCKETS: HandoffBucket[] = [
  {
    title: "Architecture & systems",
    focus: "the system architecture, services, data model, and how the pieces fit together",
  },
  {
    title: "Conventions & practices",
    focus: "team conventions, coding/process practices, tooling, and ways of working",
  },
  {
    title: "Current projects / sprint",
    focus: "what is being worked on right now — active projects, the current sprint, priorities, and deadlines",
  },
  { title: "People & contacts", focus: "who's who — key people, owners, points of contact, and who to ask about what" },
  {
    title: "Risks & gotchas",
    focus: "risks, gotchas, known pitfalls, fragile areas, and anything that commonly trips new people up",
  },
];

// ---------------------------------------------------------------------------
// runHandoffManager — fan a briefing into ≤5 domain children (parallel, per-child failure
// tolerant), then fold into ONE HandoffBrief. Same options as runHandoffAgent so the route
// can swap it in place. Returns the folded brief; the route persists + meters it once.
// ---------------------------------------------------------------------------

export async function runHandoffManager(opts: HandoffAgentOptions): Promise<HandoffBrief> {
  const buckets = HANDOFF_BUCKETS.slice(0, HANDOFF_MANAGER_CONFIG.MAX_CHILDREN);

  // Drive all domain children in parallel. A child failure MUST NOT sink the whole run —
  // catch per child, yield null, and fold whatever survived (mirrors manager-arch's tolerance).
  const results = await Promise.all(buckets.map((bucket) => runDomainChild(opts, bucket)));

  const fragments: { bucket: HandoffBucket; brief: HandoffBrief }[] = [];
  results.forEach((brief, i) => {
    if (brief) fragments.push({ bucket: buckets[i], brief });
  });

  return foldHandoffFragments(opts, fragments);
}

// ---------------------------------------------------------------------------
// One domain child — the two-call retrieve→structure pattern (same reason as runHandoffAgent:
// a single {output} call puts the model in JSON mode that unreliably disables tool use), but
// prompt-steered to ONLY this bucket's domain. Best-effort: any error yields null (skip child).
// ---------------------------------------------------------------------------

async function runDomainChild(opts: HandoffAgentOptions, bucket: HandoffBucket): Promise<HandoffBrief | null> {
  try {
    const agent = buildMastraAgent(opts.agentRow);
    const rc = buildRuntimeContext({
      orgId: opts.orgId,
      actorId: HANDOFF_AGENT_ID,
      actorName: HANDOFF_AGENT_NAME,
      capabilityToken: opts.capabilityToken,
      memoryScope: opts.memoryScope,
      sourcesRead: opts.sourcesRead,
    });

    const who =
      `${opts.granteeName}${opts.granteeRole ? ` (${opts.granteeRole})` : ""}` +
      (opts.context ? `. Context: ${opts.context}` : "");
    const steer =
      `MANAGER DIRECTIVE: For THIS briefing, focus ONLY on ${bucket.focus}. ` +
      `Omit every other domain entirely — sibling agents own them.`;

    opts.onProgress?.(`Reading memory for ${bucket.title}…`);
    // (1) retrieve WITH tools, no schema — so memory_read actually runs.
    const acted = await agent.generate(
      `Generate the "${bucket.title}" portion of an onboarding briefing for ${who}. ${steer} ` +
        `Use memory_read to retrieve everything relevant to this domain before writing.`,
      { runtimeContext: rc, maxSteps: HANDOFF_MANAGER_CONFIG.CHILD_MAX_STEPS },
    );
    const observations = (acted as { text?: string }).text ?? "";

    // (2) structure those retrieved facts into the briefing schema — no tools needed.
    const result = await agent.generate(
      `Based ONLY on what you retrieved from memory below, write the "${bucket.title}" portion of the onboarding briefing ` +
        `for ${who}. ${steer} Ground every point in the retrieved facts; never invent facts, systems, or people. ` +
        `If memory has nothing relevant for this domain, return an empty sections array.\n\n` +
        `Retrieved context:\n${observations}`,
      { runtimeContext: rc, output: HANDOFF_OUTPUT_SCHEMA },
    );
    const obj = (result as { object?: HandoffBrief }).object;
    return obj ?? null;
  } catch {
    return null; // per-child failure tolerated — the fold proceeds without this domain.
  }
}

// ---------------------------------------------------------------------------
// FOLD — merge child fragments into ONE HandoffBrief. Sections concatenate in bucket order
// (deduped by heading); a combined title + summary are synthesized; focusAreas / rampPlan are
// unioned across children where present. Deterministic — no extra LLM call (parity with
// foldArchFragments). Empty fan-out yields a valid, honest "nothing found" brief.
// ---------------------------------------------------------------------------

export function foldHandoffFragments(
  opts: Pick<HandoffAgentOptions, "granteeName" | "granteeRole">,
  fragments: { bucket: HandoffBucket; brief: HandoffBrief }[],
): HandoffBrief {
  const title = `Onboarding briefing for ${opts.granteeName}` + (opts.granteeRole ? ` (${opts.granteeRole})` : "");

  // Sections: keep bucket order, dedupe by normalized heading (first writer wins).
  const sections: HandoffBrief["sections"] = [];
  const seenHeadings = new Set<string>();
  for (const { brief } of fragments) {
    for (const s of brief.sections ?? []) {
      const key = s.heading.trim().toLowerCase();
      if (!s.content.trim() || seenHeadings.has(key)) continue;
      seenHeadings.add(key);
      sections.push(s);
    }
  }

  // Summary: synthesize from the child summaries (deduped, non-empty), capped for length.
  const childSummaries = fragments.map((f) => f.brief.summary?.trim()).filter((s): s is string => !!s);
  const uniqueSummaries = Array.from(new Set(childSummaries));
  const summary =
    uniqueSummaries.length > 0
      ? `Onboarding briefing for ${opts.granteeName}, folded from ${fragments.length} domain area(s). ` +
        uniqueSummaries.join(" ")
      : `Onboarding briefing for ${opts.granteeName}. No relevant memory was found in the granted scope for the briefing domains.`;

  // Diagram: first non-empty child diagram (a single briefing carries at most one).
  const diagram = fragments.map((f) => f.brief.diagram).find((d) => !!d && d.trim());

  // focusAreas: union across children, dedupe by label (keep the highest weight).
  const focusByLabel = new Map<string, { label: string; weight: number }>();
  for (const { brief } of fragments) {
    for (const fa of brief.focusAreas ?? []) {
      const key = fa.label.trim().toLowerCase();
      const prev = focusByLabel.get(key);
      if (!prev || fa.weight > prev.weight) focusByLabel.set(key, { label: fa.label, weight: fa.weight });
    }
  }
  const focusAreas = [...focusByLabel.values()];

  // rampPlan: concatenate in bucket order, dedupe by milestone (first writer wins).
  const rampPlan: NonNullable<HandoffBrief["rampPlan"]> = [];
  const seenMilestones = new Set<string>();
  for (const { brief } of fragments) {
    for (const m of brief.rampPlan ?? []) {
      const key = m.milestone.trim().toLowerCase();
      if (seenMilestones.has(key)) continue;
      seenMilestones.add(key);
      rampPlan.push(m);
    }
  }

  return {
    title,
    summary,
    sections,
    ...(diagram ? { diagram } : {}),
    ...(focusAreas.length ? { focusAreas } : {}),
    ...(rampPlan.length ? { rampPlan } : {}),
  };
}
