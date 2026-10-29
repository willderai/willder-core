"use client";

// The chrome-free, read-only render of a Brief plus the three "take it with you"
// affordances (design.md: calm, legible, dark-first, gold-as-signal):
//
//   • Save as PDF   → window.print() (no server render). Print CSS hides app chrome
//                     and forces color so the dark ground + charts survive to PDF.
//   • Copy link     → the /briefs/[id] URL (still auth+org-gated on open).
//   • Download HTML → a SELF-CONTAINED single .html the user OWNS: all CSS inlined,
//                     charts serialized as INLINE SVG from the live DOM, so the file
//                     opens offline with no app and no JS. This is the primary
//                     "they own it" path (governed briefs never get a public URL).
//
// On-screen we reuse the app's real ChartBlock / DecisionTable so this matches the
// workspace exactly. For the downloaded file we rebuild the text/decisions from the
// same data (Tailwind classes wouldn't survive standalone) and splice in the charts'
// already-rendered <svg> markup (which carries inline fills + our color vars).

import { useCallback, useEffect, useRef, useState } from "react";
import ChartBlock from "@/components/charts/chart-block";
import { DecisionTable } from "@/components/agents/decision-table";
import { ContradictionBlock, type ContradictionPair } from "@/components/agents/contradiction-block";
import { Markdown } from "@/components/markdown";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { useToast } from "@/components/ui";
import type { CitationCheck } from "@/services/memory/brief-citations";
import type { BriefStaleness } from "@/services/memory/brief-staleness";
import { CitedFacts, DIVERGED } from "./cited-facts";
import type { BriefSection, BriefType, ChartSpec, DecisionFragment, Milestone } from "@/types/agent-run";

export type BriefDoc = {
  id: string;
  type: BriefType;
  scopePath: string;
  /** Human-readable target label for a scope-less QA run; null once scopePath
   * already holds a real memory scope. Prefer this over scopePath
   * whenever it's set. */
  scopeLabel: string | null;
  title: string;
  summary: string;
  granteeName: string | null;
  granteeRole: string | null;
  sections: BriefSection[];
  milestones: Milestone[] | null;
  diagram: string | null;
  diagramUrl: string | null;
  charts: ChartSpec[] | null;
  decisions: DecisionFragment[] | null;
  createdAt: string;
  /** Which Handoff runner actually produced this brief; null for a brief
   * generated before this column existed, or a non-handoff type. */
  backend?: "single" | "manager" | null;
  /** The most recent grantee acknowledgement, read back server-side so a
   * reload doesn't lose it. `stale` is the staleness verdict AT acknowledge
   * time, not the current one — see the toolbar button below. */
  acknowledgement?: { at: string; stale: boolean } | null;
};

const BRIEF_META: Record<BriefType, { label: string }> = {
  handoff: { label: "Handoff" },
  architecture_plan: { label: "Architecture" },
  qa_review: { label: "QA review" },
};

// The on-screen treatment: section headings at card-title size, one hairline
// between blocks, eyebrows for labels. The downloaded file has its own
// stylesheet in handleDownloadHtml, because Tailwind classes do not travel with it.
const SECTION_HEADING = "text-lg font-semibold text-fg";
const EYEBROW = "text-eyebrow font-semibold uppercase text-fg-subtle";

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Shared forest, ice, and stone palette and the dark-theme text roles from
// app/globals.css — inlined so var(--color-*) in the chart SVGs and this sheet
// resolves offline with no app stylesheet. The file is always dark.
const COLOR_VARS = `
  --color-ink: #001914;
  --color-gunpowder: #23483F;
  --color-gold: #C9FCFC;
  --color-ember: #F59B76;
  --color-brick: #EF968D;
  --color-marble: #EFEFE9;
  --color-fg: #EFEFE9;
  --color-fg-muted: #D4D4CD;
  --color-fg-subtle: #A8B8AE;
  --color-accent: #C9FCFC;
  --color-info: #A7DFE6;
  --color-danger: #EF968D;
  --color-success: #A6D4B4;
  --color-divider: rgba(215, 212, 202, 0.12);
`;

// QA verdict at-a-glance (qa_review briefs only): GO reads green, NO-GO reads ember.
// A shared brief carries no structured bug list, so this is a heuristic on the summary
// prose; when it matches nothing the summary stays neutral (no false signal).
function qaVerdict(type: BriefType, summary: string): "go" | "nogo" | null {
  if (type !== "qa_review" || !summary) return null;
  const t = summary.toLowerCase();
  if (/\bno[\s-]?go\b|not ready|blocker|broken|\bfail|critical|regress|must[\s-]?fix/.test(t)) return "nogo";
  if (/\bgo\b|\bship\b|\bpass|healthy|\bclear\b|ready to|no (?:issues|bugs|blockers|regress)/.test(t)) return "go";
  return null;
}

type StalenessChange = { action: string; target: string; at: string };
type StaleBasis = BriefStaleness["basis"];

// Why the banner shows, in the reader's terms. On the derivation basis the verdict
// rests on what the brief recorded it read, so the line names that; scope activity
// is not the reason and is not listed. On the scope basis the brief recorded nothing
// it read, so any write under its scope counts, and the line says so plainly.
function staleReason(basis: StaleBasis, movedCitations: number): string {
  if (basis === "scope") {
    return "This briefing has no record of what it was built from, so any memory written or removed in its scope since it was generated flags it.";
  }
  if (movedCitations > 0) {
    const facts = movedCitations === 1 ? "fact it cites has" : "facts it cites have";
    return `${movedCitations} ${facts} changed, been replaced or been removed since it was generated. Each is marked in its section below.`;
  }
  return "A connected source this briefing read has replaced or removed an item since it was generated.";
}
type SourceVisibility = { total: number; inScope: number; outOfScope: number };

// States what this agent could and couldn't see, and which sources are
// currently in scope for it, as one sentence. A separate fact from the
// staleness flag above: this says what is in scope right now, not whether
// anything changed, so it renders whenever the count is known, not only when
// the brief is stale.
//
// Must describe present config, not historical provenance: the endpoint
// counts sources currently connected and in scope, it never records which
// sources the agent actually read from at generation time. A phrase like
// "Answered from" claims the latter — connecting or disconnecting a source
// after generation would then change that sentence retroactively for a
// briefing whose actual content never did. Word it as current visibility
// instead.
function sourceVisibilityLine(sources: SourceVisibility): string {
  const unit = sources.total === 1 ? "source" : "sources";
  const base = `${sources.inScope} of ${sources.total} connected ${unit} visible to this agent now`;
  return sources.outOfScope > 0 ? `${base}; ${sources.outOfScope} out of scope.` : `${base}.`;
}

function formatChangeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline markdown → HTML for the standalone download. Escapes first (no raw HTML from the
// model survives as markup), then applies the small inline set the reports use: `code`,
// **bold**, [text](url), *em*.
function mdInline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c: string) => `<code>${c}</code>`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt: string, href: string) => `<a href="${href}">${txt}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return t;
}

const MD_ROW = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const MD_TABLE_SEP = (s: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.includes("-");

const MD_STARTS_BLOCK = (s: string) =>
  /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```)/.test(s) || /^\s*([-*_])\1{2,}\s*$/.test(s);

// Block-level GFM subset → HTML for the offline file: headings, pipe tables, un/ordered
// lists, blockquotes, code fences, hr, and paragraphs. Keeps the download self-contained
// (no app CSS) — the elements are styled by the `.md` rules in the download stylesheet.
function mdToHtml(src: string): string {
  const lines = String(src ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const tag = h[1].length <= 2 ? "h3" : "h4";
      out.push(`<${tag}>${mdInline(h[2])}</${tag}>`);
      i++;
      continue;
    }
    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    // Fenced code block
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(esc(lines[i]));
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    // Table
    if (line.includes("|") && i + 1 < lines.length && MD_TABLE_SEP(lines[i + 1])) {
      const header = MD_ROW(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        rows.push(MD_ROW(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${header.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<div class="md-table"><table>${thead}${tbody}</table></div>`);
      continue;
    }
    // Unordered / ordered list
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(`<li>${mdInline(m[1])}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    // Blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${mdInline(buf.join(" "))}</blockquote>`);
      continue;
    }
    // Paragraph
    const para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !MD_STARTS_BLOCK(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${mdInline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function BriefDocument({ brief }: { brief: BriefDoc }) {
  const meta = BRIEF_META[brief.type] ?? BRIEF_META.handoff;
  const milestones = Array.isArray(brief.milestones) ? brief.milestones : [];
  const charts = Array.isArray(brief.charts) ? brief.charts : [];
  const decisions = Array.isArray(brief.decisions) ? brief.decisions : [];
  const { toast } = useToast();
  const docRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [accept, setAccept] = useState<{
    status: "idle" | "saving" | "saved" | "error";
    count: number;
    error: string;
  }>({ status: "idle", count: 0, error: "" });
  const verdict = qaVerdict(brief.type, brief.summary);
  const isHandoff = brief.type === "handoff";
  const backendLabel =
    brief.backend === "manager" ? "Manager (fan-out)" : brief.backend === "single" ? "Single agent" : "Unknown";

  // A grantee-facing completion receipt that persists: the generator's own
  // receipt (agents/page.tsx CompletionReceipt) is a transient client render in
  // the generator's session, and this is the page the external grantee opens.
  // Seeded from the server-read acknowledgement (survives reload); updated
  // in place once a fresh acknowledge call actually confirms.
  const [acknowledgement, setAcknowledgement] = useState(brief.acknowledgement ?? null);
  const [acknowledging, setAcknowledging] = useState(false);

  // "Did memory change under this brief's scope after it was
  // generated?" Handoff-only — an external grantee reads a point-in-time
  // briefing, so this is the one brief type where a stale read actually
  // matters to flag. See GET /api/briefs/:id/staleness.
  //
  // Tag state with the briefId it was fetched for: this component can
  // re-render with a new `brief` prop instead of remounting, so state from
  // the PREVIOUS brief could otherwise still be showing — against a
  // different document, or a non-handoff one — until the new fetch resolves.
  // Deriving `currentStaleness` below (rather
  // than an unconditional `setStaleness(null)` at the top of the effect,
  // which the project's set-state-in-effect lint rule flags) means a brief
  // change can never render stale data even for one frame: the old state is
  // simply never a match once `brief.id` has moved on.
  const [staleness, setStaleness] = useState<
    | ({
        // The verdict (services/memory/brief-staleness.ts): something this brief was
        // derived from changed. `changed` is only scope activity, so the banner keys
        // off `stale`, never `changed`.
        stale: boolean;
        staleBasis: StaleBasis;
        changed: boolean;
        changes: StalenessChange[];
        // Contradictions are a SEPARATE signal from `changes` — "these two things now actively
        // disagree", not merely "something changed". See GET
        // /api/briefs/:id/staleness's own scanForContradictions comment for
        // why this lives here (read-time, scoped to this brief) rather than
        // on the generic ingest path.
        contradictions?: ContradictionPair[];
        sources?: SourceVisibility;
        // The facts each section cited, re-checked now (services/memory/brief-citations.ts).
        citations?: CitationCheck[];
      } & { briefId: string })
    | null
  >(null);
  const currentStaleness = staleness?.briefId === brief.id ? staleness : null;
  const citations = isHandoff ? (currentStaleness?.citations ?? []) : [];
  const movedCitations = citations.filter((c) => DIVERGED.has(c.status)).length;
  useEffect(() => {
    if (!isHandoff) return;
    let cancelled = false;
    fetch(`/api/briefs/${brief.id}/staleness`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setStaleness({ ...data, briefId: brief.id });
      })
      .catch(() => {
        // Best-effort signal — a fetch failure just means no flag shown, not an error state.
      });
    return () => {
      cancelled = true;
    };
  }, [isHandoff, brief.id]);

  // Copyable setup steps: the real, current path an external
  // grantee follows to actually open this briefing — org invite (Settings →
  // Organization → invite by email, the Clerk flow OrgPanel already drives)
  // then this exact link. No new access mechanism invented; this just spells
  // out the existing one so an admin can paste it straight into an email.
  const handleCopySetupSteps = useCallback(async () => {
    const steps = [
      `Setup steps for ${brief.granteeName ?? "the new person"}:`,
      "1. An admin invites you: Settings -> Organization -> Invite by email.",
      "2. Accept the email invite from Willder and sign in.",
      `3. Once signed in, open your briefing: ${window.location.href}`,
      "4. It stays available to you for as long as your workspace membership does.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(steps);
      toast("Setup steps copied", "success");
    } catch {
      toast("Couldn't copy — copy the steps by hand", "error");
    }
  }, [brief.granteeName, toast]);

  // Accept the brief → persist its decisions/facts to memory. Contract:
  // 200 { persisted } · 403 { error } · 404. Stateful button: idle → saving → saved,
  // or a brief error message on failure (then back to idle so the user can retry).
  const handleAccept = useCallback(async () => {
    setAccept((s) => ({ ...s, status: "saving", error: "" }));
    try {
      const res = await fetch(`/api/briefs/${brief.id}/persist`, { method: "POST" });
      if (!res.ok) {
        let msg = res.status === 404 ? "Brief not found" : "Couldn't save";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // non-JSON body — keep the status-derived message
        }
        setAccept({ status: "error", count: 0, error: msg });
        return;
      }
      const body = (await res.json()) as { persisted?: number };
      setAccept({ status: "saved", count: body?.persisted ?? 0, error: "" });
    } catch {
      setAccept({ status: "error", count: 0, error: "Couldn't save" });
    }
  }, [brief.id]);

  // Acknowledge the brief → POST /api/briefs/:id/acknowledge. Only shown once
  // durably confirmed (design.md's "never use a process-local map as evidence
  // of a completed integration" — this is the same rule applied to a receipt):
  // no optimistic local flip, wait for the real 200 before updating state.
  const handleAcknowledge = useCallback(async () => {
    setAcknowledging(true);
    try {
      const res = await fetch(`/api/briefs/${brief.id}/acknowledge`, { method: "POST" });
      if (!res.ok) {
        toast("Couldn't record acknowledgement", "error");
        return;
      }
      const body = (await res.json()) as { acknowledgedAt: string; stale: boolean };
      setAcknowledgement({ at: body.acknowledgedAt, stale: body.stale });
      toast(body.stale ? "Acknowledged — flagged as possibly stale" : "Acknowledged", body.stale ? "info" : "success");
    } catch {
      toast("Couldn't record acknowledgement", "error");
    } finally {
      setAcknowledging(false);
    }
  }, [brief.id, toast]);

  const handlePrint = useCallback(() => window.print(), []);

  const handleCopyLink = useCallback(async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", "success");
    } catch {
      toast("Couldn't copy — copy it from the address bar", "error");
    }
  }, [toast]);

  // Build a fully self-contained .html file and trigger a browser download.
  const handleDownloadHtml = useCallback(() => {
    setDownloading(true);
    try {
      // Grab the LIVE chart SVGs (inline fills + our color vars) straight from the DOM.
      const chartHtml: string[] = [];
      docRef.current?.querySelectorAll<HTMLElement>("[data-chart-export]").forEach((n) => chartHtml.push(n.innerHTML));

      // Grab the RENDERED Mermaid diagram SVG from the DOM so the downloaded file — the
      // one you send the person — shows the actual picture, not raw mermaid source.
      const diagramSvg = docRef.current?.querySelector<SVGElement>("[data-diagram-export] svg")?.outerHTML ?? "";

      const parts: string[] = [];
      parts.push(
        `<header class="head"><p class="eyebrow">${esc(meta.label)} · ${esc(brief.scopeLabel ?? brief.scopePath)}</p>` +
          `<h1>${esc(brief.title)}</h1>` +
          (brief.granteeName || brief.granteeRole
            ? `<p class="grantee">For <strong>${esc(brief.granteeName)}</strong>${
                brief.granteeRole ? ` — ${esc(brief.granteeRole)}` : ""
              }</p>`
            : "") +
          `<p class="meta">Generated ${esc(formatDate(brief.createdAt))}</p></header>`,
      );

      if (brief.summary) {
        parts.push(
          `<section class="card"><p class="label">Summary</p><p class="body">${esc(brief.summary)}</p></section>`,
        );
      }

      for (const d of decisions) {
        const recId = d.recommendation?.optionId;
        const opts = (d.options ?? [])
          .map((o) => {
            const badges = [
              o.id === recId ? `<span class="badge gold">★ Recommended</span>` : "",
              o.id === d.chosenOptionId ? `<span class="badge ember">Your choice</span>` : "",
            ].join("");
            const traits = (
              [
                ["Pros", o.pros],
                ["Cons", o.cons],
                ["Cost", o.cost],
                ["Common practice", o.commonPractice],
                ["Example", o.example],
              ] as const
            )
              .filter(([, v]) => typeof v === "string" && v)
              .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
              .join("");
            const why =
              o.id === recId && d.recommendation?.rationale
                ? `<p class="why"><span>Why: </span>${esc(d.recommendation.rationale)}</p>`
                : "";
            return `<div class="opt"><div class="opt-head"><h4>${esc(
              o.label,
            )}</h4>${badges}</div>${why}<dl>${traits}</dl></div>`;
          })
          .join("");
        parts.push(
          `<section class="decision"><p class="label">Decision to make</p><h3>${esc(
            d.question,
          )}</h3><div class="opts">${opts}</div></section>`,
        );
      }

      for (const c of chartHtml) parts.push(`<section class="chart">${c}</section>`);

      if (brief.sections.length > 0) {
        parts.push(
          `<section class="sections">${brief.sections
            .map(
              (s) =>
                `<div class="sec"><p class="label">${esc(s.heading)}</p><div class="body md">${mdToHtml(
                  s.content,
                )}</div></div>`,
            )
            .join("")}</section>`,
        );
      }

      if (milestones.length > 0) {
        parts.push(
          `<section class="milestones"><p class="label">Milestones</p><ol>${milestones
            .map(
              (m) =>
                `<li><span class="ms-label">${esc(m.label)}</span>${
                  m.dueDate ? `<span class="ms-date">${esc(formatDate(m.dueDate))}</span>` : ""
                }</li>`,
            )
            .join("")}</ol></section>`,
        );
      }

      if (brief.diagram) {
        parts.push(
          `<section class="diagram"><p class="label">Diagram</p>${
            diagramSvg ? `<div class="diagram-svg">${diagramSvg}</div>` : `<pre>${esc(brief.diagram)}</pre>`
          }${brief.diagramUrl ? `<p><a href="${esc(brief.diagramUrl)}">View diagram →</a></p>` : ""}</section>`,
        );
      }

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(brief.title)} · Willder</title>
<style>
  :root {${COLOR_VARS}}
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--color-ink); color: var(--color-fg);
    font-family: "Manrope", ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 16px; line-height: 1.6; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc { max-width: 820px; margin: 0 auto; padding: 56px 32px 96px; }
  @media (max-width: 640px) { .doc { padding: 32px 16px 64px; } }
  h1 { font-family: "Fraunces", Georgia, "Times New Roman", serif; letter-spacing: -0.02em; }
  .head { border-bottom: 1px solid var(--color-divider); padding-bottom: 24px; }
  .head h1 { font-size: 32px; line-height: 1.15; font-weight: 600; margin: 12px 0 0; }
  @media (min-width: 641px) { .head h1 { font-size: 40px; line-height: 1.1; } }
  .eyebrow, .label, .opt dt, .md-table th {
    font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--color-fg-subtle); }
  .eyebrow { margin: 0; }
  .grantee { color: var(--color-fg-muted); margin: 12px 0 0; }
  .meta { color: var(--color-fg-subtle); font-size: 14px; margin: 8px 0 0; }
  .label { margin: 0 0 8px; }
  .body { color: var(--color-fg-muted); white-space: pre-wrap; margin: 0; }
  section { margin-top: 32px; }
  .card { border: 1px solid var(--color-divider); background: color-mix(in srgb, var(--color-fg) 2%, transparent);
    border-radius: 16px; padding: 16px 20px; }
  /* Rendered markdown inside report sections — clean tables/lists to match the app. */
  .md { white-space: normal; }
  .md > *:first-child { margin-top: 0; }
  .md p { margin: 12px 0 0; }
  .md h3, .md h4 { font-family: inherit; font-weight: 600; color: var(--color-fg); }
  .md h3 { font-size: 18px; margin: 20px 0 0; }
  .md h4 { font-size: 16px; margin: 16px 0 0; }
  .md ul, .md ol { margin: 12px 0 0; padding-left: 20px; }
  .md li { margin: 4px 0; color: var(--color-fg-muted); }
  .md ul li::marker { color: var(--color-fg-subtle); }
  .md strong { color: var(--color-fg); }
  .md code { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; color: var(--color-fg);
    background: color-mix(in srgb, var(--color-fg) 6%, transparent); border-radius: 4px; padding: 1px 5px; }
  .md pre { margin: 12px 0 0; overflow-x: auto; border: 1px solid var(--color-divider);
    background: rgba(0,0,0,0.3); border-radius: 12px; padding: 12px; }
  .md pre code { background: none; padding: 0; font-size: 12px; color: var(--color-fg-muted); }
  .md blockquote { margin: 12px 0 0; border-left: 2px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
    padding: 0 0 0 16px; color: var(--color-fg-muted); }
  .md hr { border: 0; height: 1px; background: var(--color-divider); margin: 24px 0; }
  .md-table { margin: 12px 0 0; overflow-x: auto; border: 1px solid var(--color-divider);
    border-radius: 12px; }
  .md-table table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
  .md-table th { padding: 8px 12px; border-bottom: 1px solid var(--color-divider); }
  .md-table td { padding: 8px 12px; font-size: 14px; color: var(--color-fg-muted);
    border-top: 1px solid var(--color-divider); vertical-align: top; }
  .sections .sec { border-top: 1px solid var(--color-divider); padding-top: 20px; margin-top: 20px; }
  .sections .sec:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
  .sections .sec > .label { font-size: 18px; line-height: 1.4; letter-spacing: 0; text-transform: none; color: var(--color-fg); }
  .milestones ol { list-style: none; padding: 0; margin: 12px 0 0; }
  .milestones li { display: flex; gap: 12px; align-items: baseline; padding: 8px 0;
    border-top: 1px solid var(--color-divider); }
  .milestones li:first-child { border-top: 0; }
  .ms-label { color: var(--color-fg); }
  .ms-date { margin-left: auto; font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    color: var(--color-fg-subtle); white-space: nowrap; }
  .diagram pre { overflow-x: auto; white-space: pre-wrap; border: 1px solid var(--color-divider);
    background: rgba(0,0,0,0.3); border-radius: 12px; padding: 12px; font-size: 12px;
    color: var(--color-fg-muted); }
  a { color: var(--color-accent); }
  .decision { border: 1px solid var(--color-divider); background: color-mix(in srgb, var(--color-fg) 2%, transparent);
    border-radius: 16px; padding: 20px; }
  .decision h3 { font-size: 18px; font-weight: 600; margin: 4px 0 16px; color: var(--color-fg); }
  .opts { display: flex; flex-wrap: wrap; gap: 12px; }
  .opt { flex: 1 1 240px; min-width: 0; border: 1px solid var(--color-divider); border-radius: 12px; padding: 16px; }
  .opt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
  .opt h4 { margin: 0; font-size: 16px; font-weight: 600; color: var(--color-fg); }
  .badge { font-size: 12px; font-weight: 600; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .badge.gold { color: var(--color-accent); border: 1px solid color-mix(in srgb, var(--color-accent) 50%, transparent); }
  .badge.ember { color: var(--color-fg); border: 1px solid color-mix(in srgb, var(--color-ember) 60%, transparent); }
  .why { font-size: 14px; color: var(--color-fg-muted); border-left: 2px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
    padding: 0 0 0 12px; margin: 12px 0; }
  .why span { color: var(--color-accent); font-weight: 600; }
  .opt dl { margin: 8px 0 0; }
  .opt dt { margin-top: 12px; }
  .opt dd { margin: 2px 0 0; font-size: 14px; color: var(--color-fg-muted); }
  figure { margin: 0; border: 1px solid var(--color-divider); border-radius: 16px; padding: 16px 20px; }
  figcaption { font-size: 18px; font-weight: 600; color: var(--color-fg); margin-bottom: 12px; }
  svg { max-width: 100%; height: auto; }
  /* A grouped chart's legend arrives as utility-classed spans; lay it out here. */
  [role="img"] > div { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 8px; font-size: 14px; color: var(--color-fg-muted); }
  [role="img"] > div > span { display: inline-flex; align-items: center; gap: 6px; }
  [role="img"] > div > span > span { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  footer { margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--color-divider);
    font-size: 14px; color: var(--color-fg-subtle); }
</style>
</head>
<body>
  <main class="doc">
    ${parts.join("\n")}
    <footer>Willder — read-only brief. Generated ${esc(formatDate(brief.createdAt))}.</footer>
  </main>
</body>
</html>`;

      const slug =
        brief.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "brief";
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Downloaded", "success");
    } catch {
      toast("Download failed", "error");
    } finally {
      setDownloading(false);
    }
  }, [brief, meta.label, milestones, decisions, toast]);

  const btn =
    "inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-divider px-3.5 py-2 text-sm font-semibold text-fg transition-colors hover:border-accent/35 hover:bg-fg/5 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      {/* Print CSS: hide app chrome (sidebar <aside>) + our toolbar, and force color so
          the dark ground and charts survive to the printed PDF. */}
      <style>{`
        @media print {
          aside { display: none !important; }
          .brief-print-hide { display: none !important; }
          html, body { background: var(--color-ink) !important; }
          .brief-printable { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          /* Force any collapsed <details> open so its content survives to the PDF. */
          .brief-printable details > summary { display: none !important; }
          .brief-printable details > *:not(summary) { display: block !important; }
        }
      `}</style>

      {/* Toolbar — excluded from print + not part of the downloadable doc. */}
      <div className="brief-print-hide mb-6 flex flex-wrap items-center gap-2 sm:mb-8">
        <button type="button" onClick={handleAccept} disabled={accept.status === "saving"} className={btn}>
          {accept.status === "saving"
            ? "Saving…"
            : accept.status === "saved"
              ? `Saved ✓ (${accept.count} ${accept.count === 1 ? "fact" : "facts"})`
              : accept.status === "error"
                ? accept.error
                : "Accept & save to memory"}
        </button>
        <button type="button" onClick={handleDownloadHtml} disabled={downloading} className={btn}>
          {downloading ? "Preparing…" : "Download as HTML"}
        </button>
        <button type="button" onClick={handlePrint} className={btn}>
          Save as PDF
        </button>
        <button type="button" onClick={handleCopyLink} className={btn}>
          Copy link
        </button>
        {isHandoff && (
          <button type="button" onClick={handleCopySetupSteps} className={btn}>
            Copy setup steps
          </button>
        )}
        {isHandoff && (
          <button type="button" onClick={handleAcknowledge} disabled={acknowledging} className={btn}>
            {acknowledging ? "Recording…" : acknowledgement ? "Re-acknowledge" : "Acknowledge receipt"}
          </button>
        )}
      </div>

      <article ref={docRef} className="brief-printable space-y-6">
        {/* Header */}
        <div className="border-b border-divider pb-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={EYEBROW}>{meta.label}</span>
            <span className="break-all font-mono text-xs text-fg-subtle">{brief.scopeLabel ?? brief.scopePath}</span>
          </div>
          <h1 className="mt-3 break-words font-display text-display-sm font-semibold tracking-[-0.02em] text-fg sm:text-display-md">
            {brief.title}
          </h1>
          {(brief.granteeName || brief.granteeRole) && (
            <p className="mt-3 text-base text-fg-muted">
              For <span className="font-semibold text-fg">{brief.granteeName}</span>
              {brief.granteeRole ? ` — ${brief.granteeRole}` : ""}
            </p>
          )}
          <p className="mt-2 font-mono text-xs text-fg-subtle">Generated {formatDate(brief.createdAt)}</p>
        </div>

        {/* Surfaces #1/#2: what this agent could see and drew from, at answer time.
            Independent of the stale flag below — shown whenever the count is
            known, since it isn't about whether anything changed. */}
        {isHandoff && currentStaleness?.sources && (
          <p className="brief-print-hide text-sm text-fg-subtle">{sourceVisibilityLine(currentStaleness.sources)}</p>
        )}

        {/* Something this briefing was derived from changed after it was generated.
            Keyed on the `stale` verdict, not `changed`: a write elsewhere in the scope
            does not make this briefing out of date. Gate on isHandoff too — without it,
            a non-handoff brief could render a leftover handoff warning across a
            prop-only re-render, since `currentStaleness` alone doesn't say the brief type. */}
        {isHandoff && currentStaleness?.stale && (
          <div className="brief-print-hide rounded-2xl border border-ember/30 bg-ember/[0.06] p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <svg
                className="h-4 w-4 shrink-0 text-ember"
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
              <p className="text-sm font-semibold text-fg">
                {/* A still-single change signal must not collapse
                    "one source was corrected" and "two sources now disagree"
                    into the same string. The headline says which one this is;
                    the detail list below is unchanged (still every
                    write/delete under scope), and the contradiction block
                    right after this banner is the distinguishing signal
                    itself when one exists. */}
                {(currentStaleness.contradictions?.length ?? 0) > 0
                  ? "Sources now disagree"
                  : "Decision changed after you started"}
              </p>
            </div>
            <p className="mt-2 break-words text-sm leading-relaxed text-fg-muted">
              <span className="font-semibold text-fg">{brief.title}</span> may no longer reflect the latest decision.{" "}
              {staleReason(currentStaleness.staleBasis, movedCitations)}
            </p>
            {currentStaleness.staleBasis === "scope" && currentStaleness.changes.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-divider pt-3">
                {currentStaleness.changes.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 font-mono text-xs text-fg-subtle">
                    <span className="font-semibold text-fg-muted">
                      {c.action === "memory.delete" ? "removed" : "changed"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.target}</span>
                    <span className="shrink-0">{formatChangeTime(c.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* A persisted completion receipt — Brief ID/backend/scope/generated time
            plus the grantee's own acknowledgement, carrying the staleness verdict
            AT acknowledge time so a receipt recorded while the flag above was
            showing can't silently read as a clean handoff later. */}
        {isHandoff && (
          <div
            className={`brief-print-hide rounded-2xl border p-4 sm:p-5 ${
              acknowledgement?.stale ? "border-ember/30 bg-ember/[0.06]" : "border-divider bg-fg/[0.03]"
            }`}
          >
            <p className={EYEBROW}>Completion receipt</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <div className="min-w-0">
                <dt className="text-fg-subtle">Brief ID</dt>
                <dd className="mt-0.5 break-all font-mono text-xs leading-5 text-fg">{brief.id}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-fg-subtle">Backend</dt>
                <dd className="mt-0.5 text-fg">{backendLabel}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-fg-subtle">Generated</dt>
                <dd className="mt-0.5 text-fg">{formatChangeTime(brief.createdAt)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-fg-subtle">Acknowledged</dt>
                <dd className={`mt-0.5 text-fg ${acknowledgement?.stale ? "font-semibold" : ""}`}>
                  {acknowledgement
                    ? `${formatChangeTime(acknowledgement.at)}${acknowledgement.stale ? " (flagged stale)" : ""}`
                    : "Not yet acknowledged"}
                </dd>
              </div>
            </dl>
            {acknowledgement?.stale && (
              <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                This acknowledgement was recorded while the briefing was flagged as possibly changed above — it attests
                receipt of this document, not that its content was current.
              </p>
            )}
          </div>
        )}

        {/* The handoff brief's own contradiction surface — reuses the same
            block BriefView already renders for architecture briefs (component extracted
            to components/agents/contradiction-block.tsx), populated here from the
            staleness scan since a handoff brief has no generation-time contradictions
            field of its own (HANDOFF_OUTPUT_SCHEMA never asks the model to flag one). */}
        {isHandoff &&
          currentStaleness &&
          currentStaleness.contradictions &&
          currentStaleness.contradictions.length > 0 && (
            <div className="brief-print-hide">
              <ContradictionBlock
                contradictions={currentStaleness.contradictions}
                title="Sources disagree about this decision"
              />
            </div>
          )}

        {/* Summary — QA briefs carry the verdict here; reads green (clear) vs ember. */}
        {brief.summary && (
          <div
            className={`rounded-2xl border p-4 sm:p-5 ${
              verdict === "nogo"
                ? "border-ember/30 bg-ember/[0.06]"
                : verdict === "go"
                  ? "border-success/30 bg-success/[0.06]"
                  : "border-divider bg-fg/[0.03]"
            }`}
          >
            <div className="flex items-center gap-2">
              {verdict && (
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${verdict === "nogo" ? "bg-ember" : "bg-success"}`}
                />
              )}
              <p className={`text-sm font-semibold ${verdict ? "text-fg" : "text-fg-subtle"}`}>
                {verdict === "nogo" ? "Verdict — needs attention" : verdict === "go" ? "Verdict — clear" : "Summary"}
              </p>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-fg">{brief.summary}</p>
          </div>
        )}

        {/* Decisions — the agent's recommendation is an input, not a locked call */}
        {decisions.map((d, i) => (
          <DecisionTable key={`dec-${i}`} decision={d} />
        ))}

        {/* Charts — reuse the app's SVG renderer; wrap each so the downloader can
            serialize the live <svg> into the self-contained file. */}
        {charts.map((spec, i) => (
          <div key={`chart-${i}`} data-chart-export>
            <ChartBlock spec={spec} />
          </div>
        ))}

        {/* Sections */}
        {brief.sections.length > 0 && (
          <div className="space-y-6">
            {brief.sections.map((s, i) => (
              <div key={i} className="border-t border-divider pt-6">
                <p className={SECTION_HEADING}>{s.heading}</p>
                <Markdown markdown={s.content} className="mt-3" />
                <CitedFacts citations={citations.filter((c) => c.sectionIndex === i)} />
              </div>
            ))}
          </div>
        )}

        {/* Milestones */}
        {milestones.length > 0 && (
          <div className="border-t border-divider pt-6">
            <p className={SECTION_HEADING}>Milestones</p>
            <ol className="mt-3 space-y-0">
              {milestones.map((m, i) => (
                <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                  <div className="flex flex-col items-center">
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ember" />
                    {i < milestones.length - 1 && <span aria-hidden="true" className="mt-1 w-px flex-1 bg-divider" />}
                  </div>
                  <div className="min-w-0 flex-1 -mt-0.5">
                    <p className="break-words text-base leading-snug text-fg">{m.label}</p>
                    {m.dueDate && <p className="mt-1 font-mono text-xs text-fg-subtle">{formatDate(m.dueDate)}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Diagram (Mermaid text) + optional draw.io link — verbose source collapses
            on screen (forced open for print via the @media print rule above). */}
        {brief.diagram && (
          <div className="border-t border-divider pt-6">
            <p className={SECTION_HEADING}>Diagram</p>
            {/* Rendered inline (visible by default); the source + draw.io link stay below
                as fallback/extras. Mermaid can't render in the static HTML download, so the
                offline file keeps the raw <pre> — see handleDownloadHtml. */}
            <div data-diagram-export>
              <MermaidDiagram chart={brief.diagram} />
            </div>
            <details className="group mt-3">
              <summary className="brief-print-hide flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                <svg
                  className="h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90"
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
                <span className="group-open:hidden">Show diagram source</span>
                <span className="hidden group-open:inline">Hide diagram source</span>
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border border-divider bg-fg/[0.04] p-3 font-mono text-xs leading-relaxed text-fg-muted">
                {brief.diagram}
              </pre>
            </details>
            {brief.diagramUrl && (
              <a href={brief.diagramUrl} target="_blank" rel="noreferrer" className={`brief-print-hide mt-3 ${btn}`}>
                View diagram →
              </a>
            )}
          </div>
        )}
      </article>
    </div>
  );
}
