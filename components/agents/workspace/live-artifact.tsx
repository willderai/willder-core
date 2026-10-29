"use client";

// LiveArtifact — the decision surface, rendered AS IT BUILDS (design_agent_workspace
// _ux.md §4). It folds the cumulative PartialBrief (from `artifact` events) plus the
// per-step BriefFragments (from `step_completed`) into a progressively-rendered brief:
// header → summary → contradictions → decisions → charts → QA findings → sections →
// milestones → diagram. On `done` it renders the persisted Brief instead. Blocks not
// yet arrived show a labelled hairline skeleton so the artifact's shape stays stable.
//
// Charts/tables are OWNED BY OTHER AGENTS — imported, not built here:
//   ChartBlock   default export, prop `spec: ChartSpec`   → renders one chart to SVG
//   DecisionTable named export, prop `decision: DecisionFragment` → options + recommendation
// These paths may not resolve at typecheck time yet; that is expected.

import Link from "next/link";
import ChartBlock from "@/components/charts/chart-block";
import { DecisionTable } from "@/components/agents/decision-table";
import { Markdown } from "@/components/markdown";
import { BLOCK_TITLE, BUTTON_SECONDARY, EYEBROW_ON_PAGE, SUB_PANEL } from "@/components/agents/agent-ui";
import type {
  AgentRole,
  Brief,
  BriefFragment,
  ChartSpec,
  Contradiction,
  DecisionFragment,
  Milestone,
  PartialBrief,
} from "@/types/agent-run";

function formatDue(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-divider p-4">
      <p className={EYEBROW_ON_PAGE}>{label}</p>
      <div className="mt-3 space-y-2">
        <div className="h-3 w-3/4 rounded-full bg-fg/[0.06]" />
        <div className="h-3 w-1/2 rounded-full bg-fg/[0.06]" />
      </div>
    </div>
  );
}

const SEVERITY_LABEL: Record<"blocker" | "major" | "minor", string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
};

// Progressive disclosure — a native <details>. Keeps verbose
// secondary detail (repro dumps, full perf tables) out of the default scan but one
// click away. Tokens only, no new visual style.
function Disclosure({
  more = "Show details",
  less = "Hide details",
  children,
}: {
  more?: string;
  less?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group mt-3">
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
        <svg
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="group-open:hidden">{more}</span>
        <span className="hidden group-open:inline">{less}</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

// Canonical founder-planning domain order (design_architecture_agent_v2 §1.2/§6). The
// architecture executor sets each section's `heading` to the domain name, so grouping
// "by domain" is achieved by ordering sections along this spine (data → api → backend →
// services → frontend user-flow → decisions → execution). Matched loosely by keyword so
// heading phrasing ("Data model" vs "Data Model") still lands in the right slot. Sections
// whose heading matches no domain keep their original order after the known ones.
const ARCH_DOMAIN_ORDER: string[] = [
  "requirement",
  "user flow",
  "data model",
  "api",
  "backend",
  "service",
  "decision",
  "execution",
];

function archDomainRank(heading: string): number {
  const h = heading.toLowerCase();
  const idx = ARCH_DOMAIN_ORDER.findIndex((d) => h.includes(d));
  return idx === -1 ? ARCH_DOMAIN_ORDER.length : idx;
}

export function LiveArtifact({
  brief,
  fragments,
  finalBrief,
  agentRole,
  scopePath,
  building,
}: {
  brief: PartialBrief;
  fragments: { itemId: string; fragment: BriefFragment }[];
  finalBrief: Brief | null;
  agentRole: AgentRole;
  scopePath?: string;
  /** true while the run is still producing the artifact (drives skeletons). */
  building: boolean;
}) {
  const roleLabel = agentRole === "architecture" ? "Architecture" : "QA";

  // Prefer the persisted Brief once done; else assemble from partial + fragments.
  const title = finalBrief?.title ?? brief.title;
  const summary = finalBrief?.summary ?? brief.summary;
  // Prefer scopeLabel (the human-readable target for a scope-less QA
  // run) once the persisted Brief is in — scopePath itself is always a
  // real authorization scope, org root for a scope-less run, not a label.
  const scope = finalBrief?.scopeLabel ?? finalBrief?.scopePath ?? scopePath;
  const rawSections = finalBrief?.sections ?? brief.sections ?? [];
  // Architecture sections group by domain: order them along the canonical domain spine
  // (§6). Stable sort preserves original order within a domain and for QA (rank is equal
  // for every heading when not architecture, so the QA render path is unchanged).
  const sections =
    agentRole === "architecture"
      ? rawSections
          .map((s, i) => ({ s, i }))
          .sort((a, b) => archDomainRank(a.s.heading) - archDomainRank(b.s.heading) || a.i - b.i)
          .map(({ s }) => s)
      : rawSections;
  const milestones: Milestone[] = finalBrief?.milestones ?? brief.milestones ?? [];
  const diagram = finalBrief?.diagram ?? brief.diagram ?? null;
  const contradictions: Contradiction[] = finalBrief?.contradictions ?? brief.contradictions ?? [];

  const fragmentCharts = fragments
    .map((f) => (f.fragment.as === "chart" ? f.fragment.chart : null))
    .filter((c): c is ChartSpec => c != null);
  const charts: ChartSpec[] = finalBrief?.charts ?? (brief.charts?.length ? brief.charts : fragmentCharts);

  const decisions: DecisionFragment[] =
    finalBrief?.decisions ??
    fragments
      .map((f) => (f.fragment.as === "decision" ? f.fragment : null))
      .filter((d): d is DecisionFragment => d != null);

  const bugs = fragments
    .map((f) => (f.fragment.as === "bug" ? f.fragment : null))
    .filter((b): b is Extract<BriefFragment, { as: "bug" }> => b != null);

  const perf = fragments
    .map((f) => (f.fragment.as === "performance" ? f.fragment : null))
    .filter((p): p is Extract<BriefFragment, { as: "performance" }> => p != null);

  // Verdict at-a-glance (QA only, once finalized): GO reads green, NO-GO reads amber.
  // Derived from the findings themselves (robust) rather than parsing prose: any
  // blocker/major bug ⇒ needs attention; zero bugs ⇒ clear; minor-only stays neutral.
  const verdictTone: "go" | "nogo" | null =
    agentRole === "qa" && !building
      ? bugs.some((b) => b.severity === "blocker" || b.severity === "major")
        ? "nogo"
        : bugs.length === 0
          ? "go"
          : null
      : null;

  const empty =
    !title && !summary && sections.length === 0 && charts.length === 0 && decisions.length === 0 && bugs.length === 0;

  if (empty && building) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={EYEBROW_ON_PAGE}>{roleLabel}</span>
          {scope && <span className="min-w-0 break-all font-mono text-xs text-fg-muted">{scope}</span>}
        </div>
        <Skeleton label="Summary" />
        <Skeleton label="Findings" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={EYEBROW_ON_PAGE}>{roleLabel}</span>
          {scope && <span className="min-w-0 break-all font-mono text-xs text-fg-muted">{scope}</span>}
        </div>
        {title ? (
          <h2 className="mt-2 break-words font-display text-display-sm font-semibold text-fg">{title}</h2>
        ) : (
          <div className="mt-3 h-8 w-2/3 rounded-lg bg-fg/[0.06]" />
        )}
        {/* Once the run has finalized into a persisted Brief, offer the clean,
            shareable, printable read-only view (/briefs/[id]). */}
        {finalBrief?.id && (
          <Link
            href={`/briefs/${finalBrief.id}`}
            target="_blank"
            rel="noreferrer"
            className={`mt-4 ${BUTTON_SECONDARY}`}
          >
            View / share ↗
          </Link>
        )}
      </div>

      {/* Summary — carries the QA verdict; reads green (clear) vs amber (needs attention). */}
      {summary ? (
        <div
          className={`rounded-xl border p-4 ${
            verdictTone === "nogo"
              ? "border-warning/30 bg-warning/[0.06]"
              : verdictTone === "go"
                ? "border-success/30 bg-success/[0.06]"
                : "border-divider bg-fg/[0.03]"
          }`}
        >
          <div className="flex items-center gap-2">
            {verdictTone && (
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${verdictTone === "nogo" ? "bg-warning" : "bg-success"}`}
              />
            )}
            <p className={verdictTone ? "text-sm font-semibold text-fg" : EYEBROW_ON_PAGE}>
              {verdictTone === "nogo"
                ? "Verdict — needs attention"
                : verdictTone === "go"
                  ? "Verdict — clear"
                  : "Summary"}
            </p>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-fg">{summary}</p>
        </div>
      ) : building ? (
        <Skeleton label="Summary" />
      ) : null}

      {/* Contradictions (icon-led, not a red flood) */}
      {contradictions.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4">
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 shrink-0 text-warning"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-sm font-semibold text-fg">Flagged contradictions</p>
          </div>
          <div className="mt-3 divide-y divide-divider">
            {contradictions.map((c, i) => (
              <div key={i} className="py-3 first:pt-0 last:pb-0">
                <div className="grid gap-2 sm:grid-cols-2">
                  <p className="break-words text-sm leading-relaxed text-fg">{c.factA}</p>
                  <p className="break-words text-sm leading-relaxed text-fg sm:border-l sm:border-divider sm:pl-3">
                    {c.factB}
                  </p>
                </div>
                {c.note && <p className="mt-2 break-words text-sm text-fg-muted">{c.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Decisions — options-comparison with the agent's recommendation */}
      {decisions.map((d, i) => (
        <DecisionTable key={`dec-${i}`} decision={d} />
      ))}

      {/* Charts */}
      {charts.map((spec, i) => (
        <ChartBlock key={`chart-${i}`} spec={spec} />
      ))}

      {/* QA bugs — severity is icon+label first (design.md §3 rule 2); severity also
          tints the card edge, and the repro/observed/expected dump collapses. */}
      {bugs.length > 0 && (
        <div className="space-y-4">
          <p className={BLOCK_TITLE}>Findings</p>
          {bugs.map((b, i) => {
            const sev =
              b.severity === "blocker" ? "text-danger" : b.severity === "major" ? "text-warning" : "text-fg-subtle";
            const edge =
              b.severity === "blocker"
                ? "border-danger/35"
                : b.severity === "major"
                  ? "border-warning/35"
                  : "border-divider";
            return (
              <div key={`bug-${i}`} className={`rounded-xl border ${edge} bg-fg/[0.03] p-4`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <svg
                    className={`h-3.5 w-3.5 shrink-0 ${sev}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span
                    className={`text-eyebrow font-semibold uppercase ${b.severity === "minor" ? "text-fg-muted" : "text-fg"}`}
                  >
                    {SEVERITY_LABEL[b.severity]}
                  </span>
                  {(b.priority || b.technique) && (
                    <span className="text-sm text-fg-muted">
                      {b.priority ? `· ${b.priority} priority` : ""}
                      {b.technique ? ` · ${b.technique}` : ""}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-base leading-relaxed text-fg [overflow-wrap:anywhere]">{b.finding}</p>
                <Disclosure>
                  <dl className="space-y-3">
                    {(
                      [
                        ["repro", b.repro],
                        ["observed", b.observed],
                        ["expected", b.expected],
                      ] as const
                    ).map(([k, v]) => (
                      <div key={k}>
                        <dt className={EYEBROW_ON_PAGE}>{k}</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Disclosure>
              </div>
            );
          })}
        </div>
      )}

      {/* QA performance — lead line (endpoints · worst latency · error state) reads
          green/amber at a glance; the full per-endpoint table collapses. */}
      {perf.length > 0 &&
        (() => {
          const worstMax = perf.reduce((m, p) => Math.max(m, p.maxLatencyMs), 0);
          const errCount = perf.filter((p) => p.errorRate > 0).length;
          return (
            <div className={`p-4 ${SUB_PANEL}`}>
              <p className={BLOCK_TITLE}>Performance</p>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm tabular-nums">
                <span className="text-fg">
                  {perf.length} endpoint{perf.length === 1 ? "" : "s"} measured
                </span>
                <span className="text-fg-muted">· worst max {worstMax}ms</span>
                <span className="inline-flex items-center gap-1.5 text-fg-muted">
                  ·{" "}
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${errCount > 0 ? "bg-warning" : "bg-success"}`}
                  />
                  {errCount > 0 ? `${errCount} with errors` : "no errors"}
                </span>
              </div>
              <Disclosure>
                <div className="space-y-3">
                  {perf.map((p, i) => (
                    <div key={`perf-${i}`} className="border-t border-divider pt-3 first:border-0 first:pt-0">
                      <p className="break-all font-mono text-xs text-fg">{p.endpoint}</p>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-xs text-fg-muted">
                        <span>p50 {p.p50LatencyMs}ms</span>
                        <span>max {p.maxLatencyMs}ms</span>
                        <span>{p.samples} samples</span>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 rounded-full ${p.errorRate > 0 ? "bg-warning" : "bg-success"}`}
                          />
                          {(p.errorRate * 100).toFixed(1)}% err
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Disclosure>
            </div>
          );
        })()}

      {/* Sections */}
      {sections.length > 0 && (
        <div className="space-y-4">
          {sections.map((s, i) => (
            <div key={i} className="border-t border-divider pt-4">
              <p className={`break-words ${BLOCK_TITLE}`}>{s.heading}</p>
              <Markdown markdown={s.content} className="mt-2" />
            </div>
          ))}
        </div>
      )}

      {/* Milestones */}
      {milestones.length > 0 && (
        <div className="border-t border-divider pt-4">
          <p className={BLOCK_TITLE}>Milestones</p>
          <ol className="mt-3 space-y-0">
            {milestones.map((m, i) => (
              <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                <div className="flex flex-col items-center">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                  {i < milestones.length - 1 && <span className="mt-1 w-px flex-1 bg-divider" />}
                </div>
                <div className="min-w-0 flex-1 -mt-0.5">
                  <p className="break-words text-sm leading-snug text-fg">{m.label}</p>
                  {m.dueDate && <p className="mt-0.5 font-mono text-xs text-fg-muted">{formatDue(m.dueDate)}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Diagram — verbose source, collapsed by default */}
      {diagram && (
        <div className="border-t border-divider pt-4">
          <p className={BLOCK_TITLE}>Diagram</p>
          <Disclosure more="Show diagram source" less="Hide diagram source">
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-divider bg-fg/[0.04] p-3 font-mono text-xs text-fg-muted">
              {diagram}
            </pre>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
