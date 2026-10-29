"use client";

// A run's memory trail: what one agent run read from and wrote to memory, shown under
// the run on the Agents page. It reads GET /api/agents/:id/runs/:runId/audit and
// reuses the audit page's target/action parsing (components/audit/format.ts), so a
// row reads the same way it does in the org-wide audit log.
//
// The one rule this file enforces: a refused viewer is asked once, not on every
// poll. Each request to the route is an access decision with its own audit row, so a
// 403 ends polling; reopening the run asks again.
//
// The trail comes a page at a time, oldest first, and a trail longer than a page
// waits for "Load more" rather than polling its way through every row. A live run's
// poll reads its last page again from that page's start and replaces it, rather than
// only rows after the last one shown: a row written in parallel can commit after a
// later-timestamped row was already read, and a strict tail would never show it.
import { useEffect, useRef, useState } from "react";
import { Pill } from "@/components/ui";
import { BUTTON_QUIET, EYEBROW } from "@/components/agents/agent-ui";
import { fmt, parseAction, parseTarget } from "@/components/audit/format";
import { createLatestResponseGuard } from "@/lib/agents/latest-response-guard";
import { createPollScheduler } from "@/lib/agents/poll-scheduler";

type RunStatus = "running" | "completed" | "failed";

type RunAuditEntry = {
  id: string;
  action: string;
  target: string;
  decision: "allow" | "deny";
  reason: string | null;
  at: string;
};

/** What this run read and wrote, polled while the run is still running. */
export function RunMemoryTrail({ agentId, runId, status }: { agentId: string; runId: string; status: RunStatus }) {
  const [entries, setEntries] = useState<RunAuditEntry[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [possibleOverlap, setPossibleOverlap] = useState(false);
  const [entriesSuppressed, setEntriesSuppressed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by "Load more": reruns the effect below, which reads from `pageStart`.
  const [resume, setResume] = useState(0);
  // The last page: where it starts (null for the first) and how many rows come before it.
  const pageStart = useRef<string | null>(null);
  const before = useRef(0);
  // Where the page after a full one starts, for "Load more".
  const nextStart = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Two independent guards against the same class of failure. The
    // response-identity guard (below) stops a stale response from
    // overwriting fresher state once one arrives out of order; the
    // scheduler (createPollScheduler) stops that from happening in the
    // first place by never letting a second request start while an earlier
    // one is still pending — a fixed setInterval(load, 4000) fires again
    // regardless, and if a single response ever takes longer than the
    // interval, every later tick's own response gets invalidated by the
    // identity guard the same way before it can apply, so the panel can be
    // stuck loading forever with none of its responses ever landing.
    const guard = createLatestResponseGuard();

    const load = () => {
      const token = guard.start();
      const applies = () => !cancelled && guard.isCurrent(token);
      let refused = false;
      const from = pageStart.current;
      const kept = before.current;
      const url = `/api/agents/${agentId}/runs/${runId}/audit`;

      return fetch(from ? `${url}?cursor=${encodeURIComponent(from)}` : url)
        .then((res) => {
          if (res.status === 403) {
            refused = true;
            if (applies()) setForbidden(true);
            return null;
          }
          if (!res.ok) {
            if (applies()) setError(true);
            return null;
          }
          return res.json();
        })
        .then((data) => {
          // A refusal ends polling: asking again every few seconds would write a
          // deny row each time. Reopening the run asks again.
          if (refused) return false;
          if (!applies() || !data) return true;
          // A poll can succeed after an earlier error, so clear the stale state.
          setForbidden(false);
          setError(false);
          const page: RunAuditEntry[] = data.entries ?? [];
          // A withheld trail starts over, so nothing shown before stays on screen.
          if (data.entriesSuppressed) {
            pageStart.current = null;
            before.current = 0;
          }
          nextStart.current = data.hasMore ? data.endCursor : null;
          setEntries((shown) => (data.entriesSuppressed ? page : [...(shown ?? []).slice(0, kept), ...page]));
          setHasMore(!!data.hasMore);
          setPossibleOverlap(!!data.possibleOverlap);
          setEntriesSuppressed(!!data.entriesSuppressed);
          // More rows waiting: stop until someone asks for them.
          if (data.hasMore) return false;
          // `status` is a one-time snapshot from the run list (RunHistory
          // never repolls it), so a run that has since actually finished
          // would otherwise poll forever. Trust the backend's own
          // `finishedAt` instead — once the run it just reported on has
          // finished, stop polling.
          return !data.finishedAt;
        })
        .catch(() => {
          if (applies()) setError(true);
          return true;
        })
        .finally(() => {
          if (applies()) {
            setLoading(false);
            setLoadingMore(false);
          }
        });
    };

    // A run still in progress can pick up new memory activity after this
    // component first rendered — keep the trail live instead of freezing it
    // at whatever it was when the row was first expanded.
    const scheduler = status === "running" ? createPollScheduler(load, 4000) : null;
    if (!scheduler) load();
    return () => {
      cancelled = true;
      scheduler?.stop();
    };
  }, [agentId, runId, status, resume]);

  return (
    <div className="border-t border-divider bg-fg/[0.03] px-4 py-4 sm:px-6">
      <p className={`mb-3 ${EYEBROW}`}>Memory reads &amp; writes</p>
      {forbidden ? (
        <p className="text-sm text-fg-muted">Admin access required to view this run&apos;s memory trail.</p>
      ) : loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-3 w-2/3 rounded bg-fg/[0.06] motion-safe:animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-fg-muted">Couldn&apos;t load this run&apos;s memory trail. Try reopening it.</p>
      ) : !entries || entries.length === 0 ? (
        entriesSuppressed ? (
          // The route blanks entries to [] rather than risk showing another
          // agent's rows as this run's own (see route.ts's crossAgentOverlap
          // comment) — that suppression must not read the same as genuine
          // inactivity, or the false confidence just moves from the data
          // into the UI copy instead of actually going away. Keyed off
          // `entriesSuppressed` specifically, not `possibleOverlap` — the
          // latter is also true for a same-agent overlap alone, which never
          // suppresses anything and would otherwise tell a genuinely empty
          // run "may not really be empty".
          <p className="text-sm text-fg-muted">
            Can&apos;t show this trail right now — an overlapping run makes it impossible to tell what belongs to this
            one, so nothing is shown rather than risking someone else&apos;s memory activity. This run may not really be
            empty.
          </p>
        ) : (
          <p className="text-sm text-fg-muted">This run touched no memory yet.</p>
        )
      ) : (
        <div className="flex flex-col gap-3">
          {possibleOverlap && (
            <p className="text-sm text-fg-muted">
              Another run of this same agent overlapped this window — a few entries below could belong to that other run
              instead.
            </p>
          )}
          {entries.map((e) => {
            const { scope, what, recordId } = parseTarget(e.target);
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm lg:flex-nowrap">
                <span className="shrink-0 whitespace-nowrap font-mono text-xs text-fg-subtle lg:w-36">{fmt(e.at)}</span>
                <Pill dot={e.decision === "allow" ? "success" : "danger"} className="shrink-0 text-xs">
                  {e.decision}
                </Pill>
                <span className="shrink-0 text-fg-muted">{parseAction(e.action)}</span>
                <span className="min-w-0 basis-full break-words text-fg-subtle lg:flex-1 lg:basis-auto lg:truncate">
                  {scope} · {what}
                  {recordId && <span className="ml-1 font-mono text-xs">({recordId})</span>}
                </span>
              </div>
            );
          })}
          {hasMore && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-sm text-fg-subtle">
                Showing the first {entries.length.toLocaleString()} {entries.length === 1 ? "entry" : "entries"}.
              </p>
              <button
                onClick={() => {
                  pageStart.current = nextStart.current;
                  before.current = entries.length;
                  setLoadingMore(true);
                  setResume((n) => n + 1);
                }}
                disabled={loadingMore}
                className={`-mr-2 ${BUTTON_QUIET}`}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
          <p className="mt-1 text-sm text-fg-subtle">
            Reads show the query run, not yet which exact facts it returned — that needs a data-layer change (tracked
            separately).
          </p>
        </div>
      )}
    </div>
  );
}
