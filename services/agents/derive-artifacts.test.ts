// Tests for the server-side chart DERIVATION (services/agents/derive-artifacts.ts).
// Charts are folded deterministically from the agents' structured output; these assert the
// numbers come straight from the input fields and that empty/missing inputs yield [] (no throw).
import { describe, expect, it } from "vitest";
import { deriveQaCharts, deriveArchitectureCharts, deriveHandoffCharts } from "./derive-artifacts";

describe("deriveQaCharts", () => {
  it("builds a severity histogram with per-severity counts", () => {
    const charts = deriveQaCharts({
      bugs: [
        { severity: "blocker", finding: "", repro: "", observed: "", expected: "" },
        { severity: "major", finding: "", repro: "", observed: "", expected: "" },
        { severity: "major", finding: "", repro: "", observed: "", expected: "" },
        { severity: "minor", finding: "", repro: "", observed: "", expected: "" },
      ],
      performance: [],
    });

    const hist = charts.find((c) => c.kind === "histogram");
    expect(hist).toBeDefined();
    if (hist?.kind !== "histogram") throw new Error("expected histogram");
    expect(hist.unit).toBe("count");
    expect(hist.series).toEqual([
      { label: "Blocker", value: 1 },
      { label: "Major", value: 2 },
      { label: "Minor", value: 1 },
    ]);
  });

  it("builds a grouped-bar of p50/max latency per endpoint", () => {
    const charts = deriveQaCharts({
      bugs: [],
      performance: [
        { endpoint: "GET /search", samples: 10, p50LatencyMs: 120, maxLatencyMs: 900, errorRate: 0.1 },
        { endpoint: "POST /checkout", samples: 5, p50LatencyMs: 200, maxLatencyMs: 400, errorRate: 0 },
      ],
    });

    const grouped = charts.find((c) => c.kind === "grouped-bar");
    expect(grouped).toBeDefined();
    if (grouped?.kind !== "grouped-bar") throw new Error("expected grouped-bar");
    expect(grouped.unit).toBe("ms");
    expect(grouped.measures).toEqual(["p50", "max"]);
    expect(grouped.series).toEqual([
      { label: "GET /search", value: 900, measures: { p50: 120, max: 900 } },
      { label: "POST /checkout", value: 400, measures: { p50: 200, max: 400 } },
    ]);
  });

  it("returns [] for empty and missing input without throwing", () => {
    expect(deriveQaCharts({ bugs: [], performance: [] })).toEqual([]);
    expect(deriveQaCharts(null)).toEqual([]);
    expect(deriveQaCharts(undefined)).toEqual([]);
  });
});

describe("deriveArchitectureCharts", () => {
  it("builds a timeline from milestones", () => {
    const charts = deriveArchitectureCharts({
      milestones: [{ label: "MVP", dueDate: "2026-09-01" }, { label: "GA" }],
    });

    const timeline = charts.find((c) => c.kind === "timeline");
    expect(timeline).toBeDefined();
    if (timeline?.kind !== "timeline") throw new Error("expected timeline");
    expect(timeline.items).toEqual([
      { label: "MVP", date: "2026-09-01" },
      { label: "GA", date: undefined },
    ]);
  });

  it("builds a contradiction-count bar when contradictions exist", () => {
    const charts = deriveArchitectureCharts({
      contradictions: [
        { factA: "a", factB: "b", note: "n" },
        { factA: "c", factB: "d", note: "m" },
      ],
    });

    const bar = charts.find((c) => c.kind === "bar");
    expect(bar).toBeDefined();
    if (bar?.kind !== "bar") throw new Error("expected bar");
    expect(bar.series).toEqual([{ label: "Contradictions", value: 2 }]);
  });

  it("returns [] for empty and missing input without throwing", () => {
    expect(deriveArchitectureCharts({})).toEqual([]);
    expect(deriveArchitectureCharts({ milestones: [], contradictions: [] })).toEqual([]);
    expect(deriveArchitectureCharts(null)).toEqual([]);
    expect(deriveArchitectureCharts(undefined)).toEqual([]);
  });
});

describe("deriveHandoffCharts", () => {
  it("builds a priority bar from ranked focus areas", () => {
    const charts = deriveHandoffCharts({
      focusAreas: [
        { label: "Architecture & decisions", weight: 5 },
        { label: "Team conventions", weight: 3 },
        { label: "Product context", weight: 2 },
      ],
    });

    const bar = charts.find((c) => c.kind === "bar");
    expect(bar).toBeDefined();
    if (bar?.kind !== "bar") throw new Error("expected bar");
    expect(bar.unit).toBe("weight");
    expect(bar.accent).toBe("gold");
    expect(bar.series).toEqual([
      { label: "Architecture & decisions", value: 5 },
      { label: "Team conventions", value: 3 },
      { label: "Product context", value: 2 },
    ]);
  });

  it("builds a timeline from a sequenced ramp plan (week optional)", () => {
    const charts = deriveHandoffCharts({
      rampPlan: [{ milestone: "Read the architecture brief", week: "Week 1" }, { milestone: "Ship a first change" }],
    });

    const timeline = charts.find((c) => c.kind === "timeline");
    expect(timeline).toBeDefined();
    if (timeline?.kind !== "timeline") throw new Error("expected timeline");
    expect(timeline.items).toEqual([
      { label: "Read the architecture brief", date: "Week 1" },
      { label: "Ship a first change", date: undefined },
    ]);
  });

  it("emits both charts when both fields are present", () => {
    const charts = deriveHandoffCharts({
      focusAreas: [{ label: "Deploy pipeline", weight: 1 }],
      rampPlan: [{ milestone: "Get access", week: "Day 1" }],
    });
    expect(charts.map((c) => c.kind)).toEqual(["bar", "timeline"]);
  });

  it("returns [] for empty and missing input without throwing", () => {
    expect(deriveHandoffCharts({})).toEqual([]);
    expect(deriveHandoffCharts({ focusAreas: [], rampPlan: [] })).toEqual([]);
    expect(deriveHandoffCharts(null)).toEqual([]);
    expect(deriveHandoffCharts(undefined)).toEqual([]);
  });
});
