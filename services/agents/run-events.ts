// Shared run-event bus + append (docs/design_manager_fanout.md §7-WS0).
//
// Extracted verbatim from run-loop.ts so BOTH the single-agent loop and the
// manager engine (services/agents/manager.ts) emit onto the SAME in-memory
// live-tail bus with the SAME monotonic-seq assignment. Keeping this in one
// module is what lets a manager run stream LIVE onto the stream route's tail
// instead of only replaying a finished run.
//
// The bus is best-effort and NOT a source of truth: the SSE stream route replays
// persisted AgentRunEvent rows first, then tails this bus. `emit` persists the row
// (assigning seq under the @@unique([runId, seq]) guard, retrying on the P2002
// race) and then publishes to any live listeners.
import { db } from "@/lib/db";
import type { RunEvent } from "@/types/agent-run";

// ---------------------------------------------------------------------------
// In-memory live-tail bus (best-effort, NOT truth).
// ---------------------------------------------------------------------------

type Listener = (ev: RunEvent) => void;
const buses = new Map<string, Set<Listener>>();

export function subscribeRun(runId: string, listener: Listener): () => void {
  let set = buses.get(runId);
  if (!set) {
    set = new Set();
    buses.set(runId, set);
  }
  set.add(listener);
  return () => {
    const s = buses.get(runId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) buses.delete(runId);
  };
}

export function publish(runId: string, ev: RunEvent) {
  const set = buses.get(runId);
  if (!set) return;
  for (const l of set) {
    try {
      l(ev);
    } catch {
      /* a broken listener must not break the loop */
    }
  }
}

// ---------------------------------------------------------------------------
// Event append — assigns a monotonic seq per run, persists an AgentRunEvent row,
// then publishes to the live bus. Retries on the @@unique([runId, seq]) race.
// ---------------------------------------------------------------------------

// Distributive omit so the discriminated union isn't collapsed to its common keys.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunEventBody = DistributiveOmit<RunEvent, "seq" | "runId" | "at">;

export async function emit(runId: string, body: RunEventBody): Promise<RunEvent> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const last = await db.agentRunEvent.findFirst({
      where: { runId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    const ev = { seq, runId, at: new Date().toISOString(), ...body } as RunEvent;
    try {
      await db.agentRunEvent.create({
        data: { runId, seq, type: body.type, payload: ev as unknown as object },
      });
      publish(runId, ev);
      return ev;
    } catch (e: unknown) {
      if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
        continue; // seq taken by a racing writer — recompute and retry
      }
      throw e;
    }
  }
  throw new Error(`could not assign a monotonic seq for run ${runId}`);
}
