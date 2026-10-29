// Shared "run the QA agent → persist a Brief" pipeline. Both the manual route
// (POST /api/agents/:id/qa) and any future background/cron trigger call this so the
// paths can't diverge (mirrors architecture-run.ts). The caller provisions the
// capability (scoped to a grant the human holds) and hands the raw token in — this
// helper never widens access.
//
// The QA report is a richer shape than the Brief's fixed columns, so we flatten it into
// the generic `sections` array the existing BriefView already renders (bugs, performance,
// suggestions, unmeasurable), and stash the verdict + machine-readable report in the
// summary/sections so nothing is lost. A dedicated QA viewer can read structured data
// later; this keeps v1 rendering with zero UI-schema changes.
import { createBrief } from "@/services/memory/create-brief";
import { runQaAgent, type AgentRow, type QaReport, type QaTarget } from "@/services/agents/runner";
import { deriveQaCharts } from "@/services/agents/derive-artifacts";
import { recordArtifactUsage } from "@/services/billing";
import { orgRootPath } from "@/services/access";

export interface QaReviewRunInput {
  agentRow: AgentRow;
  /** The stored agent's id: the actor on the brief's change event. */
  agentId: string;
  orgId: string;
  /** Optional memory scope for stored specs/focus; omit for a pure black-box run. */
  scopePath?: string;
  /** Present only when scopePath is (mints the scoped, read-only capability). */
  capabilityToken?: string;
  target: QaTarget;
  focus?: string;
  mode?: "api" | "browser";
  onProgress?: (message: string) => void;
}

const VERDICT_LABEL: Record<QaReport["verdict"], string> = {
  healthy: "✅ Healthy",
  issues_found: "⚠️ Issues found",
  broken: "🛑 Broken",
  could_not_test: "❓ Could not test",
};

/** Flatten the structured QA report into {heading, content} sections for BriefView. */
function reportToSections(report: QaReport): { heading: string; content: string }[] {
  const sections: { heading: string; content: string }[] = [];

  if (report.bugs.length) {
    const body = report.bugs
      .map(
        (b, i) =>
          `${i + 1}. [${b.severity.toUpperCase()}] ${b.finding}\n` +
          `   Repro: ${b.repro}\n` +
          `   Observed: ${b.observed}\n` +
          `   Expected: ${b.expected}`,
      )
      .join("\n\n");
    sections.push({ heading: `Bugs (${report.bugs.length})`, content: body });
  }

  if (report.performance.length) {
    const body = report.performance
      .map(
        (p) =>
          `${p.endpoint} — p50 ${p.p50LatencyMs}ms · max ${p.maxLatencyMs}ms · ` +
          `error rate ${(p.errorRate * 100).toFixed(1)}% · ${p.samples} sample(s)`,
      )
      .join("\n");
    sections.push({ heading: "Performance", content: body });
  }

  if (report.suggestions.length) {
    sections.push({
      heading: "Suggestions",
      content: report.suggestions.map((s) => `• ${s}`).join("\n"),
    });
  }

  if (report.unmeasurable?.length) {
    sections.push({
      heading: "Not measurable black-box",
      content: report.unmeasurable.map((s) => `• ${s}`).join("\n"),
    });
  }

  return sections;
}

export async function runAndPersistQaReview(
  input: QaReviewRunInput,
): Promise<{ brief: Awaited<ReturnType<typeof createBrief>>; report: QaReport }> {
  const { agentRow, agentId, orgId, scopePath, capabilityToken, target, focus, mode, onProgress } = input;

  const report = await runQaAgent({
    agentRow,
    orgId,
    capabilityToken,
    memoryScope: scopePath,
    target,
    focus,
    mode,
    onProgress,
  });

  // Brief.scopePath is NOT NULL and authorization-bearing (check() enforces
  // against it, cast to ::ltree) — it must always be a real scope, never a
  // display string. A scope-less black-box run has no memory scope, so fall
  // back to the org root (still a valid, authorizable scope) and keep the
  // tested host as its own display-only label instead.
  let hostLabel = target.baseUrl;
  try {
    hostLabel = `(target) ${new URL(target.baseUrl).host}`;
  } catch {
    /* keep raw baseUrl */
  }

  const brief = await createBrief(
    {
      orgId,
      type: "qa_review",
      scopePath: scopePath ?? orgRootPath(orgId),
      scopeLabel: scopePath ? null : hostLabel,
      title: report.title,
      summary: `${VERDICT_LABEL[report.verdict]} — ${report.summary}`,
      sections: reportToSections(report),
      charts: deriveQaCharts(report) as unknown as object,
    },
    { actorType: "agent", actorId: agentId, origin: "agent-run" },
  );

  // Meter the accepted artifact. Best-effort; never throws.
  await recordArtifactUsage({
    orgId,
    artifactType: "qa_review",
    briefId: brief.id,
    scopePath: scopePath ?? null,
  });

  return { brief, report };
}
