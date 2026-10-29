"use client";

// Hand-rolled SVG chart renderer for the agent Brief surface.
//
// Consumes the FROZEN `ChartSpec` discriminated union (types/agent-run.ts) and
// renders each kind to pure SVG — NO chart library, NO server-side image render
// (honors docs/design_doc_chart_generation.md §A.2 + 07_contradiction_demo). It is
// purely presentational: given a spec it draws; it fetches nothing.
//
// Brand law (claude/design.md §1,§3,§A.3): calm and flat — no gradients on data,
// hairline gridlines, GOLD is a signal not a fill (it marks the one value/point that
// matters, ordinary series stay on the neutral metadata role), danger is never
// "paint it red". Text uses the text roles, so labels hold AA in both themes.
// Accessibility: role="img" + <title>/<desc>, a visually-hidden data table built
// from the same numbers, direct value labels on marks, axis + unit labels, and a
// legend where a chart carries more than one measure. Colour never carries meaning
// alone.

import type { AccentToken, ChartSpec, ChartSeriesPoint } from "@/types/agent-run";

// design.md tokens → the CSS vars declared in app/globals.css @theme. Never raw hex.
const accentVar = (token: AccentToken): string => `var(--color-${token})`;

// Ordinary (non-signal) series colour: the metadata role, so gold/ember read as the
// accent. Gridlines are the hairline; axis labels are metadata and values supporting
// text. The downloaded brief file defines the same custom properties (brief-document).
const NEUTRAL = "color-mix(in srgb, var(--color-fg-subtle) 60%, transparent)";
const NEUTRAL_STRONG = "var(--color-fg-subtle)";
const GRID = "var(--color-divider)";
const AXIS_TEXT = "var(--color-fg-subtle)";
const VALUE_TEXT = "var(--color-fg-muted)";

// Palette for grouped measures: first measure neutral, later measures step through the
// brand accents (ember → gold → brick). Keeps a single, calm system across charts.
const MEASURE_COLORS = [NEUTRAL_STRONG, "var(--color-ember)", "var(--color-gold)", "var(--color-brick)"];
const measureColor = (i: number) => MEASURE_COLORS[i % MEASURE_COLORS.length];

const FONT_MONO = "var(--font-mono, monospace)";

/** Round a max up to a calm axis bound so gridlines land on readable numbers. */
function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 1 ? 2 : 1);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// A visually-hidden table carrying the honest numbers (screen-reader + a11y path).
// The wrapper carries sr-only, not the table: a table never shrinks below its
// content, so an sr-only table still widened the page on a phone.
function DataTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <figure className="rounded-2xl border border-divider px-6 py-8">
      <figcaption className="text-lg font-semibold text-fg">{title}</figcaption>
      <p className="mt-2 text-sm text-fg-subtle">No data to chart yet.</p>
    </figure>
  );
}

// Shared frame: title (Fraunces), the SVG, and the hidden data table.
function ChartFrame({
  title,
  ariaLabel,
  children,
  table,
}: {
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
  table: React.ReactNode;
}) {
  return (
    <figure className="rounded-2xl border border-divider px-5 py-4">
      <figcaption className="mb-3 text-lg font-semibold text-fg">{title}</figcaption>
      <div role="img" aria-label={ariaLabel}>
        {children}
      </div>
      {table}
    </figure>
  );
}

// ── bar / histogram ─────────────────────────────────────────────────────────
// Neutral bars; the single largest value is highlighted with the accent (default
// gold) — gold as signal, not fill. Supports vertical (default) + horizontal.
function BarChart({ spec }: { spec: Extract<ChartSpec, { kind: "bar" | "histogram" }> }) {
  const series = spec.series ?? [];
  if (series.length === 0) return <EmptyState title={spec.title} />;

  const unit = spec.unit ? ` (${spec.unit})` : "";
  const accent = accentVar(spec.accent ?? "gold");
  const max = Math.max(...series.map((s) => s.value), 0);
  const bound = niceMax(max);
  const maxIdx = series.reduce((best, s, i) => (s.value > series[best].value ? i : best), 0);
  const horizontal = spec.orientation === "horizontal";

  const W = 640;
  const H = 320;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => bound * t);

  const table = (
    <DataTable
      caption={`${spec.title}${unit}`}
      columns={["Category", spec.unit ?? "Value"]}
      rows={series.map((s) => [s.label, fmt(s.value)])}
    />
  );

  if (horizontal) {
    const padL = 120;
    const padR = 48;
    const padT = 8;
    const padB = 24;
    const plotW = W - padL - padR;
    const rowH = (H - padT - padB) / series.length;
    const barH = Math.min(28, rowH * 0.6);
    return (
      <ChartFrame title={spec.title} ariaLabel={`Bar chart: ${spec.title}${unit}`} table={table}>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
          <title>{spec.title}</title>
          <desc>{series.map((s) => `${s.label}: ${fmt(s.value)}`).join("; ")}</desc>
          {ticks.map((t, i) => {
            const x = padL + (t / bound) * plotW;
            return (
              <g key={i}>
                <line x1={x} y1={padT} x2={x} y2={H - padB} stroke={GRID} strokeWidth={1} />
                <text x={x} y={H - padB + 16} textAnchor="middle" fontSize={10} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
                  {fmt(t)}
                </text>
              </g>
            );
          })}
          {series.map((s, i) => {
            const y = padT + i * rowH + (rowH - barH) / 2;
            const w = bound > 0 ? (s.value / bound) * plotW : 0;
            const isSignal = i === maxIdx && series.length > 1;
            return (
              <g key={i}>
                <text x={padL - 10} y={y + barH / 2 + 4} textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
                  {truncate(s.label, 18)}
                </text>
                <rect x={padL} y={y} width={Math.max(w, 0)} height={barH} rx={2} fill={isSignal ? accent : NEUTRAL} />
                <text
                  x={padL + Math.max(w, 0) + 6}
                  y={y + barH / 2 + 4}
                  fontSize={11}
                  fontFamily={FONT_MONO}
                  fill={VALUE_TEXT}
                >
                  {fmt(s.value)}
                </text>
              </g>
            );
          })}
        </svg>
      </ChartFrame>
    );
  }

  // vertical
  const padL = 48;
  const padR = 16;
  const padT = 12;
  const padB = 56;
  const plotH = H - padT - padB;
  const plotW = W - padL - padR;
  const slot = plotW / series.length;
  const barW = Math.min(56, slot * 0.62);

  return (
    <ChartFrame title={spec.title} ariaLabel={`Bar chart: ${spec.title}${unit}`} table={table}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
        <title>{spec.title}</title>
        <desc>{series.map((s) => `${s.label}: ${fmt(s.value)}`).join("; ")}</desc>
        {ticks.map((t, i) => {
          const y = padT + plotH - (t / bound) * plotH;
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
                {fmt(t)}
              </text>
            </g>
          );
        })}
        {series.map((s, i) => {
          const h = bound > 0 ? (s.value / bound) * plotH : 0;
          const x = padL + i * slot + (slot - barW) / 2;
          const y = padT + plotH - h;
          const isSignal = i === maxIdx && series.length > 1;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={Math.max(h, 0)} rx={2} fill={isSignal ? accent : NEUTRAL} />
              <text
                x={x + barW / 2}
                y={y - 5}
                textAnchor="middle"
                fontSize={11}
                fontFamily={FONT_MONO}
                fill={VALUE_TEXT}
              >
                {fmt(s.value)}
              </text>
              <text x={x + barW / 2} y={H - padB + 16} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                {truncate(s.label, 12)}
              </text>
            </g>
          );
        })}
        {spec.unit && (
          <text x={padL} y={H - 8} fontSize={10} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
            {spec.unit}
          </text>
        )}
      </svg>
    </ChartFrame>
  );
}

// ── grouped bar ───────────────────────────────────────────────────────────
// e.g. QA latency p50 vs max per endpoint. One cluster per category, one bar per
// measure, a legend keyed to `measures`.
function GroupedBar({ spec }: { spec: Extract<ChartSpec, { kind: "grouped-bar" }> }) {
  const series = spec.series ?? [];
  const measures = spec.measures ?? [];
  if (series.length === 0 || measures.length === 0) return <EmptyState title={spec.title} />;

  const unit = spec.unit ? ` (${spec.unit})` : "";
  const valueOf = (p: ChartSeriesPoint, m: string) => p.measures?.[m] ?? 0;
  const max = Math.max(...series.flatMap((p) => measures.map((m) => valueOf(p, m))), 0);
  const bound = niceMax(max);

  const W = 640;
  const H = 340;
  const padL = 48;
  const padR = 16;
  const padT = 12;
  const padB = 56;
  const plotH = H - padT - padB;
  const plotW = W - padL - padR;
  const slot = plotW / series.length;
  const groupW = Math.min(slot * 0.7, measures.length * 26);
  const barW = groupW / measures.length;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => bound * t);

  return (
    <ChartFrame
      title={spec.title}
      ariaLabel={`Grouped bar chart: ${spec.title}${unit}`}
      table={
        <DataTable
          caption={`${spec.title}${unit}`}
          columns={["Category", ...measures]}
          rows={series.map((p) => [p.label, ...measures.map((m) => fmt(valueOf(p, m)))])}
        />
      }
    >
      {/* legend */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
        {measures.map((m, i) => (
          <span key={m} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: measureColor(i) }} />
            {m}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
        <title>{spec.title}</title>
        <desc>
          {series.map((p) => `${p.label}: ${measures.map((m) => `${m} ${fmt(valueOf(p, m))}`).join(", ")}`).join("; ")}
        </desc>
        {ticks.map((t, i) => {
          const y = padT + plotH - (t / bound) * plotH;
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
                {fmt(t)}
              </text>
            </g>
          );
        })}
        {series.map((p, gi) => {
          const gx = padL + gi * slot + (slot - groupW) / 2;
          return (
            <g key={gi}>
              {measures.map((m, mi) => {
                const v = valueOf(p, m);
                const h = bound > 0 ? (v / bound) * plotH : 0;
                const x = gx + mi * barW;
                const y = padT + plotH - h;
                return (
                  <g key={m}>
                    <rect
                      x={x + 1}
                      y={y}
                      width={Math.max(barW - 2, 1)}
                      height={Math.max(h, 0)}
                      rx={1.5}
                      fill={measureColor(mi)}
                    />
                    <text
                      x={x + barW / 2}
                      y={y - 4}
                      textAnchor="middle"
                      fontSize={9}
                      fontFamily={FONT_MONO}
                      fill={VALUE_TEXT}
                    >
                      {fmt(v)}
                    </text>
                  </g>
                );
              })}
              <text x={gx + groupW / 2} y={H - padB + 16} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                {truncate(p.label, 14)}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

// ── timeline ────────────────────────────────────────────────────────────────
// Architecture milestones as an evenly-spaced horizontal rail of nodes.
function Timeline({ spec }: { spec: Extract<ChartSpec, { kind: "timeline" }> }) {
  const items = spec.items ?? [];
  if (items.length === 0) return <EmptyState title={spec.title} />;

  const W = 640;
  const H = 160;
  const padX = 48;
  const railY = H / 2;
  const step = items.length > 1 ? (W - 2 * padX) / (items.length - 1) : 0;

  return (
    <ChartFrame
      title={spec.title}
      ariaLabel={`Timeline: ${spec.title}`}
      table={
        <DataTable
          caption={spec.title}
          columns={["Milestone", "Date"]}
          rows={items.map((it) => [it.label, it.date ?? "—"])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
        <title>{spec.title}</title>
        <desc>{items.map((it) => `${it.label}${it.date ? ` (${it.date})` : ""}`).join(" → ")}</desc>
        <line
          x1={padX}
          y1={railY}
          x2={items.length > 1 ? padX + step * (items.length - 1) : padX}
          y2={railY}
          stroke={GRID}
          strokeWidth={2}
        />
        {items.map((it, i) => {
          const x = padX + i * step;
          const above = i % 2 === 0;
          const labelY = above ? railY - 18 : railY + 30;
          const dateY = above ? railY - 32 : railY + 44;
          return (
            <g key={i}>
              <circle cx={x} cy={railY} r={5} fill="var(--color-gold)" />
              <circle
                cx={x}
                cy={railY}
                r={9}
                fill="none"
                stroke="var(--color-gold)"
                strokeOpacity={0.25}
                strokeWidth={2}
              />
              <text x={x} y={labelY} textAnchor="middle" fontSize={11} fill={VALUE_TEXT}>
                {truncate(it.label, 18)}
              </text>
              {it.date && (
                <text x={x} y={dateY} textAnchor="middle" fontSize={9} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
                  {it.date}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

// ── funnel ────────────────────────────────────────────────────────────────
// Governance dispute funnel (open → under review → resolved). Centred bars whose
// width tracks each stage's value; neutral fills, value + label per stage.
function Funnel({ spec }: { spec: Extract<ChartSpec, { kind: "funnel" }> }) {
  const stages = spec.stages ?? [];
  if (stages.length === 0) return <EmptyState title={spec.title} />;

  const W = 640;
  const rowH = 56;
  const H = stages.length * rowH + 16;
  const max = Math.max(...stages.map((s) => s.value), 0);
  const bound = max > 0 ? max : 1;
  const maxBarW = W * 0.62;
  const cx = W / 2;

  return (
    <ChartFrame
      title={spec.title}
      ariaLabel={`Funnel: ${spec.title}`}
      table={
        <DataTable
          caption={spec.title}
          columns={["Stage", "Value"]}
          rows={stages.map((s) => [s.label, fmt(s.value)])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
        <title>{spec.title}</title>
        <desc>{stages.map((s) => `${s.label}: ${fmt(s.value)}`).join(" → ")}</desc>
        {stages.map((s, i) => {
          const w = (s.value / bound) * maxBarW;
          const y = 8 + i * rowH;
          const barH = rowH - 16;
          // Opacity steps down through the funnel so narrowing reads even in greyscale.
          // The fill stays light enough that the main-text label on it holds AA.
          const opacity = 0.34 - (i / Math.max(stages.length, 1)) * 0.2;
          return (
            <g key={i}>
              <rect
                x={cx - w / 2}
                y={y}
                width={Math.max(w, 2)}
                height={barH}
                rx={3}
                fill="var(--color-fg-subtle)"
                fillOpacity={opacity}
              />
              <text
                x={cx}
                y={y + barH / 2 - 2}
                textAnchor="middle"
                fontSize={12}
                fill="var(--color-fg)"
                fontWeight={600}
              >
                {truncate(s.label, 24)}
              </text>
              <text
                x={cx}
                y={y + barH / 2 + 13}
                textAnchor="middle"
                fontSize={11}
                fontFamily={FONT_MONO}
                fill="var(--color-fg)"
              >
                {fmt(s.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

// ── matrix ────────────────────────────────────────────────────────────────
// Decision / risk matrix — impact×effort or severity×likelihood. Points are the
// agent's PROPOSED placement to argue with (design_doc §E); the accent (gold)
// marks the recommended option. Coordinates normalised defensively.
function Matrix({ spec }: { spec: Extract<ChartSpec, { kind: "matrix" }> }) {
  const points = spec.points ?? [];
  if (points.length === 0) return <EmptyState title={spec.title} />;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const norm = (v: number, arr: number[]) => {
    const lo = Math.min(...arr, 0);
    const hi = Math.max(...arr, 1);
    if (hi === lo) return 0.5;
    // If already within a 0..1 domain, keep it; otherwise rescale into 0..1.
    if (lo >= 0 && hi <= 1) return v;
    return (v - lo) / (hi - lo);
  };

  const W = 460;
  const H = 420;
  const padL = 64;
  const padR = 24;
  const padT = 20;
  const padB = 64;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  return (
    <ChartFrame
      title={spec.title}
      ariaLabel={`Matrix: ${spec.title}. X axis ${spec.xAxis.label}, Y axis ${spec.yAxis.label}`}
      table={
        <DataTable
          caption={`${spec.title} — ${spec.xAxis.label} vs ${spec.yAxis.label}`}
          columns={["Option", spec.xAxis.label, spec.yAxis.label]}
          rows={points.map((p) => [p.label, fmt(p.x), fmt(p.y)])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
        <title>{spec.title}</title>
        <desc>
          {points
            .map(
              (p) =>
                `${p.label} at ${spec.xAxis.label} ${fmt(p.x)}, ${spec.yAxis.label} ${fmt(p.y)}${p.accent ? " (recommended)" : ""}`,
            )
            .join("; ")}
        </desc>
        {/* frame + quadrant split */}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="none" stroke={GRID} strokeWidth={1} />
        <line x1={padL + plotW / 2} y1={padT} x2={padL + plotW / 2} y2={padT + plotH} stroke={GRID} strokeWidth={1} />
        <line x1={padL} y1={padT + plotH / 2} x2={padL + plotW} y2={padT + plotH / 2} stroke={GRID} strokeWidth={1} />

        {/* axis labels */}
        <text x={padL + plotW / 2} y={H - 26} textAnchor="middle" fontSize={12} fill={VALUE_TEXT}>
          {spec.xAxis.label} →
        </text>
        <text x={padL} y={H - 8} textAnchor="start" fontSize={9} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
          {spec.xAxis.low}
        </text>
        <text x={padL + plotW} y={H - 8} textAnchor="end" fontSize={9} fontFamily={FONT_MONO} fill={AXIS_TEXT}>
          {spec.xAxis.high}
        </text>
        <text
          transform={`translate(18 ${padT + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize={12}
          fill={VALUE_TEXT}
        >
          {spec.yAxis.label} →
        </text>
        <text
          transform={`translate(34 ${padT + plotH}) rotate(-90)`}
          textAnchor="start"
          fontSize={9}
          fontFamily={FONT_MONO}
          fill={AXIS_TEXT}
        >
          {spec.yAxis.low}
        </text>
        <text
          transform={`translate(34 ${padT}) rotate(-90)`}
          textAnchor="end"
          fontSize={9}
          fontFamily={FONT_MONO}
          fill={AXIS_TEXT}
        >
          {spec.yAxis.high}
        </text>

        {points.map((p, i) => {
          const nx = norm(p.x, xs);
          const ny = norm(p.y, ys);
          const px = padL + nx * plotW;
          const py = padT + (1 - ny) * plotH; // y high = top
          const color = p.accent ? accentVar(p.accent) : NEUTRAL_STRONG;
          const recommended = !!p.accent;
          return (
            <g key={i}>
              {recommended && (
                <circle cx={px} cy={py} r={11} fill="none" stroke={color} strokeOpacity={0.3} strokeWidth={3} />
              )}
              <circle cx={px} cy={py} r={recommended ? 7 : 5.5} fill={color} />
              <text x={px + 10} y={py + 4} fontSize={11} fill={VALUE_TEXT}>
                {truncate(p.label, 16)}
                {recommended ? " ★" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

/**
 * Render a single ChartSpec as hand-rolled, accessible SVG. Pure presentational —
 * pass a fully-formed spec (e.g. from `Brief.charts[]`); it draws, nothing else.
 */
export default function ChartBlock({ spec }: { spec: ChartSpec }) {
  switch (spec.kind) {
    case "bar":
    case "histogram":
      return <BarChart spec={spec} />;
    case "grouped-bar":
      return <GroupedBar spec={spec} />;
    case "timeline":
      return <Timeline spec={spec} />;
    case "funnel":
      return <Funnel spec={spec} />;
    case "matrix":
      return <Matrix spec={spec} />;
    default: {
      // Exhaustiveness guard — a new ChartSpec kind trips the compiler here.
      const _never: never = spec;
      return _never ?? null;
    }
  }
}
