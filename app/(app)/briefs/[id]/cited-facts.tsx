"use client";

// The facts one section of a handoff brief rests on, and whether each is still true.
//
// A citation to a fact that has since been replaced reads as confirmation of something
// no longer true, so a section never shows its sources without their current status:
// anything changed, replaced or gone is called out above the list, in the open, and the
// counts in the summary line add up to every citation the section has (an unchecked
// citation is counted as unchecked, never folded into "current").

import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import type { CitationCheck, CitationStatus } from "@/services/memory/brief-citations";

const STATUS_LABEL: Record<CitationStatus, string> = {
  current: "Still current",
  changed: "Changed since this briefing",
  superseded: "Replaced by a newer fact",
  gone: "Removed, or no longer visible to you",
  unknown: "Could not be checked",
};

/** Order and wording of the summary counts; each status appears once, only when present. */
const SUMMARY_ORDER: [CitationStatus, string][] = [
  ["changed", "changed"],
  ["superseded", "replaced"],
  ["gone", "removed"],
  ["unknown", "not checked"],
  ["current", "still current"],
];

export const DIVERGED: ReadonlySet<CitationStatus> = new Set(["changed", "superseded", "gone"]);

function countWord(n: number): string {
  return n === 1 ? "1 cited fact" : `${n} cited facts`;
}

function summaryLine(citations: CitationCheck[]): string {
  const counts = new Map<CitationStatus, number>();
  for (const c of citations) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const parts = SUMMARY_ORDER.filter(([status]) => counts.has(status)).map(
    ([status, word]) => `${counts.get(status)} ${word}`,
  );
  return `${countWord(citations.length)}: ${parts.join(", ")}`;
}

function StatusIcon({ status }: { status: CitationStatus }) {
  const className = "mt-0.5 h-3.5 w-3.5 shrink-0";
  if (status === "current") return <CircleCheck className={`${className} text-accent`} aria-hidden="true" />;
  if (status === "unknown") return <CircleHelp className={`${className} text-fg-subtle`} aria-hidden="true" />;
  return <TriangleAlert className={`${className} text-ember`} aria-hidden="true" />;
}

/** The cited facts under one brief section; renders nothing when the section cites none. */
export function CitedFacts({ citations }: { citations: CitationCheck[] }) {
  if (citations.length === 0) return null;
  const diverged = citations.filter((c) => DIVERGED.has(c.status)).length;

  return (
    <div className="brief-print-hide mt-3 space-y-2">
      {diverged > 0 && (
        <p className="flex items-start gap-1.5 text-sm leading-relaxed text-fg">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" aria-hidden="true" />
          <span>
            {diverged} of {countWord(citations.length)} behind this section no longer say what it quoted. Check the
            sources below before relying on it.
          </span>
        </p>
      )}
      <details className="group">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
          <svg
            className="h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Sources: {summaryLine(citations)}</span>
        </summary>
        <ul className="mt-2 space-y-3 border-l border-divider pl-4">
          {citations.map((c) => (
            <li key={c.factId} className="flex gap-2">
              <StatusIcon status={c.status} />
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold ${DIVERGED.has(c.status) ? "text-fg" : "text-fg-subtle"}`}>
                  {STATUS_LABEL[c.status]}
                </p>
                {c.factText !== null && (
                  <p className="mt-0.5 break-words text-sm leading-relaxed text-fg-muted">
                    {c.status === "current" ? c.factText : `As cited: ${c.factText}`}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
