// @vitest-environment jsdom
// MermaidDiagram renders untrusted chart text (agent-written brief diagrams,
// ```mermaid fences in agent output, org-import's diagram field), so mermaid
// must run with securityLevel "strict": click directives become inert and
// label HTML goes through mermaid's DOMPurify pass. This drives the REAL
// mermaid (no mock) and checks the SVG that lands in the page.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MermaidDiagram } from "@/components/mermaid-diagram";

// jsdom has no SVG layout; mermaid measures text while drawing. A fixed box
// is enough for it to finish the render.
beforeAll(() => {
  const proto = window.SVGElement.prototype as unknown as {
    getBBox: () => { x: number; y: number; width: number; height: number };
    getComputedTextLength: () => number;
  };
  proto.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 });
  proto.getComputedTextLength = () => 40;
  // mermaid waits for each <img> in a label to load (or report complete);
  // jsdom never loads images, so report them complete.
  Object.defineProperty(window.HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
});

afterEach(() => cleanup());

async function renderChart(chart: string) {
  const { container } = render(<MermaidDiagram chart={chart} />);
  await waitFor(
    () => {
      if (!container.querySelector("svg") && !container.querySelector("pre")) throw new Error("still loading");
    },
    { timeout: 10_000 },
  );
  return container;
}

/** Every attribute value and the raw markup, for a payload anywhere in the output. */
function dangerous(container: HTMLElement): string[] {
  const hits: string[] = [];
  for (const el of Array.from(container.querySelectorAll("*"))) {
    if (el.tagName.toLowerCase() === "script") hits.push("<script>");
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) hits.push(`${el.tagName} ${a.name}`);
      if (/javascript:/i.test(a.value)) hits.push(`${el.tagName} ${a.name}=${a.value}`);
    }
  }
  return hits;
}

describe("MermaidDiagram security (securityLevel strict)", () => {
  it("renders a normal flowchart", async () => {
    const c = await renderChart("graph TD\n  A[Start] --> B[End]");
    expect(c.querySelector("svg")).not.toBeNull();
    expect(c.textContent).toContain("Start");
  });

  it("a javascript: click link yields no javascript: href or on* handler", async () => {
    const c = await renderChart(
      'graph TD\n  A[Start] --> B[End]\n  click A "javascript:alert(document.domain)" "tip"\n  click B href "javascript:alert(1)"',
    );
    expect(c.querySelector("svg")).not.toBeNull();
    expect(dangerous(c)).toEqual([]);
  });

  it("<script>, onerror, on* and javascript: payloads in labels are stripped", async () => {
    const c = await renderChart(
      'graph TD\n  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]\n' +
        '  B --> C["<b onmouseover=alert(3)>bold</b>"]\n  C --> D["<a href=\'javascript:alert(4)\'>link</a>"]',
    );
    expect(c.querySelector("svg")).not.toBeNull();
    expect(dangerous(c)).toEqual([]);
    expect(c.innerHTML).not.toMatch(/onerror|onmouseover|<script|javascript:/i);
  });
});
