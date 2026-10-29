// Change-feed events for facts: ingests, deletes
// and corrections.
//
// A fact written through `memory_ingest` (or any other caller of `ingestMemory`) lands
// in pgvector and Graphiti through store clients, so there is no Postgres row to share
// a transaction with the way a Brief or a Source has. The rule this file enforces
// instead: the fact's event is written only once a store write that reads are served
// from has really landed, in the same transaction as the confirmed-applied audit row
// for that write. The feed and the audit trail therefore agree: neither says a fact
// exists that failed to store, and a stored fact is never announced by one and missed
// by the other. Which write that is depends on the path (lib/inngest.ts): the request
// path announces its own pgvector row before queueing graph extraction, and a queued
// job that stored both announces once both have landed.
//
// A delete is announced the same way: in one transaction with the confirmed-applied
// `memory.delete` row, and only when the store reports the fact was really removed.
//
// A correction is two writes: the removal of the old fact, announced as a `supersede`,
// and the ingest of the corrected text, announced as a `create`. The ingest names the
// fact it corrects and the removal's own event (`correctionOf`), and its announcement
// records the corrected fact's replacement in the same transaction (`recordCorrection`).
// The `supersede` says what the removed fact was filed under (`correctionTitle`), not the
// corrected text: the text is the `create`'s, and the name is how a person erasure finds
// the correction of a fact filed under that person once the fact itself is gone.
//
// Imported by its own path rather than through `services/memory`'s barrel, like
// `source-change-event`, so `lib/inngest.ts` does not pull the barrel in twice.
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { orgRootPath, recordAppliedChange } from "@/services/access";
import type { AuditOrigin } from "@/services/access/origin";
import type { ActorType, IngestInput } from "@/types/memory";
import {
  FACT_RECORD_TYPE,
  recordChangeEvent,
  recordFactCreateOnce,
  type ChangeEventTransaction,
} from "./change-events";
import { resolveFactContention } from "./conflict";
import { correctionTitle } from "./correction-names";
import { recordReplacements } from "./edges";
import { recordBasedWrite } from "./fact-update";
import { recordUnbasedWrite } from "./fact-reads";
import type { VersionTransaction } from "./pgvector-store";

/**
 * What announcing one ingest decided about the version it stored: current, or superseded
 * by `supersededBy` because its writer had not read that version (`stale-read`) or because
 * another writer stored a version of the fact first inside the contention window
 * (`conflict`).
 */
export type IngestOutcome = { supersededBy: null } | { supersededBy: string; cause: "stale-read" | "conflict" };

/**
 * Record that one ingest was applied: the confirmed-applied audit row and the fact's
 * `create` change event, in one transaction, unless the version it stored is already
 * announced.
 *
 * Call it only after the store write it announces has resolved.
 *
 * Any conflict this version is part of is resolved in the same transaction
 * (services/memory/conflict.ts), so a reader never sees a version announced without
 * the winner that supersedes it. A write based on a version it read (`baseVersion`) is
 * settled by services/memory/fact-update.ts instead: it replaces its base, or, when a
 * newer version got there first, is itself superseded. A write without a base from an
 * agent whose reads are tracked is superseded the same way when it comes from a stale
 * read (services/memory/fact-reads.ts). A replayed call announces nothing and is
 * settled again, which changes nothing and returns the same outcome.
 *
 * @param input the ingest as it was requested; scope, actor and content come from it.
 *   An omitted scope is the org root, the same default the store writes used.
 * @param episodeId the id the store returned for the ingest's own content.
 * @returns which version is current instead of this one, if any, and why: `stale-read`
 *   when the write came from a stale read (its writer is refused), `conflict` when it lost
 *   a conflict inside the contention window (it is kept, and its writer told the winner).
 */
export async function recordIngestApplied(input: IngestInput, episodeId: string): Promise<IngestOutcome> {
  return db.$transaction((tx) => applyIngest(tx, input, episodeId));
}

/**
 * {@link recordIngestApplied} as the work of the transaction that stores the version
 * (`PgvectorMemoryStore.ingestOnce`): the version is announced and settled, under the
 * org's change-feed lock, right after its row is inserted, so the row, its `create` event
 * and its outcome commit together or not at all.
 *
 * Every writer of a new fact version stores it this way. A version stored first and
 * announced in a second transaction is current to every reader until that announcement
 * commits: for as long as it waits on the org's lock, and until the queued job announces
 * it when it fails. A stale write-back read in that gap is served beside the newer
 * version it lost to, which is the lost update the version check exists to prevent.
 */
export function announcedOnStore(input: IngestInput): VersionTransaction<IngestOutcome> {
  return (tx, versionId) => applyIngest(tx, input, versionId);
}

/** The announcement, correction lineage and outcome of one stored version, inside the caller's transaction. */
async function applyIngest(
  tx: Prisma.TransactionClient,
  input: IngestInput,
  versionId: string,
): Promise<IngestOutcome> {
  await announceIngest(tx, input, versionId);
  await recordCorrection(tx, input, versionId);
  return settleIngest(tx, input, versionId);
}

/**
 * Record that one ingest was applied, as {@link recordIngestApplied} does, and say
 * whether this call announced it.
 *
 * For the ingest job, whose content may already be stored: as the row of an earlier
 * identical ingest, which its own writer announced, or as a row stored before versions
 * were announced in the transaction that stores them ({@link announcedOnStore}), which
 * nobody may have announced. A version already announced is left as its announcer
 * settled it.
 *
 * @returns whether this call announced the version.
 */
export async function recordIngestAppliedOnce(input: IngestInput, versionId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const announced = await announceIngest(tx, input, versionId);
    // Recorded whether or not this call announced the version: an identical correction
    // stored earlier is still what replaces the fact this one removed.
    await recordCorrection(tx, input, versionId);
    if (!announced) return false;
    await settleIngest(tx, input, versionId);
    return true;
  });
}

/**
 * Record that version `versionId` replaced the fact `input.correctionOf` names, inside
 * the transaction that announces the version.
 *
 * The correction names the change event that announced its own removal of the fact, and
 * that event is checked here: a `supersede` of that fact in this org. A removal that was
 * refused, failed or removed nothing announced no event, and its correction names none,
 * so lineage never marks a fact that is still stored and served as replaced, nor names a
 * correction that removed nothing as a replacement. A correction stored in another scope
 * than the fact was stored in records nothing, nor does one stored as a version a later
 * one already replaced (`recordReplacements`).
 */
async function recordCorrection(tx: Prisma.TransactionClient, input: IngestInput, versionId: string): Promise<void> {
  const corrected = input.correctionOf;
  if (corrected === undefined) return;
  const removal = await tx.changeEvent.findFirst({
    where: {
      id: corrected.removalId,
      orgId: input.groupId,
      recordType: FACT_RECORD_TYPE,
      recordId: corrected.factId,
      op: "supersede",
    },
    select: { id: true },
  });
  if (!removal) return;
  await recordReplacements(tx, [
    {
      orgId: input.groupId,
      replacementId: versionId,
      replacementScopePath: input.scopePath ?? orgRootPath(input.groupId),
      replacedId: corrected.factId,
      replacedScopePath: corrected.scopePath,
      actor: { type: input.actorType, id: input.actorId },
    },
  ]);
}

/**
 * The fact's `create` event and, when this call wrote it, the confirmed-applied audit
 * row, inside the caller's transaction.
 *
 * One version gets one of each, however many writers or attempts announce it: the event
 * insert is refused by the database for a version already announced
 * (`recordFactCreateOnce`), and the audit row follows the event. A second writer whose
 * identical content landed on the same row keeps its own visible `memory.write` allow
 * row from `check()`; the applied row says the store write landed, and it landed once.
 *
 * @returns whether this call announced the version.
 */
async function announceIngest(tx: Prisma.TransactionClient, input: IngestInput, episodeId: string): Promise<boolean> {
  const scopePath = input.scopePath ?? orgRootPath(input.groupId);
  const event = await recordFactCreateOnce(tx, {
    orgId: input.groupId,
    scopePath,
    recordId: episodeId,
    actorId: input.actorId,
    actorType: input.actorType,
    origin: input.origin,
    title: input.content,
    authorizedById: input.authorizedById,
    task: input.task,
    sessionKey: input.sessionKey,
  });
  if (!event) return false;
  await recordAppliedChange(
    {
      orgId: input.groupId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: "memory.write",
      scopePath,
      tag: input.auditTag,
      origin: input.origin,
    },
    tx,
  );
  return true;
}

/** The conflict outcome of one announced ingest, inside the caller's transaction. */
async function settleIngest(
  tx: Prisma.TransactionClient,
  input: IngestInput,
  episodeId: string,
): Promise<IngestOutcome> {
  const scopePath = input.scopePath ?? orgRootPath(input.groupId);
  // `storedScopePath` is the scope as `memory_chunks` holds it, which is null when
  // the ingest named none — not the org-root default the feed uses — or two
  // versions of one fact would not match each other.
  // Matched exactly as stored: the store writes `name` as given.
  const entityName = input.name;
  if (input.baseVersion !== undefined && entityName?.trim()) {
    const { supersededBy } = await recordBasedWrite(tx, {
      orgId: input.groupId,
      versionId: episodeId,
      baseVersionId: input.baseVersion,
      entityName,
      storedScopePath: input.scopePath ?? null,
      eventScopePath: scopePath,
      origin: input.origin,
    });
    return supersededBy ? { supersededBy, cause: "stale-read" } : { supersededBy: null };
  }
  if (input.readsTracked && entityName?.trim()) {
    const supersededBy = await recordUnbasedWrite(tx, {
      orgId: input.groupId,
      agentId: input.actorId,
      versionId: episodeId,
      entityName,
      storedScopePath: input.scopePath ?? null,
      eventScopePath: scopePath,
      origin: input.origin,
    });
    if (supersededBy) return { supersededBy, cause: "stale-read" };
  }
  const contention = await resolveFactContention(tx, {
    orgId: input.groupId,
    versionId: episodeId,
    entityName: input.name,
    storedScopePath: input.scopePath ?? null,
    eventScopePath: scopePath,
    origin: input.origin,
  });
  return contention && contention.winnerId !== episodeId
    ? { supersededBy: contention.winnerId, cause: "conflict" }
    : { supersededBy: null };
}

/**
 * Thrown when the store removed a fact but recording the removal (its applied audit row and
 * change event) failed. The fact is gone, though the feed does not say so; a caller that was
 * removing it for a correction must still keep the correction, and can name no removal for
 * its lineage.
 */
export class RemovalNotRecordedError extends Error {
  /** The visible `memory.delete` allow row that authorized the removal. */
  readonly authorizedById?: string;

  constructor(factId: string, cause: unknown, authorizedById?: string) {
    super(
      `fact ${factId} was removed, but recording its removal failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RemovalNotRecordedError";
    this.authorizedById = authorizedById;
  }
}

/** One removal of a fact, as the guarded store authorized and executed it. */
export interface FactRemoval {
  orgId: string;
  actorType: ActorType;
  actorId: string;
  /** The entry point the delete came in through. */
  origin: AuditOrigin;
  /** The scope the delete was authorized on, and the partition it ran against. */
  scopePath: string;
  factId: string;
  /** Whether the store reports the fact was actually removed. */
  removed: boolean;
  /** Present when the fact was removed because a person corrected it: the corrected
   * text, which replaces it in memory. Its presence makes the event a `supersede`. */
  correction?: string;
  /** The entity name the removed fact was filed under, when the store reports one
   * (`RemoveFactResult.storedEntityName`). A correction's `supersede` names it. */
  subject?: string | null;
  /** The removed graph fact's text, when the id named a graph fact
   * (`RemoveFactResult.removedFactText`). A correction's `supersede` names it instead. */
  factText?: string;
  /** The visible `memory.delete` allow row that authorized this removal
   * (`AccessDecision.auditLogId`), carried onto the change event so the audit log can
   * name the change this authorization produced. */
  authorizedById?: string;
  runId?: string;
}

/**
 * Record that one fact delete ran: the confirmed-applied audit row, plus, when the
 * store really removed the fact, its change event, in one transaction.
 *
 * The event is `delete` for a plain removal and `supersede` for a correction, so a
 * reader can tell a fact that is gone from one that was replaced. A correction's event
 * says what the removed fact was filed under (`correctionTitle`); the corrected text
 * itself arrives on the feed separately, as the `create` of its own ingest. A removal
 * the store did not make is never announced: nothing changed for a reader to hear about.
 *
 * @returns the change event's id, or null when the store removed nothing.
 */
export async function recordFactRemoved(removal: FactRemoval): Promise<string | null> {
  return db.$transaction(async (tx) => {
    await recordAppliedChange(
      {
        orgId: removal.orgId,
        actorType: removal.actorType,
        actorId: removal.actorId,
        action: "memory.delete",
        scopePath: removal.scopePath,
        tag: `fact:${removal.factId}`,
        runId: removal.runId,
        origin: removal.origin,
      },
      tx,
    );
    if (!removal.removed) return null;
    const event = await recordFactChange(tx, {
      orgId: removal.orgId,
      scopePath: removal.scopePath,
      factId: removal.factId,
      op: removal.correction === undefined ? "delete" : "supersede",
      actorId: removal.actorId,
      actorType: removal.actorType,
      origin: removal.origin,
      title: removal.correction === undefined ? "" : correctionTitle(removal.subject, removal.factText),
      authorizedById: removal.authorizedById,
    });
    return event.id;
  });
}

/** Append one fact's change event inside the caller's transaction. */
function recordFactChange(
  tx: ChangeEventTransaction,
  change: {
    orgId: string;
    scopePath: string;
    factId: string;
    op: "delete" | "supersede";
    actorId: string;
    actorType: ActorType;
    origin: AuditOrigin;
    title: string;
    authorizedById?: string;
    task?: string;
  },
): Promise<{ id: string; seq: bigint }> {
  return recordChangeEvent(tx, {
    orgId: change.orgId,
    scopePath: change.scopePath,
    recordType: FACT_RECORD_TYPE,
    recordId: change.factId,
    op: change.op,
    actorId: change.actorId,
    actorType: change.actorType,
    origin: change.origin,
    title: change.title,
    authorizedById: change.authorizedById,
    task: change.task,
  });
}
