// Files real FactDispute rows for a scope-level contradiction scan (conflicts.ts's
// findScopeContradictions). Kept separate from fact-disputes.ts (the dispute
// routes' reads and resolution) and from architecture-run.ts (whose
// fileContradictionDisputes is specific to a capability-scoped agent run and
// files unconditionally — appropriate there, since every contradiction it sees
// came from the agent's own retrieved-fact analysis, never a fresh human
// correction outranking a lower-tier fact). This path scans facts that already
// coexist in the graph, with no correcting author driving an auto-merge intent,
// so it only ever disputes a SAME-TIER pair; a tier mismatch is left for a human
// to resolve explicitly via POST /api/briefs/:id/correct rather than silently
// auto-merged from a background read.
import { db } from "@/lib/db";
import { resolveContradictions, type ScopeContradiction } from "@/services/facts/conflicts";
import { openFactDispute } from "@/services/memory/fact-disputes";
import type { AccessContext } from "@/services/access";

/**
 * Resolve + file same-tier disputes for a scope's detected contradictions.
 * De-duplicates against an already-open dispute (`status: "disputed"`) on the
 * same unordered edge PAIR, so a still-stale brief re-viewed repeatedly does not
 * spam duplicate rows for one conflict, while a different conflict sharing one
 * fact (A-vs-B filed, then A-vs-C) still gets its own row.
 *
 * The match is order-independent: `resolveContradictions` assigns `existing`/
 * `proposer` from whichever fact the LLM named first in this read, which is not
 * stable between reads (real-Postgres repro in scope-dispute-scan-realdb.qa.test.ts),
 * so the pair is looked up in both orientations.
 *
 * Rows with no `proposerFactUuid` (filed before that column existed, or by a
 * correction with no proposer edge) cannot be matched on the pair. Those still
 * match on either uuid alone, the old key, so an upgrade never re-files a
 * conflict that is already open; the cost is that such a row still absorbs
 * other conflicts on its edge until it is resolved.
 */
export async function fileSameTierScopeDisputes(
  ctx: AccessContext,
  orgId: string,
  scopePath: string,
  contradictions: ScopeContradiction[],
): Promise<string[]> {
  if (!contradictions.length) return [];

  const resolved = await resolveContradictions(ctx, orgId, scopePath, contradictions);
  const disputeIds: string[] = [];

  for (const c of resolved) {
    // graphiti_fact_uuid is NOT NULL — both sides must be real, matched edges.
    if (!c.existing || !c.proposer) continue;
    // Same-tier only (docs/willder_conflict_resolution.md): a tier mismatch has a
    // ranked outcome (human > agent > extraction) that belongs to an explicit
    // correction, not an automatic background scan.
    if (c.existing.actorType !== c.proposer.actorType) continue;

    const pair = [c.existing.uuid, c.proposer.uuid];
    const already = await db.factDispute.findFirst({
      where: {
        orgId,
        scopePath,
        status: "disputed",
        OR: [
          { graphitiFactUuid: pair[0], proposerFactUuid: pair[1] },
          { graphitiFactUuid: pair[1], proposerFactUuid: pair[0] },
          { graphitiFactUuid: { in: pair }, proposerFactUuid: null },
        ],
      },
      select: { id: true },
    });
    if (already) {
      disputeIds.push(already.id);
      continue;
    }

    const dispute = await openFactDispute({
      orgId,
      scopePath,
      graphitiFactUuid: c.existing.uuid,
      proposerFactUuid: c.proposer.uuid,
      proposerActorType: c.proposer.actorType,
      proposerActorId: c.proposer.actorId,
      existingActorType: c.existing.actorType,
      existingActorId: c.existing.actorId,
    });
    disputeIds.push(dispute.id);
  }
  return disputeIds;
}
