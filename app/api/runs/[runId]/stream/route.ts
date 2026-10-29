// GET /api/runs/[runId]/stream — the SSE replay+tail for an interactive run
// (docs/design_interactive_agent_loop.md §3, §7).
//
// Contract:
//   query: ?afterSeq=N (default 0) — replay only events with seq > N.
//   response: text/event-stream. Frames are `event: <RunEvent.type>\ndata: <RunEvent json>\n\n`,
//     exactly like the existing run/route.ts. Emits every persisted RunEvent in seq order
//     (plan, plan_updated, phase, step_started, step_progress, step_completed, step_failed,
//      needs_input, resumed, artifact, done, error) plus periodic `heartbeat` keepalives.
//   The stream CLOSES when it forwards a terminal event (done | error) or a `phase` event
//     whose phase is "paused" — matching the pause-via-close-stream mechanism.
//
// Behavior: subscribe to the live bus FIRST (buffered), then replay persisted events with
// seq > afterSeq, then flush the buffer, then tail live. Because serverless may freeze the
// background driver after the start/answer POST returns, this route also RE-DRIVES the loop
// (driveRun is guarded, so it's a no-op if a driver is already active) — the long-lived SSE
// connection thus hosts execution and guarantees progress on reconnect.
//
// Access: the run must belong to the caller's org, and the caller must pass
// check({ action: "memory.read" }) on every scope the run's events can carry before
// any event is sent: the run's own scope (the org root for a scope-less run, the
// same fallback the brief it produces is stored under) and the stored scope of that
// brief, which the `done` event replays in full. That is the check GET /api/briefs/:id
// makes, so the stream cannot hand out a brief the brief route refuses. Once that
// brief is retired, every reader gets the 404 the brief route gives, because the
// run's stored events still hold its content. A caller who fails either gets the
// same 404 as a run id that does not exist.
import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { canReadRun } from "@/services/agents/run-visibility";
import { isBriefRetired } from "@/services/memory/brief-retirement";
import { driveRun, subscribeRun, isTerminalPhase } from "@/services/agents/run-loop";
import type { RunEvent } from "@/types/agent-run";

const enc = new TextEncoder();
const HEARTBEAT_MS = 15_000;

function sseEvent(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

/** A `phase: paused` event or a terminal event ends the stream. */
function isClosingEvent(ev: RunEvent): boolean {
  if (ev.type === "done" || ev.type === "error") return true;
  if (ev.type === "phase" && ev.phase === "paused") return true;
  return false;
}

function runNotFound(): Response {
  return Response.json({ error: "run not found" }, { status: 404 });
}

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await db.agentRun.findFirst({
    where: { id: runId, orgId: rc.org.id },
    select: { id: true, phase: true, meta: true, briefId: true },
  });
  if (!run) return runNotFound();
  if (!(await canReadRun(rc.ctx, rc.org.id, run))) return runNotFound();
  if (run.briefId && (await isBriefRetired(run.briefId))) return runNotFound();

  const url = new URL(req.url);
  const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0") || 0;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastSeq = afterSeq;
      let replaying = true;
      const liveBuffer: RunEvent[] = [];
      // Both declared `let` (not `const`) on purpose: `cleanup` below closes over
      // them and can run (e.g. via `forward`'s early calls during replay) before
      // either is assigned. Declaring them `const` would mean assigning at
      // declaration time, which would require moving them below `cleanup` and
      // expose `cleanup` to a TDZ throw if it runs before that point is reached.
      // eslint-disable-next-line prefer-const
      let unsub: (() => void) | undefined;
      // eslint-disable-next-line prefer-const
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsub?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const forward = (ev: RunEvent) => {
        if (closed) return;
        if (ev.seq <= lastSeq) return; // dedupe across replay↔live boundary
        lastSeq = ev.seq;
        try {
          sseEvent(controller, ev.type, ev);
        } catch {
          cleanup();
          return;
        }
        if (isClosingEvent(ev)) cleanup();
      };

      // 1) Subscribe live first so nothing emitted during replay is lost.
      unsub = subscribeRun(runId, (ev) => {
        if (replaying) liveBuffer.push(ev);
        else forward(ev);
      });

      // 2) Replay persisted events (the DB is the source of truth).
      const past = await db.agentRunEvent.findMany({
        where: { runId, seq: { gt: afterSeq } },
        orderBy: { seq: "asc" },
        select: { seq: true, payload: true },
      });
      for (const row of past) {
        forward(row.payload as unknown as RunEvent);
        if (closed) return;
      }

      // 3) Flush any events buffered during replay, then switch to live tailing.
      replaying = false;
      const sorted = [...liveBuffer].sort((a, b) => a.seq - b.seq);
      for (const ev of sorted) {
        forward(ev);
        if (closed) return;
      }

      // 4) If the run is already terminal, we're done after replay.
      const fresh = await db.agentRun.findUnique({ where: { id: runId }, select: { phase: true } });
      if (isTerminalPhase(fresh?.phase) || fresh?.phase === "paused") {
        cleanup();
        return;
      }

      // 5) Keepalive + ensure the loop is being driven (guarded no-op if already active).
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          sseEvent(controller, "heartbeat", { seq: lastSeq, runId, at: new Date().toISOString(), type: "heartbeat" });
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);

      req.signal?.addEventListener("abort", cleanup);
      void driveRun(runId, rc.org.id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
