// Read-only, shareable, printable view of a single Brief (handoff / architecture
// plan / QA review). This is the reviewable artifact that sidesteps the Google Doc
// OAuth path: a person opens /briefs/[id], reads it cleanly, and can Print → Save-PDF
// or Download a self-contained .html file they own — no app chrome, no Drive.
//
// GATING: two gates, mirroring app/api/briefs/[id]/route.ts. First the org tenant
// scope — the brief is fetched with { id, orgId }, so a user can only ever see their
// own org's briefs. Then check() on the brief's own scopePath, because org membership
// is not a grant: a member the evaluator denies on that scope (never granted, or
// revoked) must not read the brief here either. This page is the surface a grantee
// actually opens, so a gate the API routes hold and this page does not is a revoke
// that does not revoke.
// No public/unauthed variant (governed briefs never live at an open URL).
//
// The server component does ONLY the two gates above, the fetch and a JSON parse, then
// hands plain serializable data to the client <BriefDocument>, which owns the
// chrome-free render, the print/copy/download affordances, and (reusing
// ChartBlock/DecisionTable) charts.

import { notFound } from "next/navigation";
import { requireAccessContext } from "@/lib/access-context";
import { latestBriefAcknowledgement } from "@/services/access";
import type { BriefSection, BriefType, ChartSpec, DecisionFragment, Milestone } from "@/types/agent-run";
import { BriefDocument, type BriefDoc } from "./brief-document";
import { authorizeBrief } from "@/services/memory/briefs";

// Auth + a per-request DB read — never statically prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Brief · Willder",
};

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Org gate — same shape as app/api/briefs/[id]/route.ts. null → not signed in /
  // no active org; treat as not-found so we never leak a brief's existence.
  const rc = await requireAccessContext();
  if (!rc) notFound();

  // Scope gate — the same check() the brief-read API routes run, made by the same
  // call that finds the brief. notFound() rather than a distinct "denied" page: a
  // reader holding no grant on this scope must not be able to tell a brief they
  // may not read from one that does not exist, the same non-disclosure the org
  // gate above keeps.
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.read" });
  if (access.status !== "allowed") notFound();
  const { brief } = access;

  // A prior acknowledgement, if any, read back here (server-side, same org gate)
  // so a reload of this page doesn't lose it — the client then updates its
  // own state after a fresh POST /acknowledge. Handoff-only, same as the
  // staleness banner below.
  const acknowledgement =
    brief.type === "handoff"
      ? await latestBriefAcknowledgement({ orgId: rc.org.id, scopePath: brief.scopePath, briefId: brief.id })
      : null;

  // The persisted Brief stores these as Prisma Json — narrow to the frozen shapes
  // from types/agent-run.ts. (No `contradictions` column exists; it's run-transient.)
  const doc: BriefDoc = {
    id: brief.id,
    type: brief.type as BriefType,
    scopePath: brief.scopePath,
    scopeLabel: brief.scopeLabel,
    title: brief.title,
    summary: brief.summary,
    granteeName: brief.granteeName,
    granteeRole: brief.granteeRole,
    sections: (brief.sections as unknown as BriefSection[]) ?? [],
    milestones: (brief.milestones as unknown as Milestone[] | null) ?? null,
    diagram: brief.diagram,
    diagramUrl: brief.diagramUrl,
    charts: (brief.charts as unknown as ChartSpec[] | null) ?? null,
    decisions: (brief.decisions as unknown as DecisionFragment[] | null) ?? null,
    createdAt: brief.createdAt.toISOString(),
    backend: (brief.backend as "single" | "manager" | null) ?? null,
    acknowledgement: acknowledgement ? { at: acknowledgement.at.toISOString(), stale: acknowledgement.stale } : null,
  };

  return <BriefDocument brief={doc} />;
}
