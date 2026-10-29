"use client";

// The audit Timeline's drawing: one lane per actor, writes as dots on the
// writer's lane, each reader's first sight as a dot on its lane joined back to
// the write, denied reads as red ticks. Plain SVG, no chart library: the marks
// are few and bespoke, and every one of them has to be clickable and labelled.
//
// Draws only what services/audit/timeline.ts derived; it computes no edges.
import { useEffect, useMemo, useRef, useState } from "react";
import type { LatencySummary, Timeline, TimelineWrite } from "@/services/audit/timeline";
import { WRITER_SLOT_CHARS, displayWriterLabel, formatDuration, scopeLabel, truncateWriterLabel } from "./format";

/** Scope band colours, in order of first appearance. Brick is left out: it means denied. */
const SCOPE_COLORS = [
  "var(--color-info)",
  "var(--color-accent)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];
const DENIED = "var(--color-danger)";
const COMPACT_BELOW_PX = 640;
const AXIS_H = 28;

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round, evenly spaced tick times inside [start, end]. */
function timeTicks(start: number, end: number, count: number): number[] {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
  const step = steps.find((s) => (end - start) / s <= count) ?? 86400e3 * Math.ceil((end - start) / (count * 86400e3));
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  return ticks;
}

function tickLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  return spanMs > 2 * 86400e3
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function TimelineChart({
  timeline,
  domain,
  playhead,
  selectedWriteId,
  onSelectWrite,
}: {
  timeline: Timeline;
  /** Visible time range, epoch ms. */
  domain: [number, number];
  /** Replay position: marks after it are faded. Null shows everything. */
  playhead: number | null;
  selectedWriteId: string | null;
  onSelectWrite: (id: string) => void;
}) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const width = measured || 960;
  const compact = width < COMPACT_BELOW_PX;
  const labelW = compact ? 0 : 168;
  const laneH = compact ? 56 : 46;
  const plotW = Math.max(width - labelW - 12, 40);
  const [d0, d1] = domain;
  const height = AXIS_H + timeline.lanes.length * laneH + 8;

  const x = (t: number) => labelW + ((t - d0) / (d1 - d0)) * plotW;
  const laneIndex = useMemo(() => new Map(timeline.lanes.map((l, i) => [l.key, i])), [timeline.lanes]);
  const y = (key: string) => AXIS_H + laneIndex.get(key)! * laneH + (compact ? laneH - 18 : laneH / 2);
  const scopeColor = useScopeColors(timeline);
  const writesById = useMemo(() => new Map(timeline.writes.map((w) => [w.id, w])), [timeline.writes]);
  const faded = (iso: string) => playhead !== null && Date.parse(iso) > playhead;
  const selected = selectedWriteId ? writesById.get(selectedWriteId) : undefined;

  return (
    <div ref={ref} className="w-full min-w-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        height={height}
        role="group"
        aria-label={`Timeline of ${timeline.writes.length} writes across ${timeline.lanes.length} lanes`}
        className="block w-full select-none"
      >
        <defs>
          <clipPath id="timeline-plot">
            <rect x={labelW} y={0} width={plotW} height={height} />
          </clipPath>
        </defs>

        {timeTicks(d0, d1, compact ? 3 : 6).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={AXIS_H - 6} y2={height} stroke="currentColor" strokeOpacity={0.07} />
            <text
              x={x(t)}
              y={AXIS_H - 12}
              textAnchor={x(t) > labelW + plotW - 30 ? "end" : x(t) < labelW + 30 ? "start" : "middle"}
              fontSize={11}
              fill="currentColor"
              fillOpacity={0.75}
            >
              {tickLabel(t, d1 - d0)}
            </text>
          </g>
        ))}

        {timeline.lanes.map((lane, i) => {
          const top = AXIS_H + i * laneH;
          const color = lane.scopePath ? scopeColor(lane.scopePath) : "currentColor";
          return (
            <g key={lane.key}>
              <rect x={labelW} y={top + 3} width={plotW} height={laneH - 6} rx={6} fill={color} fillOpacity={0.05} />
              <rect x={labelW} y={top + 3} width={3} height={laneH - 6} rx={1.5} fill={color} fillOpacity={0.7} />
              <line
                x1={labelW}
                x2={labelW + plotW}
                y1={y(lane.key)}
                y2={y(lane.key)}
                stroke="currentColor"
                strokeOpacity={0.12}
              />
              <g>
                <title>{`${displayWriterLabel(lane.name)} (${lane.actorType})${lane.scopePath ? ` · ${scopeLabel(lane.scopePath)}` : ""}`}</title>
                <text
                  x={compact ? labelW + 10 : labelW - 12}
                  y={compact ? top + 17 : y(lane.key) + 4}
                  textAnchor={compact ? "start" : "end"}
                  fontSize={12}
                  fill="currentColor"
                  fillOpacity={0.75}
                >
                  {truncateWriterLabel(
                    lane.name,
                    compact ? WRITER_SLOT_CHARS.timelineLaneCompact : WRITER_SLOT_CHARS.timelineLane,
                  )}
                </text>
              </g>
            </g>
          );
        })}

        <g clipPath="url(#timeline-plot)">
          {selected && timeline.latency && (
            <ExpectedBand write={selected} latency={timeline.latency} x={x} top={AXIS_H} bottom={height - 8} />
          )}

          {timeline.sightings.map((s) => {
            const w = writesById.get(s.writeId)!;
            const x1 = x(Date.parse(w.at));
            const y1 = y(w.laneKey);
            const x2 = x(Date.parse(s.at));
            const y2 = y(s.laneKey);
            const dim = selectedWriteId !== null && selectedWriteId !== s.writeId;
            return (
              <g key={`${s.writeId}-${s.laneKey}`} opacity={faded(s.at) ? 0.12 : dim ? 0.25 : 1}>
                <path
                  d={`M${x1},${y1} C${x1 + Math.max(12, (x2 - x1) / 2)},${y1} ${x2 - Math.max(12, (x2 - x1) / 2)},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke="var(--color-info)"
                  strokeOpacity={0.55}
                  strokeWidth={1.25}
                />
                <circle cx={x2} cy={y2} r={4} fill="none" stroke="var(--color-accent)" strokeWidth={2}>
                  <title>{`Next eligible read after ${formatDuration(s.latencyMs)}`}</title>
                </circle>
              </g>
            );
          })}

          {timeline.denials.map((d) => (
            <line
              key={d.id}
              x1={x(Date.parse(d.at))}
              x2={x(Date.parse(d.at))}
              y1={y(d.laneKey) - 8}
              y2={y(d.laneKey) + 8}
              stroke={DENIED}
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={faded(d.at) ? 0.12 : 1}
            >
              <title>{`Denied ${d.action === "memory.entity" ? "entity read" : "read"}${d.scopePath ? ` of ${scopeLabel(d.scopePath)}` : ""}`}</title>
            </line>
          ))}

          {timeline.writes.map((w) => (
            <circle
              key={w.id}
              cx={x(Date.parse(w.at))}
              cy={y(w.laneKey)}
              r={selectedWriteId === w.id ? 7 : 5.5}
              fill={scopeColor(w.scopePath)}
              stroke={selectedWriteId === w.id ? "currentColor" : "none"}
              strokeWidth={2}
              opacity={faded(w.at) ? 0.15 : 1}
              tabIndex={0}
              role="button"
              aria-label={`Inspect ${w.op} ${w.recordType} ${w.recordId} by ${displayWriterLabel(timeline.lanes[laneIndex.get(w.laneKey)!]!.name)} at ${new Date(w.at).toLocaleString()}`}
              aria-pressed={selectedWriteId === w.id}
              className="cursor-pointer"
              onClick={() => onSelectWrite(w.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectWrite(w.id);
                }
              }}
            />
          ))}

          {playhead !== null && (
            <line
              x1={x(playhead)}
              x2={x(playhead)}
              y1={AXIS_H - 6}
              y2={height}
              stroke="currentColor"
              strokeOpacity={0.6}
              strokeDasharray="3 3"
            />
          )}
        </g>
      </svg>
    </div>
  );
}

/** Where readers are expected to see the selected write: median to p95 after it. */
function ExpectedBand({
  write,
  latency,
  x,
  top,
  bottom,
}: {
  write: TimelineWrite;
  latency: LatencySummary;
  x: (t: number) => number;
  top: number;
  bottom: number;
}) {
  const at = Date.parse(write.at);
  const left = x(at + latency.medianMs);
  const right = x(at + latency.p95Ms);
  return (
    <rect
      x={left}
      y={top}
      width={Math.max(right - left, 2)}
      height={bottom - top}
      fill="var(--color-info)"
      fillOpacity={0.1}
    >
      <title>{`Window median to p95 read delay: ${formatDuration(latency.medianMs)} to ${formatDuration(latency.p95Ms)}`}</title>
    </rect>
  );
}

/** Every measured latency as a tick on one axis, with the median-to-p95 band shaded. */
export function LatencyStrip({ timeline }: { timeline: Timeline }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const width = measured || 960;
  const { latency, sightings } = timeline;
  if (latency === null) {
    return (
      <p className="text-sm text-fg-subtle">
        No eligible read to measure yet: no other agent read a covering scope after a write in this window.
      </p>
    );
  }
  const max = Math.max(1, ...sightings.map((s) => s.latencyMs), latency.p95Ms) * 1.1;
  const pad = 12;
  const x = (ms: number) => pad + (ms / max) * (width - 2 * pad);
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg
        viewBox={`0 0 ${width} 54`}
        height={54}
        className="block w-full"
        role="img"
        aria-label={`Read delay: median ${formatDuration(latency.medianMs)}, p95 ${formatDuration(latency.p95Ms)}`}
      >
        <rect
          x={x(latency.medianMs)}
          y={6}
          width={Math.max(x(latency.p95Ms) - x(latency.medianMs), 2)}
          height={24}
          fill="var(--color-info)"
          fillOpacity={0.14}
        />
        <line x1={pad} x2={width - pad} y1={30} y2={30} stroke="currentColor" strokeOpacity={0.2} />
        {sightings.map((s) => (
          <line
            key={`${s.writeId}-${s.laneKey}`}
            x1={x(s.latencyMs)}
            x2={x(s.latencyMs)}
            y1={12}
            y2={30}
            stroke="var(--color-accent)"
            strokeOpacity={0.7}
            strokeWidth={1.5}
          />
        ))}
        <line
          x1={x(latency.medianMs)}
          x2={x(latency.medianMs)}
          y1={4}
          y2={32}
          stroke="var(--color-info)"
          strokeWidth={2}
        />
        <text x={pad} y={48} fontSize={11} fill="currentColor" fillOpacity={0.75}>
          0
        </text>
        <text x={width - pad} y={48} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.75}>
          {formatDuration(max)}
        </text>
      </svg>
    </div>
  );
}

function useScopeColors(timeline: Timeline): (scopePath: string) => string {
  return useMemo(() => {
    const order = new Map<string, string>();
    const assign = (path: string | null) => {
      if (path !== null && !order.has(path)) order.set(path, SCOPE_COLORS[order.size % SCOPE_COLORS.length]!);
    };
    timeline.writes.forEach((w) => assign(w.scopePath));
    timeline.lanes.forEach((l) => assign(l.scopePath));
    return (path: string) => order.get(path) ?? SCOPE_COLORS[0]!;
  }, [timeline]);
}

/** The scopes on screen with their band colours, for the legend. */
export function useScopeLegend(timeline: Timeline): { path: string; color: string }[] {
  const color = useScopeColors(timeline);
  return useMemo(() => {
    const paths = new Set<string>();
    timeline.writes.forEach((w) => paths.add(w.scopePath));
    timeline.lanes.forEach((l) => l.scopePath && paths.add(l.scopePath));
    return [...paths].map((path) => ({ path, color: color(path) }));
  }, [timeline, color]);
}
