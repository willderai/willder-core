// Change-feed events for content that arrives from outside a memory write:
// connector items (Slack, Figma, PostHog, Drive) and uploaded files.
//
// A connector item is one Graphiti episode, or one per extracted chunk for a Drive
// file, tracked by a `SourceFile` row that names them. The rule this file enforces for items: an episode's event is written in the same
// transaction as the `SourceFile` write that records that episode's new state, so the
// feed and the sync record cannot disagree about which episodes a source has live.
// An uploaded file has no such row; its event is written once every store write for the
// file has resolved, as a memoized step of the job, like `recordIngestApplied`, or, for a
// file extracted inline, in the transaction that stores its passages.
//
// Imported by its own path rather than through `services/memory`'s barrel, like
// `fact-change-event`, so `lib/inngest.ts` does not pull the barrel in twice.
import { db } from "@/lib/db";
import { orgRootPath } from "@/services/access";
import type { AuditOrigin } from "@/services/access/origin";
import type { ActorType } from "@/types/memory";
import { recordChangeEvent, type ChangeEventTransaction } from "./change-events";
import { FACT_RECORD_TYPE } from "./change-events";

/** Change-feed name for an uploaded file. Its `recordId` is the ingest job's event
 * id: the `jobId` an upload returns. */
const DOCUMENT_RECORD_TYPE = "document";

/**
 * One connector-item episode whose state a sync just changed.
 *
 * Only a `create` carries the item's text. A `supersede` or `delete` is announced in
 * the scope the old episode was removed from, and a reconnect can move a source's
 * scope between syncs, so that scope is not always where the item's current text
 * lives. The replacing text reaches its own readers through the `create` of the
 * episode that replaces it; putting it on the `supersede` would show it to readers
 * of the old scope who cannot read the new one.
 */
export type SourceItemChange = {
  orgId: string;
  /** The scope the episode was written to, or removed from: where its readers are. */
  scopePath: string;
  episodeId: string;
  /** The connector's sync actor, e.g. `slack-sync:<sourceId>`. */
  actorId: string;
  /**
   * The connect that authorizes this source to write into this scope:
   * `Source.connectAuthorizationId`, the visible `memory.write` allow row `check()` wrote
   * for the `sources:connect` request (app/api/sources/route.ts).
   *
   * A sync runs no `check()` of its own, so this is the only authorization a sync write
   * genuinely has, and it is the one the audit trail should name: it is scoped to the
   * scope being written and it names the person who connected the source. It is not the
   * writer -- the writer is `actorId`, the source itself -- and the two answer different
   * questions (`GET /api/audit/timeline/:changeId` returns `authorizationKind: "connect"`
   * so a reader is told which it is reading).
   *
   * Null for a source connected before the column existed: the event then records no
   * authorization, which reads as a missing answer, rather than
   * borrowing an unrelated row.
   */
  authorizedById: string | null;
} & (
  | {
      /** A fresh ingest. */
      op: "create";
      /** The item's text. A Drive file's name stands in for its text. */
      title: string;
    }
  | {
      /** `supersede` for the episode an upstream edit replaced, `delete` for one
       * whose item vanished upstream. */
      op: "supersede" | "delete";
    }
);

/**
 * Append one connector item's change event, inside the transaction that writes its
 * `SourceFile` row. The episode is announced as a fact, the same record type an
 * ingest through `memory_ingest` uses, because a reader queries and removes both
 * the same way.
 */
export function recordSourceItemChange(
  tx: ChangeEventTransaction,
  change: SourceItemChange,
): Promise<{ id: string; seq: bigint }> {
  return recordChangeEvent(tx, {
    orgId: change.orgId,
    scopePath: change.scopePath,
    recordType: FACT_RECORD_TYPE,
    recordId: change.episodeId,
    op: change.op,
    actorId: change.actorId,
    // A sync is the system acting on a connected source, never a person or an agent.
    actorType: "extraction",
    origin: "connector-sync",
    title: change.op === "create" ? change.title : "",
    authorizedById: change.authorizedById ?? undefined,
  });
}

/** The fields of a file ingest its change event is built from. */
export interface IngestedDocument {
  orgId: string;
  /** Omitted means the org root, the same default the store writes used. */
  scopePath?: string;
  actorId: string;
  actorType: ActorType;
  /** The entry point the upload came in through. */
  origin: AuditOrigin;
  filename: string;
  /** The audit row of the `memory.write` allow decision that gated the upload. */
  authorizedById?: string;
}

/**
 * Record that one file's content was written to memory: a `create` event for the
 * document. Call it only once the file's content is stored: after every store write
 * has resolved, as its own job step, so a retry replays the memoized result instead of
 * announcing the file twice; or inside `tx`, the transaction that stores the content,
 * so the event commits exactly when the content does.
 *
 * @param documentId the ingest job's event id, or the id an inline upload returned.
 * @param tx the transaction to write in; without one, the event gets its own.
 */
export async function recordDocumentIngested(
  document: IngestedDocument,
  documentId: string,
  tx?: ChangeEventTransaction,
): Promise<void> {
  const record = (client: ChangeEventTransaction) =>
    recordChangeEvent(client, {
      orgId: document.orgId,
      scopePath: document.scopePath ?? orgRootPath(document.orgId),
      recordType: DOCUMENT_RECORD_TYPE,
      recordId: documentId,
      op: "create",
      actorId: document.actorId,
      actorType: document.actorType,
      origin: document.origin,
      title: document.filename,
      authorizedById: document.authorizedById,
    });
  if (tx) await record(tx);
  else await db.$transaction(record);
}

/** One uploaded file's removal, as its change event names it. */
export interface RemovedDocument {
  orgId: string;
  /** The scope the file was written to: where its readers are. */
  scopePath: string;
  /** The id its `create` event carried. */
  documentId: string;
  actorId: string;
  actorType: ActorType;
  origin: AuditOrigin;
  /** The audit row of the `memory.delete` allow decision that gated the removal. */
  authorizedById?: string;
}

/**
 * Record that an uploaded file was removed: a `delete` event for its document, written
 * inside `tx`, the transaction that removes its passages.
 */
export async function recordDocumentRemoved(tx: ChangeEventTransaction, document: RemovedDocument): Promise<void> {
  await recordChangeEvent(tx, {
    orgId: document.orgId,
    scopePath: document.scopePath,
    recordType: DOCUMENT_RECORD_TYPE,
    recordId: document.documentId,
    op: "delete",
    actorId: document.actorId,
    actorType: document.actorType,
    origin: document.origin,
    title: "",
    authorizedById: document.authorizedById,
  });
}
