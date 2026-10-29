// @vitest-environment jsdom
//
// Standing regression test for graph-explorer.tsx's wheel-zoom attach bug:
// the wheel listener effect must not run only once on mount, before loading
// has cleared and before the real <svg> exists, with stable useCallbacks that
// never let it re-run — that silently kills a completely standard
// scroll-to-zoom interaction. The fix (attachSvgRef flips `svgMounted` once
// the <svg> actually attaches, and the effect depends on it) must not be
// touched here; this file only pins the *behaviour*: mount -> loading -> real
// svg attach -> a wheel event changes the zoom level.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { GraphExplorer } from "./graph-explorer";
import type { MemoryGraph } from "@/types/memory";

afterEach(() => {
  vi.unstubAllGlobals();
});

function twoNodeGraph(): MemoryGraph {
  return {
    nodes: [
      { uuid: "n0", name: "Acme Corp", type: "org" },
      { uuid: "n1", name: "Jane Doe", type: "person" },
    ],
    edges: [{ uuid: "e0", source: "n0", target: "n1", fact: "employs" }],
  };
}

describe("GraphExplorer — wheel-zoom attaches after real mount", () => {
  it("goes through loading -> svg attach, and a wheel event changes the displayed zoom", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(twoNodeGraph()), { status: 200 })),
    );

    const { container } = render(<GraphExplorer />);

    // Real mount -> loading state first (no <svg> in the tree yet).
    expect(screen.getByText(/loading graph/i)).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();

    // -> loading clears once fetchGraph resolves and lays the graph out;
    // the real <svg> attaches only at this point.
    const svg = await waitFor(() => {
      const el = container.querySelector("svg");
      if (!el) throw new Error("svg not attached yet");
      return el;
    });

    const zoomLabel = () => screen.getByText(/%$/).textContent;
    const before = zoomLabel();

    // A dead wheel-attach effect (the pre-fix bug) leaves this a no-op.
    fireEvent.wheel(svg, { deltaY: -100, clientX: 450, clientY: 270 });

    await waitFor(() => expect(zoomLabel()).not.toBe(before));
  });
});
