"use client";

// Renders a Mermaid diagram source string to inline SVG on the client. Mermaid is a
// heavy, browser-only lib (it touches document during render), so it is dynamically
// imported inside an effect to avoid SSR. Render failures never break the page: on
// error we fall back to the raw source in a <pre> so a malformed diagram is still
// readable. Mermaid draws with its dark theme, so the frame keeps a dark well in both themes.

import { useEffect, useId, useState } from "react";

type Status = "loading" | "ok" | "error";

export function MermaidDiagram({ chart, className }: { chart: string; className?: string }) {
  // The outcome of the current chart's render, or null while it is in flight.
  // Cleared during render whenever `chart` changes, so a new (or returning)
  // chart reads as "loading" until its own render settles -- never as a
  // stale outcome of an earlier render of the same text.
  const [rendered, setRendered] = useState<{ chart: string; status: "ok" | "error" } | null>(null);
  const [renderedFor, setRenderedFor] = useState(chart);
  if (chart !== renderedFor) {
    setRenderedFor(chart);
    setRendered(null);
  }
  // The last successful SVG, held in state rather than written into the DOM
  // node, so it survives the container unmounting while the <pre> fallback
  // shows. Like before, the previous diagram stays under the loading skeleton.
  const [svg, setSvg] = useState("");
  const hasSource = !!chart && chart.trim() !== "";
  const status: Status = !hasSource ? "error" : rendered?.chart === chart ? rendered.status : "loading";
  // useId is stable across renders + unique per instance; strip the colons React uses
  // so the result is a valid DOM/CSS id for mermaid.render.
  const rawId = useId();
  const domId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-_]/g, "")}`;

  useEffect(() => {
    if (!chart || !chart.trim()) return;
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          // Chart text is untrusted (agent-written briefs and markdown fences,
          // org-import diagrams): "strict" keeps click directives inert and
          // sanitizes labels. "loose" would let `click A "javascript:..."` run.
          securityLevel: "strict",
        });
        const out = await mermaid.render(domId, chart);
        if (cancelled) return;
        setSvg(out.svg);
        setRendered({ chart, status: "ok" });
      } catch {
        if (cancelled) return;
        setRendered({ chart, status: "error" });
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [chart, domId]);

  if (status === "error") {
    return (
      <pre
        className={`mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl border border-divider bg-fg/[0.04] p-3 font-mono text-xs leading-relaxed text-fg-muted ${
          className ?? ""
        }`}
      >
        {chart}
      </pre>
    );
  }

  return (
    <div
      className={`mt-3 overflow-x-auto rounded-xl border border-divider bg-[#001914] p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full ${
        className ?? ""
      }`}
    >
      {/* The diagram's ground is forest in both themes, so its skeleton is too: ivory at 10% over it, written solid. */}
      {status === "loading" && (
        <div className="h-24 w-full rounded-lg bg-[#182e29] motion-safe:animate-pulse" aria-hidden />
      )}
      <div aria-hidden={status !== "ok"} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
