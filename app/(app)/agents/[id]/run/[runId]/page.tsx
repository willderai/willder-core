"use client";

// Interactive agent-run workspace (design_agent_workspace_ux.md §1). The full-page
// surface: a steps/conversation rail (left) + the live artifact (right). It is
// linkable, reload-safe and new-tab-safe by construction — `runId` is the persisted
// AgentRun id and the SSE stream is resumable (?afterSeq=N), so a fresh load
// re-subscribes and replays. All run state comes from useRunStream (the RunEvent
// contract); the client holds no authority — every mutation POSTs to a run-scoped
// endpoint (…/answer, …/edit) the server re-authorizes.

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/components/ui";
import { useRunStream } from "@/components/agents/workspace/use-run-stream";
import { StepsRail } from "@/components/agents/workspace/steps-rail";
import { LiveArtifact } from "@/components/agents/workspace/live-artifact";
import { ClarificationCard } from "@/components/agents/workspace/clarification-card";
import { PhaseStepper } from "@/components/agents/workspace/phase-stepper";
import { BUTTON_QUIET } from "@/components/agents/agent-ui";
import type { RunPhase } from "@/types/agent-run";

/** A compact bordered header action (pause, stop, share). */
const HEADER_ACTION =
  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-xl border border-divider px-3 text-sm text-fg-muted transition-colors hover:border-accent/35 hover:text-fg";

const PHASE_LABEL: Record<RunPhase, string> = {
  planning: "Planning",
  consulting: "Consulting",
  executing: "Running",
  paused: "Waiting on you",
  finalizing: "Finalizing",
  done: "Completed",
  failed: "Stopped",
};

export default function AgentRunWorkspacePage() {
  const params = useParams<{ id: string; runId: string }>();
  const runId = params.runId;
  const { toast } = useToast();

  const run = useRunStream(runId);
  const [mobileTab, setMobileTab] = useState<"steps" | "artifact">("steps");
  const [confirmStop, setConfirmStop] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const checkpointRef = useRef<HTMLDivElement>(null);

  const agentRole = run.plan?.agentRole ?? "qa";
  const paused = run.phase === "paused" && !!run.checkpoint;
  const terminal = run.phase === "done" || run.phase === "failed";
  const building = !terminal && !run.finalBrief;
  const revision = run.plan?.revision ?? 0;

  // A blocking checkpoint pulls focus: the clarification renders as a prominent
  // full-width panel above the panes (so it's visible in any tab); scroll it in,
  // focus the card, and prefix the tab title so a backgrounded tab signals the human.
  useEffect(() => {
    if (!paused) return;
    const t = setTimeout(() => {
      checkpointRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      checkpointRef.current?.querySelector<HTMLElement>("input,textarea,button")?.focus();
    }, 60);
    const prev = document.title;
    document.title = `● ${prev.replace(/^●\s*/, "")}`;
    return () => {
      clearTimeout(t);
      document.title = prev;
    };
  }, [paused, run.checkpoint?.checkpointId]);

  // Default the mobile view to the artifact once the run completes.
  useEffect(() => {
    if (terminal) setMobileTab("artifact");
  }, [terminal]);

  async function handleAnswer(payload: Parameters<typeof run.submitAnswer>[0]) {
    setAnswerError(null);
    const ok = await run.submitAnswer(payload);
    if (!ok) setAnswerError("Couldn't submit — the run may have moved on. Try again.");
    // On success the stream emits `resumed` and the checkpoint collapses.
  }

  // Run-level pause/stop have no backend in this first (SSV) cut — the loop,
  // clarification, and plan edits are wired; run-control is a fast follow.
  function handleStop() {
    setConfirmStop(false);
    toast("Stopping a run mid-flight isn't available in this preview yet.", "info");
  }

  function togglePause() {
    toast("Pause/resume isn't available in this preview yet.", "info");
  }

  // The clarification is the run's focal point when paused: it renders as its own
  // prominent, ice-signalled panel above the workspace panes (not buried in the
  // narrow rail), so "what the agent needs from you" is unmissable in any view.
  const clarification =
    paused && run.checkpoint ? (
      <div ref={checkpointRef} className="mx-auto w-full max-w-3xl">
        <ClarificationCard
          request={run.checkpoint}
          submitting={run.submitting}
          error={answerError}
          onSubmit={handleAnswer}
          onDefer={!run.checkpoint.blocking ? () => run.postEdit({ action: "resume" }) : undefined}
        />
      </div>
    ) : null;

  // Action-oriented caption for the stepper — tells the human where to look now.
  const activeStepTitle = run.steps.find((s) => s.status === "active")?.title;
  const caption = paused
    ? "Answer below to continue"
    : run.phase === "done"
      ? "Report ready"
      : run.phase === "failed"
        ? "Run stopped"
        : run.phase === "finalizing"
          ? "Assembling report"
          : run.phase === "executing"
            ? (activeStepTitle ?? "Running checks")
            : run.phase === "consulting"
              ? "Checking memory"
              : run.phase === "planning"
                ? "Planning the run"
                : undefined;

  const rail = (
    <StepsRail
      steps={run.steps}
      messages={run.messages}
      phase={run.phase}
      planRevision={revision}
      checkpointItemId={run.checkpoint?.itemId ?? null}
      disabled={terminal}
      onAddStep={(title, detail, baseRevision) => run.postEdit({ action: "add_step", title, detail, baseRevision })}
      onRemoveStep={(itemId, baseRevision) => run.postEdit({ action: "remove_step", itemId, baseRevision })}
      onRedirect={(text) => run.postEdit({ action: "redirect", text })}
      onRerunStep={(itemId, feedback, baseRevision) =>
        run.postEdit({ action: "rerun_step", itemId, feedback, baseRevision })
      }
    />
  );

  const artifact = (
    <LiveArtifact
      brief={run.brief}
      fragments={run.fragments}
      finalBrief={run.finalBrief}
      agentRole={agentRole}
      building={building}
    />
  );

  return (
    <div className="mx-auto flex h-full max-w-[1400px] flex-col px-5 py-6 sm:px-8">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-divider pb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            href="/agents"
            className="inline-flex min-h-10 items-center whitespace-nowrap text-sm text-fg-muted transition-colors hover:text-fg"
          >
            ← Agents
          </Link>
          <span aria-hidden="true" className="text-fg-subtle">
            ·
          </span>
          <span className="text-sm font-semibold text-fg">{agentRole === "architecture" ? "Architecture" : "QA"}</span>
          <span className="whitespace-nowrap font-mono text-xs text-fg-muted">run {runId.slice(-6)}</span>
          {run.phase && (
            <span
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-divider px-2.5 py-1 text-sm ${
                paused || run.phase === "failed" ? "font-semibold text-fg" : "text-fg-muted"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  paused
                    ? "bg-accent"
                    : terminal
                      ? run.phase === "failed"
                        ? "bg-danger"
                        : "bg-success"
                      : "bg-accent motion-safe:animate-pulse"
                }`}
              />
              {paused ? "Waiting on you" : PHASE_LABEL[run.phase]}
            </span>
          )}
          {run.connection === "connecting" && !terminal && <span className="text-sm text-fg-muted">reconnecting…</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!terminal && (
            <button type="button" onClick={togglePause} className={HEADER_ACTION}>
              {run.phase === "paused" ? "▶ Resume" : "⏸ Pause"}
            </button>
          )}
          {!terminal &&
            (confirmStop ? (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleStop}
                  className="inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-xl border border-danger/40 px-3 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  Confirm stop
                </button>
                <button type="button" onClick={() => setConfirmStop(false)} className={BUTTON_QUIET}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmStop(true)}
                className={`${BUTTON_QUIET} hover:text-danger`}
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
                Stop
              </button>
            ))}
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href).then(
                () => toast("Workspace link copied.", "success"),
                () => toast("Couldn't copy link.", "error"),
              );
            }}
            className={HEADER_ACTION}
          >
            ↗ Share
          </button>
        </div>
      </header>

      {/* Phase breadcrumb — the macro Plan → Clarify → Execute → Report progress. */}
      <PhaseStepper
        phase={run.phase}
        paused={paused}
        terminal={terminal}
        failed={run.phase === "failed"}
        caption={caption}
        parallelCount={run.steps.filter((s) => (s as { parallel?: boolean }).parallel && s.status === "active").length}
        className="mt-4"
      />

      {run.error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.06] px-4 py-3">
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
          <p className="min-w-0 break-words text-sm text-fg">{run.error}</p>
        </div>
      )}

      {/* Focal clarification — front-and-center when the run is waiting on the human. */}
      {clarification && <div className="mt-4">{clarification}</div>}

      {/* Mobile segmented toggle (the two-pane collapses to one at a time on < lg). */}
      <div className="mt-4 flex gap-1 rounded-full border border-divider bg-fg/[0.03] p-1 lg:hidden">
        {(["steps", "artifact"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setMobileTab(k)}
            aria-pressed={mobileTab === k}
            className={`relative min-h-10 flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              mobileTab === k ? "bg-accent/15 text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {k === "steps" ? "Steps" : terminal ? "Report" : "Artifact"}
          </button>
        ))}
      </div>

      {/* Two-column workspace: the steps rail and the report. Neither pane is dimmed
          with opacity, so every line keeps AA contrast; the clarification above the
          panes and the phase stepper say where to look. */}
      <div className="mt-4 flex min-h-0 flex-1 gap-6">
        <aside
          className={`min-h-0 w-full min-w-0 shrink-0 overflow-hidden lg:block lg:w-[380px] ${
            mobileTab === "steps" ? "block" : "hidden"
          }`}
        >
          <div className="h-full rounded-2xl border border-divider bg-fg/[0.02] p-4">{rail}</div>
        </aside>
        <main
          className={`-mx-2 min-h-0 min-w-0 flex-1 overflow-y-auto px-2 lg:block ${
            mobileTab === "artifact" ? "block" : "hidden"
          }`}
        >
          {artifact}
        </main>
      </div>
    </div>
  );
}
