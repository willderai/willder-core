"use client";

// use-run-stream — the client hook that owns the interactive agent-run SSE
// subscription and reduces the RunEvent wire contract (types/agent-run.ts) into
// the state the workspace renders. Everything here is CONSUMPTION of the frozen
// contract; it never redefines a contract shape.
//
// Transport (fixed contract, backend built by another agent):
//   GET  /api/runs/[runId]/stream?afterSeq=N   SSE, replays persisted events then tails
//   POST /api/runs/[runId]/answer              ResumePayload  (resume a paused checkpoint)
//   POST /api/runs/[runId]/edit                RunEditPayload (live-change affordances)
//
// Replay/reconnect discipline: every RunEvent carries a monotonic `seq`. We track
// the highest applied seq, reconnect with ?afterSeq=<seq>, and drop any event whose
// seq we have already applied — so a reconnect that replays the persisted log never
// double-applies. `heartbeat` events are keepalive only and are never seq-gated.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  AgentRole,
  AgentRunPlan,
  Brief,
  BriefFragment,
  ClarificationRequest,
  PartialBrief,
  PlanItem,
  PlanItemStatus,
  ResumePayload,
  RunEvent,
  RunPhase,
} from "@/types/agent-run";

/**
 * Body for POST /api/runs/[runId]/edit. The /edit endpoint is fixed by contract but
 * its body is not frozen in types/agent-run.ts, so the workspace and the loop
 * substrate agree on this discriminated shape. `baseRevision` mirrors
 * AgentRunPlan.revision for optimistic-concurrency on plan mutations.
 */
type RunEditPayload =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "stop" }
  | { action: "add_step"; title: string; detail?: string; baseRevision: number }
  | { action: "remove_step"; itemId: string; baseRevision: number }
  | { action: "redirect"; text: string }
  // Per-stage redirect: re-run ONE completed/failed step with feedback (two-level redirect).
  | { action: "rerun_step"; itemId: string; feedback: string; baseRevision: number };

type ConnectionState = "connecting" | "open" | "closed";

interface ReducerState {
  lastSeq: number;
  plan: AgentRunPlan | null;
  phase: RunPhase | null;
  /** Live per-step status overlaid on plan.items[].status (updated between plan snapshots). */
  statusOverlay: Record<string, PlanItemStatus>;
  /** Latest progress-narration / failure line per step id. */
  messages: Record<string, string>;
  activeStepId: string | null;
  /** Cumulative brief-so-far, merged from `artifact` events. */
  brief: PartialBrief;
  /** Ordered per-step outputs (decisions, bugs, perf, charts, contradictions). */
  fragments: { itemId: string; fragment: BriefFragment }[];
  /** Open needs_input checkpoint; non-null ⇒ the run is paused on the human. */
  checkpoint: ClarificationRequest | null;
  finalBrief: Brief | null;
  error: string | null;
}

const INITIAL: ReducerState = {
  lastSeq: 0,
  plan: null,
  phase: null,
  statusOverlay: {},
  messages: {},
  activeStepId: null,
  brief: {},
  fragments: [],
  checkpoint: null,
  finalBrief: null,
  error: null,
};

/** Cumulative brief-so-far: each `artifact` carries full fields, so later overwrites. */
function mergeBrief(prev: PartialBrief, next: PartialBrief): PartialBrief {
  return { ...prev, ...next };
}

function reduce(state: ReducerState, ev: RunEvent): ReducerState {
  // seq-gate everything except keepalive so replayed events are idempotent.
  if (ev.type !== "heartbeat" && ev.seq <= state.lastSeq) return state;
  const lastSeq = ev.type === "heartbeat" ? state.lastSeq : ev.seq;

  switch (ev.type) {
    case "plan":
    case "plan_updated":
      // A fresh plan (or replan) carries authoritative statuses — drop the overlay
      // so a stale live status can't shadow the new plan.
      return { ...state, lastSeq, plan: ev.plan, statusOverlay: {} };
    case "phase":
      return { ...state, lastSeq, phase: ev.phase };
    case "step_started":
      return {
        ...state,
        lastSeq,
        activeStepId: ev.itemId,
        statusOverlay: { ...state.statusOverlay, [ev.itemId]: "active" },
        messages: { ...state.messages, [ev.itemId]: "" },
      };
    case "step_progress":
      return { ...state, lastSeq, messages: { ...state.messages, [ev.itemId]: ev.message } };
    case "step_completed": {
      // Replace an existing fragment for this step id (a per-stage rerun re-emits
      // step_completed for an already-completed step) rather than appending a duplicate;
      // preserves ordering for a first completion by appending.
      let fragments = state.fragments;
      if (ev.fragment) {
        const at = state.fragments.findIndex((f) => f.itemId === ev.itemId);
        if (at >= 0) {
          fragments = [...state.fragments];
          fragments[at] = { itemId: ev.itemId, fragment: ev.fragment };
        } else {
          fragments = [...state.fragments, { itemId: ev.itemId, fragment: ev.fragment }];
        }
      }
      return {
        ...state,
        lastSeq,
        statusOverlay: { ...state.statusOverlay, [ev.itemId]: "done" },
        activeStepId: state.activeStepId === ev.itemId ? null : state.activeStepId,
        fragments,
      };
    }
    case "step_failed":
      return {
        ...state,
        lastSeq,
        statusOverlay: { ...state.statusOverlay, [ev.itemId]: "failed" },
        messages: { ...state.messages, [ev.itemId]: ev.error },
        activeStepId: state.activeStepId === ev.itemId ? null : state.activeStepId,
      };
    case "needs_input":
      return { ...state, lastSeq, checkpoint: ev.checkpoint, phase: "paused" };
    case "resumed":
      return {
        ...state,
        lastSeq,
        checkpoint: state.checkpoint?.checkpointId === ev.checkpointId ? null : state.checkpoint,
      };
    case "artifact":
      return { ...state, lastSeq, brief: mergeBrief(state.brief, ev.partial) };
    case "done":
      return {
        ...state,
        lastSeq,
        finalBrief: ev.brief,
        phase: "done",
        checkpoint: null,
        activeStepId: null,
      };
    case "error":
      return { ...state, lastSeq, error: ev.message, phase: "failed" };
    case "heartbeat":
      return state;
    default:
      return state;
  }
}

/**
 * A rail node is either a single sequential step or a "fan-out band" — a run of
 * consecutive `parallel` plan items the manager multiplexes onto the SAME step_*
 * events (keyed by itemId = childRunId, §4). Grouping is a pure derived selector
 * over the already-overlaid `steps`; it adds NO new event types and NO reducer
 * state. A lone `parallel` item is NOT banded — a fan-out of one is behaviorally
 * single-agent — so with zero `parallel` items every node is a plain step and the
 * single-agent rail renders pixel-identically.
 */
export type RailNode = { kind: "step"; item: PlanItem } | { kind: "band"; items: PlanItem[] };

/** Group runs of consecutive `parallel: true` items into fan-out bands; every
 *  other item stays a sequential step. Input order is preserved. */
export function groupRailItems(items: PlanItem[]): RailNode[] {
  const nodes: RailNode[] = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].parallel) {
      let j = i;
      while (j < items.length && items[j].parallel) j++;
      const band = items.slice(i, j);
      // A band needs ≥2 lanes; a single parallel child degrades to a plain step.
      if (band.length >= 2) nodes.push({ kind: "band", items: band });
      else nodes.push({ kind: "step", item: band[0] });
      i = j;
    } else {
      nodes.push({ kind: "step", item: items[i] });
      i++;
    }
  }
  return nodes;
}

export interface RunStream extends ReducerState {
  /** plan.items with the live status overlay applied — what the rail renders. */
  steps: PlanItem[];
  connection: ConnectionState;
  /** true once terminal (done or errored) — the stream stops reconnecting. */
  terminal: boolean;
  submitting: boolean;
  submitAnswer: (payload: ResumePayload) => Promise<boolean>;
  postEdit: (payload: RunEditPayload) => Promise<boolean>;
}

export function useRunStream(runId: string): RunStream {
  const [state, rawDispatch] = useReducer(reduce, INITIAL);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [submitting, setSubmitting] = useState(false);

  // Highest applied seq, read by the (long-lived) reconnect loop to build afterSeq.
  const seqRef = useRef(0);
  const terminalRef = useRef(false);
  // Current plan revision, for optimistic-concurrency on edits that don't carry one.
  const revisionRef = useRef(0);
  // Current plan role, so a human-added step defaults to the right PlanItemKind:
  // architecture plans are per-domain `section`s; QA plans are `scenario`s (§6).
  const agentRoleRef = useRef<AgentRole>("qa");

  const dispatch = useCallback((ev: RunEvent) => {
    if (ev.type !== "heartbeat" && ev.seq > seqRef.current) seqRef.current = ev.seq;
    if (ev.type === "done" || ev.type === "error") terminalRef.current = true;
    rawDispatch(ev);
  }, []);

  useEffect(() => {
    // Reset for a new run id.
    seqRef.current = 0;
    terminalRef.current = false;
    const ac = new AbortController();
    let stopped = false;

    async function loop() {
      while (!stopped && !terminalRef.current) {
        setConnection("connecting");
        try {
          const res = await fetch(`/api/runs/${runId}/stream?afterSeq=${seqRef.current}`, {
            signal: ac.signal,
            headers: { Accept: "text/event-stream" },
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          setConnection("open");

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const blocks = buf.split("\n\n");
            buf = blocks.pop() ?? "";
            for (const block of blocks) {
              // SSE: one event per block; concatenate its data: lines.
              const data = block
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("");
              if (!data) continue;
              let ev: RunEvent;
              try {
                ev = JSON.parse(data) as RunEvent;
              } catch {
                continue;
              }
              dispatch(ev);
            }
          }
        } catch {
          if (ac.signal.aborted) return;
        }
        if (stopped || terminalRef.current) break;
        // Stream ended (proxy cut / server closed a non-terminal run) — back off, reconnect.
        setConnection("connecting");
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!stopped) setConnection("closed");
    }

    loop();
    return () => {
      stopped = true;
      ac.abort();
    };
  }, [runId, dispatch]);

  useEffect(() => {
    revisionRef.current = state.plan?.revision ?? 0;
  }, [state.plan?.revision]);

  useEffect(() => {
    if (state.plan?.agentRole) agentRoleRef.current = state.plan.agentRole;
  }, [state.plan?.agentRole]);

  const submitAnswer = useCallback(
    async (payload: ResumePayload) => {
      setSubmitting(true);
      try {
        const res = await fetch(`/api/runs/${runId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [runId],
  );

  // Translate the workspace's action-style affordances into the backend /edit
  // contract: { editId, baseRevision, ops[] } (services/agents/run-loop applyPlanEdit).
  // Run-level controls (pause/resume/stop) have no backend in the SSV — soft no-op.
  const postEdit = useCallback(
    async (payload: RunEditPayload) => {
      const editId = globalThis.crypto?.randomUUID?.() ?? `edit-${Date.now()}-${seqRef.current}`;
      // A human-added step maps to the role's natural PlanItemKind: `section` for
      // architecture (per-domain sections), `scenario` for QA (§6).
      const addedKind = agentRoleRef.current === "architecture" ? "section" : "scenario";
      let body:
        | { editId: string; baseRevision: number; ops: unknown[] }
        | { editId: string; baseRevision: number; rerun: { itemId: string; feedback: string } }
        | null = null;
      switch (payload.action) {
        case "add_step":
          body = {
            editId,
            baseRevision: payload.baseRevision,
            ops: [{ op: "add", item: { kind: addedKind, title: payload.title, detail: payload.detail } }],
          };
          break;
        case "remove_step":
          body = { editId, baseRevision: payload.baseRevision, ops: [{ op: "remove", itemId: payload.itemId }] };
          break;
        case "redirect":
          // Whole-run redirect: re-aim everything going forward by appending a new step.
          body = {
            editId,
            baseRevision: revisionRef.current,
            ops: [{ op: "add", item: { kind: addedKind, title: `Redirect: ${payload.text}`, detail: payload.text } }],
          };
          break;
        case "rerun_step":
          // Per-stage redirect: re-run just this one completed/failed step with feedback.
          body = {
            editId,
            baseRevision: payload.baseRevision,
            rerun: { itemId: payload.itemId, feedback: payload.feedback },
          };
          break;
        default:
          // pause | resume | stop — not wired in the SSV backend yet.
          return false;
      }
      try {
        const res = await fetch(`/api/runs/${runId}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    [runId],
  );

  const steps: PlanItem[] = (state.plan?.items ?? []).map((it) =>
    state.statusOverlay[it.id] ? { ...it, status: state.statusOverlay[it.id] } : it,
  );

  return {
    ...state,
    steps,
    connection,
    terminal: terminalRef.current,
    submitting,
    submitAnswer,
    postEdit,
  };
}
