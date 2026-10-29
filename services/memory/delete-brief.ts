// The one way a Brief row is removed: the row, its change-feed event and its audit row
// commit together.
//
// A brief's creation is announced on the change feed (./create-brief.ts), so its
// removal is too, or an agent following the feed would keep acting on a brief that is
// gone. The rule this file enforces: the delete, its `delete` event and its
// `record.removed` audit row (./record-removal.ts) share one transaction. The brief's
// citations, provenance, retirements and waivers go with it (their foreign keys cascade).
import { db } from "@/lib/db";
import type { AccessContext } from "@/services/access";
import { recordChangeEvent } from "@/services/memory/change-events";
import { BRIEF_RECORD_TYPE } from "@/services/memory/create-brief";
import { recordRemoval } from "@/services/memory/record-removal";

/**
 * Permanently remove brief `briefId` from the caller's org, withdrawn or not.
 *
 * The caller must already have decided the removal with check(). This does not authorize.
 *
 * @returns false when the org has no brief with that id.
 */
export async function deleteBrief(ctx: AccessContext, briefId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const brief = await tx.brief.findFirst({
      where: { id: briefId, orgId: ctx.orgId },
      select: { id: true, scopePath: true, title: true, type: true },
    });
    if (!brief) return false;
    // A removal racing this one finds nothing to delete and records nothing.
    const { count } = await tx.brief.deleteMany({ where: { id: brief.id, orgId: ctx.orgId } });
    if (count === 0) return false;
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: brief.scopePath,
      recordType: BRIEF_RECORD_TYPE,
      recordId: brief.id,
      op: "delete",
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      origin: ctx.origin,
      title: `deleted: ${brief.title}`,
    });
    await recordRemoval(tx, ctx, {
      kind: "brief",
      id: brief.id,
      scopePath: brief.scopePath,
      briefType: brief.type,
    });
    return true;
  });
}
