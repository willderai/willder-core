"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot } from "lucide-react";
import { PageHeader, Card, Pill, Modal, Tabs, useToast } from "@/components/ui";
import { TextField, Label, Input, TextArea, Switch } from "@heroui/react";
import { ScopePicker } from "@/components/memory/scope-picker";
import ChartBlock from "@/components/charts/chart-block";
import { ContradictionBlock } from "@/components/agents/contradiction-block";
import { CompletionReceipt } from "@/components/agents/completion-receipt";
import { RunMemoryTrail } from "@/components/agents/run-memory-trail";
import {
  BLOCK_TITLE,
  BUTTON_PRIMARY,
  BUTTON_QUIET,
  BUTTON_SECONDARY,
  EYEBROW,
  EYEBROW_ON_PAGE,
  FIELD,
  FIELD_HELP,
  FIELD_LABEL,
  FOCUS,
  SUB_PANEL,
} from "@/components/agents/agent-ui";
import type { Brief, BriefType } from "@/lib/agents/brief-types";
import { displayWriterLabel } from "@/components/audit/format";
import { briefScopeDisplay } from "@/lib/agents/brief-scope-display";
import { ListControls, ListNoMatch } from "@/components/list-controls/list-controls";
import {
  compareTime,
  isNarrowed,
  showsListControls,
  type ListConfig,
  type ListState,
} from "@/components/list-controls/list-query";
import { AgentKpis } from "@/components/agents/dashboard/agent-kpis";
import { AgentRoster } from "@/components/agents/dashboard/agent-roster";
import { ActivityFeed } from "@/components/agents/dashboard/activity-feed";
import { AGENT_VERBS, duration, timeAgo } from "@/components/agents/dashboard/format";
import { useListState } from "@/components/list-controls/use-list-state";
import { RUN_PAGE_SIZE } from "@/lib/agent-lists";
import { SearchPicker, type PickOption } from "@/components/search-picker/search-picker";
import { searchContacts } from "@/components/search-picker/pick-sources";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentRole = "research" | "copy" | "handoff" | "architecture" | "qa" | "custom";
type RunStatus = "running" | "completed" | "failed";
type ToolKey = "web_search" | "scrape" | "memory_read" | "memory_write";

type AgentRun = {
  id: string;
  status: RunStatus;
  triggeredBy: string | null;
  meta: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
};

type Agent = {
  id: string;
  agentKey: string;
  name: string;
  role: AgentRole;
  model: string | null;
  // Absent, not null, for a caller who may not configure agents: GET /api/agents
  // leaves the prompt and settings out unless the caller holds access.manage at
  // the org root (services/agents/config-access.ts). See mayConfigure().
  systemPrompt?: string | null;
  tools: ToolKey[];
  active: boolean;
  _count: { runs: number };
  runs: AgentRun[];
};

/**
 * Whether the caller may configure this agent. The agent routes return the system
 * prompt only to a caller who may also write it, so its presence is the answer;
 * a member gets a read-only card instead of a form whose save would be refused.
 */
function mayConfigure(agent: Agent): boolean {
  return "systemPrompt" in agent;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_META: Record<ToolKey, { label: string; description: string }> = {
  web_search: {
    label: "Web search",
    description: "Search the web for company news and signals (Exa)",
  },
  scrape: {
    label: "Web scrape",
    description: "Scrape and extract content from any URL (Firecrawl)",
  },
  memory_read: {
    label: "Memory read",
    description: "Retrieve relevant facts from the org's memory graph",
  },
  memory_write: {
    label: "Memory write",
    description: "Write research findings to the org's memory graph",
  },
};

const ALL_TOOL_KEYS = Object.keys(TOOL_META) as ToolKey[];

const MODEL_OPTIONS = [
  { value: "gpt-4o-mini", label: "GPT-4o mini" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4.1", label: "GPT-4.1" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run state as a colour role: live runs in ice, finished in green, failures in red. */
function runStatusDot(status: RunStatus): "success" | "accent" | "danger" {
  if (status === "completed") return "success";
  if (status === "running") return "accent";
  return "danger";
}

function roleLabel(role: AgentRole): string {
  if (role === "research") return "Research";
  if (role === "copy") return "Copy";
  if (role === "handoff") return "Handoff";
  if (role === "architecture") return "Architecture";
  if (role === "qa") return "QA";
  return "Custom";
}

/** Roles whose backend was deleted in the Era 1 outbound-sales cut. No new agent
 *  can be created with one — `POST /api/agents` only ever writes "custom" and the
 *  built-in seeds in lib/tenant.ts no longer include them — so only rows created
 *  before the cut still carry one. Their run endpoint no longer exists, so the UI
 *  must not offer a test run for them. */
function isRetiredRole(role: AgentRole): boolean {
  return role === "research";
}

// ---------------------------------------------------------------------------
// Brief types (UC6 — Handoff agent)
// ---------------------------------------------------------------------------

const BRIEF_META: Record<BriefType, { label: string }> = {
  handoff: { label: "Handoff" },
  architecture_plan: { label: "Architecture" },
  qa_review: { label: "QA review" },
};

function formatDueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Launch an INTERACTIVE run (the workspace path). POSTs the same config the quick
// path uses to the fixed contract endpoint and returns the persisted AgentRun id,
// which is the workspace URL key (/agents/[id]/run/[runId]). The quick "Generate"
// path stays exactly as-is — this is the second door to the same kind of run.
async function startInteractiveRun(
  agentId: string,
  body: Record<string, unknown>,
  endpoint: "run-interactive" | "plan-interactive" | "run-manager" | "plan-manager" = "run-interactive",
): Promise<string> {
  const res = await fetch(`/api/agents/${agentId}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.runId) throw new Error(data?.error ?? "Couldn't open the workspace");
  return data.runId as string;
}

// ---------------------------------------------------------------------------
// CorrectionControl — human-in-command "flag / correct" affordance (UC9).
// Shared by every BriefView (Handoff + Architecture). Submits to
// POST /api/briefs/:id/correct with an optional section heading. Confirmation
// reflects whether the correction was auto-merged or routed to a dispute.
// ---------------------------------------------------------------------------

function CorrectionControl({
  briefId,
  sectionHeading,
  label = "Flag as wrong / correct this",
}: {
  briefId: string;
  sectionHeading?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ autoMerged: boolean; disputeId?: string } | null>(null);

  async function handleSubmit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/briefs/${briefId}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sectionHeading: sectionHeading || undefined,
          correction: text.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Failed to submit correction");
        return;
      }
      setResult({ autoMerged: !!data.autoMerged, disputeId: data.disputeId });
    } catch {
      setError("Failed to submit correction");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    const disputed = !result.autoMerged && !!result.disputeId;
    return (
      <div
        className={`mt-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm text-fg ${
          disputed ? "border-warning/40" : "border-success/40"
        }`}
      >
        <svg
          className={`mt-0.5 h-4 w-4 shrink-0 ${disputed ? "text-warning" : "text-success"}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {disputed ? (
            <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          ) : (
            <path d="M20 6 9 17l-5-5" />
          )}
        </svg>
        <span>
          {disputed
            ? "Correction submitted for review (conflicts with an existing decision)."
            : "Correction applied to memory."}
        </span>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg text-sm text-fg-muted transition-colors hover:text-fg ${FOCUS}`}
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
        {label}
      </button>
    );
  }

  return (
    <div className="mt-3 border-t border-divider pt-3">
      <p className="text-sm font-medium text-fg">
        {sectionHeading ? `Correct “${sectionHeading}”` : "Correct this brief"}
      </p>
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What's the correct information?"
        className={`mt-2 ${FIELD}`}
      />
      {error && <p className="mt-1.5 text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={handleSubmit} disabled={submitting || !text.trim()} className={BUTTON_PRIMARY}>
          {submitting ? "Submitting…" : "Submit correction"}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setText("");
            setError(null);
          }}
          className={BUTTON_QUIET}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BriefView — render a generated Brief (title, summary, sections, diagram/links).
// Shared by the Handoff and Architecture agents; header + extra blocks
// (milestones, contradictions) adapt to the brief type. Every section — plus
// the brief as a whole — carries a human-in-command correction affordance (UC9).
// ---------------------------------------------------------------------------

function BriefView({ brief }: { brief: Brief }) {
  const meta = BRIEF_META[brief.type] ?? BRIEF_META.handoff;
  const milestones = Array.isArray(brief.milestones) ? brief.milestones : [];
  const contradictions = Array.isArray(brief.contradictions) ? brief.contradictions : [];
  // Corrections reconcile a memory FACT (handoff/architecture briefs). A QA report is
  // observed product behavior — bugs/latency aren't memory facts to dispute — so the
  // "flag as wrong / correct this → memory" affordance doesn't apply to qa_review.
  const canCorrect = brief.type !== "qa_review";

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={EYEBROW}>{meta.label}</span>
          <span className="min-w-0 break-all font-mono text-xs text-fg-subtle">{briefScopeDisplay(brief)}</span>
        </div>
        <h3 className="mt-2 break-words text-lg font-semibold leading-snug text-fg">{brief.title}</h3>
        {(brief.granteeName || brief.granteeRole) && (
          <p className="mt-1 break-words text-sm text-fg-subtle">
            For <span className="text-fg-muted">{brief.granteeName}</span>
            {brief.granteeRole ? ` — ${brief.granteeRole}` : ""}
          </p>
        )}
      </div>

      <div className={`p-4 ${SUB_PANEL}`}>
        <p className={EYEBROW}>Summary</p>
        <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-fg">{brief.summary}</p>
        {canCorrect && <CorrectionControl briefId={brief.id} label="Correct the summary" />}
      </div>

      <ContradictionBlock contradictions={contradictions} />

      {brief.sections.length > 0 && (
        <div className="space-y-4">
          {brief.sections.map((s, i) => (
            <div key={i} className="border-t border-divider pt-4">
              <p className={`break-words ${BLOCK_TITLE}`}>{s.heading}</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-fg-muted">
                {s.content}
              </p>
              {canCorrect && <CorrectionControl briefId={brief.id} sectionHeading={s.heading} />}
            </div>
          ))}
        </div>
      )}

      {milestones.length > 0 && (
        <div className="border-t border-divider pt-4">
          <p className={BLOCK_TITLE}>Milestones</p>
          <ol className="mt-3 space-y-0">
            {milestones.map((m, i) => (
              <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                {/* timeline rail */}
                <div className="flex flex-col items-center">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                  {i < milestones.length - 1 && <span className="mt-1 w-px flex-1 bg-divider" />}
                </div>
                <div className="min-w-0 flex-1 -mt-0.5">
                  <p className="break-words text-sm leading-snug text-fg">{m.label}</p>
                  {m.dueDate && <p className="mt-0.5 font-mono text-xs text-fg-subtle">{formatDueDate(m.dueDate)}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {Array.isArray(brief.charts) && brief.charts.length > 0 && (
        <div className="space-y-4 border-t border-divider pt-4">
          {brief.charts.map((spec, i) => (
            <ChartBlock key={i} spec={spec} />
          ))}
        </div>
      )}

      {brief.diagram && (
        <div className="border-t border-divider pt-4">
          <p className={BLOCK_TITLE}>Diagram</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border border-divider bg-fg/[0.04] p-3 font-mono text-xs text-fg-muted">
            {brief.diagram}
          </pre>
        </div>
      )}

      {(brief.diagramUrl || brief.googleDocUrl) && (
        <div className="flex flex-wrap gap-3 border-t border-divider pt-4">
          {brief.diagramUrl && (
            <a href={brief.diagramUrl} target="_blank" rel="noreferrer" className={BUTTON_SECONDARY}>
              View diagram →
            </a>
          )}
          {brief.googleDocUrl && (
            <a href={brief.googleDocUrl} target="_blank" rel="noreferrer" className={BUTTON_SECONDARY}>
              Open Google Doc →
            </a>
          )}
        </div>
      )}

      {/* Whole-brief correction fallback (covers anything not tied to a section) */}
      {canCorrect && (
        <div className="border-t border-divider pt-4">
          <p className={FIELD_HELP}>Spot something wrong? Corrections feed back into memory — you stay in command.</p>
          <CorrectionControl briefId={brief.id} label="Flag something else in this brief" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentConfigForm — the shared configuration body (name, model, tools, prompt,
// memory scope + role-specific: architecture nightly sweep,
// and a test run). Rendered inside AgentModal (create flow) and inline in each
// card's expandable panel (edit flow). Provides its own action row.
// ---------------------------------------------------------------------------

function AgentConfigForm({
  agent,
  defaultScope,
  onSaved,
  onCancel,
}: {
  agent: Agent | null;
  defaultScope: string | null;
  onSaved: (agent: Agent) => void;
  onCancel?: () => void;
}) {
  const isCreate = agent === null;
  const [name, setName] = useState(agent?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [tools, setTools] = useState<ToolKey[]>(agent?.tools ?? []);
  const [model, setModel] = useState(agent?.model ?? MODEL_OPTIONS[0].value);
  const [memoryScope, setMemoryScope] = useState<string | null>(
    (agent as (Agent & { settings?: { memoryScope?: string } }) | null)?.settings?.memoryScope ?? defaultScope,
  );
  const existingCron = (agent as (Agent & { settings?: { cron?: { enabled?: boolean; scope?: string } } }) | null)
    ?.settings?.cron;
  const [cronEnabled, setCronEnabled] = useState<boolean>(existingCron?.enabled ?? false);
  const [cronScope, setCronScope] = useState<string | null>(existingCron?.scope ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The contact the test run drafts for, searched on the server as the person types.
  const [testContact, setTestContact] = useState<PickOption | null>(null);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ subject: string; body: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const agentRole = agent?.role ?? "copy";
  const roleRetired = isRetiredRole(agentRole);

  function toggleTool(key: ToolKey) {
    setTools((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function handleRun() {
    if (!agent || !testContact) return;
    setRunning(true);
    setRunResult(null);
    setRunError(null);
    setRunProgress(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: testContact.value }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setRunError(data?.error ?? "Run failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventLine = block
            .split("\n")
            .find((l) => l.startsWith("event:"))
            ?.slice(7)
            .trim();
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(6)
            .trim();
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine);
          if (eventLine === "progress") setRunProgress(payload.message ?? null);
          if (eventLine === "done") {
            setRunResult(payload);
            setRunProgress(null);
          }
          if (eventLine === "error") {
            setRunError(payload.message ?? "Run failed");
            setRunProgress(null);
          }
        }
      }
    } catch {
      setRunError("Run failed");
      setRunProgress(null);
    } finally {
      setRunning(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: {
        name: string;
        systemPrompt: string | null;
        tools: ToolKey[];
        model: string | null;
        memoryScope: string | null;
        cron?: { enabled: boolean; scope: string };
      } = {
        name: name.trim(),
        systemPrompt: systemPrompt.trim() || null,
        tools,
        model: model || null,
        memoryScope: memoryScope || null,
      };
      // Nightly contradiction sweep — architecture agents only. Backend cron
      // (lib/inngest.ts) reads settings.cron; enabled:false is what turns it off.
      if (agentRole === "architecture") {
        payload.cron = { enabled: cronEnabled, scope: cronScope ?? "" };
      }
      const res = isCreate
        ? await fetch("/api/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/agents/${agent!.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.formErrors?.[0] ?? "Something went wrong");
        return;
      }
      const data = await res.json();
      onSaved(data.agent);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <TextField value={name} onChange={setName} isRequired>
        <Label>Name</Label>
        <Input placeholder="Agent name" fullWidth />
      </TextField>

      <div>
        <label className={FIELD_LABEL}>Model</label>
        <select value={model} onChange={(e) => setModel(e.target.value)} className={FIELD}>
          {MODEL_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={FIELD_LABEL}>Tools</label>
        <div className="space-y-3">
          {ALL_TOOL_KEYS.map((key) => (
            <label key={key} className="group flex cursor-pointer items-start gap-3">
              <div className="mt-0.5 h-4 w-4 shrink-0">
                <input
                  type="checkbox"
                  checked={tools.includes(key)}
                  onChange={() => toggleTool(key)}
                  className={`h-4 w-4 rounded accent-action ${FOCUS}`}
                />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{TOOL_META[key].label}</p>
                <p className={FIELD_HELP}>{TOOL_META[key].description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <TextField value={systemPrompt} onChange={setSystemPrompt}>
        <Label>System prompt</Label>
        <TextArea
          rows={6}
          placeholder="Describe the agent's role and how it should behave. Leave blank to use the default prompt for this role."
          fullWidth
        />
      </TextField>

      <div>
        <label className={FIELD_LABEL}>Memory scope</label>
        <p className={`mb-2 ${FIELD_HELP}`}>
          Restrict this agent&apos;s memory reads and writes to a specific scope. Leave unset for org-wide access.
        </p>
        <ScopePicker selected={memoryScope} onChange={setMemoryScope} />
        {memoryScope && (
          <button type="button" onClick={() => setMemoryScope(null)} className={`mt-1 -ml-2 ${BUTTON_QUIET}`}>
            Clear (use org root)
          </button>
        )}
      </div>

      {/* Nightly contradiction sweep — architecture agents only. Turns on the
            backend cron (lib/inngest.ts) that flags new contradictions nightly. */}
      {agentRole === "architecture" && (
        <div>
          <label className={FIELD_LABEL}>Nightly contradiction sweep</label>
          <p className={`mb-2.5 ${FIELD_HELP}`}>
            Runs this agent automatically each night to flag new contradictions in the selected scope.
          </p>
          <Switch isSelected={cronEnabled} onChange={setCronEnabled}>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <p className="text-sm text-fg">Run nightly</p>
            </Switch.Content>
          </Switch>
          {cronEnabled && (
            <div className="mt-3">
              <label className={FIELD_LABEL}>Scope to sweep</label>
              <ScopePicker selected={cronScope} onChange={setCronScope} />
              {!cronScope && (
                <p className={`mt-1.5 ${FIELD_HELP}`}>Select a scope above to enable the nightly sweep.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Test run — existing agents whose run endpoint still exists. */}
      {!isCreate && !roleRetired && (
        <div className={`space-y-3 p-4 ${SUB_PANEL}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className={EYEBROW}>Test run</p>
            <p className={FIELD_HELP}>Reads memory · generates an email draft</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 sm:flex-1">
              <SearchPicker
                label="Contact"
                placeholder="Choose a contact"
                searchPlaceholder="Search by name, email or title"
                selected={testContact}
                onChange={setTestContact}
                search={searchContacts}
              />
            </div>
            <button onClick={handleRun} disabled={running || !testContact} className={BUTTON_SECONDARY}>
              {running ? "Running…" : "▶ Draft"}
            </button>
          </div>
          {running && runProgress && (
            <div className="flex items-center gap-2 text-sm text-fg-muted [overflow-wrap:anywhere]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
              {runProgress}
            </div>
          )}
          {runError && <p className="text-sm text-danger [overflow-wrap:anywhere]">{runError}</p>}
          {runResult && (
            <div className="space-y-2 border-t border-divider pt-3">
              <p className={EYEBROW}>Subject</p>
              <p className="text-sm text-fg [overflow-wrap:anywhere]">{runResult.subject}</p>
              <p className={`mt-3 ${EYEBROW}`}>Body</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
                {runResult.body}
              </p>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-divider pt-4">
        {onCancel && (
          <button onClick={onCancel} className={BUTTON_QUIET}>
            Cancel
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving || !name.trim() || (agentRole === "architecture" && cronEnabled && !cronScope)}
          className={BUTTON_PRIMARY}
        >
          {saving ? "Saving…" : isCreate ? "Create agent" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentModal — thin wrapper around AgentConfigForm for the "+ New agent" create
// flow. (Editing built-in agents now happens inline in each card's panel.)
// ---------------------------------------------------------------------------

function AgentModal({
  agent,
  defaultScope,
  onClose,
  onSaved,
}: {
  agent: Agent | null;
  defaultScope: string | null;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}) {
  return (
    <Modal title={agent === null ? "New agent" : "Configure agent"} size="2xl" onClose={onClose}>
      <AgentConfigForm agent={agent} defaultScope={defaultScope} onSaved={onSaved} onCancel={onClose} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// AgentRunSetup — the inline run-setup for the three output agents (handoff,
// architecture, qa). Holds the same inputs the old run modals had and POSTs the
// same bodies to the same endpoints; renders the result Brief in place. QA and
// architecture also expose the interactive workspace door (startInteractiveRun).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AttachmentPicker — reusable control for PER-RUN, EPHEMERAL doc attachments
// (docs/design_per_run_attachments.md). On select it POSTs each file to the
// extraction helper, collects the returned { name, content }, and hands the list
// back to the parent to include in the interactive run's start body. The content
// is used as reference context for that one run only — it is NEVER saved to memory.
// ---------------------------------------------------------------------------

type RunAttachment = { name: string; content: string };

const ATTACHMENT_ACCEPT = [
  ".pdf",
  ".docx",
  ".doc",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
].join(",");
const MAX_RUN_ATTACHMENTS = 5;

function AttachmentPicker({
  attachments,
  onChange,
}: {
  attachments: RunAttachment[];
  onChange: (next: RunAttachment[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...attachments];
    for (const file of files) {
      if (next.length >= MAX_RUN_ATTACHMENTS) {
        setError(`Up to ${MAX_RUN_ATTACHMENTS} documents per run.`);
        break;
      }
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/agents/attachments/extract", { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "couldn't read that file");
        next.push({ name: data.name as string, content: data.content as string });
      } catch (err) {
        setError(`"${file.name}": ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    onChange(next);
    setBusy(false);
  }

  return (
    <div>
      <label className={FIELD_LABEL}>Attach a doc for this run (optional)</label>
      <p className={`mb-2 ${FIELD_HELP}`}>Used as reference context for this run only — not saved to memory.</p>
      {attachments.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {attachments.map((a, i) => (
            <li
              key={`${a.name}-${i}`}
              className={`flex items-center justify-between gap-2 py-1 pl-3 pr-1 text-sm text-fg-muted ${SUB_PANEL}`}
            >
              <span className="min-w-0 truncate" title={a.name}>
                {a.name}
              </span>
              <button
                type="button"
                onClick={() => onChange(attachments.filter((_, idx) => idx !== i))}
                className={`shrink-0 hover:text-danger ${BUTTON_QUIET}`}
                aria-label={`Remove ${a.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <input ref={inputRef} type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={onPick} className="hidden" />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy || attachments.length >= MAX_RUN_ATTACHMENTS}
        className={BUTTON_SECONDARY}
      >
        {busy ? "Reading…" : attachments.length > 0 ? "Add another" : "Attach a document"}
      </button>
      {error && <p className="mt-1.5 text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}
    </div>
  );
}

function AgentRunSetup({ agent }: { agent: Agent }) {
  const router = useRouter();
  const { toast } = useToast();
  const [scope, setScope] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [openingWs, setOpeningWs] = useState(false);
  const [fanOut, setFanOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  // UC6 pilot: which backend actually produced the current `brief` — captured
  // at generation time (not re-read from `fanOut`, which the form no longer
  // shows once a result is in) so the completion receipt below can name it.
  const [lastBackend, setLastBackend] = useState<"single" | "manager" | null>(null);

  // Handoff
  const [granteeName, setGranteeName] = useState("");
  const [granteeRole, setGranteeRole] = useState("");
  // Handoff + Architecture
  const [context, setContext] = useState("");
  // Architecture
  const [title, setTitle] = useState("");
  // QA
  const [baseUrl, setBaseUrl] = useState("");
  const [mode, setMode] = useState<"api" | "browser">("api");
  const [focus, setFocus] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  // QA + Architecture: per-run, ephemeral doc attachments (workspace runs only).
  const [attachments, setAttachments] = useState<RunAttachment[]>([]);

  const urlValid = (() => {
    try {
      const u = new URL(baseUrl.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  })();

  async function runQuick(path: string, body: Record<string, unknown>, failMsg: string) {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? failMsg);
        return;
      }
      setBrief(data.brief);
    } catch {
      setError(failMsg);
    } finally {
      setGenerating(false);
    }
  }

  async function openWorkspace(body: Record<string, unknown>) {
    if (openingWs) return;
    // Open the tab synchronously on click so the popup blocker allows it, then
    // point it at the run once created (fall back to same-tab nav if blocked).
    const tab = window.open("", "_blank");
    setOpeningWs(true);
    setError(null);
    try {
      const endpoint =
        agent.role === "architecture"
          ? fanOut
            ? "plan-manager"
            : "plan-interactive"
          : fanOut
            ? "run-manager"
            : "run-interactive";
      const runId = await startInteractiveRun(agent.id, body, endpoint);
      const url = `/agents/${agent.id}/run/${runId}`;
      if (tab) tab.location.href = url;
      else router.push(url);
      setOpeningWs(false);
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "Couldn't open the workspace");
      setOpeningWs(false);
    }
  }

  // Result state — render the brief in place with a reset back to the form.
  if (brief) {
    const resetLabel = agent.role === "qa" ? "New test" : agent.role === "architecture" ? "New plan" : "New briefing";
    return (
      <div className="space-y-4">
        {agent.role === "handoff" && <CompletionReceipt brief={brief} backend={lastBackend} onCopy={toast} />}
        <BriefView brief={brief} />
        <button
          onClick={() => {
            setBrief(null);
            setLastBackend(null);
            setError(null);
          }}
          className={`-ml-2 ${BUTTON_QUIET}`}
        >
          ← {resetLabel}
        </button>
      </div>
    );
  }

  const spinnerMessage =
    agent.role === "qa"
      ? "Driving the product and probing for defects… this can take a minute or more."
      : agent.role === "architecture"
        ? "Reading memory within scope, drafting the plan and reconciling decisions… this can take up to a minute."
        : "Reading memory within the granted scope and drafting the briefing… this can take up to a minute.";

  return (
    <div className="space-y-5">
      {agent.role === "handoff" && (
        <>
          <div>
            <label className={FIELD_LABEL}>Scope to grant</label>
            <p className={`mb-2 ${FIELD_HELP}`}>
              The briefing will be bounded to exactly this part of memory — nothing wider.
            </p>
            <ScopePicker selected={scope} onChange={setScope} />
          </div>
          <TextField value={granteeName} onChange={setGranteeName} isRequired>
            <Label>Grantee name</Label>
            <Input placeholder="e.g. Jordan Rivera" fullWidth />
          </TextField>
          <TextField value={granteeRole} onChange={setGranteeRole}>
            <Label>Grantee role (optional)</Label>
            <Input placeholder="e.g. Contract designer" fullWidth />
          </TextField>
          <TextField value={context} onChange={setContext}>
            <Label>Extra context (optional)</Label>
            <TextArea rows={4} placeholder="Anything specific this person should know going in…" fullWidth />
          </TextField>
          {!scope && <p className={FIELD_HELP}>Select a scope above to enable generation.</p>}
        </>
      )}

      {agent.role === "architecture" && (
        <>
          <div>
            <label className={FIELD_LABEL}>Scope to plan against</label>
            <p className={`mb-2 ${FIELD_HELP}`}>
              The plan reads only this part of memory — decisions, constraints, and prior context within it.
            </p>
            <ScopePicker selected={scope} onChange={setScope} />
          </div>
          <TextField value={title} onChange={setTitle}>
            <Label>Focus / title (optional)</Label>
            <Input placeholder="e.g. Payments service migration" fullWidth />
          </TextField>
          <TextField value={context} onChange={setContext}>
            <Label>Context (optional)</Label>
            <TextArea
              rows={4}
              placeholder="Anything specific the plan should account for — goals, constraints, deadlines…"
              fullWidth
            />
          </TextField>
          <AttachmentPicker attachments={attachments} onChange={setAttachments} />
          {!scope && <p className={FIELD_HELP}>Select a scope above to enable planning.</p>}
        </>
      )}

      {agent.role === "qa" && (
        <>
          <TextField value={baseUrl} onChange={setBaseUrl}>
            <Label>Target URL</Label>
            <Input placeholder="https://api.your-product.com" fullWidth />
          </TextField>
          {baseUrl.trim() && !urlValid && <p className="text-sm text-danger">Enter a valid http(s) URL.</p>}
          <div>
            <label className={FIELD_LABEL}>Mode</label>
            <Tabs
              items={[
                { key: "api", label: "API" },
                { key: "browser", label: "Browser" },
              ]}
              value={mode}
              onChange={(k) => setMode(k as "api" | "browser")}
            />
            <p className={`mt-1.5 ${FIELD_HELP}`}>
              {mode === "api"
                ? "Exercises HTTP endpoints — probes for bugs and measures response latency."
                : "Drives a real browser (Playwright) to test the web UI like a user."}
            </p>
          </div>
          <TextField value={focus} onChange={setFocus}>
            <Label>Focus (optional)</Label>
            <TextArea
              rows={3}
              placeholder="e.g. Hammer the /search endpoint with edge cases; check the checkout flow…"
              fullWidth
            />
          </TextField>
          <TextField value={authHeader} onChange={setAuthHeader}>
            <Label>Authorization header (optional)</Label>
            <Input placeholder="Bearer …  — sent with every request" fullWidth />
          </TextField>
          <div>
            <label className={FIELD_LABEL}>Scope for specs / focus (optional)</label>
            <p className={`mb-2 ${FIELD_HELP}`}>
              Optional — if set, the agent reads only this part of memory for stored specs or acceptance criteria to
              test against. Leave empty for a pure black-box run against the URL.
            </p>
            <ScopePicker selected={scope} onChange={setScope} />
          </div>
          <AttachmentPicker attachments={attachments} onChange={setAttachments} />
          {!urlValid && !generating && <p className={FIELD_HELP}>Enter a target URL to enable testing.</p>}
        </>
      )}

      {generating && (
        <div className={`flex items-center gap-3 px-4 py-3 text-sm text-fg-muted ${SUB_PANEL}`}>
          <svg
            className="h-4 w-4 shrink-0 animate-spin text-accent motion-reduce:animate-none"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          {spinnerMessage}
        </div>
      )}

      {error && <p className="text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        {agent.role === "handoff" && (
          <>
            <button
              onClick={() => {
                setLastBackend(fanOut ? "manager" : "single");
                runQuick(
                  "handoff",
                  {
                    scopePath: scope,
                    granteeName: granteeName.trim(),
                    granteeRole: granteeRole.trim() || undefined,
                    context: context.trim() || undefined,
                    fanOut: fanOut || undefined,
                  },
                  "Failed to generate briefing",
                );
              }}
              disabled={generating || !scope || !granteeName.trim()}
              className={BUTTON_PRIMARY}
            >
              {generating ? "Generating…" : "Generate briefing"}
            </button>
            {/* UC6 pilot: manual backend selection for comparison — pick which
                path generates this briefing, rather than it being automatic. */}
            <div
              className="inline-flex gap-1 self-center rounded-full border border-divider bg-fg/[0.03] p-1"
              title="Single agent reads memory directly; Manager fans out into ≤5 parallel domain sub-agents (faster on large scopes) then folds the result — same briefing shape either way."
            >
              <button
                type="button"
                onClick={() => setFanOut(false)}
                aria-pressed={!fanOut}
                className={`min-h-10 whitespace-nowrap rounded-full px-3 text-sm font-semibold transition-colors ${FOCUS} ${!fanOut ? "bg-accent/15 text-fg" : "text-fg-subtle hover:text-fg"}`}
              >
                Single agent
              </button>
              <button
                type="button"
                onClick={() => setFanOut(true)}
                aria-pressed={fanOut}
                className={`min-h-10 whitespace-nowrap rounded-full px-3 text-sm font-semibold transition-colors ${FOCUS} ${fanOut ? "bg-accent/15 text-fg" : "text-fg-subtle hover:text-fg"}`}
              >
                Manager (fan-out)
              </button>
            </div>
          </>
        )}

        {agent.role === "architecture" && (
          <>
            <button
              onClick={() =>
                runQuick(
                  "architecture",
                  { scopePath: scope, title: title.trim() || undefined, context: context.trim() || undefined },
                  "Failed to generate plan",
                )
              }
              disabled={generating || openingWs || !scope}
              className={BUTTON_PRIMARY}
            >
              {generating ? "Planning…" : "Generate plan"}
            </button>
            <label
              className="flex min-h-10 cursor-pointer select-none items-center gap-2 self-center text-sm text-fg-muted"
              title="Fan out into ≤5 parallel sub-agents (depth-1) — faster on large scopes"
            >
              <input
                type="checkbox"
                checked={fanOut}
                onChange={(e) => setFanOut(e.target.checked)}
                className={`h-4 w-4 accent-action ${FOCUS}`}
              />
              Fan out
            </label>
            <button
              onClick={() =>
                openWorkspace({
                  scopePath: scope,
                  prompt: title.trim() || context.trim() || "Plan the architecture for this scope.",
                  context: context.trim() || undefined,
                  attachments: attachments.length ? attachments : undefined,
                })
              }
              disabled={generating || openingWs || !scope}
              className={BUTTON_SECONDARY}
            >
              {openingWs ? "Opening…" : "Open workspace ↗"}
            </button>
          </>
        )}

        {agent.role === "qa" && (
          <>
            <button
              onClick={() =>
                runQuick(
                  "qa",
                  {
                    scopePath: scope ?? undefined,
                    mode,
                    focus: focus.trim() || undefined,
                    target: { baseUrl: baseUrl.trim(), authHeader: authHeader.trim() || undefined },
                  },
                  "QA run failed",
                )
              }
              disabled={generating || openingWs || !urlValid}
              className={BUTTON_PRIMARY}
            >
              {generating ? "Testing…" : "Quick run"}
            </button>
            <label
              className="flex min-h-10 cursor-pointer select-none items-center gap-2 self-center text-sm text-fg-muted"
              title="Fan out into ≤5 parallel sub-agents (depth-1) — faster on large targets"
            >
              <input
                type="checkbox"
                checked={fanOut}
                onChange={(e) => setFanOut(e.target.checked)}
                className={`h-4 w-4 accent-action ${FOCUS}`}
              />
              Fan out
            </label>
            <button
              onClick={() =>
                openWorkspace({
                  scopePath: scope ?? undefined,
                  mode,
                  focus: focus.trim() || undefined,
                  target: { baseUrl: baseUrl.trim(), authHeader: authHeader.trim() || undefined },
                  attachments: attachments.length ? attachments : undefined,
                })
              }
              disabled={generating || openingWs || !urlValid}
              className={BUTTON_SECONDARY}
            >
              {openingWs ? "Opening…" : "Open workspace ↗"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentCard — one primary button per card. It expands an inline panel that
// combines the agent's run-setup (output agents) with a collapsible
// configuration sub-section (all agents). Agents without a run-setup show a
// short note on how they run instead.
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  selected,
  onSelect,
  onSaved,
  defaultScope,
}: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  onSaved: (agent: Agent) => void;
  defaultScope: string | null;
}) {
  const lastRun = agent.runs?.[0] ?? null;
  const runnable = agent.role === "handoff" || agent.role === "architecture" || agent.role === "qa";
  const configurable = mayConfigure(agent);
  const [expanded, setExpanded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(true);

  return (
    <div className={`rounded-2xl ${selected ? "outline-2 outline-accent" : ""}`}>
      {/* A click anywhere on the card selects it; the name below is the button that
          does the same from the keyboard and tells assistive tech which card is chosen. */}
      <div onClick={onSelect} className="w-full cursor-pointer text-left">
        <Card className="p-5 sm:p-6">
          {/* Top row: role + active + the single primary button */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className={EYEBROW}>{AGENT_VERBS[agent.role]?.verb ?? roleLabel(agent.role)}</span>
              {agent.active ? (
                <span className="flex items-center gap-1.5 text-sm text-fg-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
                  active
                </span>
              ) : (
                <span className="text-sm text-fg-subtle">idle</span>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className={BUTTON_SECONDARY}
            >
              {runnable ? "Set up & run" : configurable ? "Configure" : "Details"}
            </button>
          </div>

          {/* Agent name + model + tools */}
          <h2 className="mt-4 break-words text-lg font-semibold leading-snug text-fg [overflow-wrap:anywhere]">
            <button
              type="button"
              aria-pressed={selected}
              aria-label={`Show run history for ${displayWriterLabel(agent.name)}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
              }}
              className={`rounded-sm text-left ${FOCUS}`}
            >
              {displayWriterLabel(agent.name)}
            </button>
          </h2>
          {AGENT_VERBS[agent.role] && (
            <p className="mt-1 text-sm leading-snug text-fg-muted">{AGENT_VERBS[agent.role]?.does}</p>
          )}
          {agent.model && (
            <p className="mt-1 truncate font-mono text-xs text-fg-subtle">
              {MODEL_OPTIONS.find((m) => m.value === agent.model)?.label ?? agent.model}
            </p>
          )}
          {agent.tools.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {agent.tools.map((t) => (
                <span key={t} className="rounded-full border border-divider px-2.5 py-0.5 text-sm text-fg-muted">
                  {TOOL_META[t]?.label ?? t}
                </span>
              ))}
            </div>
          )}

          {/* Footer: run count + last run */}
          <div className="mt-5 flex items-end justify-between gap-4 border-t border-divider pt-4">
            <div className="min-w-0">
              {lastRun ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Pill dot={runStatusDot(lastRun.status)} className="text-xs">
                    {lastRun.status}
                  </Pill>
                  <span className="whitespace-nowrap text-sm text-fg-muted">
                    {duration(lastRun.startedAt, lastRun.finishedAt)}
                  </span>
                  <span className="whitespace-nowrap text-sm text-fg-subtle">{timeAgo(lastRun.startedAt)}</span>
                </div>
              ) : (
                <p className="text-sm text-fg-subtle">No runs yet.</p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums text-fg">
                {agent._count.runs.toLocaleString()}
              </p>
              <p className="mt-1 whitespace-nowrap text-sm text-fg-subtle">runs total</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Big modal (not inline) for run-setup + collapsible config. */}
      {expanded && (
        <Modal title={displayWriterLabel(agent.name)} size="wide" onClose={() => setExpanded(false)}>
          <div className="space-y-5">
            {/* Configuration — first, collapsible, only for a caller who may change it. */}
            {configurable && (
              <div>
                <button
                  onClick={() => setConfigOpen((v) => !v)}
                  aria-expanded={configOpen}
                  className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left ${FOCUS}`}
                >
                  <span className={BLOCK_TITLE}>Configuration</span>
                  <span className="whitespace-nowrap text-sm text-fg-muted">{configOpen ? "Hide ▲" : "Edit ▼"}</span>
                </button>
                {configOpen && (
                  <div className="mt-4">
                    <AgentConfigForm agent={agent} defaultScope={defaultScope} onSaved={onSaved} />
                  </div>
                )}
              </div>
            )}

            {/* Task — second, collapsible (open by default; it's the action). */}
            <div className={configurable ? "border-t border-divider pt-5" : undefined}>
              <button
                onClick={() => setTaskOpen((v) => !v)}
                aria-expanded={taskOpen}
                className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left ${FOCUS}`}
              >
                <span className={BLOCK_TITLE}>{runnable ? "Task & run" : "How it runs"}</span>
                <span className="whitespace-nowrap text-sm text-fg-muted">{taskOpen ? "Hide ▲" : "Show ▼"}</span>
              </button>
              {taskOpen && (
                <div className="mt-4">
                  {runnable ? (
                    <AgentRunSetup agent={agent} />
                  ) : (
                    <div className={`px-4 py-3 ${SUB_PANEL}`}>
                      <p className="text-sm leading-relaxed text-fg-muted">
                        {isRetiredRole(agent.role)
                          ? "This role can no longer run. The agent stays listed so its past runs remain visible."
                          : configurable
                            ? "Set its tools and memory scope under Configuration above, then use the test run there to try it on a single contact."
                            : "An org owner or admin sets its tools and memory scope."}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunRow
// ---------------------------------------------------------------------------

function RunRow({
  run,
  agentId,
  agentName,
}: {
  run: AgentRun & { agentName?: string };
  agentId: string;
  agentName?: string;
}) {
  const meta = run.meta as Record<string, string>;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-divider last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 px-4 py-4 text-left transition-colors hover:bg-fg/[0.03] focus-visible:-outline-offset-2! sm:flex sm:gap-4 sm:px-6"
      >
        <Pill dot={runStatusDot(run.status)} className="shrink-0 justify-self-start text-xs">
          {run.status}
        </Pill>
        {/* On a phone the name takes its own line under the status, so it is not cut to a few letters. */}
        <div className="col-span-3 row-start-2 min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">
            {agentName ? displayWriterLabel(agentName) : "Agent"}
          </p>
          {meta?.type === "test-run" && meta?.contactName ? (
            <p className="mt-0.5 truncate text-sm text-fg-subtle">test run · {meta.contactName}</p>
          ) : meta?.campaignId ? (
            <p className="mt-0.5 truncate text-sm text-fg-subtle">
              {(meta.campaignName as string) ?? `campaign ${(meta.campaignId as string).slice(-6)}`}
              {" · "}
              {(meta.prospectContactName as string) ??
                (meta.prospectId ? `prospect ${(meta.prospectId as string).slice(-6)}` : "—")}
            </p>
          ) : null}
        </div>
        <div className="col-start-2 row-start-1 shrink-0 text-right">
          <p className="whitespace-nowrap text-sm text-fg-muted">{duration(run.startedAt, run.finishedAt)}</p>
          <p className="mt-0.5 whitespace-nowrap text-sm text-fg-subtle">{timeAgo(run.startedAt)}</p>
        </div>
        <span
          aria-hidden="true"
          className={`col-start-3 row-start-1 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {expanded && <RunMemoryTrail agentId={agentId} runId={run.id} status={run.status} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunHistory panel
// ---------------------------------------------------------------------------

const RUN_STATUS_LABEL: Record<RunStatus, string> = { running: "Running", completed: "Completed", failed: "Failed" };

/**
 * How the run history searches, filters and orders. The server does the work
 * (GET /api/agents/:id/runs), because the list is paged and only the server can
 * leave out runs the caller cannot read before it counts; these entries mirror
 * what that route matches so the toolbar and the URL describe the same view.
 */
const RUN_LIST: ListConfig<AgentRun> = {
  noun: { one: "run", many: "runs" },
  searchText: (run) =>
    [run.meta.campaignName, run.meta.contactName, run.meta.prospectContactName].map((v) =>
      typeof v === "string" ? v : null,
    ),
  sorts: [
    {
      key: "started",
      label: "Started",
      compare: (a, b) => compareTime(a.startedAt, b.startedAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
  ],
  filters: [
    {
      key: "status",
      label: "Status",
      options: (Object.keys(RUN_STATUS_LABEL) as RunStatus[]).map((status) => ({
        value: status,
        label: RUN_STATUS_LABEL[status],
      })),
      matches: (run, status) => run.status === status,
    },
  ],
  paramPrefix: "runs.",
};

/**
 * The run list request for a view, or null for the default view until someone asks
 * for the full history (`expanded`): the agent payload already carries its last run.
 */
function runListUrl(agentId: string, view: ListState, expanded: boolean): string | null {
  if (!expanded && !isNarrowed(view) && view.direction === "desc") return null;
  const params = new URLSearchParams({ limit: String(RUN_PAGE_SIZE), order: view.direction });
  if (view.filters.status) params.set("status", view.filters.status);
  if (view.query.trim() !== "") params.set("q", view.query.trim());
  return `/api/agents/${agentId}/runs?${params}`;
}

/** The runs loaded for one request: its first page plus every "load more" after it. */
type RunPage =
  | { url: string; runs: AgentRun[]; total: number; nextCursor: string | null }
  | { url: string; failed: true };

function RunHistory({ agent }: { agent: Agent }) {
  const [expanded, setExpanded] = useState(false);
  const listView = useListState(RUN_LIST);
  const requestUrl = runListUrl(agent.id, listView.committed, expanded);
  // The runs on screen and the request they answer; a mismatch means the newer request is still out.
  const [page, setPage] = useState<RunPage | null>(null);
  // A "load more" in flight or failed, for the cursor it was asked from; any other cursor is idle.
  const [more, setMore] = useState<{ cursor: string; status: "loading" | "failed" } | null>(null);

  useEffect(() => {
    if (requestUrl === null) return;
    const controller = new AbortController();
    fetch(requestUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET ${requestUrl} failed: ${res.status}`);
        const data = await res.json();
        setPage({
          url: requestUrl,
          runs: data.runs ?? [],
          total: data.total ?? 0,
          nextCursor: data.nextCursor ?? null,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPage({ url: requestUrl, failed: true });
      });
    return () => controller.abort();
  }, [requestUrl]);

  const current = requestUrl !== null && page?.url === requestUrl ? page : null;

  /** The next runs after the last one shown, by time, appended; dropped if the view changed meanwhile. */
  async function loadMore() {
    if (!current || "failed" in current || !current.nextCursor) return;
    const { url, nextCursor } = current;
    setMore({ cursor: nextCursor, status: "loading" });
    try {
      const res = await fetch(`${url}&cursor=${encodeURIComponent(nextCursor)}`);
      if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
      const data = await res.json();
      setPage((shown) =>
        shown && shown.url === url && "runs" in shown && shown.nextCursor === nextCursor
          ? {
              ...shown,
              runs: [...shown.runs, ...(data.runs ?? [])],
              total: data.total ?? shown.total,
              nextCursor: data.nextCursor ?? null,
            }
          : shown,
      );
    } catch {
      setMore({ cursor: nextCursor, status: "failed" });
    }
  }

  const moreStatus = current && "runs" in current && more?.cursor === current.nextCursor ? more.status : "idle";
  const filtered = requestUrl !== null;
  const shownRuns = filtered ? (current && "runs" in current ? current.runs : []) : agent.runs;

  return (
    <Card className="mt-4 sm:mt-6">
      <div className="flex flex-col gap-3 border-b border-divider px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={BLOCK_TITLE}>Run history</span>
            <span className="min-w-0 break-words text-sm text-fg-subtle">{displayWriterLabel(agent.name)}</span>
          </div>
          {!filtered && agent._count.runs > agent.runs.length && (
            <button onClick={() => setExpanded(true)} className={`-mr-2 ${BUTTON_QUIET}`}>
              {`Load the newest ${Math.min(agent._count.runs, RUN_PAGE_SIZE).toLocaleString()} of ${agent._count.runs.toLocaleString()} runs`}
            </button>
          )}
        </div>
        {showsListControls(agent._count.runs, listView.state) && (
          <ListControls
            config={RUN_LIST}
            controls={listView}
            total={agent._count.runs}
            shown={current && "runs" in current ? current.total : null}
          />
        )}
      </div>

      {filtered && !current ? (
        <p role="status" className="px-6 py-10 text-center text-sm text-fg-muted">
          Loading runs…
        </p>
      ) : current && "failed" in current ? (
        <p role="alert" className="px-6 py-10 text-center text-sm text-danger">
          Could not load these runs. Change the filters or reload to try again.
        </p>
      ) : shownRuns.length === 0 ? (
        isNarrowed(listView.committed) ? (
          <div className="p-4 sm:p-6">
            <ListNoMatch config={RUN_LIST} controls={listView} />
          </div>
        ) : (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-fg-muted">No runs recorded yet.</p>
          </div>
        )
      ) : (
        <div>
          {shownRuns.map((run) => (
            <RunRow key={run.id} run={run} agentId={agent.id} agentName={agent.name} />
          ))}
          {current && "runs" in current && current.total > current.runs.length && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-divider px-4 py-3 sm:px-6">
              <p className="text-sm text-fg-subtle">
                Showing the {direction(listView.committed)} {current.runs.length.toLocaleString()} of{" "}
                {current.total.toLocaleString()} matching runs.
              </p>
              {current.nextCursor && (
                <button onClick={loadMore} disabled={moreStatus === "loading"} className={`-mr-2 ${BUTTON_QUIET}`}>
                  {moreStatus === "loading"
                    ? "Loading…"
                    : moreStatus === "failed"
                      ? "Could not load more runs. Try again"
                      : loadMoreLabel(Math.min(RUN_PAGE_SIZE, current.total - current.runs.length), listView.committed)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** "Load 50 older runs", "Load 1 newer run": the next page's button, by the history's order. */
function loadMoreLabel(count: number, view: ListState): string {
  const age = view.direction === "desc" ? "older" : "newer";
  return `Load ${count.toLocaleString()} ${age} ${count === 1 ? "run" : "runs"}`;
}

/** "newest" or "oldest": which end of the history a capped page shows. */
function direction(view: ListState): string {
  return view.direction === "desc" ? "newest" : "oldest";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** The URL parameter naming the agent whose details and run history are open. */
const AGENT_PARAM = "agent";

/** Writes the open agent into the URL without a navigation, so a link reopens it. */
function replaceAgentInUrl(agentId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (agentId) params.set(AGENT_PARAM, agentId);
  else params.delete(AGENT_PARAM);
  const query = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}

/**
 * The agents dashboard: the numbers, the built-in agents as actions on memory, every
 * agent in a paged roster, the open agent's details and runs, and recent runs across
 * all of them.
 */
export default function AgentsPage() {
  const searchParams = useSearchParams();
  const [builtins, setBuiltins] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams?.get(AGENT_PARAM) ?? null);
  // The open agent when it is not one of the built-ins already on the page.
  const [opened, setOpened] = useState<Agent | null>(null);
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    fetch("/api/agents?kind=builtin")
      .then((r) => r.json())
      .then((data) => {
        const agents: Agent[] = data.agents ?? [];
        setBuiltins(agents);
        setSelectedId((current) => current ?? agents[0]?.id ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  const builtinSelected = builtins.find((a) => a.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId || loading || builtinSelected) return;
    const controller = new AbortController();
    fetch(`/api/agents/${selectedId}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setOpened(data?.agent ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [selectedId, loading, builtinSelected]);

  function select(agentId: string) {
    setSelectedId(agentId);
    replaceAgentInUrl(agentId);
  }

  function handleSaved(saved: Agent) {
    setBuiltins((prev) => prev.map((a) => (a.id === saved.id ? { ...a, ...saved } : a)));
    setOpened((prev) => (prev && prev.id === saved.id ? { ...prev, ...saved } : prev));
    setModalOpen(false);
    if (saved.role === "custom") select(saved.id);
  }

  const selectedAgent = builtinSelected ?? (opened?.id === selectedId ? opened : null);
  // Creating an agent needs the same authority as configuring one. An empty roster
  // says nothing either way, so the button stays and the server decides.
  const rosterReadOnly = builtins.length > 0 && !builtins.some(mayConfigure);
  const card = (a: Agent) => (
    <AgentCard
      key={a.id}
      agent={a}
      selected={a.id === selectedId}
      onSelect={() => select(a.id)}
      onSaved={handleSaved}
      defaultScope={selectedScope}
    />
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-8 sm:py-12">
      <PageHeader
        eyebrow="Agents"
        title="Agents dashboard"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <ScopePicker selected={selectedScope} onChange={setSelectedScope} />
            {!rosterReadOnly && (
              <button onClick={() => setModalOpen(true)} className={BUTTON_PRIMARY}>
                + New agent
              </button>
            )}
          </div>
        }
      >
        What every agent did, what it was allowed and denied, and what it wrote. Each one reads only what its scope
        allows.
      </PageHeader>

      <section aria-label="Agent numbers" className="mt-6 sm:mt-8">
        <AgentKpis />
      </section>

      <section aria-labelledby="ask-memory" className="mt-8 sm:mt-10">
        <h2 id="ask-memory" className={EYEBROW_ON_PAGE}>
          Ask memory
        </h2>
        {loading ? (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 rounded-2xl border border-divider bg-fg/[0.03] motion-safe:animate-pulse" />
            ))}
          </div>
        ) : builtins.length === 0 ? (
          <Card className="mt-3 flex flex-col items-center px-6 py-12 text-center sm:px-8">
            <Bot size={26} aria-hidden="true" className="mb-4 text-accent" />
            <p className="text-base font-semibold text-fg">
              Agents are provisioned automatically when you create an organization.
            </p>
            <p className="mt-2 text-sm text-fg-muted">Create or switch to an organization to continue.</p>
          </Card>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{builtins.map(card)}</div>
        )}
      </section>

      <section aria-label="All agents" className="mt-8 sm:mt-10">
        <AgentRoster selectedId={selectedId} onOpen={select} />
      </section>

      {selectedAgent && (
        <section aria-label="Open agent" className="mt-4 sm:mt-6">
          {!builtinSelected && <div className="max-w-xl">{card(selectedAgent)}</div>}
          <RunHistory key={selectedAgent.id} agent={selectedAgent} />
        </section>
      )}

      <section aria-label="Recent runs" className="mt-8 sm:mt-10">
        <ActivityFeed />
      </section>

      {modalOpen && (
        <AgentModal
          agent={null}
          defaultScope={selectedScope}
          onClose={() => setModalOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
