// The one way a Brief row is created: the row and its change-feed event commit together.
//
// A brief is a governed write other agents act on (a handoff, an architecture plan, a
// QA review), so it belongs on the real-time change feed (services/memory/change-feed.ts).
// The rule this file enforces: the Brief insert and its `change_events` row share one
// transaction, so the feed never announces a brief that rolled back and never misses
// one that committed. The event's scope and title are read off the row just written,
// never passed in separately, so they cannot disagree with what a reader can open.
// The facts the brief cited commit in the same transaction, so a brief never exists
// without the citations its staleness check reads.
import { db } from "@/lib/db";
import type { Brief, Prisma } from "@/lib/generated/prisma/client";
import { recordBriefCitations, type BriefCitationInput } from "@/services/memory/brief-citations";
import { recordBriefProvenance } from "@/services/memory/brief-retirement";
import { recordChangeEvent, type ChangeAuthor } from "@/services/memory/change-events";

/** Change-feed name for a Brief row. */
export const BRIEF_RECORD_TYPE = "brief";

/**
 * Insert a Brief and append its `create` change event in the same transaction.
 *
 * @param data the Brief row, exactly as `db.brief.create` would take it.
 * @param author the agent (or user) that produced the brief, and where it came in.
 *   Its id is never a capability token.
 * @param citations the facts the brief's sections rest on, already bounded
 *   (services/memory/brief-citations.ts boundCitations).
 * @param sourcesRead every source the generating run read, when the run saw all of
 *   its memory reads; stored with the brief so retiring a source withdraws only the
 *   briefs that read it. Omit it otherwise.
 * @throws if any write fails; none is then committed.
 */
export async function createBrief(
  data: Prisma.BriefUncheckedCreateInput,
  author: ChangeAuthor,
  citations: BriefCitationInput[] = [],
  sourcesRead?: ReadonlySet<string>,
): Promise<Brief> {
  return db.$transaction(async (tx) => {
    const brief = await tx.brief.create({ data });
    await recordBriefCitations(tx, brief.id, citations);
    if (sourcesRead) await recordBriefProvenance(tx, brief.id, sourcesRead);
    await recordChangeEvent(tx, {
      orgId: brief.orgId,
      scopePath: brief.scopePath,
      recordType: BRIEF_RECORD_TYPE,
      recordId: brief.id,
      op: "create",
      ...author,
      title: brief.title,
    });
    return brief;
  });
}
