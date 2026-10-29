// Whether a brief is stale: whether something it was derived from changed after it
// was generated.
//
// A brief records what it was derived from in two places: the facts its sections cite
// (`BriefCitation`, brief-citations.ts) and the connected sources its generating run
// read (`BriefProvenance`, brief-retirement.ts). The rule this file enforces: a brief
// with that record reads stale exactly when one of those changed since it was
// generated, meaning a cited fact is no longer current, or a source it read replaced or
// removed an item. A write anywhere else in its scope leaves it fresh, because a brief
// cannot be out of date about something it never drew on.
//
// A brief without a provenance row (generated before the row existed, or by a run that
// could not see every memory read it made) has no complete record of what it read. It
// falls back to its scope: stale when any write landed under its scope since it was
// generated, or a cited fact moved. That over-approximates on purpose, as
// brief-retirement.ts's fallback does, so no brief derived from a change is missed.
//
// Known limit: on the derivation basis, an agent-written fact the run read but did
// not cite is not tracked, because provenance records sources, not fact ids. A brief
// built on such a fact goes stale only through its citations.
import { db } from "@/lib/db";
import { auditChangesUnderScope, type AccessContext } from "@/services/access";
import { connectorActorId } from "@/services/access/system-actors";
import { checkBriefCitations, type CitationCheck, type CitationStatus } from "./brief-citations";

/** A cited fact in one of these states no longer says what the brief quoted. */
const MOVED_CITATION: ReadonlySet<CitationStatus> = new Set(["changed", "superseded", "gone"]);

export interface BriefStaleness {
  stale: boolean;
  /**
   * `derivation` when the verdict rests on what the brief recorded it was derived
   * from; `scope` when the brief recorded no provenance and the verdict fell back to
   * any write under its scope.
   */
  basis: "derivation" | "scope";
  /** Each cited fact, re-checked at the brief's scope (brief-citations.ts). */
  citations: CitationCheck[];
  /** Writes that landed under the brief's scope since it was generated, oldest first, at most `changeLimit`. */
  changes: Array<{ action: string; target: string | null; at: Date }>;
}

/**
 * The staleness verdict for one brief, as its reader sees it.
 *
 * @param brief a brief the caller has already been allowed to read.
 * @param changeLimit most scope changes to return; the verdict itself needs one.
 * @throws AccessDeniedError when `ctx` may not read the brief's scope.
 */
export async function checkBriefStaleness(
  ctx: AccessContext,
  brief: { id: string; orgId: string; scopePath: string; createdAt: Date },
  changeLimit = 1,
): Promise<BriefStaleness> {
  const [citations, changes, provenance] = await Promise.all([
    checkBriefCitations(ctx, { id: brief.id, orgId: brief.orgId, scopePath: brief.scopePath }),
    auditChangesUnderScope({
      orgId: brief.orgId,
      scopePath: brief.scopePath,
      after: brief.createdAt,
      // The brief's own persist/correct writes are tagged with this target and are not a change to it.
      excludeTarget: `${brief.scopePath}/brief:${brief.id}`,
      limit: Math.max(changeLimit, 1),
    }),
    db.briefProvenance.findUnique({ where: { briefId: brief.id }, select: { sourceIds: true } }),
  ]);

  const citationMoved = citations.some((citation) => MOVED_CITATION.has(citation.status));
  if (provenance === null) {
    return { stale: citationMoved || changes.length > 0, basis: "scope", citations, changes };
  }
  const stale = citationMoved || (await sourceChangedSince(brief.orgId, provenance.sourceIds, brief.createdAt));
  return { stale, basis: "derivation", citations, changes };
}

/**
 * Whether any of these sources replaced or removed an item after `since`, read off
 * the change events a connector sync writes for each retired episode
 * (content-change-event.ts). A new item is not a change to what was read. A source
 * that no longer exists took all its content with it, so it counts as changed.
 */
async function sourceChangedSince(orgId: string, sourceIds: string[], since: Date): Promise<boolean> {
  if (sourceIds.length === 0) return false;
  const sources = await db.source.findMany({
    where: { orgId, id: { in: sourceIds } },
    select: { id: true, type: true },
  });
  if (sources.length < sourceIds.length) return true;

  const event = await db.changeEvent.findFirst({
    where: {
      orgId,
      actorId: { in: sources.map(connectorActorId) },
      op: { in: ["supersede", "delete"] },
      createdAt: { gt: since },
    },
    select: { id: true },
  });
  return event !== null;
}
