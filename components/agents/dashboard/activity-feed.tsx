"use client";

// Recent runs across every agent, newest first (GET /api/agents/activity), filtered
// by outcome. It pages by "Show older runs", since
// it is ordered by time. A run opens in place to show how it went: its outcome and
// error in plain words, every memory read and write with its decision, in order, and
// a link to the run's own page when it has one.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Card, Pill, Tabs } from "@/components/ui";
import { BUTTON_QUIET } from "@/components/agents/agent-ui";
import { RunMemoryTrail } from "@/components/agents/run-memory-trail";
import { displayWriterLabel } from "@/components/audit/format";
import { AGENT_VERBS, duration, timeAgo } from "./format";

export type ActivityRun = {
  id: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  status: "running" | "completed" | "failed";
  stalled: boolean;
  phase: string | null;
  meta: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

const FILTERS = [
  { key: "", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "running", label: "Running" },
  { key: "completed", label: "Completed" },
];

/** A run's outcome in words, including the two kinds of "running" that are not working. */
export function outcomeOf(run: Pick<ActivityRun, "status" | "stalled" | "phase">): {
  label: string;
  dot: "success" | "accent" | "danger" | "ember";
} {
  if (run.status === "completed") return { label: "Completed", dot: "success" };
  if (run.status === "failed") return { label: "Failed", dot: "danger" };
  if (run.stalled) return { label: "Stalled", dot: "danger" };
  if (run.phase === "paused") return { label: "Waiting on a person", dot: "ember" };
  return { label: "Running", dot: "accent" };
}

/** What the run was about, from the names its starter gave it, or null. */
function runSubject(meta: Record<string, unknown> | null): string | null {
  for (const key of ["campaignName", "contactName", "prospectContactName"]) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

type Page = { runs: ActivityRun[]; next: string | null };

/** The runs shown for one view (its first request's URL), or that view's failure. */
type Shown = { url: string; runs: ActivityRun[]; next: string | null } | { url: string; failed: true };

export function ActivityFeed() {
  const [status, setStatus] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [more, setMore] = useState(false);
  const base = feedUrl(status);

  useEffect(() => {
    const controller = new AbortController();
    fetch(base, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET ${base} failed: ${res.status}`);
        const page: Page = await res.json();
        if (!Array.isArray(page?.runs)) throw new Error(`GET ${base} returned no runs`);
        setShown({ url: base, runs: page.runs, next: page.next });
      })
      .catch(() => {
        if (!controller.signal.aborted) setShown({ url: base, failed: true });
      });
    return () => controller.abort();
  }, [base]);

  // Runs answering an earlier filter are never shown under the current one.
  const current = shown?.url === base ? shown : null;
  const state = !current ? "loading" : "failed" in current ? "failed" : "ready";
  const runs = current && "runs" in current ? current.runs : [];
  const next = current && "runs" in current ? current.next : null;

  async function loadOlder() {
    if (!next || more) return;
    setMore(true);
    const view = base;
    try {
      const res = await fetch(`${view}&before=${encodeURIComponent(next)}`);
      if (!res.ok) throw new Error(`GET older runs failed: ${res.status}`);
      const page: Page = await res.json();
      if (!Array.isArray(page?.runs)) throw new Error("GET older runs returned no runs");
      // Appended only to the view it continues: a filter changed meanwhile drops it.
      setShown((prev) =>
        prev?.url === view && "runs" in prev
          ? { url: view, runs: [...prev.runs, ...page.runs], next: page.next }
          : prev,
      );
    } catch {
      setShown((prev) => (prev?.url === view ? { url: view, failed: true } : prev));
    } finally {
      setMore(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-divider px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">Activity</h2>
          <p className="truncate text-sm text-fg-subtle">Runs of every agent you can see, newest first</p>
        </div>
        <Tabs items={FILTERS} value={status} onChange={setStatus} />
      </div>
      {state === "loading" ? (
        <p role="status" className="px-6 py-10 text-center text-sm text-fg-muted">
          Loading runs…
        </p>
      ) : state === "failed" ? (
        <p role="alert" className="px-6 py-10 text-center text-sm text-danger">
          Could not load the runs. Reload to try again.
        </p>
      ) : runs.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-fg-muted">
          {status ? "No runs you can see match this filter." : "No runs you can see yet."}
        </p>
      ) : (
        <ul>
          {runs.map((run) => (
            <FeedItem key={run.id} run={run} />
          ))}
        </ul>
      )}
      {state === "ready" && next && (
        <div className="border-t border-divider px-4 py-3 sm:px-6">
          <button type="button" onClick={loadOlder} disabled={more} className={`-ml-2 ${BUTTON_QUIET}`}>
            {more ? "Loading…" : "Show older runs"}
          </button>
        </div>
      )}
    </Card>
  );
}

function feedUrl(status: string): string {
  const params = new URLSearchParams({ limit: "20" });
  if (status) params.set("status", status);
  return `/api/agents/activity?${params}`;
}

function FeedItem({ run }: { run: ActivityRun }) {
  const [open, setOpen] = useState(false);
  const outcome = outcomeOf(run);
  const subject = runSubject(run.meta);
  const verb = AGENT_VERBS[run.agentRole]?.verb;
  return (
    <li className="border-b border-divider last:border-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 text-left transition-colors hover:bg-fg/[0.03] focus-visible:-outline-offset-2! sm:px-6"
      >
        <Pill dot={outcome.dot} className="shrink-0">
          {outcome.label}
        </Pill>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-fg">
            {verb ? `${verb} · ` : ""}
            {displayWriterLabel(run.agentName)}
          </span>
          {subject && <span className="block truncate text-sm text-fg-subtle">{subject}</span>}
        </span>
        <span className="flex items-center gap-2 text-right">
          <span>
            <span className="block whitespace-nowrap text-sm text-fg-muted">{timeAgo(run.startedAt)}</span>
            <span className="block whitespace-nowrap text-sm text-fg-subtle">
              {duration(run.startedAt, run.finishedAt)}
            </span>
          </span>
          <ChevronDown
            size={16}
            aria-hidden
            className={`text-fg-subtle transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open && <RunDrillDown run={run} />}
    </li>
  );
}

/** How one run went: outcome and error in words, then its memory trail. */
export function RunDrillDown({ run }: { run: ActivityRun }) {
  const outcome = outcomeOf(run);
  return (
    <div className="border-t border-divider">
      <div className="flex flex-col gap-1 px-4 py-3 text-sm sm:px-6">
        <p className="text-fg">
          {outcome.label === "Stalled"
            ? "Nothing has driven this run for too long, so it will be marked failed."
            : outcome.label === "Waiting on a person"
              ? "This run asked a question and waits for an answer on its page."
              : `${outcome.label} ${timeAgo(run.startedAt)}, took ${duration(run.startedAt, run.finishedAt)}.`}
        </p>
        {run.error && (
          <p role="note" className="text-danger">
            It stopped with this error: {run.error}
          </p>
        )}
        {run.phase !== null && (
          <Link
            href={`/agents/${run.agentId}/run/${run.id}`}
            className="w-fit text-sm font-semibold text-accent underline-offset-4 hover:underline"
          >
            Open the run&apos;s steps and output
          </Link>
        )}
      </div>
      <RunMemoryTrail agentId={run.agentId} runId={run.id} status={run.status} />
    </div>
  );
}
