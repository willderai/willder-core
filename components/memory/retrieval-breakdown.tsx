// The "where this came from" row under an Ask answer: which stores the read
// asked, how many of the returned facts each supplied, and the estimated context
// tokens those facts cost. A breakdown, not a claim that one store is better.

import type { RetrievalBackend, RetrievalBreakdown } from "@/types/memory";

/** Store names as the Explore page's tabs call them. */
const STORE_LABELS: Record<RetrievalBackend, string> = {
  source: "Records",
  semantic: "Chunks",
  graph: "Graph",
  files: "Files",
};

export function RetrievalBreakdownRow({ breakdown }: { breakdown: RetrievalBreakdown }) {
  const parts = breakdown.stores.map(({ store, hits, failed }) =>
    failed ? `${STORE_LABELS[store]} unavailable` : `${STORE_LABELS[store]} ${hits} ${hits === 1 ? "hit" : "hits"}`,
  );
  parts.push(`about ${breakdown.contextTokens.toLocaleString("en-US")} context tokens`);
  return (
    <section aria-label="Where this came from" className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-eyebrow font-semibold uppercase text-fg-subtle">Where this came from</span>
      <span className="font-mono text-xs text-fg-subtle">{parts.join(" · ")}</span>
    </section>
  );
}
