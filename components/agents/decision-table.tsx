"use client";

// Architecture options-comparison table — the shared surface where the user and the
// agent argue a direction (docs/design_doc_chart_generation.md §0.1, §C.2).
//
// Consumes the FROZEN `DecisionFragment` (types/agent-run.ts): a `question`, its
// `options[]` (label + pros/cons/cost/commonPractice/example), a `recommendation`
// ({optionId, rationale}), and an optional `chosenOptionId` once the human decides.
//
// The load-bearing brand rule (types/agent-run.ts:12-15, design_doc §0.1): the
// recommended option is the agent's RECOMMENDATION — an input, NOT a locked org
// decision. It is flagged with an ice ★ badge and its rationale, and the header says
// so in plain words. A `chosenOptionId` (the human's actual pick, which may differ)
// is rendered distinctly as the confirmed choice. Pure presentational: `onChoose`
// lets a parent wire selection later; it defaults to a no-op and touches no backend.

import type { DecisionFragment, DecisionOption } from "@/types/agent-run";

const TRAIT_ROWS: { key: keyof DecisionOption; label: string }[] = [
  { key: "pros", label: "Pros" },
  { key: "cons", label: "Cons" },
  { key: "cost", label: "Cost" },
  { key: "commonPractice", label: "Common practice" },
  { key: "example", label: "Example" },
];

function OptionCard({
  option,
  isRecommended,
  isChosen,
  rationale,
  onChoose,
}: {
  option: DecisionOption;
  isRecommended: boolean;
  isChosen: boolean;
  rationale?: string;
  onChoose: (optionId: string) => void;
}) {
  // Chosen (confirmed) reads strongest, on a sunset edge; recommended is a quiet
  // ice edge; the rest sit on a hairline. Colour marks the edge, never the words'
  // only carrier: each state also has its badge (claude/design.md section 2).
  const border = isChosen ? "border-ember/60" : isRecommended ? "border-accent/50" : "border-divider";

  return (
    <div className={`flex min-w-0 flex-col gap-3 rounded-xl border ${border} px-4 py-4`}>
      {/* The badges wrap below the name when the card is narrow, so neither squeezes the other. */}
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <h4 className="min-w-0 flex-[1_1_9rem] text-base font-semibold text-fg">{option.label}</h4>
        <div className="flex shrink-0 flex-wrap gap-1">
          {isRecommended && (
            <span className="flex items-center gap-1 rounded-full border border-accent/50 px-2 py-0.5 text-xs font-semibold text-fg">
              <span aria-hidden className="text-accent">
                ★
              </span>{" "}
              Recommended
            </span>
          )}
          {isChosen && (
            <span className="flex items-center gap-1 rounded-full border border-ember/60 px-2 py-0.5 text-xs font-semibold text-fg">
              Your choice
            </span>
          )}
        </div>
      </div>

      {isRecommended && rationale && (
        <p className="border-l-2 border-accent/50 pl-3 text-sm leading-relaxed text-fg-muted">
          <span className="font-semibold text-fg">Why: </span>
          {rationale}
        </p>
      )}

      <dl className="flex flex-col gap-2">
        {TRAIT_ROWS.map(({ key, label }) => {
          const value = option[key];
          if (typeof value !== "string" || !value) return null;
          return (
            <div key={key}>
              <dt className="text-eyebrow font-semibold uppercase text-fg-subtle">{label}</dt>
              <dd className="mt-0.5 text-sm leading-relaxed text-fg-muted">{value}</dd>
            </div>
          );
        })}
      </dl>

      <button
        type="button"
        onClick={() => onChoose(option.id)}
        aria-pressed={isChosen}
        className={`mt-auto min-h-9 rounded-xl border px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info ${
          isChosen
            ? "border-ember/60 bg-ember/10 text-fg"
            : "border-divider text-fg-muted hover:border-accent/40 hover:text-fg"
        }`}
      >
        {isChosen ? "Chosen" : "Choose this"}
      </button>
    </div>
  );
}

function DecisionCard({ decision, onChoose }: { decision: DecisionFragment; onChoose: (optionId: string) => void }) {
  const recommendedId = decision.recommendation?.optionId;
  const chosenId = decision.chosenOptionId;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-divider px-5 py-5">
      <header className="flex flex-col gap-1">
        <span className="text-eyebrow font-semibold uppercase text-fg-subtle">Decision to make</span>
        <h3 className="text-lg font-semibold text-fg">{decision.question}</h3>
        <p className="text-sm text-fg-muted">
          {chosenId
            ? "You've made this call. The agent's recommendation is shown for reference — you can change it."
            : "The ★ marks what the agent recommends and why — a suggestion, not a decision. You decide."}
        </p>
      </header>

      {/* As many columns of at least 15rem as fit, so three options never squeeze into a narrow main column. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] items-stretch gap-3">
        {decision.options.map((opt) => (
          <OptionCard
            key={opt.id}
            option={opt}
            isRecommended={opt.id === recommendedId}
            isChosen={opt.id === chosenId}
            rationale={decision.recommendation?.rationale}
            onChoose={onChoose}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Render one or more architecture decisions as a side-by-side options comparison.
 * Pure presentational.
 *
 * @param decision  A single DecisionFragment or an array of them.
 * @param onChoose  Optional selection hook a parent can wire to persist a choice
 *                  later. Receives the chosen `optionId`. Defaults to a no-op — this
 *                  component implements NO backend / correction-loop call itself.
 */
export function DecisionTable({
  decision,
  onChoose,
}: {
  decision: DecisionFragment | DecisionFragment[];
  onChoose?: (optionId: string) => void;
}) {
  const decisions = Array.isArray(decision) ? decision : [decision];
  const choose = onChoose ?? (() => {});

  if (decisions.length === 0) {
    return <p className="text-sm text-fg-subtle">No decisions to compare yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {decisions.map((d, i) => (
        <DecisionCard key={i} decision={d} onChoose={choose} />
      ))}
    </div>
  );
}
