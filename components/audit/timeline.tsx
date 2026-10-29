"use client";

// Timeline correlates writes with later eligible reads; it is not a delivery receipt.
//
// Owns the data and the controls: the window, live refresh, zoom, replay and
// the detail panel. The drawing is timeline-chart.tsx. Every request is keyed to
// the scope and window it was made for, and a response that arrives after either
// changed is dropped, so a slow load can never paint another scope's rows.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Pause, Play, Radio, ZoomIn, ZoomOut } from "lucide-react";
import { z } from "zod";
import { isAuditOrigin } from "@/services/access/origin";
import type { Timeline } from "@/services/audit/timeline";
import { LatencyStrip, TimelineChart, useScopeLegend } from "./timeline-chart";
import { changeHref, displayWriterLabel, fmt, formatDuration, scopeLabel } from "./format";

type TimelineResponse = {
  scope: string;
  from: string;
  to: string;
  timeline: Timeline;
  truncated: { writes: boolean; reads: boolean };
};

type ChangeDetail = {
  id: string;
  op: string;
  recordType: string;
  recordId: string;
  scopePath: string;
  summary: string;
  writer: string;
  actingFor: string | null;
  source: { id: string; name: string; type: string } | null;
  replacedById: string | null;
  replacesIds: string[];
  replacedBy: VersionLink | null;
  replaces: VersionLink[];
  at: string;
};

/** A version this change replaced or was replaced by, with the change that wrote it when
 * that change is in the scope on screen. */
type VersionLink = { id: string; change: { id: string; summary: string } | null };

const recordedTime = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const identifier = z.string().min(1);
const duration = z.number().finite().nonnegative();
/** Null on an event recorded before origins were. */
const origin = z.string().refine(isAuditOrigin).nullable();
const timelineResponseSchema = z
  .object({
    scope: identifier,
    from: recordedTime,
    to: recordedTime,
    truncated: z.object({ writes: z.boolean(), reads: z.boolean() }),
    timeline: z.object({
      lanes: z.array(
        z.object({
          key: identifier,
          actorType: z.string(),
          actorId: identifier,
          name: z.string(),
          scopePath: z.string().nullable(),
        }),
      ),
      writes: z.array(
        z.object({
          id: identifier,
          at: recordedTime,
          laneKey: identifier,
          scopePath: identifier,
          op: z.string(),
          recordType: z.string(),
          recordId: z.string(),
          origin,
          outcome: z.literal("success"),
        }),
      ),
      sightings: z.array(
        z.object({
          writeId: identifier,
          laneKey: identifier,
          readId: identifier,
          at: recordedTime,
          latencyMs: duration,
          action: z.literal("memory.read"),
          scopePath: identifier,
          origin,
          outcome: z.literal("allow"),
        }),
      ),
      denials: z.array(
        z.object({
          id: identifier,
          at: recordedTime,
          laneKey: identifier,
          action: z.string(),
          scopePath: z.string().nullable(),
          origin,
          outcome: z.literal("deny"),
        }),
      ),
      latency: z.object({ count: z.number().int().positive(), medianMs: duration, p95Ms: duration }).nullable(),
      unseenWriteIds: z.array(identifier),
    }),
  })
  .refine((data) => {
    // SVG positions require a real time span and valid lane/write references.
    const { timeline } = data;
    const lanes = new Set(timeline.lanes.map((lane) => lane.key));
    const writes = new Set(timeline.writes.map((write) => write.id));
    return (
      Date.parse(data.from) < Date.parse(data.to) &&
      lanes.size === timeline.lanes.length &&
      writes.size === timeline.writes.length &&
      timeline.writes.every((write) => lanes.has(write.laneKey)) &&
      timeline.sightings.every((read) => lanes.has(read.laneKey) && writes.has(read.writeId)) &&
      timeline.denials.every((read) => lanes.has(read.laneKey)) &&
      timeline.unseenWriteIds.every((id) => writes.has(id))
    );
  });

const versionLinkSchema = z.object({
  id: identifier,
  change: z.object({ id: identifier, summary: z.string() }).nullable(),
});

const changeDetailSchema = z.object({
  id: identifier,
  op: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  scopePath: identifier,
  summary: z.string(),
  writer: z.string(),
  actingFor: z.string().nullable(),
  source: z.object({ id: identifier, name: z.string(), type: z.string() }).nullable(),
  replacedById: identifier.nullable(),
  replacesIds: z.array(identifier),
  replacedBy: versionLinkSchema.nullable(),
  replaces: z.array(versionLinkSchema),
  at: recordedTime,
});

function responseError(body: unknown, fallback: string): string {
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
}

/** Each result carries the scope and range it was loaded for (see `viewKey`);
 * one loaded for anything else reads as still loading. */
type Load =
  | { state: "none"; key: string }
  | { state: "ready"; key: string; data: TimelineResponse }
  | { state: "error"; key: string; message: string };

const RANGES = [
  { key: "1h", label: "1 hour", ms: 3600e3 },
  { key: "24h", label: "24 hours", ms: 86400e3 },
  { key: "7d", label: "7 days", ms: 7 * 86400e3 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const LIVE_REFRESH_MS = 15_000;
const REPLAY_MS = 10_000;
const MIN_ZOOM_SPAN_MS = 60_000;

const CONTROL =
  "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const CONTROL_IDLE = "border-divider text-fg-subtle hover:border-accent/35 hover:text-fg";
const CONTROL_ON = "border-accent/50 bg-accent/10 text-fg";
const EYEBROW = "text-eyebrow font-semibold uppercase text-fg-subtle";

/**
 * `selected` is the change whose detail is open, and lives in the page's address so a
 * link to it can be handed to someone else; `onSelect` changes it.
 */
export function AuditTimeline({
  scope,
  selected,
  onSelect,
}: {
  scope: string | null;
  selected: string | null;
  onSelect: (changeId: string | null) => void;
}) {
  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [live, setLive] = useState(true);
  // The window's end while not live; ignored while live, when each load ends at now.
  const [frozenEnd, setFrozenEnd] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The route refused this viewer. Each request is an access decision with its own
  // audit row, so live refresh stops until the viewer asks again.
  const [refused, setRefused] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "none", key: "" });
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const rangeMs = RANGES.find((r) => r.key === rangeKey)!.ms;
  // What the view is of. A live refresh or a freeze keeps it, so the rows on
  // screen stay up while the next load is in flight; a new range changes it,
  // and rows loaded for the old one are never shown under the new.
  const viewKey = `${scope ?? ""}|${rangeKey}`;

  // A different window is a different question: nothing selected, zoomed or
  // replayed in the old one carries over. (A different scope remounts this
  // component; see the audit page.)
  const chooseRange = (key: RangeKey) => {
    setRangeKey(key);
    onSelect(null);
    setZoom(null);
    setPlayhead(null);
    setPlaying(false);
  };

  useEffect(() => {
    const controller = new AbortController();
    const end = live || frozenEnd === null ? Date.now() : frozenEnd;
    const params = new URLSearchParams({
      from: new Date(end - rangeMs).toISOString(),
      to: new Date(end).toISOString(),
    });
    if (scope) params.set("scope", scope);
    fetch(`/api/audit/timeline?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        setRefused(res.status === 403);
        if (res.ok) {
          const parsed = timelineResponseSchema.safeParse(body);
          if (!parsed.success || (scope !== null && parsed.data.scope !== scope)) {
            setLoad({ state: "error", key: viewKey, message: "The timeline returned incomplete data. Try again." });
          } else {
            setLoad({ state: "ready", key: viewKey, data: parsed.data });
          }
        } else if (res.status === 403)
          setLoad({ state: "error", key: viewKey, message: "Admin access required to view the timeline." });
        else
          setLoad({
            state: "error",
            key: viewKey,
            message: responseError(body, `The timeline could not load (HTTP ${res.status}).`),
          });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setLoad({
            state: "error",
            key: viewKey,
            message: e instanceof Error ? e.message : "The timeline could not load.",
          });
        }
      });
    return () => controller.abort();
  }, [scope, rangeMs, viewKey, live, frozenEnd, refresh]);

  useEffect(() => {
    if (!live || refused) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setRefresh((n) => n + 1);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [live, refused]);

  const data = load.state === "ready" && load.key === viewKey ? load.data : null;
  const windowDomain: [number, number] | null = data ? [Date.parse(data.from), Date.parse(data.to)] : null;
  const domain = zoom ?? windowDomain;

  /** Stop following now, so zoom and replay hold still under the viewer. */
  const freeze = useCallback(() => {
    if (!live || !data) return;
    setFrozenEnd(Date.parse(data.to));
    setLive(false);
  }, [live, data]);

  const goLive = () => {
    setZoom(null);
    setPlayhead(null);
    setPlaying(false);
    setFrozenEnd(null);
    setLive(true);
  };

  const zoomBy = (factor: number) => {
    if (!domain || !windowDomain) return;
    freeze();
    const [w0, w1] = windowDomain;
    const span = Math.max((domain[1] - domain[0]) * factor, MIN_ZOOM_SPAN_MS);
    if (span >= w1 - w0) return setZoom(null);
    const center = playhead ?? (domain[0] + domain[1]) / 2;
    const start = Math.min(Math.max(center - span / 2, w0), w1 - span);
    setZoom([start, start + span]);
  };

  useReplay(playing, domain, playhead, setPlayhead, () => setPlaying(false));

  const onScrub = (value: number) => {
    freeze();
    setPlaying(false);
    setPlayhead(value);
  };

  const togglePlay = () => {
    if (!domain) return;
    freeze();
    if (!playing && (playhead === null || playhead >= domain[1])) setPlayhead(domain[0]);
    setPlaying(!playing);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.key}
            aria-pressed={rangeKey === r.key}
            onClick={() => chooseRange(r.key)}
            className={`${CONTROL} ${rangeKey === r.key ? CONTROL_ON : CONTROL_IDLE}`}
          >
            {r.label}
          </button>
        ))}
        <span className="mx-1 hidden h-5 w-px bg-divider sm:block" />
        <button
          onClick={live ? freeze : goLive}
          className={`${CONTROL} ${live ? CONTROL_ON : CONTROL_IDLE}`}
          aria-pressed={live}
        >
          <Radio className="h-3.5 w-3.5" aria-hidden />
          {live ? "Live" : "Go live"}
        </button>
        <button
          onClick={() => zoomBy(0.5)}
          className={`${CONTROL} ${CONTROL_IDLE}`}
          aria-label="Zoom in"
          disabled={!domain}
        >
          <ZoomIn className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          onClick={() => zoomBy(2)}
          className={`${CONTROL} ${CONTROL_IDLE}`}
          aria-label="Zoom out"
          disabled={!zoom}
        >
          <ZoomOut className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* Above the chart, and whether or not the change falls in the window on screen: a
          reader handed a link to one change opens it here, at any width. */}
      {selected && (
        <ChangePanel
          key={`${scope ?? ""}:${selected}`}
          scope={scope}
          changeId={selected}
          timeline={data?.timeline ?? null}
          onClose={() => onSelect(null)}
        />
      )}

      {load.state === "error" && load.key === viewKey ? (
        <div
          role="alert"
          className="rounded-2xl border border-danger/25 bg-danger/[0.06] px-6 py-10 text-center text-sm text-fg-muted"
        >
          <p>{load.message}</p>
          <button onClick={() => setRefresh((n) => n + 1)} className={`${CONTROL} ${CONTROL_IDLE} mt-4`}>
            Try again
          </button>
        </div>
      ) : !data || !domain ? (
        <div className="h-64 animate-pulse rounded-2xl border border-divider bg-fg/[0.03]" aria-busy />
      ) : data.timeline.lanes.length === 0 ? (
        <div className="rounded-2xl border border-divider bg-fg/[0.03] px-6 py-16 text-center text-sm text-fg-muted">
          No writes, eligible agent reads, or denied reads in this window ending {fmt(data.to)}.
        </div>
      ) : (
        <>
          <Stats data={data} />
          {(data.truncated.writes || data.truncated.reads) && (
            <p className="text-sm text-ember">
              This window holds more activity than one view shows; it is cut at the oldest rows. Pick a shorter window
              to see the rest.
            </p>
          )}

          <div className="min-w-0 overflow-hidden rounded-2xl border border-divider bg-fg/[0.03] px-3 py-4 text-fg">
            <TimelineChart
              timeline={data.timeline}
              domain={domain}
              playhead={playhead}
              selectedWriteId={selected}
              onSelectWrite={onSelect}
            />
            <div className="mt-3 flex items-center gap-3 px-1">
              <button
                onClick={togglePlay}
                className={`${CONTROL} ${CONTROL_IDLE}`}
                aria-label={playing ? "Pause replay" : "Replay this window"}
              >
                {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              </button>
              <input
                type="range"
                min={domain[0]}
                max={domain[1]}
                step={Math.max(1, Math.round((domain[1] - domain[0]) / 1000))}
                value={playhead ?? domain[1]}
                onChange={(e) => onScrub(Number(e.target.value))}
                aria-label="Scrub through the window"
                className="h-1 flex-1 cursor-pointer accent-info"
              />
              <span className="w-28 shrink-0 text-right font-mono text-xs text-fg-subtle">
                {fmt(new Date(playhead ?? domain[1]).toISOString())}
              </span>
            </div>
          </div>

          <Legend timeline={data.timeline} />

          <section aria-label="Time to next eligible read" className="flex flex-col gap-2">
            <h3 className={EYEBROW}>Time to next eligible read, every reader</h3>
            <LatencyStrip timeline={data.timeline} />
          </section>

          <p className="text-sm leading-relaxed text-fg-subtle">
            Read delay measures the first later allowed read of a scope covering the write, by another agent. It does
            not confirm that the specific change was delivered, used in context, or changed an action. Figures come from
            recorded access attempts and memory changes in this window.
          </p>
        </>
      )}
    </div>
  );
}

function Stats({ data }: { data: TimelineResponse }) {
  const { timeline } = data;
  const items: [string, string][] = [
    ["Writes", String(timeline.writes.length)],
    ["With a later read", String(timeline.writes.length - timeline.unseenWriteIds.length)],
    ["Median read delay", timeline.latency ? formatDuration(timeline.latency.medianMs) : "none yet"],
    ["p95 read delay", timeline.latency ? formatDuration(timeline.latency.p95Ms) : "none yet"],
    ["Denied reads", String(timeline.denials.length)],
    ["Changed action", "Not measured"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-divider bg-fg/[0.03] px-4 py-3">
          <dt className={EYEBROW}>{label}</dt>
          <dd className="mt-1 text-lg tabular-nums text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Legend({ timeline }: { timeline: Timeline }) {
  const scopes = useScopeLegend(timeline);
  const mark = "inline-flex items-center gap-2 text-sm text-fg-muted";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <span className={mark}>
          <svg width="12" height="12" aria-hidden>
            <circle cx="6" cy="6" r="5" fill="var(--color-info)" />
          </svg>
          Write
        </span>
        <span className={mark}>
          <svg width="12" height="12" aria-hidden>
            <circle cx="6" cy="6" r="4" fill="none" stroke="var(--color-accent)" strokeWidth="2" />
          </svg>
          Next eligible read
        </span>
        <span className={mark}>
          <svg width="8" height="14" aria-hidden>
            <line x1="4" x2="4" y1="1" y2="13" stroke="var(--color-danger)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Denied read
        </span>
        <span className={mark}>
          <svg width="18" height="12" aria-hidden>
            <rect width="18" height="12" rx="2" fill="var(--color-info)" fillOpacity="0.18" />
          </svg>
          Window median to p95, projected from selected write
        </span>
        <span className={mark} title="This view has no action-outcome instrumentation.">
          Action outcomes not measured
        </span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {scopes.map(({ path, color }) => (
          <span key={path} className="inline-flex items-center gap-2 text-sm text-fg-muted" title={path}>
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
            {scopeLabel(path)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The selected write's text and citation, read through an audited request, in the plain
 * words an outsider handed this change needs: who wrote it and for whom, where it came
 * from, and what it replaced, each with a link to follow. */
function ChangePanel({
  scope,
  changeId,
  timeline,
  onClose,
}: {
  scope: string | null;
  changeId: string;
  /** The window on screen, for the readers list; null until it loads. */
  timeline: Timeline | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    fetch(`/api/audit/timeline/${encodeURIComponent(changeId)}${query}`, { signal: controller.signal })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (res.ok) {
          const parsed = changeDetailSchema.safeParse(body);
          if (parsed.success && parsed.data.id === changeId) setDetail(parsed.data);
          else setError("This change returned incomplete data. Try again.");
        } else setError(responseError(body, `This change could not load (HTTP ${res.status}).`));
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "This change could not load.");
      });
    return () => controller.abort();
  }, [scope, changeId, retry]);

  const laneName = useMemo(
    () => new Map((timeline?.lanes ?? []).map((l) => [l.key, displayWriterLabel(l.name)])),
    [timeline],
  );
  const readers = (timeline?.sightings ?? [])
    .filter((s) => s.writeId === changeId)
    .sort((a, b) => a.latencyMs - b.latencyMs);
  const inWindow = timeline?.writes.some((w) => w.id === changeId) ?? false;

  return (
    <section aria-label="Selected change" className="rounded-2xl border border-accent/25 bg-accent/[0.04] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <h3 className={EYEBROW}>Selected change</h3>
        <button
          onClick={onClose}
          className="inline-flex min-h-11 items-center px-2 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          Close
        </button>
      </div>
      {error ? (
        <div role="alert" className="mt-3 text-sm text-danger">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setRetry((value) => value + 1);
            }}
            className={`${CONTROL} ${CONTROL_IDLE} mt-3`}
          >
            Try again
          </button>
        </div>
      ) : !detail ? (
        <div className="mt-3 h-10 animate-pulse rounded bg-fg/[0.06]" aria-busy />
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <p className="break-words text-base text-fg">{detail.summary || `(${detail.op}: no text left to show)`}</p>
          <p className="text-sm text-fg-muted">
            {detail.op} {detail.recordType}, {fmt(detail.at)}, in {scopeLabel(detail.scopePath)}
          </p>
          <p className="break-all font-mono text-xs text-fg-subtle">
            {detail.recordType} {detail.recordId}
          </p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-1.5">
            <dt className="text-fg-subtle">Written by</dt>
            <dd className="mb-2 break-words text-fg sm:mb-0">{writerText(detail)}</dd>
            <dt className="text-fg-subtle">Source</dt>
            <dd className="mb-2 break-words text-fg sm:mb-0">
              {detail.source ? (
                <Link
                  href={`/integrations#source-${encodeURIComponent(detail.source.id)}`}
                  className="text-info underline-offset-2 hover:underline"
                >
                  {displayWriterLabel(detail.source.name)} ({detail.source.type})
                </Link>
              ) : (
                "Written directly, not by a connected source"
              )}
            </dd>
            <dt className="text-fg-subtle">Replaced</dt>
            <dd className="break-words text-fg">
              <Replacement detail={detail} scope={scope} />
            </dd>
          </dl>
          <p className="text-sm text-fg-subtle">
            <Link href={changeHref(changeId, scope)} className="text-info underline-offset-2 hover:underline">
              Link to this change
            </Link>{" "}
            opens this same answer for anyone with access to this scope.
          </p>
        </div>
      )}
      <div className="mt-4 border-t border-divider pt-3">
        <h4 className={`mb-2 ${EYEBROW}`}>Read by</h4>
        {readers.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {readers.map((s) => (
              <li key={s.laneKey} className="flex justify-between gap-4 text-sm">
                <span className="text-fg-muted">{laneName.get(s.laneKey) ?? s.laneKey}</span>
                <span className="font-mono text-fg-subtle">{formatDuration(s.latencyMs)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-subtle">
            {timeline && !inWindow
              ? "This change is outside the window on screen; pick a window that holds it to see who read it."
              : "No later eligible read appears in this window."}
          </p>
        )}
      </div>
    </section>
  );
}

/** "Research Agent, acting for Jane Doe": the writer and, for an agent or a sync, the
 * person it wrote for. */
function writerText(detail: ChangeDetail): string {
  const writer = displayWriterLabel(detail.writer);
  return detail.actingFor ? `${writer}, acting for ${displayWriterLabel(detail.actingFor)}` : writer;
}

/** What this version replaced, and what replaced it, each linked to the change that wrote
 * it when that change is readable here, as GET /api/memory/versions/:id reports it. */
function Replacement({ detail, scope }: { detail: ChangeDetail; scope: string | null }) {
  if (detail.replaces.length === 0 && !detail.replacedBy) {
    if (detail.op === "supersede") return <>Replaced; the replacing version is not recorded</>;
    if (detail.op === "delete") return <>Removed, not replaced</>;
    return <>Nothing</>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {detail.replaces.map((version) => (
        <li key={`replaces-${version.id}`}>
          Replaces <VersionName version={version} scope={scope} />
        </li>
      ))}
      {detail.replacedBy && (
        <li>
          Replaced by <VersionName version={detail.replacedBy} scope={scope} />
        </li>
      )}
    </ul>
  );
}

/** A version by its text, linked to the change that wrote it; by id alone when that change
 * is not readable in this scope. */
function VersionName({ version, scope }: { version: VersionLink; scope: string | null }) {
  if (!version.change) return <span className="break-all font-mono text-xs">{version.id}</span>;
  return (
    <Link href={changeHref(version.change.id, scope)} className="text-info underline-offset-2 hover:underline">
      &ldquo;{version.change.summary || version.id}&rdquo;
    </Link>
  );
}

/** Advance the playhead across `domain` in {@link REPLAY_MS} while `playing`,
 * from wherever it stood when play was pressed. */
function useReplay(
  playing: boolean,
  domain: [number, number] | null,
  playhead: number | null,
  setPlayhead: (value: number) => void,
  onEnd: () => void,
) {
  const latest = useRef({ playhead, onEnd });
  useEffect(() => {
    latest.current = { playhead, onEnd };
  });
  const start = domain?.[0];
  const end = domain?.[1];
  useEffect(() => {
    if (!playing || start === undefined || end === undefined) return;
    let position = latest.current.playhead ?? start;
    let last = performance.now();
    let frame = 0;
    const step = (now: number) => {
      position = Math.min(position + ((now - last) / REPLAY_MS) * (end - start), end);
      last = now;
      setPlayhead(position);
      if (position >= end) latest.current.onEnd();
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, start, end, setPlayhead]);
}
