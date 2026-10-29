// Interactive agent-loop contract. Single source of truth shared by the three
// parallel builders: the loop substrate (services/agents/loop.ts + the /loop
// routes) that EMITS these, the workspace UI that CONSUMES them, and the
// chart/document layer that renders the artifact. Frontend-safe (no runtime
// deps, no prisma import) so both server and client import the same shapes.
//
// Reconciles three designs — treat this file as frozen once builders start:
//   - docs/design_interactive_agent_loop.md    (RunEvent wire contract, plan/step/pause)
//   - docs/design_agent_workspace_ux.md         (ClarifyQuestion / ClarifyOption / topics)
//   - docs/design_doc_chart_generation.md        (ChartSpec union, Brief.charts/decisions)
//
// Design rule that runs through everything: a recommendation is the agent's INPUT
// (common practice / an assumption), NOT a confirmed org fact. Every recommended
// default carries `source` so the UI renders the two visibly distinct and never
// dresses a recommendation up as something the org already decided.

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Which agent role this run is executing. Mirrors prisma `AgentRole` (architecture|qa). */
export type AgentRole = "architecture" | "qa";

/**
 * Finer-grained run lifecycle than the coarse `AgentRunStatus` (running|completed|failed).
 * Persisted on `AgentRun.phase` (nullable — legacy one-shot runs have no phase). This is
 * also the value carried by the `phase` RunEvent; treat the set as the frozen wire contract.
 */
export type RunPhase =
  | "planning" // agent emitted the PLAN; nothing executed yet (user may edit)
  | "consulting" // clarify ↔ resume cycles: gather numbers, present options + recommendation
  | "executing" // walking the plan one PlanItem at a time
  | "paused" // a needs_input checkpoint is open; state lives in Postgres
  | "finalizing" // folding fragments into the canonical Brief
  | "done" // terminal
  | "failed"; // terminal

/**
 * Provenance of a recommended default. A retrieved memory fact is a confirmed org
 * FACT; anything from common practice / an assumption is the agent's RECOMMENDATION.
 * The consulting phase keeps the two visibly distinct and never presents one as the other.
 */
export type RecommendationSource = "recommendation" | "fact";

/** design.md color tokens usable as a chart/point accent — never raw hex. */
export type AccentToken = "gold" | "ember" | "brick" | "gunpowder";

// ---------------------------------------------------------------------------
// PLAN / STEP schema  (design_interactive_agent_loop.md §2.2)
// ---------------------------------------------------------------------------

/** The kind of work one plan item performs. Architecture kinds + QA kinds. */
export type PlanItemKind =
  // Architecture
  | "section" // produce one plan section (System design, Data model, …)
  | "decision" // an options-comparison decision (chart-gen §0.1)
  | "diagram" // Mermaid diagram
  | "milestones" // delivery schedule
  | "contradiction-scan" // sweep retrieved facts for conflicts
  // QA
  | "scenario" // one test scenario / behavior to exercise
  | "endpoint-probe" // hit a specific endpoint/flow with a technique
  | "perf-measure" // record latency/error-rate for exercised endpoints
  | "spec-check"; // check product vs a stored spec / acceptance criterion

export type PlanItemStatus = "pending" | "active" | "done" | "skipped" | "failed";

/** One item in the ordered checklist the agent produces and the user can steer. */
export interface PlanItem {
  /** Stable cuid; survives reorder/edit so events + fragments stay bound to it. */
  id: string;
  kind: PlanItemKind;
  /** Human-readable ("Probe POST /checkout with bad input"). */
  title: string;
  /** Agent's intent, or the user's added instruction. */
  detail?: string;
  status: PlanItemStatus;
  /** Provenance — user-added items are tracked separately from agent-planned ones. */
  origin: "agent" | "user";
  /** Partial artifact this item produced once done. Persisted on PlanItem.result. */
  result?: BriefFragment;
  /** Set by the manager: this item is one parallel child sub-agent. Absent ⇒ single-agent render. */
  parallel?: boolean;
  /** The child AgentRun id this item drives (equals `id` today; explicit for clarity). */
  childRunId?: string;
}

/** The full plan for a run. `revision` guards optimistic-concurrency on live edits (§5). */
export interface AgentRunPlan {
  runId: string;
  agentRole: AgentRole;
  items: PlanItem[];
  /** Bumped on every applied plan edit; the edit endpoint rejects stale baseRevisions. */
  revision: number;
}

// ---------------------------------------------------------------------------
// BRIEF FRAGMENTS  — a completed item's partial contribution to the Brief.
// Shapes reuse existing Brief/QaReport/ArchitecturePlan fields so finalizing
// is a FOLD of fragments into the same Brief columns, not a translation.
// (design_interactive_agent_loop.md §2.2)
// ---------------------------------------------------------------------------

/** One option inside a decision — carries the trade-offs the human weighs, not a bare label. */
export interface DecisionOption {
  id: string;
  label: string;
  pros?: string;
  cons?: string;
  cost?: string;
  /** What most teams do at this scale. */
  commonPractice?: string;
  /** A concrete real-world example. */
  example?: string;
  /** The agent's pre-selected pick (mirror of `recommendation.optionId`). */
  recommended?: boolean;
}

/**
 * A decision point the human resolves — the consultative artifact (§2.1). Isomorphic to
 * chart-gen's decisions[] (§0.1). The `recommendation` is the agent's RECOMMENDATION,
 * NOT a confirmed org fact; it becomes a confirmed decision only once the human accepts it
 * (`chosenOptionId` set), which then routes to the correction/dispute loop (UC9).
 */
export interface DecisionFragment {
  as: "decision";
  question: string;
  options: DecisionOption[];
  recommendation: { optionId: string; rationale: string };
  /** Set once the human DECIDEs — may differ from the recommended option. */
  chosenOptionId?: string;
}

/** The union of what a completed plan item can add to the Brief. */
export type BriefFragment =
  | { as: "section"; heading: string; content: string } // → Brief.sections[]
  | { as: "milestones"; milestones: Milestone[] } // → Brief.milestones
  | { as: "diagram"; diagram: string } // → Brief.diagram
  | DecisionFragment // → Brief.decisions[]
  | { as: "contradiction"; factA: string; factB: string; note: string }
  | {
      as: "bug";
      severity: "blocker" | "major" | "minor";
      priority?: "high" | "medium" | "low";
      technique?: string;
      finding: string;
      repro: string;
      observed: string;
      expected: string;
    }
  | {
      as: "performance";
      endpoint: string;
      samples: number;
      p50LatencyMs: number;
      maxLatencyMs: number;
      errorRate: number;
    }
  | { as: "chart"; chart: ChartSpec }; // → Brief.charts[]

// ---------------------------------------------------------------------------
// CLARIFICATION  — just-in-time typed questions (workspace-ux §3 shapes,
// reconciled with the loop doc's recommendedDefault + FACT/RECOMMENDATION rule).
// ---------------------------------------------------------------------------

/** What a clarification question is gathering — lets the UI group the scale NUMBERS both agents need. */
export type ClarifyTopic =
  | "scale"
  | "traffic"
  | "team"
  | "growth"
  | "sla"
  | "cost"
  | "release-criticality"
  | "decision"
  | "scope"
  | "other";

/** One selectable option on a clarification question — surfaces trade-offs inline, not a bare label. */
export interface ClarifyOption {
  value: string;
  label: string;
  detail?: string;
  pros?: string;
  cons?: string;
  cost?: string;
  commonPractice?: string;
  example?: string;
}

/**
 * A single structured, typed question. Every question carries a `recommended` default —
 * the option/value the agent recommends, pre-selected on render (one-click accept). The
 * `rationale` is the one-liner the card shows; `source` marks it as the agent's
 * RECOMMENDATION vs a retrieved FACT (only "fact" when a memory fact already answers it).
 * Free text is allowed ONLY for the `text` kind.
 */
export type ClarifyQuestion =
  | {
      id: string;
      kind: "single"; // radio cards
      prompt: string;
      help?: string;
      topic?: ClarifyTopic;
      options: ClarifyOption[];
      recommended: { value: string; rationale: string; source: RecommendationSource };
      allowOther?: boolean;
    }
  | {
      id: string;
      kind: "multi"; // checkbox cards
      prompt: string;
      help?: string;
      topic?: ClarifyTopic;
      options: ClarifyOption[];
      recommended: { values: string[]; rationale: string; source: RecommendationSource };
      min?: number;
      max?: number;
    }
  | {
      id: string;
      kind: "value"; // pre-filled input (date/text)
      prompt: string;
      help?: string;
      topic?: ClarifyTopic;
      inputType: "date" | "text";
      unit?: string;
      placeholder?: string;
      recommended: { value: string; rationale: string; source: RecommendationSource };
    }
  | {
      id: string;
      kind: "number"; // pre-filled numeric input (e.g. tenants, req/s, p95 ms)
      prompt: string;
      help?: string;
      topic?: ClarifyTopic;
      unit?: string;
      placeholder?: string;
      recommended: { value: number; rationale: string; source: RecommendationSource };
    }
  | {
      id: string;
      kind: "text"; // the only free-text path
      prompt: string;
      help?: string;
      placeholder?: string;
      maxLen?: number;
      recommended?: { value: string; rationale: string; source: RecommendationSource };
    };

/**
 * A clarification carries one or more STRUCTURED questions. Persisted to
 * `AgentRun.pendingInput` while paused. `checkpointId` is the stable id the resume
 * references (a duplicate resume with the same id is a no-op).
 */
export interface ClarificationRequest {
  checkpointId: string;
  /** The plan item that got stuck, if any. */
  itemId?: string;
  /** true = the run is paused until answered (blocking); false = deferrable inline ask. */
  blocking: boolean;
  /** Usually 1; small batches allowed (e.g. the scale numbers gathered together). */
  questions: ClarifyQuestion[];
}

/**
 * POST .../resume body: one answer per question. An "accept all defaults" resume can omit
 * answers the human never touched — the loop fills them from each question's `recommended`
 * default and records them as agent assumptions (RECOMMENDATION, not FACT).
 */
export interface ResumePayload {
  checkpointId: string;
  answers: {
    questionId: string;
    /** true = took the recommendation as-is (one-click accept-and-proceed). */
    acceptedDefault?: boolean;
    answer?:
      | { kind: "single"; optionId: string }
      | { kind: "multi"; optionIds: string[] }
      | { kind: "value"; value: string }
      | { kind: "number"; value: number }
      | { kind: "text"; value: string };
  }[];
}

// ---------------------------------------------------------------------------
// BRIEF artifact shape  — the assembled output the loop folds fragments into and
// the workspace renders progressively. Frontend-facing view of the persisted
// Brief plus the chart-gen additions (charts, decisions).
// ---------------------------------------------------------------------------

export interface BriefSection {
  heading: string;
  content: string;
}

export interface Milestone {
  label: string;
  dueDate?: string;
}

export interface Contradiction {
  factA: string;
  factB: string;
  note: string;
}

export type BriefType = "handoff" | "architecture_plan" | "qa_review";

/** The canonical assembled artifact (mirrors prisma `Brief` + chart-gen's charts/decisions). */
export interface Brief {
  id: string;
  type: BriefType;
  scopePath: string;
  /** Human-readable target label for a scope-less QA run; null once scopePath
   * already holds a real memory scope. Display-only. */
  scopeLabel?: string | null;
  title: string;
  summary: string;
  sections: BriefSection[];
  diagram?: string | null;
  diagramUrl?: string | null;
  googleDocUrl?: string | null;
  milestones?: Milestone[] | null;
  contradictions?: Contradiction[] | null;
  /** ChartSpec[] — client-rendered SVG; NO server image rendering. */
  charts?: ChartSpec[] | null;
  /** Architecture options-comparison artifacts (chart-gen §0.1). */
  decisions?: DecisionFragment[] | null;
  createdAt?: string;
}

/**
 * The running assembly re-emitted (debounced) as fragments land so the workspace's
 * BriefView / ChartBlock redraw live. Every field is optional — the brief is still building.
 */
export type PartialBrief = Partial<
  Pick<Brief, "title" | "summary" | "sections" | "milestones" | "diagram" | "contradictions">
> & { charts?: ChartSpec[] };

// ---------------------------------------------------------------------------
// RUN EVENT  — the streamed wire contract (SSE `event: <type>` / `data: <json>`).
// Every event carries a monotonic `seq` so a reconnecting client requests
// ?afterSeq=N and replays only what it missed. (design_interactive_agent_loop.md §2.3)
// Treat this union as FROZEN once shipped — it is the interface between the loop
// substrate and the workspace UI.
// ---------------------------------------------------------------------------

export type RunEvent = { seq: number; runId: string; at: string } & (
  | { type: "plan"; plan: AgentRunPlan } // initial plan OR full replacement
  | { type: "plan_updated"; plan: AgentRunPlan; reason: "user_edit" | "agent_replan" }
  | { type: "phase"; phase: RunPhase }
  | { type: "step_started"; itemId: string; index: number; title: string }
  | { type: "step_progress"; itemId: string; message: string } // tool-call narration
  | { type: "step_completed"; itemId: string; fragment?: BriefFragment } // partial artifact → live render
  | { type: "step_failed"; itemId: string; error: string }
  | { type: "needs_input"; checkpoint: ClarificationRequest } // → phase becomes "paused"
  | { type: "resumed"; checkpointId: string }
  | { type: "artifact"; partial: PartialBrief } // cumulative brief-so-far
  | { type: "done"; briefId: string; brief: Brief }
  | { type: "error"; message: string }
  | { type: "heartbeat" } // keepalive to hold the SSE / proxies open
);

// ---------------------------------------------------------------------------
// CHART SPEC  — small discriminated union, client-rendered to SVG. NO server-side
// image rendering (honors docs/demo-seed/07_contradiction_demo.md). Derive
// deterministically from structured data; never let the LLM invent chart numbers.
// (design_doc_chart_generation.md §A.2)
// ---------------------------------------------------------------------------

export interface ChartSeriesPoint {
  /** Category / x value (also the accessible row label). */
  label: string;
  value: number;
  /** Optional grouped/stacked values under named measures, e.g. { "p50": 120, "max": 900 }. */
  measures?: Record<string, number>;
}

export type ChartSpec =
  | {
      kind: "bar" | "histogram";
      title: string;
      unit?: string; // "ms", "count", "%"
      series: ChartSeriesPoint[];
      /** design.md token, never raw hex — renderer maps to CSS vars. */
      accent?: AccentToken;
      orientation?: "vertical" | "horizontal";
    }
  | {
      kind: "grouped-bar"; // e.g. QA latency p50 vs max per endpoint
      title: string;
      unit?: string;
      measures: string[]; // ordered measure keys, drive the legend
      series: ChartSeriesPoint[]; // each point carries `measures`
    }
  | {
      kind: "timeline"; // architecture milestones
      title: string;
      items: { label: string; date?: string }[];
    }
  | {
      kind: "funnel"; // governance dispute funnel
      title: string;
      stages: { label: string; value: number }[];
    }
  | {
      kind: "matrix"; // decision/risk matrix — the discuss-a-direction chart
      title: string;
      xAxis: { label: string; low: string; high: string }; // e.g. "Effort", low→high
      yAxis: { label: string; low: string; high: string }; // e.g. "Impact", low→high
      /** Each point is an option/risk placed in the grid; `accent` marks the recommended one. */
      points: { label: string; x: number; y: number; accent?: "gold" | "ember" | "brick" }[];
    };
