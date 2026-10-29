import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render tests for the hand-rolled SVG chart renderer (components/charts/chart-block.tsx).
// No DOM library is installed and vitest runs in a node environment, so we render each
// ChartSpec kind to static markup with react-dom/server and assert on the output: it must
// render without throwing, expose the accessible role/label/<title>/<desc>, carry the honest
// numbers, and degrade to an empty state when a spec has no data. (design.md a11y contract.)
import ChartBlock from "./chart-block";
import type { ChartSpec } from "@/types/agent-run";

const render = (spec: ChartSpec) => renderToStaticMarkup(createElement(ChartBlock, { spec }));

describe("ChartBlock — bar / histogram", () => {
  const bar: ChartSpec = {
    kind: "bar",
    title: "Requests per endpoint",
    unit: "count",
    series: [
      { label: "GET /a", value: 10 },
      { label: "POST /b", value: 25 },
    ],
  };

  it("renders a vertical bar chart with the accessible role, label, title and desc", () => {
    const html = render(bar);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Bar chart: Requests per endpoint (count)"');
    expect(html).toContain("<title>Requests per endpoint</title>");
    expect(html).toContain("<desc>");
    // Honest numbers appear in the desc/value labels.
    expect(html).toContain("GET /a: 10");
    expect(html).toContain("POST /b: 25");
  });

  it("renders a horizontal bar chart", () => {
    const html = render({ ...bar, orientation: "horizontal" });
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Requests per endpoint</title>");
  });

  it("renders a histogram kind the same way", () => {
    const html = render({ ...bar, kind: "histogram" });
    expect(html).toContain('aria-label="Bar chart: Requests per endpoint (count)"');
  });

  it("renders the empty state (no role=img) when the series is empty", () => {
    const html = render({ kind: "bar", title: "Nothing yet", series: [] });
    expect(html).toContain("No data to chart yet.");
    expect(html).toContain("Nothing yet");
    expect(html).not.toContain('role="img"');
  });
});

describe("ChartBlock — grouped-bar", () => {
  const spec: ChartSpec = {
    kind: "grouped-bar",
    title: "Latency by endpoint",
    unit: "ms",
    measures: ["p50", "max"],
    series: [
      { label: "GET /search", value: 0, measures: { p50: 120, max: 900 } },
      { label: "POST /order", value: 0, measures: { p50: 80, max: 400 } },
    ],
  };

  it("renders with the grouped-bar label, a legend for each measure, and a desc of the numbers", () => {
    const html = render(spec);
    expect(html).toContain('aria-label="Grouped bar chart: Latency by endpoint (ms)"');
    expect(html).toContain("p50");
    expect(html).toContain("max");
    expect(html).toContain("GET /search");
  });

  it("renders the empty state when measures are missing", () => {
    const html = render({ ...spec, measures: [] });
    expect(html).toContain("No data to chart yet.");
    expect(html).not.toContain('role="img"');
  });
});

describe("ChartBlock — timeline", () => {
  const spec: ChartSpec = {
    kind: "timeline",
    title: "Delivery milestones",
    items: [
      { label: "Kickoff", date: "2026-01" },
      { label: "Beta", date: "2026-03" },
    ],
  };

  it("renders the rail with an accessible label, title and dated milestones", () => {
    const html = render(spec);
    expect(html).toContain('aria-label="Timeline: Delivery milestones"');
    expect(html).toContain("<title>Delivery milestones</title>");
    expect(html).toContain("Kickoff");
    expect(html).toContain("Beta");
  });

  it("renders a single-item timeline without throwing", () => {
    const html = render({ kind: "timeline", title: "One", items: [{ label: "Only" }] });
    expect(html).toContain("Only");
  });

  it("renders the empty state when there are no items", () => {
    const html = render({ kind: "timeline", title: "TBD", items: [] });
    expect(html).toContain("No data to chart yet.");
  });
});

describe("ChartBlock — funnel", () => {
  const spec: ChartSpec = {
    kind: "funnel",
    title: "Dispute funnel",
    stages: [
      { label: "Opened", value: 40 },
      { label: "Under review", value: 18 },
      { label: "Resolved", value: 12 },
    ],
  };

  it("renders each stage with the accessible label + desc", () => {
    const html = render(spec);
    expect(html).toContain('aria-label="Funnel: Dispute funnel"');
    expect(html).toContain("Opened");
    expect(html).toContain("Resolved");
    expect(html).toContain("<desc>");
  });

  it("renders the empty state when there are no stages", () => {
    const html = render({ kind: "funnel", title: "Empty", stages: [] });
    expect(html).toContain("No data to chart yet.");
  });
});

describe("ChartBlock — matrix", () => {
  const spec: ChartSpec = {
    kind: "matrix",
    title: "Impact vs effort",
    xAxis: { label: "Effort", low: "Low", high: "High" },
    yAxis: { label: "Impact", low: "Low", high: "High" },
    points: [
      { label: "Option A", x: 0.2, y: 0.8, accent: "gold" },
      { label: "Option B", x: 0.7, y: 0.4 },
    ],
  };

  it("renders with axis labels in the accessible label and marks the recommended point", () => {
    const html = render(spec);
    expect(html).toContain('role="img"');
    expect(html).toContain("X axis Effort");
    expect(html).toContain("Y axis Impact");
    // The gold-accented point is announced as recommended in the desc + carries a ★.
    expect(html).toContain("(recommended)");
    expect(html).toContain("★");
    expect(html).toContain("Option A");
    expect(html).toContain("Option B");
  });

  it("renders the empty state when there are no points", () => {
    const html = render({
      kind: "matrix",
      title: "Empty matrix",
      xAxis: { label: "Effort", low: "Lo", high: "Hi" },
      yAxis: { label: "Impact", low: "Lo", high: "Hi" },
      points: [],
    });
    expect(html).toContain("No data to chart yet.");
    expect(html).not.toContain('role="img"');
  });
});
