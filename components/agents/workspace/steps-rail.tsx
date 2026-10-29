"use client";

// StepsRail — the conversation-of-record rail (design_agent_workspace_ux.md §2).
// Renders the plan as an ordered, icon-led checklist with per-step status glyphs,
// the live progress line under the active step, and the paused "needs input"
// checkpoint slot inserted at the current step (which pulls focus, §2). Live-change
// affordances (add step / redirect / remove pending step) live in the footer and
// POST to …/edit via callbacks. Status is announced through a polite aria-live
// region; every step carries a text status label, never a glyph alone (a11y §8).

import { Fragment, useState, type ReactNode } from "react";
import type { PlanItem, PlanItemStatus, RunPhase } from "@/types/agent-run";
import { groupRailItems } from "@/components/agents/workspace/use-run-stream";
import { BUTTON_QUIET, BUTTON_SECONDARY, FIELD, FOCUS } from "@/components/agents/agent-ui";

/** The status line under a step title, and the counts on a fan-out band. */
const STEP_META = "text-sm text-fg-muted";

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: "pending",
  active: "in progress",
  done: "done",
  skipped: "skipped",
  failed: "failed",
};

/** Icon-led, quiet-color status glyph (design.md §6 — color supports, never floods). */
function StepGlyph({ status }: { status: PlanItemStatus }) {
  if (status === "active") {
    // Contained-ring loader (design.md §8), not a generic spinner.
    return (
      <span
        className="mt-0.5 inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent/25 border-t-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (status === "done") {
    return (
      <svg
        className="mt-0.5 h-4 w-4 shrink-0 text-accent"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        className="mt-0.5 h-4 w-4 shrink-0 text-danger"
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
    );
  }
  if (status === "skipped") {
    return (
      <span className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full border border-fg-subtle/40" aria-hidden="true" />
    );
  }
  // pending
  return (
    <span className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full border border-fg-subtle" aria-hidden="true" />
  );
}

/** Aggregate a fan-out band's lanes into one glyph status for the band's rail
 *  marker: any failure surfaces, else all-done, else any-active, else pending. */
function bandStatus(items: PlanItem[]): PlanItemStatus {
  if (items.some((it) => it.status === "failed")) return "failed";
  if (items.every((it) => it.status === "done" || it.status === "skipped")) return "done";
  if (items.some((it) => it.status === "active")) return "active";
  return "pending";
}

export function StepsRail({
  steps,
  messages,
  phase,
  planRevision,
  checkpointSlot,
  checkpointItemId,
  onAddStep,
  onRemoveStep,
  onRedirect,
  onRerunStep,
  disabled,
}: {
  steps: PlanItem[];
  messages: Record<string, string>;
  phase: RunPhase | null;
  planRevision: number;
  /** The clarification card, rendered right after `checkpointItemId` (or at the end). */
  checkpointSlot?: ReactNode;
  checkpointItemId?: string | null;
  onAddStep: (title: string, detail: string | undefined, baseRevision: number) => void;
  onRemoveStep: (itemId: string, baseRevision: number) => void;
  /** Whole-run redirect (footer): re-aim everything going forward. */
  onRedirect: (text: string) => void;
  /** Per-stage redirect: re-run ONE completed/failed step with feedback (two-level redirect). */
  onRerunStep?: (itemId: string, feedback: string, baseRevision: number) => void;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addDetail, setAddDetail] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [redirectText, setRedirectText] = useState("");
  // Per-stage redirect: which step's feedback box is open, and its draft text.
  const [redirectStepId, setRedirectStepId] = useState<string | null>(null);
  const [stepFeedback, setStepFeedback] = useState("");

  const hasCheckpointTarget = steps.some((s) => s.id === checkpointItemId);
  const activeMsg = steps.find((s) => s.status === "active")?.id;

  // Group consecutive `parallel` items into fan-out bands (§4). With zero parallel
  // items every node is a plain step → the sequential rail renders exactly as before.
  const nodes = groupRailItems(steps);

  // The per-step content block (title, status, live line, per-step redirect). Reused
  // verbatim by sequential steps AND by each lane inside a fan-out band, so the
  // "↪ Redirect this step" + remove affordances keep working for children too.
  const renderStepContent = (step: PlanItem) => {
    const msg = messages[step.id];
    const canRemove = step.status === "pending";
    return (
      <div className="min-w-0 flex-1 -mt-0.5">
        <div className="flex items-start justify-between gap-2">
          <p
            className={`min-w-0 break-words text-sm leading-snug ${
              step.status === "active"
                ? "font-semibold text-fg"
                : step.status === "failed"
                  ? "text-fg"
                  : "text-fg-muted"
            } ${step.status === "skipped" ? "line-through" : ""}`}
          >
            {step.title}
            {step.origin === "user" && (
              <span className="ml-1.5 text-eyebrow font-semibold uppercase text-fg-muted">yours</span>
            )}
          </p>
          {!disabled && canRemove && (
            <button
              type="button"
              onClick={() => onRemoveStep(step.id, planRevision)}
              className={`-mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm text-fg-muted transition-colors hover:text-danger ${FOCUS}`}
              aria-label={`Remove step ${step.title}`}
            >
              ✕
            </button>
          )}
        </div>
        {/* text status label — never glyph-only */}
        <p className={`mt-0.5 ${STEP_META}`}>{STATUS_LABEL[step.status]}</p>
        {step.detail && step.status !== "active" && (
          <p className="mt-1 text-sm text-fg-muted [overflow-wrap:anywhere]">{step.detail}</p>
        )}
        {msg && (step.status === "active" || step.status === "failed") && (
          <p
            className={`mt-1 text-sm [overflow-wrap:anywhere] ${
              step.status === "failed" ? "text-fg" : "text-fg-muted"
            }`}
          >
            {msg}
          </p>
        )}
        {/* Per-stage redirect — re-run just THIS completed/failed step with feedback.
            Distinct from the footer "Redirect the run" (which re-aims everything). */}
        {!disabled &&
          onRerunStep &&
          (step.status === "done" || step.status === "failed") &&
          (redirectStepId === step.id ? (
            <div className="mt-2 space-y-2">
              <textarea
                autoFocus
                rows={2}
                value={stepFeedback}
                onChange={(e) => setStepFeedback(e.target.value)}
                placeholder="Redo just this step (e.g. also probe the 401 path)"
                className={FIELD}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!stepFeedback.trim()}
                  onClick={() => {
                    onRerunStep(step.id, stepFeedback.trim(), planRevision);
                    setStepFeedback("");
                    setRedirectStepId(null);
                  }}
                  className={BUTTON_SECONDARY}
                >
                  Redo step
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRedirectStepId(null);
                    setStepFeedback("");
                  }}
                  className={BUTTON_QUIET}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRedirectStepId(step.id);
                setStepFeedback("");
              }}
              className={`-ml-2 mt-0.5 ${BUTTON_QUIET}`}
            >
              ↪ Redirect this step
            </button>
          ))}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Polite live region so step transitions are announced (a11y §8). */}
      <p className="sr-only" aria-live="polite">
        {activeMsg ? `Working: ${steps.find((s) => s.id === activeMsg)?.title}` : ""}
        {phase === "paused" ? "Waiting on your input." : ""}
      </p>

      <ol className="-mx-2 flex-1 space-y-0 overflow-y-auto px-2 pt-1">
        {steps.length === 0 && (
          <li className="flex items-center gap-3 py-2 text-sm text-fg-muted">
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent/25 border-t-accent motion-reduce:animate-none"
            />
            Planning the run…
          </li>
        )}
        {nodes.map((node, i) => {
          const isLast = i === nodes.length - 1;
          if (node.kind === "step") {
            const step = node.item;
            const showCheckpointHere = Boolean(checkpointSlot) && checkpointItemId === step.id;
            return (
              <Fragment key={step.id}>
                <li className="relative flex gap-3 pb-4">
                  {/* connector rail */}
                  <div className="flex flex-col items-center">
                    <StepGlyph status={step.status} />
                    {(!isLast || showCheckpointHere) && <span className="mt-1 w-px flex-1 bg-divider" />}
                  </div>
                  {renderStepContent(step)}
                </li>
                {showCheckpointHere && <li className="pb-4 pl-7">{checkpointSlot}</li>}
              </Fragment>
            );
          }

          // Fan-out band — N parallel child sub-agents multiplexed onto the same
          // step_* events, rendered as stacked lanes under one grouped header.
          const band = node.items;
          const doneCount = band.filter((it) => it.status === "done" || it.status === "skipped").length;
          const bandKey = `band-${band[0].id}`;
          const showCheckpointHere = Boolean(checkpointSlot) && band.some((it) => it.id === checkpointItemId);
          return (
            <Fragment key={bandKey}>
              <li className="relative flex gap-3 pb-4">
                {/* connector rail — one aggregate glyph for the whole band */}
                <div className="flex flex-col items-center">
                  <StepGlyph status={bandStatus(band)} />
                  {(!isLast || showCheckpointHere) && <span className="mt-1 w-px flex-1 bg-divider" />}
                </div>
                <div className="min-w-0 flex-1 -mt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-eyebrow font-semibold uppercase text-fg-muted">
                      {band.length} sub-agents in parallel
                    </p>
                    <p className={`shrink-0 ${STEP_META}`}>
                      {doneCount}/{band.length} done
                    </p>
                  </div>
                  {/* Stacked lanes — each lane is one child's live progress + status. */}
                  <ul className="mt-2 space-y-3">
                    {band.map((lane) => (
                      <li key={lane.id} className="flex gap-3 border-l border-divider pl-2.5">
                        <StepGlyph status={lane.status} />
                        {renderStepContent(lane)}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
              {showCheckpointHere && <li className="pb-4 pl-7">{checkpointSlot}</li>}
            </Fragment>
          );
        })}

        {/* Checkpoint targeting no step (or a step not in the plan) renders at the end. */}
        {checkpointSlot && (!checkpointItemId || !hasCheckpointTarget) && <li className="pb-4">{checkpointSlot}</li>}
      </ol>

      {/* Live-change footer — add step / redirect (the two that make it interactive). */}
      {!disabled && (
        <div className="mt-2 space-y-2 border-t border-divider pt-3">
          {adding ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                placeholder="New step (e.g. Probe /checkout with bad input)"
                className={FIELD}
              />
              <input
                value={addDetail}
                onChange={(e) => setAddDetail(e.target.value)}
                placeholder="Instruction (optional)"
                className={FIELD}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!addTitle.trim()}
                  onClick={() => {
                    onAddStep(addTitle.trim(), addDetail.trim() || undefined, planRevision);
                    setAddTitle("");
                    setAddDetail("");
                    setAdding(false);
                  }}
                  className={BUTTON_SECONDARY}
                >
                  Add
                </button>
                <button type="button" onClick={() => setAdding(false)} className={BUTTON_QUIET}>
                  Cancel
                </button>
              </div>
            </div>
          ) : redirecting ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                rows={2}
                value={redirectText}
                onChange={(e) => setRedirectText(e.target.value)}
                placeholder="Steer the run (e.g. focus on EU latency instead)"
                className={FIELD}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!redirectText.trim()}
                  onClick={() => {
                    onRedirect(redirectText.trim());
                    setRedirectText("");
                    setRedirecting(false);
                  }}
                  className={BUTTON_SECONDARY}
                >
                  Send
                </button>
                <button type="button" onClick={() => setRedirecting(false)} className={BUTTON_QUIET}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="-ml-2 flex flex-wrap items-center gap-x-3">
              <button type="button" onClick={() => setAdding(true)} className={BUTTON_QUIET}>
                + Add step
              </button>
              <button
                type="button"
                onClick={() => setRedirecting(true)}
                className={BUTTON_QUIET}
                title="Re-aim the whole run going forward (each step also has its own redirect)"
              >
                ↪ Redirect the run
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
