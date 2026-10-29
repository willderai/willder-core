"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw, ShieldCheck, ShieldOff, ScrollText } from "lucide-react";
import { Card, Pill } from "@/components/ui";
import { ListControls, ListNoMatch, ListPagination } from "@/components/list-controls/list-controls";
import { compareTime, type ListConfig, type SortDirection } from "@/components/list-controls/list-query";
import { useListState, type ListStateControls } from "@/components/list-controls/use-list-state";
import { serverListPage, useUrlPage } from "@/components/list-controls/use-url-page";
import { useUrlParam } from "@/components/memory/store-list-tab";
import { MAX_AUDIT_PAGE } from "@/lib/page-limits";
import { ActorPicker, type SelectedActor } from "./actor-picker";
import { changeHref, displayWriterLabel, fmt, parseAction, parseTarget, tokenShortId } from "./format";

type DecisionFilter = "all" | "allow" | "deny";

type AuditEntry = {
  id: string;
  actorType: string;
  actorName: string;
  triggeredBy?: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  capabilityId?: string;
  /** The changes this authorization produced, oldest first; empty for a read or a denial. */
  changeIds: string[];
  at: string;
};

type AuditResponse = {
  entries: AuditEntry[];
  /** Records matching every filter, the decision filter included: the list. */
  total: number;
  /** Allowed and denied across all pages, at the same scope and identity as
   * the list but regardless of the decision filter. */
  counts: { allowed: number; denied: number };
  page: number;
  pageSize: number;
  totalPages: number;
};

type Result =
  | { status: "loading" }
  | { status: "error" | "forbidden" | "unauthorized" }
  | { status: "ready"; data: AuditResponse; checkedAt: Date };

const CONTROL =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-divider px-4 py-2 text-sm text-fg-muted transition-colors hover:border-accent/35 hover:bg-fg/5 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";
const EYEBROW = "text-eyebrow font-semibold uppercase text-fg-subtle";

/**
 * How the access log searches and orders. The server does both (GET /api/audit,
 * `q` and `order`): the log is paged, and only the server can leave out the rows
 * the log hides before it counts. `searchText` lists what the route matches, so
 * the toolbar and the URL describe the same view.
 */
const AUDIT_LIST: ListConfig<AuditEntry> = {
  noun: { one: "record", many: "records" },
  searchText: (entry) => [entry.action, entry.target, entry.reason, entry.actorName, entry.capabilityId],
  sorts: [
    {
      key: "time",
      label: "Time",
      compare: (a, b) => compareTime(a.at, b.at),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
  ],
};

function readDecision(value: string | null): DecisionFilter {
  return value === "allow" || value === "deny" ? value : "all";
}

/** Remounting results for a new query immediately removes previous records,
 * including open inspections, before another authorization check completes.
 * Each request also checks cancellation after its asynchronous JSON read.
 * The page, decision and identity live in the URL beside the search and order,
 * so a link, reload or back reopens the same view. */
export function AuditLog({ scope }: { scope: string | null }) {
  const [decisionParam, setDecisionParam] = useUrlParam("decision", "replace");
  const [actorTypeParam, setActorTypeParam] = useUrlParam("actorType", "replace");
  const [actorIdParam, setActorIdParam] = useUrlParam("actorId", "replace");
  const decision = readDecision(decisionParam);
  const actor = useMemo<SelectedActor | null>(
    () => (actorTypeParam && actorIdParam ? { actorType: actorTypeParam, actorId: actorIdParam } : null),
    [actorTypeParam, actorIdParam],
  );
  const listView = useListState(AUDIT_LIST);
  const search = listView.committed.query.trim();
  const order = listView.committed.direction;
  // A new search, order, decision or identity starts again at page 1.
  const [page, setPage] = useUrlPage(
    "page",
    JSON.stringify([search, order, decision, actor?.actorType, actor?.actorId]),
    MAX_AUDIT_PAGE,
  );
  const [revision, setRevision] = useState(0);
  // How many records the answer on screen matched, for the toolbar's count while a
  // search is on; null while it loads or after it failed, so no count is claimed.
  const [matched, setMatched] = useState<number | null>(null);

  function filterByDecision(next: DecisionFilter) {
    setDecisionParam(next === "all" ? null : next);
  }

  function filterByActor(next: SelectedActor | null) {
    setActorTypeParam(next?.actorType ?? null);
    setActorIdParam(next?.actorId ?? null);
  }

  return (
    <section aria-label="Access log" className="space-y-3 sm:space-y-5">
      <ListControls config={AUDIT_LIST} controls={listView} total={null} shown={matched}>
        <div
          role="group"
          aria-label="Filter by decision"
          className="inline-flex gap-1 rounded-full border border-divider bg-fg/[0.03] p-1"
        >
          {(
            [
              ["all", "All decisions"],
              ["allow", "Allowed"],
              ["deny", "Denied"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={decision === key}
              onClick={() => filterByDecision(key)}
              className={`min-h-10 whitespace-nowrap rounded-full px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-3 ${decision === key ? "bg-accent/10 text-fg" : "text-fg-subtle hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <ActorPicker selected={actor} onChange={filterByActor} />
      </ListControls>
      <AuditResults
        key={JSON.stringify([scope, decision, actor, search, order])}
        revision={revision}
        scope={scope}
        decision={decision}
        actor={actor}
        search={search}
        order={order}
        page={page}
        listView={listView}
        onLoaded={setMatched}
        onPageChange={setPage}
        onRefresh={() => setRevision((current) => current + 1)}
      />
    </section>
  );
}

function isAuditResponse(value: unknown): value is AuditResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<AuditResponse>;
  return (
    Array.isArray(data.entries) &&
    data.entries.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.actorType === "string" &&
        typeof entry.actorName === "string" &&
        typeof entry.action === "string" &&
        (entry.target === null || typeof entry.target === "string") &&
        (entry.decision === "allow" || entry.decision === "deny") &&
        (entry.reason === null || typeof entry.reason === "string") &&
        (entry.triggeredBy === undefined || typeof entry.triggeredBy === "string") &&
        (entry.capabilityId === undefined || typeof entry.capabilityId === "string") &&
        Array.isArray(entry.changeIds) &&
        entry.changeIds.every((id) => typeof id === "string" && id.length > 0) &&
        typeof entry.at === "string" &&
        Number.isFinite(Date.parse(entry.at)),
    ) &&
    Number.isInteger(data.total) &&
    data.total! >= 0 &&
    !!data.counts &&
    isCount(data.counts.allowed) &&
    isCount(data.counts.denied) &&
    Number.isInteger(data.page) &&
    data.page! >= 1 &&
    Number.isInteger(data.pageSize) &&
    data.pageSize! >= 1 &&
    Number.isInteger(data.totalPages) &&
    data.totalPages! >= 0
  );
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function AuditResults({
  scope,
  decision,
  actor,
  search,
  order,
  page,
  revision,
  listView,
  onLoaded,
  onPageChange,
  onRefresh,
}: {
  scope: string | null;
  decision: DecisionFilter;
  actor: SelectedActor | null;
  search: string;
  order: SortDirection;
  page: number;
  revision: number;
  listView: ListStateControls;
  /** Called with how many records matched once an answer is shown, and null until then or on failure. */
  onLoaded: (total: number | null) => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
}) {
  const [result, setResult] = useState<Result>({ status: "loading" });
  const [paging, setPaging] = useState<Pick<AuditResponse, "total" | "pageSize"> | null>(null);
  const request = `${page}:${revision}`;
  const [previousRequest, setPreviousRequest] = useState(request);
  // Clear records synchronously, but keep only the pager metadata across page turns.
  if (previousRequest !== request) {
    setPreviousRequest(request);
    setResult({ status: "loading" });
  }

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function load() {
      const params = new URLSearchParams({ page: String(page) });
      if (scope) params.set("scope", scope);
      if (search) params.set("q", search);
      if (order === "asc") params.set("order", "asc");
      if (decision !== "all") params.set("decision", decision);
      if (actor) {
        params.set("actorType", actor.actorType);
        params.set("actorId", actor.actorId);
      }
      try {
        const response = await fetch(`/api/audit?${params}`, { signal: controller.signal, cache: "no-store" });
        if (cancelled) return;
        if (response.status === 401 || response.status === 403) {
          setResult({ status: response.status === 401 ? "unauthorized" : "forbidden" });
          return;
        }
        if (!response.ok) throw new Error("Audit request failed");
        const data: unknown = await response.json();
        if (cancelled) return;
        if (!isAuditResponse(data)) throw new Error("Invalid audit response");
        setPaging({ total: data.total, pageSize: data.pageSize });
        setResult({ status: "ready", data, checkedAt: new Date() });
      } catch {
        if (!cancelled) setResult({ status: "error" });
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [scope, decision, actor, search, order, page, revision]);

  useEffect(() => {
    onLoaded(result.status === "ready" ? result.data.total : null);
  }, [result, onLoaded]);

  return (
    <div className="space-y-3 sm:space-y-5">
      <AuditResultContent
        result={result}
        scope={scope}
        decision={decision}
        actor={actor}
        search={search}
        order={order}
        page={page}
        listView={listView}
        onPageChange={onPageChange}
        onRefresh={onRefresh}
      />
      {paging && (
        <ListPagination
          noun={AUDIT_LIST.noun}
          paging={serverListPage({ ...paging, rows: [], page }, onPageChange)}
          keepVisible
          empty={result.status === "ready" && result.data.entries.length === 0}
          loading={result.status === "loading"}
          unavailable={result.status !== "loading" && result.status !== "ready"}
        />
      )}
    </div>
  );
}

function AuditResultContent({
  result,
  scope,
  decision,
  actor,
  search,
  order,
  page,
  listView,
  onPageChange,
  onRefresh,
}: {
  result: Result;
  scope: string | null;
  decision: DecisionFilter;
  actor: SelectedActor | null;
  search: string;
  order: SortDirection;
  page: number;
  listView: ListStateControls;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
}) {
  if (result.status === "loading") {
    return (
      <Card>
        <div role="status" className="border-b border-divider px-5 py-4 text-sm text-fg-muted">
          Loading audit records…
        </div>
        <div aria-hidden="true" className="divide-y divide-divider">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex items-center gap-5 px-5 py-6 motion-safe:animate-pulse">
              <div className="h-3 w-20 rounded bg-fg/[0.06]" />
              <div className="flex-1 space-y-3">
                <div className="h-3 w-2/3 rounded bg-fg/[0.06]" />
                <div className="h-2.5 w-1/2 rounded bg-fg/[0.04]" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (result.status !== "ready") {
    const title =
      result.status === "forbidden"
        ? "Admin access required"
        : result.status === "unauthorized"
          ? "Your session needs attention"
          : "Couldn’t load the audit log";
    const description =
      result.status === "forbidden"
        ? "You need permission to manage access before you can view audit records."
        : result.status === "unauthorized"
          ? "Sign in again, then retry to view your organization’s audit records."
          : "The records could not be retrieved. Try again to check the latest activity.";
    return (
      <Card>
        <div role="alert" className="flex flex-col items-start px-6 py-9 sm:px-8">
          <ShieldOff aria-hidden="true" size={22} className="mb-5 text-info" />
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-fg-muted">{description}</p>
          <button type="button" onClick={onRefresh} className={`${CONTROL} mt-6`}>
            <RefreshCw size={14} aria-hidden="true" />
            Try again
          </button>
        </div>
      </Card>
    );
  }

  const { data, checkedAt } = result;
  const { allowed, denied } = data.counts;
  const first = (data.page - 1) * data.pageSize + 1;
  const last = first + data.entries.length - 1;
  const isFiltered = decision !== "all" || scope !== null || actor !== null || search !== "";

  return (
    <div className="space-y-3 sm:space-y-5">
      <Card>
        <dl aria-label="Audit summary" className="grid grid-cols-3 divide-x divide-divider">
          <Summary label="Records" value={allowed + denied} detail="Across all pages" />
          <Summary label="Allowed" value={allowed} detail="Across all pages" className="text-success" />
          <Summary label="Denied" value={denied} detail="Across all pages" className="text-danger" />
        </dl>
      </Card>
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-fg">Recorded activity</h2>
            <p className="mt-1 text-sm text-fg-subtle">
              {data.entries.length
                ? `Records ${first.toLocaleString()}–${last.toLocaleString()} of ${data.total.toLocaleString()}`
                : "No matching records"}
              {decision !== "all" && ` · ${decision === "allow" ? "Allowed" : "Denied"} only`} ·{" "}
              {order === "asc" ? "Oldest" : "Newest"} first
            </p>
          </div>
          <button type="button" onClick={onRefresh} className={CONTROL}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        </div>
        {data.entries.length === 0 && page === 1 && search !== "" ? (
          <div className="p-4 sm:p-5">
            <ListNoMatch config={AUDIT_LIST} controls={listView} />
          </div>
        ) : data.entries.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <ScrollText size={26} aria-hidden="true" className="mb-5 text-accent/70" />
            <h3 className="text-base font-semibold text-fg">
              {page > 1
                ? "No records on this page"
                : isFiltered
                  ? "No records match these filters"
                  : "Your audit trail starts here"}
            </h3>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-fg-subtle">
              {page > 1
                ? "The available records may have changed. Return to the first page to check the latest activity."
                : isFiltered
                  ? "Try a different scope, identity, or decision to explore the recorded activity."
                  : "Recorded memory activity and access decisions will appear here as people and agents work."}
            </p>
            {page > 1 && (
              <button type="button" onClick={() => onPageChange(1)} className={`${CONTROL} mt-5`}>
                Return to first page
              </button>
            )}
          </div>
        ) : (
          <ol aria-label="Audit records" className="divide-y divide-divider">
            {data.entries.map((entry) => (
              <AuditRecord key={entry.id} entry={entry} scope={scope} />
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-4">
          <p className="font-mono text-xs text-fg-subtle">
            Checked{" "}
            <time dateTime={checkedAt.toISOString()}>
              {checkedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </time>{" "}
            · Refresh to update
          </p>
        </div>
      </Card>
      <p className="max-w-3xl px-1 text-sm leading-relaxed text-fg-subtle">
        Counts follow the search, scope and identity filters and include both decisions, whichever decision is listed.
        An allowed decision alone does not confirm a completed operation.
      </p>
    </div>
  );
}

function Summary({
  label,
  value,
  detail,
  className = "text-fg",
}: {
  label: string;
  value: number;
  detail: string;
  className?: string;
}) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-5 sm:py-6">
      <dt className={`${EYEBROW} leading-relaxed`}>{label}</dt>
      <dd className={`mt-1 text-2xl font-medium tracking-tight tabular-nums sm:mt-2 sm:text-3xl ${className}`}>
        {value.toLocaleString()}
      </dd>
      <dd className="mt-1 text-xs text-fg-subtle sm:mt-1.5">{detail}</dd>
    </div>
  );
}

function AuditRecord({ entry, scope }: { entry: AuditEntry; scope: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const target =
    entry.target === null ? { scope: "Not recorded", what: "No target recorded" } : parseTarget(entry.target);
  const allowed = entry.decision === "allow";
  const detailId = `audit-detail-${entry.id}`;
  return (
    <li className={expanded ? "bg-accent/[0.025]" : "transition-colors hover:bg-fg/[0.03]"}>
      <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2 px-5 py-4 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-x-6">
        <time
          dateTime={entry.at}
          title={new Date(entry.at).toISOString()}
          className="col-span-2 font-mono text-xs leading-relaxed text-fg-subtle sm:col-span-1 sm:pt-0.5"
        >
          {fmt(entry.at)}
        </time>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="break-words font-semibold text-fg">
              {displayWriterLabel(entry.actorName) || "Unnamed identity"}
            </span>
            <span className="font-mono text-xs text-fg-subtle">{entry.actorType}</span>
            <span aria-hidden="true" className="text-fg-subtle">
              /
            </span>
            <span className="text-fg-muted">{parseAction(entry.action)}</span>
            {entry.capabilityId && (
              <span title={entry.capabilityId} className="font-mono text-xs text-fg-subtle">
                token {tokenShortId(entry.capabilityId)}
              </span>
            )}
          </div>
          <p className="mt-1.5 line-clamp-2 break-words text-sm leading-relaxed text-fg-muted">
            {target.what}
            {target.recordId && <span className="ml-2 font-mono text-xs text-fg-subtle">{target.recordId}</span>}
          </p>
          <p className="mt-1 break-all font-mono text-xs leading-relaxed text-fg-subtle">{target.scope}</p>
          {entry.changeIds.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {entry.changeIds.map((changeId, i) => (
                <Link
                  key={changeId}
                  href={changeHref(changeId, scope)}
                  className="text-info underline-offset-2 hover:underline"
                >
                  {entry.changeIds.length > 1 ? `See change ${i + 1} it made` : "See the change it made"}
                </Link>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-3">
          <Pill className="!px-2.5 !py-1 !text-xs">
            {allowed ? (
              <ShieldCheck size={12} aria-hidden="true" className="text-success" />
            ) : (
              <ShieldOff size={12} aria-hidden="true" className="text-danger" />
            )}
            {allowed ? "Allowed" : "Denied"}
          </Pill>
          <button
            type="button"
            aria-label={`${expanded ? "Close" : "Inspect"} event ${entry.id}`}
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex min-h-8 items-center gap-1 rounded text-sm text-accent transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            {expanded ? "Close" : "Inspect"}
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={`transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>
      {expanded && (
        <section
          id={detailId}
          aria-label={`Details for event ${entry.id}`}
          className="mx-5 mb-5 rounded-xl border border-accent/15 bg-ink/50 p-4 sm:p-5"
        >
          <div className="mb-5 border-b border-divider pb-5">
            <h3 className={EYEBROW}>Recorded reason</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
              {entry.reason || "No reason was recorded for this event."}
            </p>
          </div>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Detail label="Identity name" value={displayWriterLabel(entry.actorName) || "Not recorded"} />
            <Detail label="Identity type" value={entry.actorType} />
            {entry.triggeredBy && <Detail label="Triggered by" value={entry.triggeredBy} />}
            <Detail label="Action" value={entry.action} />
            {entry.capabilityId && <Detail label="Token ID" value={entry.capabilityId} />}
            <Detail label="Recorded at · UTC" value={new Date(entry.at).toISOString()} />
            <Detail label="Full target" value={entry.target ?? "Not recorded"} wide />
            <Detail label="Event ID" value={entry.id} wide />
          </dl>
        </section>
      )}
    </li>
  );
}

function Detail({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <dt className={EYEBROW}>{label}</dt>
      <dd className="mt-2 select-text whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-fg-muted">
        {value}
      </dd>
    </div>
  );
}
