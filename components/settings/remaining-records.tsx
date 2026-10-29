"use client";

// On a disconnected source's card: lets a person check, on demand, that the
// disconnect removed what the source brought in, and remove again what is left.
//
// The counts come from GET /api/sources/:id/records, which answers in counts only
// and refuses a caller who cannot read every scope it would name. They are read
// only when asked, never on page load: one read scans the org's graph, and a list
// of a thousand disconnected sources must not start a thousand of them.

import { useState } from "react";
import { SOURCE_REQUEST_TIMEOUT_MS } from "./source-requests";
import { remainingRecords, type ScopeRecordCounts } from "./connector-data";

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "done"; text: string; retirable: boolean }
  | { state: "failed"; message: string };

export function RemainingRecords({
  sourceId,
  removing,
  onRemoveAgain,
}: {
  sourceId: string;
  removing: boolean;
  /** Runs the disconnect again; resolves once it has finished, whether or not it succeeded. */
  onRemoveAgain: () => Promise<void>;
}) {
  const [check, setCheck] = useState<Check>({ state: "idle" });

  async function read() {
    setCheck({ state: "checking" });
    // A read that never answers would keep both buttons disabled, so it is bounded. Its
    // error text is not quoted: a 403 names the access check, a 502 the memory service.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/sources/${sourceId}/records`, { signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403)
        throw new Error(
          "Checking needs read access to every scope this source wrote to. Ask an admin of this organization for that access.",
        );
      if (!res.ok)
        throw new Error(`Could not check this source's records (HTTP ${res.status}). Try again in a minute.`);
      setCheck({ state: "done", ...remainingRecords((data.scopes ?? []) as ScopeRecordCounts[]) });
    } catch (e) {
      const message = controller.signal.aborted
        ? `The check did not answer within ${SOURCE_REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`
        : e instanceof Error && !(e instanceof TypeError)
          ? e.message
          : "Could not reach Willder to check this source's records. Try again.";
      setCheck({ state: "failed", message });
    } finally {
      clearTimeout(timer);
    }
  }

  async function removeAgain() {
    await onRemoveAgain();
    await read();
  }

  // One read or removal at a time: both buttons are disabled while either runs,
  // so no answer can arrive out of order.
  const busy = check.state === "checking" || removing;
  return (
    <div className="mt-2 text-sm leading-relaxed" aria-live="polite">
      {check.state === "done" && <p className="text-fg-muted">{check.text}</p>}
      {check.state === "failed" && <p className="break-words text-danger">{check.message}</p>}
      <div className="mt-1 flex flex-wrap gap-x-4">
        <button
          type="button"
          onClick={() => void read()}
          disabled={busy}
          className="min-h-9 font-medium text-fg-muted transition-colors hover:text-info disabled:opacity-40"
        >
          {check.state === "checking"
            ? "Checking…"
            : check.state === "idle"
              ? "Check what's left in memory"
              : "Check again"}
        </button>
        {check.state === "done" && check.retirable && (
          <button
            type="button"
            onClick={() => void removeAgain()}
            disabled={busy}
            className="min-h-9 font-medium text-fg-muted transition-colors hover:text-danger disabled:opacity-40"
          >
            {removing ? "Removing…" : "Remove what's left"}
          </button>
        )}
      </div>
    </div>
  );
}
