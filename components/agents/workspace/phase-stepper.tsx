"use client";

// PhaseStepper — the macro-progress breadcrumb for a run. It collapses the fine
// RunPhase into the four stages a human tracks — Plan → Clarify → Execute → Report —
// so the workspace reads at a glance: what's done, what's happening now, what's left.
// It is the primary "where are we / where to look" cue; the header pill still carries
// the exact phase + connection nuance. Color supports, never floods (design.md §3):
// ice (accent) marks progress, red (danger) marks a stopped run; the words stay in the
// text roles so they read at AA on the light theme's backdrop too. On a phone only the
// stage the run is at keeps a visible label (the others stay readable to screen readers),
// and on the narrowest phones the stages wrap rather than scroll sideways.

import type { RunPhase } from "@/types/agent-run";

type StageStatus = "done" | "current" | "upcoming" | "failed";

const STAGES = [
  { key: "plan", label: "Plan" },
  { key: "clarify", label: "Clarify" },
  { key: "execute", label: "Execute" },
  { key: "report", label: "Report" },
] as const;

/** Map the fine phase onto the four macro-stages (index into STAGES). */
function activeStage(phase: RunPhase | null): number {
  switch (phase) {
    case "planning":
      return 0;
    case "consulting":
    case "paused":
      return 1;
    case "executing":
      return 2;
    case "finalizing":
    case "done":
      return 3;
    case "failed":
      // The pre-failure sub-phase isn't preserved on the wire; anchor a stopped run
      // at Execute, the stage runs most commonly halt in.
      return 2;
    default:
      return 0;
  }
}

function Check() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const CIRCLE: Record<StageStatus, string> = {
  done: "border-accent/40 bg-accent/10 text-accent",
  current: "border-accent text-accent",
  upcoming: "border-fg-muted/50 text-fg-muted",
  failed: "border-danger bg-danger text-[var(--danger-foreground)]",
};

const LABEL: Record<StageStatus, string> = {
  done: "text-fg-muted",
  current: "font-semibold text-fg",
  upcoming: "text-fg-muted",
  failed: "font-semibold text-fg",
};

export function PhaseStepper({
  phase,
  paused,
  terminal,
  failed,
  caption,
  parallelCount,
  className = "",
}: {
  phase: RunPhase | null;
  paused: boolean;
  terminal: boolean;
  failed: boolean;
  /** Action-oriented status guiding where to look ("Answer below to continue"). */
  caption?: string;
  /** Count of parallel child sub-agents currently fanned out under Execute. When >1
   *  the Execute caption reads "N sub-agents running"; absent/≤1 ⇒ caption unchanged
   *  (single-agent stays pixel-identical). The manager fan-out (§4) sets this. */
  parallelCount?: number;
  className?: string;
}) {
  const active = activeStage(phase);
  const complete = terminal && !failed;
  // Pulse the current stage only while the run is actively working (not paused, not
  // terminal) — a paused Clarify stage should read as a steady, waiting ice.
  const pulse = !paused && !terminal;

  // While children fan out under Execute, prefer a fan-out caption over the passed
  // one. Everywhere else (and single-agent) the caption is untouched.
  const effectiveCaption =
    parallelCount && parallelCount > 1 && active === 2 && !terminal && !paused
      ? `${parallelCount} sub-agents running`
      : caption;

  return (
    <nav
      aria-label="Run progress"
      className={`rounded-2xl border border-divider bg-fg/[0.02] px-4 py-3 sm:px-5 ${className}`}
    >
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <ol className="flex flex-wrap items-center gap-y-2">
          {STAGES.map((s, i) => {
            const status: StageStatus = complete
              ? "done"
              : failed && i === active
                ? "failed"
                : i < active
                  ? "done"
                  : i === active
                    ? "current"
                    : "upcoming";
            const segmentPassed = complete || i < active;
            return (
              <li key={s.key} className="flex items-center">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums ${
                      CIRCLE[status]
                    } ${status === "current" && pulse ? "animate-pulse motion-reduce:animate-none" : ""}`}
                    aria-hidden="true"
                  >
                    {status === "done" ? <Check /> : status === "failed" ? "!" : i + 1}
                  </span>
                  <span className={`text-sm ${LABEL[status]} ${i === active ? "" : "sr-only sm:not-sr-only"}`}>
                    {s.label}
                    <span className="sr-only">
                      {" — "}
                      {status === "current" ? "in progress" : status}
                    </span>
                  </span>
                </div>
                {i < STAGES.length - 1 && (
                  <span
                    className={`mx-1.5 h-px w-3 sm:mx-2 sm:w-5 lg:mx-3 lg:w-10 ${
                      segmentPassed ? "bg-accent/40" : "bg-divider"
                    }`}
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ol>

        {effectiveCaption && (
          <p
            className={`text-sm lg:text-right ${
              paused || failed ? "font-semibold text-fg" : "font-medium text-fg-muted"
            }`}
          >
            {effectiveCaption}
          </p>
        )}
      </div>
    </nav>
  );
}
