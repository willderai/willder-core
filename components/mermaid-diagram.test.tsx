// @vitest-environment jsdom
// MermaidDiagram's render lifecycle with a controllable mermaid mock: each
// render() call parks until the test resolves or rejects it, so out-of-order
// and retry sequences can be driven exactly ("X errors, then empty, then X renders").
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Pending = { chart: string; resolve: (svg: string) => void; reject: (e: unknown) => void };
const pending: Pending[] = [];
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(
      (_id: string, chart: string) =>
        new Promise<{ svg: string }>((res, rej) =>
          pending.push({ chart, resolve: (svg) => res({ svg }), reject: rej }),
        ),
    ),
  },
}));
import { MermaidDiagram } from "@/components/mermaid-diagram";

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
const state = (c: HTMLElement) =>
  c.querySelector("pre") ? "error" : c.querySelector(".animate-pulse, [class*='animate-pulse']") ? "loading" : "ok";
const svgText = (c: HTMLElement) => c.querySelector("svg")?.textContent ?? null;

afterEach(() => {
  cleanup();
  pending.length = 0;
});

describe("MermaidDiagram", () => {
  it("empty chart renders the source fallback, no render call", async () => {
    const { container } = render(<MermaidDiagram chart="   " />);
    await flush();
    expect(state(container)).toBe("error");
    expect(pending.length).toBe(0);
  });
  it("loading -> ok", async () => {
    const { container } = render(<MermaidDiagram chart="graph A" />);
    expect(state(container)).toBe("loading");
    await flush();
    pending.shift()!.resolve("<svg><text>A</text></svg>");
    await flush();
    expect(state(container)).toBe("ok");
    expect(svgText(container)).toBe("A");
  });
  it("render failure -> fallback", async () => {
    const { container } = render(<MermaidDiagram chart="bad" />);
    await flush();
    pending.shift()!.reject(new Error("parse"));
    await flush();
    expect(state(container)).toBe("error");
  });
  it("chart change shows loading until the new render settles; stale render ignored", async () => {
    const { container, rerender } = render(<MermaidDiagram chart="graph A" />);
    await flush();
    pending.shift()!.resolve("<svg><text>A</text></svg>");
    await flush();
    rerender(<MermaidDiagram chart="graph B" />);
    await flush();
    expect(state(container)).toBe("loading");
    rerender(<MermaidDiagram chart="graph C" />);
    await flush();
    const b = pending.find((p) => p.chart === "graph B")!;
    const c = pending.find((p) => p.chart === "graph C")!;
    c.resolve("<svg><text>C</text></svg>");
    await flush();
    b.resolve("<svg><text>B</text></svg>");
    await flush();
    expect(state(container)).toBe("ok");
    expect(svgText(container)).toBe("C");
  });
  it("error -> valid chart recovers", async () => {
    const { container, rerender } = render(<MermaidDiagram chart="bad" />);
    await flush();
    pending.shift()!.reject(new Error("parse"));
    await flush();
    rerender(<MermaidDiagram chart="graph Z" />);
    await flush();
    expect(state(container)).toBe("loading");
    pending.shift()!.resolve("<svg><text>Z</text></svg>");
    await flush();
    expect(state(container)).toBe("ok");
    expect(svgText(container)).toBe("Z");
  });
  it("X errors, then empty, then X again and X now renders -> diagram visible, not an empty box", async () => {
    const { container, rerender } = render(<MermaidDiagram chart="graph X" />);
    await flush();
    pending.shift()!.reject(new Error("chunk load"));
    await flush();
    rerender(<MermaidDiagram chart="" />);
    await flush();
    rerender(<MermaidDiagram chart="graph X" />);
    await flush();
    pending.shift()!.resolve("<svg><text>X</text></svg>");
    await flush();
    expect(state(container)).toBe("ok");
    expect(svgText(container)).toBe("X");
  });
  it("A -> B (pending) -> A: shows A's diagram, not blank", async () => {
    const { container, rerender } = render(<MermaidDiagram chart="graph A" />);
    await flush();
    pending.shift()!.resolve("<svg><text>A</text></svg>");
    await flush();
    rerender(<MermaidDiagram chart="graph B" />);
    await flush();
    rerender(<MermaidDiagram chart="graph A" />);
    await flush();
    for (const p of pending.splice(0)) p.resolve(`<svg><text>${p.chart.slice(-1)}</text></svg>`);
    await flush();
    expect(state(container)).toBe("ok");
    expect(svgText(container)).toBe("A");
  });
});
