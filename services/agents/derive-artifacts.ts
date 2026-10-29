// Server-side chart DERIVATION for agent Briefs (docs/design_doc_chart_generation.md).
//
// Charts are DERIVED deterministically from the agents' existing structured output —
// never invented by the LLM. These are pure, typed functions with no I/O: they take the
// structured QA report / architecture plan an agent already produced and fold the numbers
// that are already in it into the `ChartSpec` union (types/agent-run.ts) that ChartBlock
// renders. Every number here comes from a field the agent emitted; nothing is fabricated.
//
// Guard rule: missing/empty inputs return `[]`, never throw. A chart is only produced when
// there is real data behind it, so an empty run yields no charts rather than empty axes.
import type { ChartSpec, DecisionFragment } from "@/types/agent-run";
import type { QaReport, ArchitecturePlan, HandoffBrief } from "@/services/agents/runner";

// The QA numbers we read. Both the one-shot report and the interactive fragments carry
// these exact field names, so either path can feed this without a translation layer.
type QaChartInput = Pick<QaReport, "bugs" | "performance">;

// Fixed severity order so the histogram buckets are stable across runs.
const BUG_SEVERITIES = ["blocker", "major", "minor"] as const;
const SEVERITY_LABEL: Record<(typeof BUG_SEVERITIES)[number], string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
};

/**
 * QA charts derived from the structured report:
 *  - severity histogram: count of bugs per blocker/major/minor (only when bugs exist).
 *  - latency grouped-bar: p50 vs max latency per endpoint (only when perf data exists).
 * Reads ONLY `bugs[].severity` and `performance[].{endpoint,p50LatencyMs,maxLatencyMs}`.
 */
export function deriveQaCharts(report: QaChartInput | null | undefined): ChartSpec[] {
  const charts: ChartSpec[] = [];
  if (!report) return charts;

  const bugs = report.bugs ?? [];
  if (bugs.length > 0) {
    charts.push({
      kind: "histogram",
      title: "Bugs by severity",
      unit: "count",
      accent: "ember",
      series: BUG_SEVERITIES.map((sev) => ({
        label: SEVERITY_LABEL[sev],
        value: bugs.filter((b) => b.severity === sev).length,
      })),
    });
  }

  const perf = report.performance ?? [];
  if (perf.length > 0) {
    charts.push({
      kind: "grouped-bar",
      title: "Latency by endpoint (p50 vs max)",
      unit: "ms",
      measures: ["p50", "max"],
      series: perf.map((p) => ({
        label: p.endpoint,
        // `value` is the row's headline magnitude (worst case); the p50/max split
        // lives in `measures`, which drives the grouped bars + legend.
        value: p.maxLatencyMs,
        measures: { p50: p.p50LatencyMs, max: p.maxLatencyMs },
      })),
    });
  }

  return charts;
}

// The architecture numbers we read. `ArchitecturePlan` (the one-shot schema) carries
// milestones + contradictions; the interactive finalize fold (WS1) also threads the
// collected DecisionFragments through so the decision matrix can be derived. `decisions`
// is optional so the existing one-shot caller (which passes an `ArchitecturePlan` with no
// decisions column) still type-checks and gets the timeline/contradiction charts unchanged.
type ArchitectureChartInput = Pick<ArchitecturePlan, "milestones" | "contradictions"> & {
  decisions?: DecisionFragment[] | null;
};

/**
 * Architecture charts derived from the structured plan:
 *  - timeline: one item per milestone (only when milestones exist).
 *  - contradiction-count bar: how many contradictions were flagged (only when any exist).
 *  - decision matrix: one `matrix` per decision, plotting its options on effort×impact,
 *    with the recommended option marked gold (only when a decision has ≥2 options).
 * Reads ONLY `milestones[].{label,dueDate}`, the length of `contradictions[]`, and
 * `decisions[].{options,recommendation.optionId}` — nothing here is LLM-invented.
 */
export function deriveArchitectureCharts(plan: ArchitectureChartInput | null | undefined): ChartSpec[] {
  const charts: ChartSpec[] = [];
  if (!plan) return charts;

  const milestones = plan.milestones ?? [];
  if (milestones.length > 0) {
    charts.push({
      kind: "timeline",
      title: "Delivery milestones",
      items: milestones.map((m) => ({ label: m.label, date: m.dueDate })),
    });
  }

  const contradictions = plan.contradictions ?? [];
  if (contradictions.length > 0) {
    charts.push({
      kind: "bar",
      title: "Contradictions found",
      unit: "count",
      accent: "brick",
      series: [{ label: "Contradictions", value: contradictions.length }],
    });
  }

  // Decision matrix (reuses the existing `matrix` ChartSpec kind — no new kinds). One
  // matrix per decision: each option becomes a point on an effort×impact grid, and the
  // recommended option is marked `gold`. Coordinates are STRUCTURAL, not LLM-scored:
  // options are listed leanest-first, so list order proxies effort (earlier ⇒ lower) and
  // its inverse proxies impact (earlier ⇒ higher). The load-bearing signal is the gold
  // marker on the recommended option; positions only spread the options across the grid.
  const decisions = plan.decisions ?? [];
  for (let di = 0; di < decisions.length; di++) {
    const d = decisions[di];
    const options = d.options ?? [];
    if (options.length < 2) continue; // a matrix needs at least two points to compare
    const recommendedId = d.recommendation?.optionId;
    charts.push({
      kind: "matrix",
      title: `Decision: ${d.question}`,
      xAxis: { label: "Effort", low: "Lower", high: "Higher" },
      yAxis: { label: "Impact", low: "Lower", high: "Higher" },
      points: options.map((o, i) => {
        const point: {
          label: string;
          x: number;
          y: number;
          accent?: "gold" | "ember" | "brick";
        } = {
          label: o.label,
          x: i,
          y: options.length - 1 - i,
        };
        if (recommendedId != null && o.id === recommendedId) point.accent = "gold";
        return point;
      }),
    });
  }

  return charts;
}

// The handoff numbers we read. Both fields are OPTIONAL on the brief — the model fills them
// only when the retrieved context genuinely supports a ranking / a sequence — so a briefing
// with nothing to chart simply yields no charts (never forced, never fabricated).
type HandoffChartInput = Pick<HandoffBrief, "focusAreas" | "rampPlan">;

/**
 * Handoff charts derived from the structured briefing:
 *  - onboarding focus-area bar: relative priority/emphasis per focus area (only when the
 *    model ranked focus areas — reads `focusAreas[].{label,weight}`).
 *  - onboarding ramp timeline: one item per sequenced step (only when a ramp exists —
 *    reads `rampPlan[].{milestone,week}`).
 * Every value comes straight from a field the handoff agent emitted; nothing is invented,
 * and missing/empty inputs return [] (parity with deriveQaCharts / deriveArchitectureCharts).
 */
export function deriveHandoffCharts(brief: HandoffChartInput | null | undefined): ChartSpec[] {
  const charts: ChartSpec[] = [];
  if (!brief) return charts;

  const focusAreas = brief.focusAreas ?? [];
  if (focusAreas.length > 0) {
    charts.push({
      kind: "bar",
      title: "Onboarding focus areas by priority",
      unit: "weight",
      accent: "gold",
      series: focusAreas.map((f) => ({ label: f.label, value: f.weight })),
    });
  }

  const rampPlan = brief.rampPlan ?? [];
  if (rampPlan.length > 0) {
    charts.push({
      kind: "timeline",
      title: "Onboarding ramp",
      items: rampPlan.map((m) => ({ label: m.milestone, date: m.week })),
    });
  }

  return charts;
}
