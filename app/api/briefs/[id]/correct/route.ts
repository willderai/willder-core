// UC9 — human correction of an agent-generated brief (docs/willder_conflict_resolution.md).
// A human flags/corrects a brief; the correction is written back to memory as a HUMAN-authored
// episode (highest provenance), scoped to the brief's scopePath, whatever the governance rule
// decides:
//   - correction contradicts an AGENT/EXTRACTION fact  → human outranks → auto-merge
//     (remove the stale fact; the correction becomes the standing fact, recorded as its
//     replacement). autoMerged: true.
//   - correction contradicts a same-tier HUMAN fact    → open a fact dispute for a scope
//     admin to resolve. autoMerged: false, disputeId set.
//   - no contradiction                                 → clean write. autoMerged: false.
// Contract is fixed (the frontend flag/correct control calls this exact shape).
//
// What can refuse a correction is checked before anything is removed (400 for text Postgres cannot
// store, 402 at the free plan's episode cap). The overruled fact is removed first, so the
// correction can name that removal (`correctionOf`); when the correction then cannot be
// queued, the 503 says the fact is gone and what to do.
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { briefWriteDenied } from "@/lib/brief-access";
import { AccessDeniedError, type AccessContext } from "@/services/access";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import { briefCorrectionName } from "@/services/memory/correction-names";
import { FactAlreadyReplacedError } from "@/services/memory/fact-update";
import { RemovalNotRecordedError } from "@/services/memory/fact-change-event";
import { checkEpisodeCap, GuardrailError } from "@/services/guardrails";
import { ingestMemory } from "@/lib/inngest";
import { findContradiction } from "@/services/facts/conflicts";
import { openFactDispute } from "@/services/memory/fact-disputes";
import { unstorableText } from "@/lib/unstorable-text";
import { recordFeedback } from "@/services/signals";
import type { IngestInput } from "@/types/memory";
import { authorizeBrief } from "@/services/memory/briefs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  let body: { sectionHeading?: string; correction?: string };
  try {
    body = (await req.json()) as { sectionHeading?: string; correction?: string };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["correction", "sectionHeading"]);
  if (wrongType) return Response.json({ error: wrongType }, { status: 400 });
  // Refused before the contradiction search and the write: Postgres cannot store a NUL,
  // and ingestMemory's refusal of one would otherwise surface as a 500 that names nothing.
  const unstorable = unstorableText({ correction: body.correction, sectionHeading: body.sectionHeading });
  if (unstorable) return Response.json({ error: unstorable.message }, { status: 400 });
  const correction = body.correction?.trim();
  if (!correction) return Response.json({ error: "correction is required" }, { status: 400 });

  // A correction is a memory write; auto-merge invalidation (memory.delete) is covered
  // by write+, so gate once on memory.write over the brief's scope.
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.write", target: `brief:${id}` });
  if (access.status !== "allowed") return briefWriteDenied(rc.ctx, access);
  const scopePath = access.brief.scopePath;

  // Refused before the contradiction search, and before any fact is removed.
  try {
    await checkEpisodeCap(rc.org.id);
  } catch (e) {
    if (e instanceof GuardrailError) return Response.json({ error: e.message }, { status: 402 });
    throw e;
  }

  // Detect a contradiction (broad semantic retrieve + LLM judge) BEFORE we ingest the
  // correction, so we're comparing against the prior fact set — and so we know the
  // contradicted edge's provenance to pick auto-merge vs dispute.
  const { contradiction, complete } = await findContradiction(rc.ctx, rc.org.id, scopePath, correction);
  const overrule =
    contradiction && contradiction.actorType !== "human"
      ? await removeOverruledFact(rc.ctx, contradiction.uuid, scopePath, correction)
      : null;

  // Always record the correction as a HUMAN episode — the durable record of the human's
  // input, regardless of how the conflict resolves.
  try {
    await ingestMemory({
      groupId: rc.org.id,
      content: body.sectionHeading ? `Regarding "${body.sectionHeading}": ${correction}` : correction,
      source: "text",
      // Each person's corrections of a brief are their own fact: two people's corrections are
      // not two versions of one fact, which the conflict rule would settle by hiding one. A
      // correction that overruled a fact names it, so the name is that correction's alone.
      name: briefCorrectionName(id, rc.user.id, overrule?.correctionOf?.factId),
      actorType: "human",
      origin: rc.ctx.origin,
      actorId: rc.user.id,
      actorName: rc.user.name ?? undefined,
      scopePath,
      authorizedById: access.decision.auditLogId,
      // Same self-write tag persist/route.ts uses — see its own comment (item
      // handoff-staleness-flag-ordering-20260919).
      auditTag: `brief:${id}`,
      correctionOf: overrule?.correctionOf,
    });
  } catch (e) {
    if (overrule?.removed) {
      console.error(`[briefs] brief ${id}'s correction was not queued after its overruled fact was removed:`, e);
      return Response.json(
        {
          error:
            "The fact this corrects was removed, but your correction was not confirmed as saved. If it does not show in memory within a minute, submit it again.",
          factRemoved: true,
        },
        { status: 503 },
      );
    }
    if (e instanceof GuardrailError) return Response.json({ error: e.message }, { status: 402 });
    throw e;
  }
  if (overrule?.failure) return overrule.failure;

  // Same-tier (human vs human) → open a fact dispute; nothing flips until resolved.
  const disputeId =
    contradiction?.actorType === "human"
      ? (
          await openFactDispute({
            orgId: rc.org.id,
            scopePath,
            graphitiFactUuid: contradiction.uuid,
            proposerActorType: "human",
            proposerActorId: rc.user.id,
            existingActorType: "human",
            existingActorId: contradiction.actorName ?? "unknown",
          })
        ).id
      : undefined;
  const autoMerged = overrule?.removed ?? false;

  // Extend the existing feedback-signal mechanism to corrections (fire-and-forget).
  await recordFeedback({
    eventType: "edited",
    orgId: rc.org.id,
    actorId: rc.user.id,
    originalBody: contradiction?.fact ?? "",
    editedBody: correction,
    meta: { briefId: id, scopePath, autoMerged, disputeId, sectionHeading: body.sectionHeading },
  });

  // A check whose read did not search everything found no contradiction only in what it
  // searched; say so rather than let the absence of a dispute read as "none exists".
  return Response.json({
    ok: true,
    autoMerged,
    disputeId,
    ...(complete ? {} : { contradictionCheckIncomplete: true }),
  });
}

/** What removing the fact a correction overrules did. */
interface Overrule {
  /** Whether the fact is gone: the correction is then auto-merged, and must not be lost without a word. */
  removed: boolean;
  /** The removal the correction names, when it was recorded (`IngestInput.correctionOf`). */
  correctionOf?: IngestInput["correctionOf"];
  /** The answer to give once the correction is recorded, when the removal failed. */
  failure?: Response;
}

/**
 * Remove the agent's or extraction's fact a person's correction overrules. A fact already
 * replaced by another version is left to it; a removal that fails leaves the fact, and its
 * answer says the correction was saved anyway.
 */
async function removeOverruledFact(
  ctx: AccessContext,
  factId: string,
  scopePath: string,
  correction: string,
): Promise<Overrule> {
  try {
    const removal = await guardedMemory.removeFact(ctx, { groupId: ctx.orgId, factId }, scopePath, correction);
    const version = removal.removedVersion;
    return {
      removed: removal.removed,
      correctionOf: version ? { factId, removalId: version.changeId, scopePath: version.scopePath } : undefined,
    };
  } catch (e) {
    if (e instanceof RemovalNotRecordedError) {
      // Gone, though the change feed does not say so: the correction names no removal.
      console.error(`[briefs] ${e.message}`);
      return { removed: true };
    }
    if (e instanceof FactAlreadyReplacedError) return { removed: false };
    const saved = "Your correction was saved, but the fact it overrules was not removed";
    if (e instanceof AccessDeniedError) {
      return { removed: false, failure: Response.json({ error: `${saved}: ${e.decision.reason}` }, { status: 403 }) };
    }
    if (e instanceof MemoryServiceError) {
      return { removed: false, failure: Response.json({ error: `${saved}: ${e.message}` }, { status: 502 }) };
    }
    console.error(`[briefs] removing fact ${factId} for a correction failed:`, e);
    return { removed: false, failure: Response.json({ error: `${saved}.` }, { status: 500 }) };
  }
}
