// Permanently removing a disconnected source's row.
//
// A disconnect (DELETE /api/sources/:id) retires what a source ingested and keeps its
// row, marked `disconnected`. The row is also how a retirement that did not finish is
// finished: a disconnect whose second sweep failed, or a sync write that landed after
// both sweeps, leaves records only another disconnect of the same source can find.
//
// The rule this file enforces: the row goes only once nothing it could still retire is
// left (./source-records.ts counts what is), and its removal commits with its change
// event and its `record.removed` audit row (./record-removal.ts).
import { db } from "@/lib/db";
import { dropSourceBlobs } from "@/lib/source-listing-blobs";
import type { AccessContext } from "@/services/access";
import { recordRemoval } from "./record-removal";
import { recordSourceChange } from "./source-change-event";
import { countSourceRecords, holdsRetirableRecords, type SourceRecordCounts } from "./source-records";

/** What {@link removeDisconnectedSource} did. Every outcome but `deleted` leaves the row. */
export type SourceRemoval =
  | { status: "deleted" }
  | { status: "missing" }
  /** Not disconnected: it still writes into memory. */
  | { status: "connected" }
  /** Disconnected, but records it wrote are still in these scopes. */
  | { status: "recordsRemain"; scopes: SourceRecordCounts[] };

/**
 * Remove source `sourceId` from the caller's org if it is disconnected and holds no
 * records a disconnect would still retire.
 *
 * The caller must already have decided the removal with check(). This does not authorize.
 *
 * @throws MemoryServiceError when the memory service cannot say what the source left
 *   in the graph; nothing is removed.
 */
export async function removeDisconnectedSource(ctx: AccessContext, sourceId: string): Promise<SourceRemoval> {
  const source = await db.source.findFirst({
    where: { id: sourceId, orgId: ctx.orgId },
    select: { id: true, orgId: true, scopePath: true, name: true, type: true, status: true },
  });
  if (!source) return { status: "missing" };
  if (source.status !== "disconnected") return { status: "connected" };

  const remaining = (await countSourceRecords(source)).filter(holdsRetirableRecords);
  if (remaining.length > 0) return { status: "recordsRemain", scopes: remaining };

  const removal = await db.$transaction(async (tx): Promise<SourceRemoval> => {
    // Guarded on the status, so a reconnect landing after the read leaves a live source;
    // a removal racing this one finds nothing and records nothing.
    const { count } = await tx.source.deleteMany({
      where: { id: source.id, orgId: ctx.orgId, status: "disconnected" },
    });
    if (count === 0) {
      const still = await tx.source.count({ where: { id: source.id, orgId: ctx.orgId } });
      return still > 0 ? { status: "connected" } : { status: "missing" };
    }
    await recordSourceChange(tx, source, "delete", ctx.actor.id, ctx.origin);
    await recordRemoval(tx, ctx, {
      kind: "source",
      id: source.id,
      scopePath: source.scopePath,
      sourceType: source.type,
    });
    return { status: "deleted" };
  });
  // Then what its syncs stored in Blob: a listing a dead run left, a Drive file whose
  // extraction did not finish. The removal stands without it: a blob left by a failure
  // here is deleted by org deletion or scripts/blob-orphans.ts.
  if (removal.status === "deleted") {
    await dropSourceBlobs(ctx.orgId, source.id).catch((e: unknown) =>
      console.error(`[source-removal] ${source.id}: a stored file is still to be deleted`, e),
    );
  }
  return removal;
}
