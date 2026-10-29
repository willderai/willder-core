// Change-feed events for connector Source rows (real-time coordination).
//
// Connecting a source puts new content into a scope and disconnecting one takes it
// back out, so both are governed writes other agents need to hear about, as is an
// admin removing a disconnected source's row. The rule this file enforces: the event's
// scope and title come from the Source row as it was just written, inside the same
// transaction, so the feed can never describe a source in a scope it is not actually in.
//
// Imported by its own path rather than through `services/memory`'s barrel, like
// `source-retirement`, so the source routes do not load every store to get it.
import type { ChangeOp } from "@/lib/generated/prisma/enums";
import type { AuditOrigin } from "@/services/access/origin";
import { recordChangeEvent, type ChangeEventTransaction } from "./change-events";

/** Change-feed name for a Source row. */
const SOURCE_RECORD_TYPE = "source";

/** The fields of a just-written `Source` row that its change event is built from. */
export interface ChangedSource {
  id: string;
  orgId: string;
  scopePath: string;
  name: string;
}

/**
 * Append the change event for a Source write, inside the transaction that made it.
 *
 * @param source the row as returned by the write, not as the request described it.
 * @param op `create` for a first connect; `update` for a reconnect or a disconnect,
 *   since a disconnected row is kept (status `disconnected`) rather than removed;
 *   `delete` when an admin removes that disconnected row.
 * @param actorId the user who connected or disconnected it. Never a capability token.
 * @param origin the entry point the connect or disconnect came in through.
 */
export function recordSourceChange(
  tx: ChangeEventTransaction,
  source: ChangedSource,
  op: Extract<ChangeOp, "create" | "update" | "delete">,
  actorId: string,
  origin: AuditOrigin,
): Promise<{ id: string; seq: bigint }> {
  return recordChangeEvent(tx, {
    orgId: source.orgId,
    scopePath: source.scopePath,
    recordType: SOURCE_RECORD_TYPE,
    recordId: source.id,
    op,
    actorId,
    actorType: "human",
    origin,
    title: source.name,
  });
}
