// Fact provenance: app-state (Postgres) above the Graphiti graph that links a
// confirmed fact to the PR/commit/file it was recorded from and flags it when
// that source moves on. Same "governance sits above the graph, references the
// edge uuid" shape as services/memory/fact-disputes.ts — this is provenance-linking
// + a staleness flag, not a new write-governance engine.
//
// Deliberately caller-reported, not self-polling: there is no GitHub/git
// integration here, so checkFactStaleness() only ever compares a
// caller-supplied `currentRevision` against what was recorded — it never
// reaches out to GitHub itself. A caller that already has git access (CI, a
// webhook, a human) reports "sourceRef X is now at revision Y."
import { db } from "@/lib/db";
import { check, type AccessContext } from "@/services/access";
import { guardedMemory } from "@/services/memory";
import { keepServedAnchors } from "./raw-rows";
import type { FactSourceType, FactProvenanceStatus } from "@/lib/generated/prisma/client";

export interface RecordFactProvenanceInput {
  orgId: string;
  scopePath: string;
  graphitiFactUuid: string;
  sourceType: FactSourceType;
  sourceRef: string;
  recordedRevision?: string;
  ownerId: string;
}

/**
 * The fact a caller named does not exist in the scope they are writing to.
 *
 * Carries no detail about why: a fact in another scope or another tenant and a
 * uuid that was never real both raise this, with the same message, so the
 * failure cannot be used to probe for facts outside the caller's own grant.
 */
export class UnresolvedFactError extends Error {
  constructor(readonly graphitiFactUuid: string) {
    super("fact not found in this scope");
    this.name = "UnresolvedFactError";
  }
}

/**
 * Link a confirmed fact to its source.
 *
 * `graphitiFactUuid` arrives from the client at both doors (the REST route's
 * path segment, the MCP tool's argument), so it is resolved through the
 * tenant-scoped memory service before anything is written — a uuid is an
 * opaque string the caller chose, never evidence that the fact is real or
 * theirs. Without this, a caller with write access to any one scope could mint
 * a provenance row against an arbitrary uuid, including a real fact belonging
 * to a scope they cannot read. `openFactDispute`'s callers take the uuid out
 * of a scope-enforced read, and this does the same.
 *
 * The resolution runs here rather than at each door so a third writer cannot
 * reintroduce the gap by forgetting it.
 *
 * Idempotency is still intentionally NOT enforced — the same fact can be
 * backed by more than one source over time (e.g. a decision reaffirmed in a
 * later PR), same convention as openFactDispute().
 *
 * @throws UnresolvedFactError if the uuid names no fact in `input.scopePath`.
 * @throws AccessDeniedError if `ctx` cannot read `input.scopePath` at all.
 */
export async function recordFactProvenance(ctx: AccessContext, input: RecordFactProvenanceInput) {
  const fact = await guardedMemory.findFact(
    ctx,
    { groupId: input.orgId, factId: input.graphitiFactUuid },
    input.scopePath,
  );
  if (!fact) throw new UnresolvedFactError(input.graphitiFactUuid);

  // Persist the uuid the store resolved, not the one the caller sent: the row
  // is bound to the fact that was actually found.
  return db.factProvenance.create({
    data: { ...input, graphitiFactUuid: fact.uuid, status: "fresh" },
  });
}

/**
 * The provenance rows recorded for one fact that the caller may read, newest
 * first. A fact's rows are not guaranteed to share one scope, so each is decided
 * against its own `scopePath` (each decision audited) and a caller never learns
 * about a link recorded outside their own grant.
 */
export async function listReadableFactProvenance(ctx: AccessContext, graphitiFactUuid: string) {
  // On a tier whose reads do not include the graph, a link anchored on a graph edge is not
  // served, since the edge is not either; one anchored on a raw row is.
  const rows = await keepServedAnchors(
    ctx.orgId,
    await db.factProvenance.findMany({
      where: { orgId: ctx.orgId, graphitiFactUuid },
      orderBy: { createdAt: "desc" },
    }),
  );
  const visible = [];
  for (const row of rows) {
    const decision = await check(ctx, {
      action: "memory.read",
      scope: row.scopePath,
      target: `fact_provenance:${row.id}`,
    });
    if (decision.allowed) visible.push(row);
  }
  return visible;
}

export interface CheckFactStalenessInput {
  orgId: string;
  /** Matched together with sourceRef: sourceRef alone
   *  is free-form text, so a PR/commit/file link that happens to reuse the same
   *  reference string as another type would otherwise all flip stale together on
   *  one type's revision report. */
  sourceType: FactSourceType;
  sourceRef: string;
  currentRevision: string;
  reason?: string;
}

export interface CheckFactStalenessResult {
  flagged: Array<{ id: string; graphitiFactUuid: string; ownerId: string; scopePath: string }>;
  /** Matched rows whose scope this caller's token/grant does not cover — never
   *  written to, same "must never surface or touch a fact outside the caller's
   *  granted scope" discipline as any other access-control boundary here. */
  skippedOutOfScope: string[];
  /** Matched rows with no recordedRevision yet — nothing to compare, left fresh. */
  skippedNoRevision: string[];
}

/**
 * Compare `currentRevision` against every fresh FactProvenance row recorded for
 * `sourceRef` in this org. A mismatch flips the row to `potentially_stale` and
 * stamps `flaggedAt`/`flaggedReason` — it NEVER deletes or mutates the underlying
 * fact, only this governance row (owner review happens through the normal
 * approval-inbox-style surface, follow-on UI, not here).
 *
 * Enforced per-row, not once for the whole batch: `ctx`'s token/grant is checked
 * against EACH matched row's own `scopePath` before that row is touched OR
 * bucketed into any counter. A `sourceRef` can legitimately have provenance
 * rows in more than one scope (two different teams both cited the same PR); a
 * caller must never flag, or even learn about the existence of, a row outside
 * what their own token covers — that includes a `skippedNoRevision` count,
 * not just `flagged`/`skippedOutOfScope`. The scope check runs before the
 * no-revision check for exactly this reason: a row this caller can't see must
 * land in `skippedOutOfScope`, never in `skippedNoRevision`, regardless of
 * whether it happens to have no recorded revision. The reverse ordering would
 * let an out-of-scope row with no recordedRevision skip the check() call
 * entirely and surface through the no-revision count.
 */
export async function checkFactStaleness(
  ctx: AccessContext,
  input: CheckFactStalenessInput,
): Promise<CheckFactStalenessResult> {
  const candidates = await db.factProvenance.findMany({
    where: { orgId: input.orgId, sourceType: input.sourceType, sourceRef: input.sourceRef, status: "fresh" },
  });

  const flagged: CheckFactStalenessResult["flagged"] = [];
  const skippedOutOfScope: string[] = [];
  const skippedNoRevision: string[] = [];

  for (const row of candidates) {
    if (row.recordedRevision === input.currentRevision) {
      continue; // still fresh, nothing to do — never counted, no scope check needed
    }

    const decision = await check(ctx, {
      action: "memory.write",
      scope: row.scopePath,
      target: `fact_provenance:${row.id}`,
    });
    if (!decision.allowed) {
      skippedOutOfScope.push(row.id);
      continue;
    }

    if (!row.recordedRevision) {
      skippedNoRevision.push(row.id);
      continue;
    }

    const reason = input.reason ?? `${input.sourceRef} moved from ${row.recordedRevision} to ${input.currentRevision}`;
    // updateMany with `status: "fresh"` still in the WHERE predicate, not a
    // plain update-by-id: two concurrent revision reports
    // both reading this row as `fresh` could otherwise both "win" the read-then-
    // write race, and the later write would silently replace the first
    // transition's flaggedAt/flaggedReason with unrelated revision details. Only
    // the report whose write actually transitions the row (count === 1) counts
    // it as flagged; a report that loses the race treats the row as already
    // claimed by someone else's transition, not a second flag of its own.
    const { count } = await db.factProvenance.updateMany({
      where: { id: row.id, status: "fresh" },
      data: {
        status: "potentially_stale" satisfies FactProvenanceStatus,
        flaggedAt: new Date(),
        flaggedReason: reason,
      },
    });
    if (count === 0) continue;
    flagged.push({
      id: row.id,
      graphitiFactUuid: row.graphitiFactUuid,
      ownerId: row.ownerId,
      scopePath: row.scopePath,
    });
  }

  return { flagged, skippedOutOfScope, skippedNoRevision };
}
