"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleCheck, RefreshCw, ShieldOff, Sparkles } from "lucide-react";
import { Card, Pill } from "@/components/ui";
import { ListPagination } from "@/components/list-controls/list-controls";
import { DateRangeFilter, useUrlDayRange } from "@/components/list-controls/date-range-filter";
import { serverListPage, useUrlPage } from "@/components/list-controls/use-url-page";
import { isDayRangeSet, NO_DAY_RANGE, setDayRangeParams, type DayRange } from "@/lib/date-range";
import { MAX_SESSION_PAGE } from "@/lib/page-limits";
import { changeHref, displayWriterLabel, fmt } from "./format";

/**
 * The audit page's "Session starts" view: for each recent agent session, what Willder gave it
 * at its start and which of those things it went on to use (GET /api/audit/sessions). Records
 * are named by type and id only; each opens through the audited change detail.
 */

type ServedLine = {
  position: number;
  itemType: string;
  namedIds: string[];
  use: "named" | "returned" | null;
  changeId: string | null;
};

type SessionStart = {
  servingId: string;
  agentName: string;
  sessionKey: string;
  scopePath: string;
  taskKey: string;
  servedAt: string;
  lineCount: number;
  lines: ServedLine[];
};

type SessionsResponse = {
  sessions: SessionStart[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type Result =
  | { status: "loading" }
  | { status: "error" | "forbidden" | "unauthorized" }
  | { status: "ready"; data: SessionsResponse; checkedAt: Date };

const SESSION_NOUN = { one: "session", many: "sessions" };

const CONTROL =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-divider px-4 py-2 text-sm text-fg-muted transition-colors hover:border-accent/35 hover:bg-fg/5 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";

/** A served line's type in plain words. */
const ITEM_TYPE_LABEL: Record<string, string> = {
  convention: "Rule",
  fact: "Fact",
  change: "Recent change",
  note: "Working note",
  provenance: "Graph fact",
};

function itemTypeLabel(itemType: string): string {
  return ITEM_TYPE_LABEL[itemType] ?? itemType;
}

/** "Got 5 things at start and used 2 of them." and its parts, in plain words. */
export function sessionSummary(session: Pick<SessionStart, "sessionKey" | "lineCount" | "lines">): {
  headline: string;
  erased: string | null;
} {
  const got = `Got ${session.lineCount} ${session.lineCount === 1 ? "thing" : "things"} at start`;
  const used = session.lines.filter((line) => line.use !== null).length;
  const headline =
    session.sessionKey === ""
      ? `${got}. Which it used can’t be told: the session had no name.`
      : `${got} and used ${used} of them.`;
  const erasedCount = session.lineCount - session.lines.length;
  const erased =
    erasedCount > 0
      ? `${erasedCount} of them ${erasedCount === 1 ? "has" : "have"} been erased since and ${erasedCount === 1 ? "is" : "are"} not shown.`
      : null;
  return { headline, erased };
}

function isLine(value: unknown): value is ServedLine {
  const line = value as Partial<ServedLine> | null;
  return (
    !!line &&
    Number.isInteger(line.position) &&
    typeof line.itemType === "string" &&
    Array.isArray(line.namedIds) &&
    line.namedIds.every((id) => typeof id === "string") &&
    (line.use === null || line.use === "named" || line.use === "returned") &&
    (line.changeId === null || typeof line.changeId === "string")
  );
}

function isSessionsResponse(value: unknown): value is SessionsResponse {
  const data = value as Partial<SessionsResponse> | null;
  return (
    !!data &&
    Array.isArray(data.sessions) &&
    data.sessions.every(
      (s) =>
        s &&
        typeof s.servingId === "string" &&
        typeof s.agentName === "string" &&
        typeof s.sessionKey === "string" &&
        typeof s.scopePath === "string" &&
        typeof s.taskKey === "string" &&
        typeof s.servedAt === "string" &&
        Number.isFinite(Date.parse(s.servedAt)) &&
        Number.isInteger(s.lineCount) &&
        Array.isArray(s.lines) &&
        s.lines.every(isLine),
    ) &&
    Number.isInteger(data.total) &&
    Number.isInteger(data.page) &&
    Number.isInteger(data.pageSize) &&
    Number.isInteger(data.totalPages)
  );
}

/**
 * Remounted by the page for a new scope, so a previous scope's sessions never stay on screen.
 * The page and the date range are in the URL (`sessions.page`, `sessions.from`,
 * `sessions.through`), so a link or reload reopens them; a new range starts again at page 1.
 */
export function SessionStarts({ scope }: { scope: string | null }) {
  const [range, setRange] = useUrlDayRange("sessions.");
  const [page, setPage] = useUrlPage("sessions.page", JSON.stringify(range), MAX_SESSION_PAGE);
  const [revision, setRevision] = useState(0);
  return (
    <section aria-label="Session starts" className="space-y-3 sm:space-y-5">
      <p className="max-w-3xl px-1 text-sm leading-relaxed text-fg-muted">
        When an agent starts a session, Willder gives it what it should already know: the rules of its scope, what
        earlier sessions on the same task decided, and recent changes. Here is what each session got, and what it went
        on to use.
      </p>
      <DateRangeFilter range={range} onChange={setRange} noun="sessions" />
      <SessionStartsResults
        key={JSON.stringify([scope, range])}
        revision={revision}
        scope={scope}
        range={range}
        page={page}
        onPageChange={setPage}
        onClearRange={() => setRange(NO_DAY_RANGE)}
        onRefresh={() => setRevision((r) => r + 1)}
      />
    </section>
  );
}

function SessionStartsResults({
  scope,
  range,
  page,
  revision,
  onPageChange,
  onClearRange,
  onRefresh,
}: {
  scope: string | null;
  range: DayRange;
  page: number;
  revision: number;
  onPageChange: (page: number) => void;
  onClearRange: () => void;
  onRefresh: () => void;
}) {
  const [result, setResult] = useState<Result>({ status: "loading" });
  const [paging, setPaging] = useState<Pick<SessionsResponse, "total" | "pageSize"> | null>(null);
  const request = `${page}:${revision}`;
  const [previousRequest, setPreviousRequest] = useState(request);
  // Clear records synchronously, but keep only the pager metadata across page turns.
  if (previousRequest !== request) {
    setPreviousRequest(request);
    setResult({ status: "loading" });
  }
  const { fromDay, throughDay } = range;
  const ranged = isDayRangeSet(range);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function load() {
      const params = new URLSearchParams({ page: String(page) });
      if (scope) params.set("scope", scope);
      setDayRangeParams(params, { fromDay, throughDay });
      try {
        const response = await fetch(`/api/audit/sessions?${params}`, { signal: controller.signal, cache: "no-store" });
        if (cancelled) return;
        if (response.status === 401 || response.status === 403) {
          setResult({ status: response.status === 401 ? "unauthorized" : "forbidden" });
          return;
        }
        if (!response.ok) throw new Error("Session starts request failed");
        const data: unknown = await response.json();
        if (cancelled) return;
        if (!isSessionsResponse(data)) throw new Error("Invalid session starts response");
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
  }, [scope, fromDay, throughDay, page, revision]);

  return (
    <div className="space-y-3 sm:space-y-5">
      <SessionStartsResultContent
        result={result}
        scope={scope}
        ranged={ranged}
        page={page}
        onPageChange={onPageChange}
        onClearRange={onClearRange}
        onRefresh={onRefresh}
      />
      {paging && (
        <ListPagination
          noun={SESSION_NOUN}
          paging={serverListPage({ ...paging, rows: [], page }, onPageChange)}
          keepVisible
          empty={result.status === "ready" && result.data.sessions.length === 0}
          loading={result.status === "loading"}
          unavailable={result.status !== "loading" && result.status !== "ready"}
        />
      )}
    </div>
  );
}

function SessionStartsResultContent({
  result,
  scope,
  ranged,
  page,
  onPageChange,
  onClearRange,
  onRefresh,
}: {
  result: Result;
  scope: string | null;
  ranged: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onClearRange: () => void;
  onRefresh: () => void;
}) {
  if (result.status === "loading") {
    return (
      <Card>
        <div role="status" className="border-b border-divider px-5 py-4 text-sm text-fg-muted">
          Loading session starts…
        </div>
        <div aria-hidden="true" className="divide-y divide-divider">
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-3 px-5 py-6 motion-safe:animate-pulse">
              <div className="h-3 w-1/3 rounded bg-fg/[0.06]" />
              <div className="h-2.5 w-2/3 rounded bg-fg/[0.04]" />
              <div className="h-2.5 w-1/2 rounded bg-fg/[0.04]" />
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
          : "Couldn’t load session starts";
    const description =
      result.status === "forbidden"
        ? "You need permission to manage access before you can see what agents were given."
        : result.status === "unauthorized"
          ? "Sign in again, then retry to see what agents were given."
          : "The sessions could not be retrieved. Try again to check the latest.";
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
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">Recent session starts</h2>
          <p className="mt-1 text-sm text-fg-subtle">
            {data.total === 0
              ? ranged
                ? "None in these dates"
                : "None yet"
              : `${data.total.toLocaleString()} ${data.total === 1 ? "session" : "sessions"}${ranged ? " in these dates" : ""} · Newest first`}
          </p>
        </div>
        <button type="button" onClick={onRefresh} className={CONTROL}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>
      {data.sessions.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <Sparkles size={26} aria-hidden="true" className="mb-5 text-accent/70" />
          <h3 className="text-base font-semibold text-fg">
            {page > 1
              ? "No sessions on this page"
              : ranged
                ? "No session starts in these dates"
                : "No session starts yet"}
          </h3>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-fg-subtle">
            {page > 1
              ? "The list may have changed. Return to the first page to see the latest."
              : ranged
                ? "Try other dates, or clear them to see every session in this scope."
                : "When an agent starts a session in this scope, what it was given and what it used will show here."}
          </p>
          {page > 1 ? (
            <button type="button" onClick={() => onPageChange(1)} className={`${CONTROL} mt-5`}>
              Return to first page
            </button>
          ) : (
            ranged && (
              <button type="button" onClick={onClearRange} className={`${CONTROL} mt-5`}>
                Clear dates
              </button>
            )
          )}
        </div>
      ) : (
        <ol aria-label="Session starts" className="divide-y divide-divider">
          {data.sessions.map((session) => (
            <SessionStartRow key={session.servingId} session={session} scope={scope} />
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
  );
}

function SessionStartRow({ session, scope }: { session: SessionStart; scope: string | null }) {
  const { headline, erased } = sessionSummary(session);
  const attributable = session.sessionKey !== "";
  return (
    <li className="px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 break-words text-base font-semibold text-fg">
          {displayWriterLabel(session.agentName) || "Unnamed agent"}
          <span className="font-normal text-fg-muted">
            {session.taskKey ? (
              <>
                {" "}
                on task <span className="font-mono text-sm text-fg">{session.taskKey}</span>
              </>
            ) : (
              " with no task named"
            )}
          </span>
        </h3>
        <time dateTime={session.servedAt} title={session.servedAt} className="font-mono text-xs text-fg-subtle">
          {fmt(session.servedAt)}
        </time>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-fg">{headline}</p>
      {erased && <p className="mt-1 text-sm text-fg-subtle">{erased}</p>}
      <p className="mt-1 break-all font-mono text-xs text-fg-subtle">
        {session.scopePath}
        {attributable && ` · session ${session.sessionKey}`}
      </p>
      <ol aria-label="What it got" className="mt-4 divide-y divide-divider rounded-xl border border-divider">
        {session.lines.map((line) => (
          <ServedLineRow key={line.position} line={line} attributable={attributable} scope={scope} />
        ))}
      </ol>
    </li>
  );
}

function ServedLineRow({
  line,
  attributable,
  scope,
}: {
  line: ServedLine;
  attributable: boolean;
  scope: string | null;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-4">
      <span className="pt-0.5 font-mono text-xs text-fg-subtle tabular-nums">{line.position}</span>
      <div className="min-w-0">
        <p className="text-sm text-fg">{itemTypeLabel(line.itemType)}</p>
        <p className="mt-0.5 break-all font-mono text-xs text-fg-subtle">{line.namedIds.join(", ")}</p>
        {line.changeId && (
          <Link
            href={changeHref(line.changeId, scope)}
            className="mt-1 inline-block text-sm text-info underline-offset-2 hover:underline"
          >
            Open the record
          </Link>
        )}
      </div>
      <div className="col-start-2 sm:col-start-3">
        {line.use ? (
          <Pill className="!px-2.5 !py-1 !text-xs">
            <CircleCheck size={12} aria-hidden="true" className="text-success" />
            {line.use === "named" ? "Used: named it in a call" : "Used: came back in an answer"}
          </Pill>
        ) : (
          <span className="text-xs text-fg-subtle">{attributable ? "Not used" : "Use unknown"}</span>
        )}
      </div>
    </li>
  );
}
