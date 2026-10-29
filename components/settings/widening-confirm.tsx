"use client";

// A source connect as the Integrations panels send it, and its confirmation step.
//
// POST /api/sources refuses with 409 when connecting would let more people, or
// any agent holding a token on the scope, read the source through Willder than
// can read it at the source, or when the connector cannot say who reads it. This turns that refusal into one plain
// question, and confirming resends the same request with the exact
// acknowledgement the server named. Nothing connects until the person says yes.
//
// The rule this file keeps: a connect never fails silently. Every answer other than
// success or that question becomes a message that names the fix (./source-requests.ts),
// and the question takes focus when it appears, so it is seen where the person clicked.

import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { sourceFailureMessage, sourceRequest } from "./source-requests";

/** A widening the server asked the person connecting to acknowledge. */
export interface PendingWidening {
  /** The request to resend once confirmed. */
  body: Record<string, unknown>;
  widening: { status: "known"; people: number; agents: number } | { status: "unknown"; atMost: number; agents: number };
  /** Echoed back unchanged: both counts, exactly as the server named them. */
  acknowledge: { people: number | "unknown"; agents: number };
}

/** The source a connect wrote, as POST /api/sources answers it. */
export interface ConnectedSource {
  id: string;
  type: string;
  name: string;
  scopePath: string;
  status: string;
}

type ConnectResult =
  /** `sourceId` names what was written; `source` is null when the answer did not describe it fully. */
  | { connected: true; sourceId: string | null; source: ConnectedSource | null }
  | { connected: false; pending: PendingWidening };

type ConnectAnswer = {
  error?: unknown;
  code?: unknown;
  widening?: PendingWidening["widening"];
  acknowledge?: PendingWidening["acknowledge"];
  source?: Partial<ConnectedSource>;
};

/** The source in a 201's body, or null when the body does not name one fully. */
function connectedSource(body: ConnectAnswer | null): ConnectedSource | null {
  const s = body?.source;
  if (!s || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.scopePath !== "string") return null;
  return {
    id: s.id,
    type: String(s.type ?? ""),
    name: s.name,
    scopePath: s.scopePath,
    status: String(s.status ?? "active"),
  };
}

/**
 * POST a connect. Resolves `connected` with the source it wrote, or the widening to
 * confirm when the server refused for that reason. Throws an Error whose message
 * names the fix on any other answer, including one that never arrived. `signal`
 * cancels it when the panel that sent it is gone.
 */
export async function connectSource(body: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectResult> {
  const answer = await sourceRequest("connect", "/api/sources", {
    signal,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = answer.body as ConnectAnswer | null;
  if (answer.status === 409 && data?.code === "widening_not_acknowledged") {
    if (data.widening && data.acknowledge !== undefined) {
      return { connected: false, pending: { body, widening: data.widening, acknowledge: data.acknowledge } };
    }
    throw new Error(
      "Willder has to ask who may read this source, but the question did not arrive. Reload the page, then connect again.",
    );
  }
  if (!answer.ok) throw new Error(sourceFailureMessage("connect", answer));
  const sourceId = typeof data?.source?.id === "string" ? data.source.id : null;
  return { connected: true, sourceId, source: connectedSource(data) };
}

/** The request that confirms `pending`. */
export function confirmedBody(pending: PendingWidening): Record<string, unknown> {
  return { ...pending.body, acknowledgeWidening: pending.acknowledge };
}

function people(n: number): string {
  return n === 1 ? "1 more person" : `${n} more people`;
}

function agents(n: number): string {
  return n === 1 ? "1 agent" : `${n} agents`;
}

/** "9 more people and 3 agents", leaving out a count of zero unless both are. */
function whoGains(peopleCount: number, agentCount: number): string {
  if (agentCount === 0) return people(peopleCount);
  if (peopleCount === 0) return agents(agentCount);
  return `${people(peopleCount)} and ${agents(agentCount)}`;
}

/** The question, in the words the person connecting reads. */
function wideningQuestion(widening: PendingWidening["widening"], what: string): string {
  if (widening.status === "known") {
    return `This lets ${whoGains(widening.people, widening.agents)} read ${what} through Willder. Confirm to connect.`;
  }
  const agentClause = widening.agents > 0 ? `, and ${agents(widening.agents)} will` : "";
  // atMost 0 means no bound is known, not "none": don't say "up to 0".
  const who = widening.atMost === 0 ? "an unknown number of people" : `up to ${people(widening.atMost)}`;
  return `Willder can't see who can read ${what} at the source, so ${who} could read it through Willder${agentClause}. Confirm to connect.`;
}

export function WideningConfirm({
  pending,
  what,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PendingWidening;
  /** What is being connected, as the sentence names it: "these files", "this channel". */
  what: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The question replaces the click's answer, so it takes focus and comes into view:
  // on a phone the Connect button can be the last thing on screen.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, [pending]);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="alertdialog"
      aria-label="Confirm who can read this source"
      className="rounded-xl border border-gold/30 bg-gold/[0.05] px-4 py-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
    >
      <p>{wideningQuestion(pending.widening, what)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="primary" size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? "Connecting…" : "Confirm and connect"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A refused connect's sentence, shown where the person clicked. */
export function ConnectError({ message }: { message: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    line.current?.scrollIntoView?.({ block: "nearest" });
  }, [message]);
  return (
    <p ref={line} role="alert" className="flex items-start gap-1.5 break-words text-sm leading-relaxed text-danger">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
