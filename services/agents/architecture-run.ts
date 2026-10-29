// Shared "run the architecture agent → persist a Brief → file disputes for flagged
// contradictions" pipeline. Both the manual route (POST /api/agents/:id/architecture)
// and the nightly cron (lib/inngest.ts architectureNightly) call this so the two paths
// can't diverge. The caller provisions the capability (the human route scopes it to a
// grant the human holds; the cron scopes it to the agent's configured watch scope) and
// hands the raw token in — this helper never widens access, it only uses what it's given.
import { createBrief } from "@/services/memory/create-brief";
import { architectureAgentContext } from "@/lib/architecture-agent";
import { runArchitectureAgent, drawioLinkFromMermaid, type AgentRow } from "@/services/agents/runner";
import { deriveArchitectureCharts } from "@/services/agents/derive-artifacts";
import { resolveContradictions } from "@/services/facts/conflicts";
import { openFactDispute } from "@/services/memory/fact-disputes";
import { recordArtifactUsage } from "@/services/billing";

export interface ArchitecturePlanRunInput {
  agentRow: AgentRow;
  /** The stored agent's id: the actor on the brief's change event. */
  agentId: string;
  orgId: string;
  scopePath: string;
  capabilityToken: string;
  title?: string;
  context?: string;
}

/**
 * UC9 — file a dispute per flagged contradiction we can tie to a real graph edge,
 * scoped + audited as the architecture agent (the same capability its reads used).
 * Extracted so BOTH the one-shot pipeline (runAndPersistArchitecturePlan) and the
 * interactive loop (services/agents/run-loop.ts doArchFinalize) file disputes through
 * one implementation and can't diverge (docs/design_architecture_agent_v2.md §2.5).
 * Never widens access — it only uses the token it's handed.
 */
export async function fileContradictionDisputes(
  orgId: string,
  scopePath: string,
  capabilityToken: string,
  contradictions: { factA: string; factB: string; note: string }[] | undefined,
): Promise<string[]> {
  const disputeIds: string[] = [];
  if (!contradictions?.length) return disputeIds;

  const agentCtx = architectureAgentContext(orgId, capabilityToken);
  const resolved = await resolveContradictions(agentCtx, orgId, scopePath, contradictions);
  for (const c of resolved) {
    if (!c.existing) continue; // graphiti_fact_uuid is NOT NULL — need a real edge
    const dispute = await openFactDispute({
      orgId,
      scopePath,
      graphitiFactUuid: c.existing.uuid,
      proposerFactUuid: c.proposer?.uuid,
      existingActorType: c.existing.actorType,
      existingActorId: c.existing.actorId,
      proposerActorType: c.proposer?.actorType ?? "human",
      proposerActorId: c.proposer?.actorId ?? "unknown",
    });
    disputeIds.push(dispute.id);
  }
  return disputeIds;
}

export async function runAndPersistArchitecturePlan(
  input: ArchitecturePlanRunInput,
): Promise<{ brief: Awaited<ReturnType<typeof createBrief>>; disputeIds: string[] }> {
  const { agentRow, agentId, orgId, scopePath, capabilityToken, title, context } = input;

  const result = await runArchitectureAgent({
    agentRow,
    title,
    context,
    orgId,
    capabilityToken,
    memoryScope: scopePath,
  });

  const brief = await createBrief(
    {
      orgId,
      type: "architecture_plan",
      scopePath,
      title: result.title,
      summary: result.summary,
      sections: result.sections,
      milestones: result.milestones ?? undefined,
      diagram: result.diagram ?? null,
      diagramUrl: result.diagram ? drawioLinkFromMermaid(result.diagram) : null,
      charts: deriveArchitectureCharts(result) as unknown as object,
    },
    { actorType: "agent", actorId: agentId, origin: "agent-run" },
  );

  // Meter the accepted artifact. Best-effort; never throws.
  await recordArtifactUsage({
    orgId,
    artifactType: "architecture_plan",
    briefId: brief.id,
    scopePath,
  });

  // UC9: file a dispute per flagged contradiction we can tie to a real graph edge,
  // scoped + audited as the architecture agent (same capability its reads used).
  const disputeIds = await fileContradictionDisputes(orgId, scopePath, capabilityToken, result.contradictions);

  return { brief, disputeIds };
}
