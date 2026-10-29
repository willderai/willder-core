// Shared "flagged contradictions" block — was inline in BriefView
// (app/(app)/agents/page.tsx), extracted so GET /api/briefs/:id/staleness'
// contradiction scan can render the same block for a handoff brief (app/(app)/briefs/[id]/
// brief-document.tsx), which has no generation-time contradictions of its own
// to hang this off. Pure presentational — same markup/style either caller
// used before this extraction, no behavior change for BriefView's existing use.
export interface ContradictionPair {
  factA: string;
  factB: string;
  note: string;
}

export function ContradictionBlock({
  contradictions,
  title = "Flagged contradictions",
}: {
  contradictions: ContradictionPair[];
  title?: string;
}) {
  if (contradictions.length === 0) return null;

  return (
    <div className="rounded-2xl border border-ember/30 bg-ember/[0.06] p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <svg
          className="h-4 w-4 shrink-0 text-ember"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-sm font-semibold text-fg">{title}</p>
      </div>
      <div className="mt-3 divide-y divide-divider">
        {contradictions.map((c, i) => (
          <div key={i} className="py-3 first:pt-0 last:pb-0">
            <div className="grid gap-2 sm:grid-cols-2">
              <p className="break-words text-sm leading-relaxed text-fg">{c.factA}</p>
              <p className="break-words text-sm leading-relaxed text-fg sm:border-l sm:border-divider sm:pl-3">
                {c.factB}
              </p>
            </div>
            {c.note && <p className="mt-2 text-sm text-fg-muted">{c.note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
