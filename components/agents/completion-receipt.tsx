"use client";

import type { Brief } from "@/lib/agents/brief-types";
import { briefScopeDisplay } from "@/lib/agents/brief-scope-display";
import { BUTTON_SECONDARY, EYEBROW, SUB_PANEL } from "@/components/agents/agent-ui";

// ---------------------------------------------------------------------------
// CompletionReceipt — UC6 pilot: a concrete, copyable proof that a handoff
// briefing was actually completed, and by which backend. `brief.backend` is
// the persisted field (gap 4, item handoff-staleness-receipt-integrity-gap-
// 20260919) — survives a reload. `sessionBackend` is the in-session value
// from the run that JUST produced this brief, kept only as a fallback for a
// brief that predates the column (reads null) so this run's own receipt
// still shows the real backend instead of "Unknown".
// ---------------------------------------------------------------------------

export function CompletionReceipt({
  brief,
  backend: sessionBackend,
  onCopy,
}: {
  brief: Brief;
  backend: "single" | "manager" | null;
  onCopy: (message: string, variant?: "success" | "error" | "info") => void;
}) {
  const backend = brief.backend ?? sessionBackend;
  const backendLabel = backend === "manager" ? "Manager (fan-out)" : backend === "single" ? "Single agent" : "Unknown";
  const generatedAt = new Date(brief.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  async function copyReceipt() {
    const lines = [
      "Handoff briefing — completion receipt",
      `Brief ID: ${brief.id}`,
      `Grantee: ${brief.granteeName ?? "—"}${brief.granteeRole ? ` (${brief.granteeRole})` : ""}`,
      `Scope granted: ${briefScopeDisplay(brief)}`,
      `Backend: ${backendLabel}`,
      `Generated: ${generatedAt}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      onCopy("Receipt copied", "success");
    } catch {
      onCopy("Couldn't copy — copy it by hand", "error");
    }
  }

  return (
    <div className={`p-4 ${SUB_PANEL}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={EYEBROW}>Completion receipt</p>
        <button onClick={copyReceipt} className={`shrink-0 ${BUTTON_SECONDARY}`}>
          Copy receipt
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 text-sm min-[420px]:grid-cols-2 sm:grid-cols-5">
        <div className="min-w-0">
          <dt className="text-fg-subtle">Brief ID</dt>
          <dd className="break-all font-mono text-xs text-fg">{brief.id}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-subtle">Grantee</dt>
          <dd className="break-words text-fg">
            {brief.granteeName ?? "—"}
            {brief.granteeRole ? ` (${brief.granteeRole})` : ""}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-subtle">Backend</dt>
          <dd className="text-fg">{backendLabel}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-subtle">Scope</dt>
          <dd className="break-words text-fg [overflow-wrap:anywhere]">{briefScopeDisplay(brief)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-subtle">Generated</dt>
          <dd className="text-fg">{generatedAt}</dd>
        </div>
      </dl>
    </div>
  );
}
