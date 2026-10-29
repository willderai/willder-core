"use client";

// The agents dashboard's roster: every agent of the org, built-in, custom and, for an
// access manager, connected (an MCP client, Claude Code, a Routine: an agent known by
// its capability tokens). One row each, with its state, its last activity and seven
// days of it. The server searches, filters, sorts and pages (GET /api/agents/roster),
// so the list works the same at four agents and at four thousand; the view and the
// page live in the URL under `roster.`.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, PlugZap } from "lucide-react";
import { Card, Pill } from "@/components/ui";
import { ListControls, ListNoMatch, ListPagination } from "@/components/list-controls/list-controls";
import {
  compareText,
  compareTime,
  isNarrowed,
  type ListConfig,
  type ListState,
} from "@/components/list-controls/list-query";
import { listViewKey } from "@/components/list-controls/list-page";
import { useListState } from "@/components/list-controls/use-list-state";
import { useServerListPage } from "@/components/list-controls/use-list-page";
import { listSearchText } from "@/lib/list-search";
import { BUTTON_QUIET, BUTTON_SECONDARY } from "@/components/agents/agent-ui";
import { displayWriterLabel, scopeLabel } from "@/components/audit/format";
import { ActivitySparkline, type DayActivity } from "./activity-sparkline";
import { AGENT_VERBS, timeAgo } from "./format";

export type RosterStatus = "running" | "failing" | "idle" | "paused" | "revoked";
export type RosterKind = "builtin" | "custom" | "connected";

export type RosterRow = {
  kind: RosterKind;
  id: string;
  key: string;
  name: string;
  role: string | null;
  status: RosterStatus;
  activity: number;
  lastRunStatus: string | null;
  lastRunId: string | null;
  lastActiveAt: string | null;
  lastAllowedAt: string | null;
  lastDeniedAt: string | null;
  scopes: string[];
  permission: string | null;
  liveTokens: number | null;
  series: DayActivity[];
};

type RosterPage = { rows: RosterRow[]; total: number; pageSize: number };

/** Rows per page; the route's ROSTER_PAGE_SIZE. */
const PAGE_SIZE = 12;

const STATUS: Record<RosterStatus, { label: string; dot: "accent" | "danger" | "marble" | "ember" }> = {
  running: { label: "Running", dot: "accent" },
  failing: { label: "Failing", dot: "danger" },
  idle: { label: "Idle", dot: "marble" },
  paused: { label: "Paused", dot: "ember" },
  revoked: { label: "Revoked", dot: "marble" },
};

const KIND_LABEL: Record<RosterKind, string> = { builtin: "Built-in", custom: "Custom", connected: "Connected" };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A refusal in the last seven days: the route's `use=denied`, and the only one shown in red. */
function deniedThisWeek(row: RosterRow): boolean {
  return row.lastDeniedAt !== null && Date.now() - Date.parse(row.lastDeniedAt) < 7 * DAY_MS;
}

/** The route's `use` filter: token use by a connected agent. */
const USE_LABEL = { denied: "Denied this week", unused: "Live token, unused 30 days" } as const;

/**
 * The roster's view. The compare functions are never run: the server orders the
 * rows (GET /api/agents/roster). They are here because the toolbar and the URL read
 * the same config every list uses.
 */
export const ROSTER_LIST: ListConfig<RosterRow> = {
  noun: { one: "agent", many: "agents" },
  searchText: (row) => [row.name, row.key],
  sorts: [
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.name, b.name),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    {
      key: "lastActive",
      label: "Last active",
      compare: (a, b) => compareTime(a.lastActiveAt, b.lastActiveAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "runs",
      label: "Activity, last 7 days",
      compare: (a, b) => a.activity - b.activity,
      defaultDirection: "desc",
      directionLabels: { asc: "Least first", desc: "Most first" },
    },
    {
      key: "lastAllowed",
      label: "Last allowed",
      compare: (a, b) => compareTime(a.lastAllowedAt, b.lastAllowedAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "lastDenied",
      label: "Last denied",
      compare: (a, b) => compareTime(a.lastDeniedAt, b.lastDeniedAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
  ],
  filters: [
    {
      key: "kind",
      label: "Type",
      options: (Object.keys(KIND_LABEL) as RosterKind[]).map((value) => ({ value, label: KIND_LABEL[value] })),
      matches: (row, value) => row.kind === value,
    },
    {
      key: "status",
      label: "Status",
      options: (Object.keys(STATUS) as RosterStatus[]).map((value) => ({ value, label: STATUS[value].label })),
      matches: (row, value) => row.status === value,
    },
    {
      key: "use",
      label: "Token use",
      options: (Object.keys(USE_LABEL) as (keyof typeof USE_LABEL)[]).map((value) => ({
        value,
        label: USE_LABEL[value],
      })),
      matches: (row, value) =>
        value === "denied"
          ? deniedThisWeek(row)
          : row.kind === "connected" &&
            (row.liveTokens ?? 0) > 0 &&
            (row.lastAllowedAt === null || Date.now() - Date.parse(row.lastAllowedAt) >= 30 * DAY_MS),
    },
  ],
  paramPrefix: "roster.",
};

/** The roster request for a view and page. */
export function rosterUrl(view: ListState, page: number): string {
  const params = new URLSearchParams({ sort: view.sort, order: view.direction });
  const search = listSearchText(view.query);
  if (search) params.set("q", search);
  if (view.filters.kind) params.set("kind", view.filters.kind);
  if (view.filters.status) params.set("status", view.filters.status);
  if (view.filters.use) params.set("use", view.filters.use);
  if (page > 1) params.set("page", String(page));
  return `/api/agents/roster?${params}`;
}

type Loaded = { request: { url: string }; page: RosterPage } | { request: { url: string }; failed: true };

export function AgentRoster({ selectedId, onOpen }: { selectedId: string | null; onOpen: (agentId: string) => void }) {
  const view = useListState(ROSTER_LIST);
  const server = useServerListPage<RosterRow>({
    prefix: ROSTER_LIST.paramPrefix ?? "",
    viewKey: listViewKey(ROSTER_LIST, view.committed),
    pageSize: PAGE_SIZE,
  });
  const url = rosterUrl(view.committed, server.page);
  const request = useMemo(() => ({ url }), [url]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The previous page keeps the pager mounted; displayed rows and counts require a fresh answer.
  const [lastPage, setLastPage] = useState<RosterPage | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
        const body: RosterPage = await res.json();
        if (!Array.isArray(body?.rows)) throw new Error(`GET ${url} returned no rows`);
        if (controller.signal.aborted) return;
        setLoaded({ request, page: body });
        setLastPage(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ request, failed: true });
      });
    return () => controller.abort();
  }, [url, request]);

  // A URL revisited after another request needs a new answer, even if its text matches.
  const current = loaded?.request === request ? loaded : null;
  const page = current && "page" in current ? current.page : null;
  const paging = server.paging(page?.rows ?? [], page?.total ?? lastPage?.total ?? 0);
  const narrowed = isNarrowed(view.committed);

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-divider px-4 py-4 sm:px-6">
        <h2 className="text-base font-semibold text-fg">All agents</h2>
        <ListControls config={ROSTER_LIST} controls={view} total={null} shown={narrowed && page ? page.total : null} />
      </div>

      {!current ? (
        <p role="status" className="px-6 py-10 text-center text-sm text-fg-muted">
          Loading agents…
        </p>
      ) : "failed" in current ? (
        <p role="alert" className="px-6 py-10 text-center text-sm text-danger">
          Could not load the agents. Change the filters or reload to try again.
        </p>
      ) : page && page.rows.length === 0 ? (
        narrowed ? (
          <div className="p-4 sm:p-6">
            <ListNoMatch config={ROSTER_LIST} controls={view} />
          </div>
        ) : (
          <p className="px-6 py-10 text-center text-sm text-fg-muted">
            {server.page > 1 ? "This page is past the end of the list." : "No agents yet."}
          </p>
        )
      ) : (
        <ul>
          {page?.rows.map((row) => (
            <RosterItem key={`${row.kind}:${row.id}`} row={row} selected={row.id === selectedId} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {lastPage && (
        <ListPagination
          noun={ROSTER_LIST.noun}
          paging={paging}
          loading={!current}
          unavailable={current !== null && "failed" in current}
          keepVisible
          empty={page?.rows.length === 0}
          className="border-t border-divider px-4 py-3 sm:px-6"
        />
      )}
    </Card>
  );
}

function RosterItem({
  row,
  selected,
  onOpen,
}: {
  row: RosterRow;
  selected: boolean;
  onOpen: (agentId: string) => void;
}) {
  const connected = row.kind === "connected";
  const verb = row.role ? AGENT_VERBS[row.role] : undefined;
  const status = STATUS[row.status];
  const Icon = connected ? PlugZap : Bot;
  const name = connected ? row.name : displayWriterLabel(row.name);
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-divider px-4 py-3 last:border-0 sm:px-6 lg:grid-cols-[minmax(0,2.2fr)_6.5rem_7.5rem_6.5rem_minmax(0,1.4fr)_16rem] ${selected ? "bg-accent/[0.06]" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Icon size={18} strokeWidth={1.8} aria-hidden className="shrink-0 text-fg-subtle" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg" title={row.key}>
            {verb ? `${verb.verb} · ${name}` : name}
          </p>
          <p className="truncate text-sm text-fg-subtle">
            {KIND_LABEL[row.kind]}
            {verb ? ` · ${verb.does}` : ""}
          </p>
        </div>
      </div>
      <div className="justify-self-end lg:justify-self-start">
        <Pill dot={status.dot}>{status.label}</Pill>
      </div>
      {connected ? <TokenUse row={row} /> : <LastRun row={row} />}
      <div className="flex items-center gap-2 justify-self-end lg:justify-self-start">
        <ActivitySparkline
          series={row.series}
          noun={connected ? { one: "call", many: "calls" } : { one: "run", many: "runs" }}
          failedWord={connected ? "denied" : "failed"}
        />
        <span title="Last 7 days" className="w-10 text-right text-sm tabular-nums text-fg-muted">
          {row.activity.toLocaleString()}
        </span>
      </div>
      <p
        className={`col-span-2 min-w-0 truncate text-sm text-fg-subtle lg:col-span-1 ${connected ? "" : "hidden lg:block"}`}
      >
        {connected ? (
          row.scopes.length > 0 ? (
            <span title={row.scopes.join("\n")}>
              {row.permission} on {scopeLabel(row.scopes[0])}
              {row.scopes.length > 1 ? ` and ${row.scopes.length - 1} more` : ""}
            </span>
          ) : (
            "No live token"
          )
        ) : (
          "Scope chosen for each run"
        )}
      </p>
      <div className="col-span-2 flex flex-wrap items-center gap-2 lg:col-span-1 lg:justify-self-end">
        {connected ? (
          <>
            <Link href={`/access?tab=tokens&q=${encodeURIComponent(row.key)}`} className={BUTTON_QUIET}>
              Tokens
            </Link>
            <Link href={`/audit?q=${encodeURIComponent(row.key)}`} className={BUTTON_QUIET}>
              Audit
            </Link>
            <Link href="/audit?view=sessions" className={BUTTON_QUIET}>
              Session starts<span className="sr-only"> for {name}</span>
            </Link>
          </>
        ) : (
          <button type="button" aria-pressed={selected} onClick={() => onOpen(row.id)} className={BUTTON_SECONDARY}>
            Open<span className="sr-only"> {name}</span>
          </button>
        )}
      </div>
    </li>
  );
}

/** An own agent's newest visible run, and whether it failed. */
function LastRun({ row }: { row: RosterRow }) {
  if (!row.lastActiveAt) return <p className="text-sm text-fg-subtle">No runs you can see</p>;
  return (
    <p className="text-sm text-fg-muted">
      <span className="sr-only">Last active </span>
      {timeAgo(row.lastActiveAt)}
      {row.lastRunStatus === "failed" && <span className="text-danger"> · failed</span>}
    </p>
  );
}

/**
 * A connected agent's last allowed and last denied token call, both shown: the
 * newest call alone would hide a refusal behind a later success, or the reverse.
 */
function TokenUse({ row }: { row: RosterRow }) {
  if (!row.lastAllowedAt && !row.lastDeniedAt) return <p className="text-sm text-fg-subtle">No calls yet</p>;
  return (
    <p className="flex flex-col text-sm text-fg-muted">
      <span>
        <span className="sr-only">Last allowed call </span>
        <span aria-hidden>Allowed </span>
        {row.lastAllowedAt ? timeAgo(row.lastAllowedAt) : <span className="text-fg-subtle">never</span>}
      </span>
      <span className={deniedThisWeek(row) ? "text-danger" : ""}>
        <span className="sr-only">Last denied call </span>
        <span aria-hidden>Denied </span>
        {row.lastDeniedAt ? timeAgo(row.lastDeniedAt) : <span className="text-fg-subtle">never</span>}
      </span>
    </p>
  );
}
