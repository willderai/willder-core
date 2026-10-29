/**
 * Withdrawing the briefs a moved or disconnected source could have fed.
 *
 * A brief is a copy: its sections are text an agent wrote from what it
 * retrieved at the brief's scope. Retiring a source's chunks and facts
 * (`source-retirement.ts`) does not reach that copy, so before this a brief
 * kept serving the content at a scope the content had left.
 *
 * The rule this file enforces: once a source's content stops being readable at
 * a brief's scope, the brief stops being readable too. A brief at scope S
 * retrieves from S and everything below it, so it can hold a source's content
 * exactly when it was created after the source and S covers a scope that
 * source wrote to. Such a brief is retired when the source is disconnected, or
 * moved to a scope S does not cover. A move that stays inside S changes
 * nothing for S's readers, who can still read the content where it went.
 *
 * A brief whose generating run recorded the sources it read (its
 * `BriefProvenance` row) is retired only when that list names the source. A
 * brief without the row falls back to scope and time alone, which
 * over-approximates on purpose: a brief that never used the source is withdrawn
 * with the ones that did, and none that did is missed. Only a run that sees
 * every memory read it makes may write the row, since a list missing a source
 * would keep a brief readable after that source's content left.
 *
 * Each source that withdraws a brief records its own retirement row, even when
 * another source has already withdrawn the brief, and the brief stays withdrawn
 * while any row remains. An org admin can waive one source the fallback
 * withdrew a brief for (`unretireBrief`), but never a source the brief's own
 * provenance names, and never a row written before rows were kept per source.
 * The ruling is kept as a waiver for that one source, so its next move does not
 * withdraw the brief again; the brief reads again only once no other source's
 * row is left.
 */

import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { pathCovers, type DerivedAuditAction } from "@/services/access";
import { writeAuditRow } from "@/services/access/audit-row";
import type { AuditOrigin } from "@/services/access/origin";

export const BRIEF_RETIREMENT_REASON = {
  sourceMoved: "source_moved",
  sourceDisconnected: "source_disconnected",
} as const;

/**
 * The filter every brief read adds. A retired brief reads as absent everywhere,
 * the same as an id that was never issued, so retirement cannot be probed.
 */
export const NOT_RETIRED = { retirements: { none: {} } } as const;

/**
 * Whether the brief has been retired. For a copy of a brief's content kept
 * outside the brief row, such as the `done` event a run stores, where
 * `NOT_RETIRED` cannot be added to the read: a brief query that finds nothing
 * cannot tell a retired brief from a deleted one.
 */
export async function isBriefRetired(briefId: string): Promise<boolean> {
  const retirement = await db.briefRetirement.findFirst({ where: { briefId }, select: { briefId: true } });
  return retirement !== null;
}

/**
 * Store which sources a brief's generating run read, inside the transaction
 * that creates the brief.
 *
 * @param sourceIds every `Source.id` the run's memory reads returned content
 *   from. Pass it only from a run that recorded all of its reads.
 */
export async function recordBriefProvenance(
  tx: Prisma.TransactionClient,
  briefId: string,
  sourceIds: Iterable<string>,
): Promise<void> {
  await tx.briefProvenance.create({ data: { briefId, sourceIds: [...new Set(sourceIds)].sort() } });
}

export interface BriefRetiringSource {
  id: string;
  orgId: string;
}

/**
 * Retire every brief in the source's org that could hold content the source
 * wrote under `ingestedScopePaths` and that can no longer read it.
 *
 * A brief another source has already withdrawn still gets this source's row, so
 * waiving the other source later cannot bring back content this one took away.
 *
 * @param source the source being moved or disconnected.
 * @param ingestedScopePaths every scope the source's content was written to.
 * @param movedTo the scope the source now points at, or null for a disconnect.
 * @returns how many briefs this source newly withdrew, counting ones another
 *   source had already withdrawn. Idempotent: 0 the second time.
 */
export async function retireBriefsFedBySource(
  source: BriefRetiringSource,
  ingestedScopePaths: string[],
  movedTo: string | null,
): Promise<number> {
  const row = await db.source.findUnique({
    where: { id: source.id },
    select: { orgId: true, createdAt: true },
  });
  if (!row || row.orgId !== source.orgId) return 0;

  const candidates = await db.brief.findMany({
    where: {
      orgId: source.orgId,
      createdAt: { gte: row.createdAt },
      retirementWaivers: { none: { sourceId: source.id } },
    },
    select: { id: true, scopePath: true, provenance: { select: { sourceIds: true } } },
  });

  const retiring = candidates.filter(
    (brief) =>
      (brief.provenance === null || brief.provenance.sourceIds.includes(source.id)) &&
      ingestedScopePaths.some((path) => pathCovers(brief.scopePath, path)) &&
      (movedTo === null || !pathCovers(brief.scopePath, movedTo)),
  );
  if (retiring.length === 0) return 0;

  const reason = movedTo === null ? BRIEF_RETIREMENT_REASON.sourceDisconnected : BRIEF_RETIREMENT_REASON.sourceMoved;
  const { count } = await db.briefRetirement.createMany({
    data: retiring.map((brief) => ({ briefId: brief.id, sourceId: source.id, reason })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Why `unretireBrief` waived nothing: the brief is not withdrawn by the named
 * source (or by any, when none is named), its provenance names that source, or
 * several sources withdrew it and the caller did not say which one to waive, or
 * the row was written before retirements were kept per source (`legacy`).
 */
export type UnretireRefusal = "not_retired" | "read_the_source" | "source_required" | "legacy";

export type UnretireResult =
  | { refusal: UnretireRefusal; retiredBy: string[] }
  /** The source was waived; the brief reads again once `retiredBy` is empty. */
  | { refusal: null; retiredBy: string[] };

/**
 * Waive one source that withdrew a retired brief, remove that source's
 * retirement row, and record who did it, in one transaction. The brief is
 * readable again only when no other source's row remains. The caller has already
 * established that `actor` holds `access.manage` at the brief's scope.
 *
 * Refused with `read_the_source` when the brief's own provenance names the
 * source: that brief does quote content which has left its scope, and only a new
 * brief generated from what the scope holds now can replace it.
 *
 * Refused with `legacy` for a row written before retirements were kept per
 * source: another source may have withdrawn the brief then without a row, so
 * waiving this one could serve that source's content again.
 *
 * @param params.sourceId the source to waive. May be omitted only when exactly
 *   one source withdrew the brief.
 * @returns the refusal, or null, with the sources still withdrawing the brief.
 */
export async function unretireBrief(params: {
  orgId: string;
  briefId: string;
  sourceId?: string;
  actor: { type: "human" | "agent"; id: string };
  /** The entry point the waiver came in through. */
  origin: AuditOrigin;
}): Promise<UnretireResult> {
  const { orgId, briefId, actor } = params;
  return db.$transaction(async (tx) => {
    const brief = await tx.brief.findFirst({
      where: { id: briefId, orgId },
      select: {
        scopePath: true,
        retirements: { select: { sourceId: true, reason: true, legacy: true }, orderBy: { createdAt: "asc" } },
        provenance: { select: { sourceIds: true } },
      },
    });
    const retiredBy = brief?.retirements.map((row) => row.sourceId) ?? [];
    if (!brief || retiredBy.length === 0) return { refusal: "not_retired", retiredBy };
    if (params.sourceId === undefined && retiredBy.length > 1) return { refusal: "source_required", retiredBy };

    const retirement = brief.retirements.find((row) => row.sourceId === (params.sourceId ?? retiredBy[0]));
    if (!retirement) return { refusal: "not_retired", retiredBy };
    const { sourceId, reason } = retirement;
    if (brief.provenance?.sourceIds.includes(sourceId)) return { refusal: "read_the_source", retiredBy };
    if (retirement.legacy) return { refusal: "legacy", retiredBy };

    // Matched on the source too, so only the row checked above is removed, and
    // a concurrent un-retire of the same row removes nothing here.
    const { count } = await tx.briefRetirement.deleteMany({ where: { briefId, sourceId } });
    if (count === 0) return { refusal: "not_retired", retiredBy };
    const stillRetiredBy = retiredBy.filter((id) => id !== sourceId);
    await tx.briefRetirementWaiver.create({ data: { briefId, sourceId, actorId: actor.id } });
    await writeAuditRow(
      {
        orgId,
        actorType: actor.type,
        actorId: actor.id,
        action: "brief.unretired" satisfies DerivedAuditAction,
        target: `${brief.scopePath}/brief:${briefId}`,
        decision: "allow",
        metadata: { sourceId, reason, stillRetiredBy },
        origin: params.origin,
      },
      tx,
    );
    return { refusal: null, retiredBy: stillRetiredBy };
  });
}
