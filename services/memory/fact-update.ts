// Writes based on a read: how a new version of a fact replaces the one its writer read,
// and what happens when that version is no longer current.
//
// The lost update this file exists to stop: agent A reads a fact, agent B writes a new
// version of it, and A writes back from its stale read. Without knowing what A read, the
// product cannot tell A's write-back from a fresh update, so B's version stops being the
// answer even though nobody chose that.
//
// A writer says what it read by naming that version as `baseVersion`. A write with a
// base is an update: it replaces its base. THE ONE RULE: a write replaces its base only
// while the base is still the current version, so a write made from a stale read never
// replaces the newer version. It is refused instead, naming the current version, the same
// optimistic-concurrency contract `contact_upsert`'s `baseRevision` gives a contact.
//
// Refusal happens in two places, one per timing:
//
// - Before anything is stored (`assertBaseVersionCurrent`), which is where an ordinary
//   stale write-back ends: nothing is stored, embedded, extracted or announced.
// - Under the per-org change-feed lock, when the version is announced
//   (`recordBasedWrite`), for the write that passed the first check while a newer version
//   was being stored. Its row exists by then, so it is kept, as the conflict model keeps
//   every losing version (services/memory/conflict.ts): marked superseded by the version
//   stored before it, announced to its writer on the change feed, readable by id.
//
// A write that names no base is checked against what its writer was served instead
// (services/memory/fact-reads.ts), so a client that never sends `baseVersion` is not left
// unprotected.
//
// Nothing is merged and no winner is kept silently: the newer version stays current, and
// the stale writer is told, synchronously and on its next tool call.
//
// "Newer version" means a newer version of THE FACT THE BASE IS A VERSION OF, never just a
// newer row under the same entity name. A name names an entity, not a fact
// (services/memory/fact-reads.ts): save_memory, contacts and accounts all write many
// different facts about one entity. So a base is stale only when its own lineage moved on:
// a `supersedes` edge replaced it, or another write naming the same base was stored before
// this one (its row records that base, `memory_chunks.baseVersionId`, from the moment it is
// stored). Judging by the name instead refused an update to one fact because another fact
// about the entity was newer, and told the writer to rebase on that unrelated fact, which
// the writer then retired by following the advice.
import { Prisma } from "@/lib/generated/prisma/client";
import type { AuditOrigin } from "@/services/access/origin";
import { orgRootPath } from "@/services/access/org-root";
import { scopeContainsSql } from "@/services/access/scope-containment";
import { factVersionSql, recordSupersession, type ConflictTransaction } from "./conflict";

/** The slice of a Prisma client or transaction a lookup here needs. */
export type FactVersionReader = Pick<Prisma.TransactionClient, "$queryRaw">;

/** How a fact is named in an error: its entity name and the scope it is read under. */
interface FactName {
  entityName: string;
  scopePath: string;
}

/**
 * Thrown when a write names a `baseVersion` that is no longer the current version of the
 * fact it is a version of.
 *
 * Carries the id of that fact's current version (never another fact's under the same
 * entity name), so a caller can read it with `memory_version` and
 * write again with it as the base. When the stale write had already been stored before
 * the refusal (it raced the newer version), `storedVersionId` names the stored copy, which
 * is superseded and readable by id.
 */
export class StaleBaseVersionError extends Error {
  readonly baseVersionId: string;
  readonly currentVersionId: string;
  readonly storedVersionId?: string;

  constructor(fact: FactName, input: { baseVersionId: string; currentVersionId: string; storedVersionId?: string }) {
    const stored = input.storedVersionId
      ? ` Your write was stored as ${input.storedVersionId} and is superseded by ${input.currentVersionId}; both are readable by id.`
      : " Nothing was stored.";
    super(
      `baseVersion ${input.baseVersionId} does not match the current version of "${fact.entityName}" in ${fact.scopePath}: ` +
        `the fact it is a version of is now ${input.currentVersionId}.${stored} Read ${input.currentVersionId} with memory_version, then write again ` +
        `with baseVersion ${input.currentVersionId}.`,
    );
    this.name = "StaleBaseVersionError";
    this.baseVersionId = input.baseVersionId;
    this.currentVersionId = input.currentVersionId;
    this.storedVersionId = input.storedVersionId;
  }
}

/**
 * Thrown when `baseVersion` names no stored version of the fact being written: another
 * fact's version, another scope's, another org's, or an id that does not exist. One error
 * for all of them, so the id cannot be used to probe what exists outside the fact.
 */
export class UnknownBaseVersionError extends Error {
  constructor(fact: FactName, baseVersionId: string) {
    super(
      `baseVersion ${baseVersionId} is not a version of "${fact.entityName}" in ${fact.scopePath}. ` +
        "Pass the id of the version you read, as memory_query, memory_version or a change notice gave it. Nothing was stored.",
    );
    this.name = "UnknownBaseVersionError";
  }
}

/**
 * Thrown when a person corrects a fact version that another version has already replaced:
 * an update based on it, or the winner of a conflict it lost. A version is replaced once,
 * so the correction is refused before anything is removed, naming the version in force,
 * the same contract a stale `baseVersion` gets.
 */
export class FactAlreadyReplacedError extends Error {
  readonly currentVersionId: string;

  constructor(factId: string, currentVersionId: string) {
    super(
      `This fact (${factId}) was already replaced by ${currentVersionId}. Correct ${currentVersionId}, the version in force, instead. Nothing was changed.`,
    );
    this.name = "FactAlreadyReplacedError";
    this.currentVersionId = currentVersionId;
  }
}

/**
 * The version in force in place of the stored fact version `versionId`, when another
 * version has already replaced it; null when nothing has, or when no version by that id is
 * stored within `scopePath` in this org (the rows a delete authorized at `scopePath`
 * reaches). So a version outside the caller's scope answers exactly as a missing one does.
 */
export async function currentReplacementWithin(
  reader: FactVersionReader,
  target: { orgId: string; versionId: string; scopePath: string },
): Promise<string | null> {
  const within = scopeContainsSql(Prisma.raw('c."scopePath"'), target.scopePath, {
    relation: "within",
    mode: "text",
    includeUntagged: target.scopePath === orgRootPath(target.orgId),
  });
  const stored = await reader.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT c."id" FROM "memory_chunks" c
    WHERE c."id" = ${target.versionId} AND c."orgId" = ${target.orgId} AND ${within}
    LIMIT 1
  `);
  if (stored.length === 0) return null;
  return currentVersionReplacing(reader, target.orgId, target.versionId);
}

/** Which fact a based write is a version of, and the version it read. */
export interface BasedWriteTarget {
  orgId: string;
  /** Entity name the ingest named; with the scope, what makes two versions one fact. */
  entityName: string;
  /** The scope as `memory_chunks` stores it, which is null when the ingest named none. */
  storedScopePath: string | null;
  /** The scope the fact is read and announced under. */
  eventScopePath: string;
  baseVersionId: string;
}

/**
 * Refuse a based write before it is stored when its base is not the fact's current
 * version, or is not a version of this fact at all.
 *
 * Not authoritative on its own: a newer version can be stored after this returns, so
 * `recordBasedWrite` decides again under the per-org lock.
 *
 * @throws UnknownBaseVersionError when the base is not a version of this fact.
 * @throws StaleBaseVersionError when a newer version has replaced the base.
 */
export async function assertBaseVersionCurrent(reader: FactVersionReader, target: BasedWriteTarget): Promise<void> {
  const base = await versionOfFact(reader, target, target.baseVersionId);
  if (!base) throw new UnknownBaseVersionError(nameOf(target), target.baseVersionId);
  const current = await currentVersionSince(reader, target, base, null);
  if (current !== base.id) {
    throw new StaleBaseVersionError(nameOf(target), { baseVersionId: base.id, currentVersionId: current });
  }
}

/** What announcing a based write decided. */
export interface BasedWriteOutcome {
  /** The version that is current instead of this one, or null when this one is current. */
  supersededBy: string | null;
}

/**
 * Record, inside the caller's transaction and after its change event took the per-org
 * lock, what a based write did to its fact: replaced its base, or lost to a version stored
 * before it.
 *
 * - The base is current and no current version was stored between it and this one: this
 *   version replaces it. A `supersedes` edge from this version to the base, and a
 *   `supersede` event on the base attributed to this version's writer, so whoever read
 *   the base hears it moved.
 * - Otherwise this version is stale: superseded by the current version, with the event on
 *   this version attributed to that version's writer, so this writer hears it (its own
 *   writes are filtered out of its change notices).
 *
 * An edge is only ever written between two versions that are both current at the time,
 * which keeps the `supersedes` graph free of cycles whatever order concurrent
 * announcements run in. A version another announcement already superseded has nothing
 * left to decide, and nor does a replayed announcement of a version that already
 * replaced its base (a queued job's step retried after its transaction committed).
 *
 * @returns which version is current instead of this one, if any.
 */
export async function recordBasedWrite(
  tx: ConflictTransaction,
  target: BasedWriteTarget & { versionId: string; origin: AuditOrigin },
): Promise<BasedWriteOutcome> {
  const self = await versionOfFact(tx, target, target.versionId);
  if (!self) throw new Error(`recordBasedWrite: version ${target.versionId} is not stored as "${target.entityName}"`);

  const replacedBy = await supersederOf(tx, target.orgId, self.id);
  if (replacedBy) return { supersededBy: await currentOf(tx, target.orgId, replacedBy) };

  const base = await versionOfFact(tx, target, target.baseVersionId);
  // A base deleted since the first check (a person removed it) leaves nothing to replace
  // or to be stale against; this write stays a plain new version.
  if (!base) return { supersededBy: null };
  // Already announced: this version replaced its base, and is current.
  if ((await supersederOf(tx, target.orgId, base.id)) === self.id) return { supersededBy: null };

  const announced = {
    orgId: target.orgId,
    eventScopePath: target.eventScopePath,
    entityName: target.entityName,
    origin: target.origin,
  };
  const current = await currentVersionSince(tx, target, base, self);
  if (current === base.id) {
    await recordSupersession(tx, { ...announced, winner: self, loserId: base.id, how: "replaced" });
    return { supersededBy: null };
  }
  // The head of the base's lineage may since have been deleted by a person; it still
  // decides, under an unknown writer.
  const winner = (await versionOfFact(tx, target, current)) ?? { id: current, actorId: null, actorType: "" };
  await recordSupersession(tx, { ...announced, winner, loserId: self.id, how: "superseded" });
  return { supersededBy: current };
}

/**
 * Whether version `id` of the target fact has been replaced, and by which current
 * version. Used to answer an identical retry of a based write the way its first attempt
 * was answered.
 *
 * @returns the current version replacing `id`, or null when `id` is current.
 */
export async function currentVersionReplacing(
  reader: FactVersionReader,
  orgId: string,
  id: string,
): Promise<string | null> {
  const replacedBy = await supersederOf(reader, orgId, id);
  return replacedBy ? currentOf(reader, orgId, replacedBy) : null;
}

/**
 * The version a write naming `versionId` as its base would have to name instead: the
 * current version of the fact `versionId` is a version of, judged exactly as a based write
 * is (`currentVersionSince`), when that is no longer `versionId` itself. Null when
 * `versionId` is still its fact's current version, is not a version of the target fact, or
 * its fact's current version is no longer stored as one (a person deleted it).
 *
 * Never another fact's version under the same entity name: this is what lets a refusal
 * of a write without a base (services/memory/fact-reads.ts) name a base to write against
 * without naming an unrelated fact the writer would retire by following it.
 */
export async function newerVersionOfFactOf(
  reader: FactVersionReader,
  target: Omit<BasedWriteTarget, "baseVersionId">,
  versionId: string,
): Promise<string | null> {
  const fact = { ...target, baseVersionId: versionId };
  const version = await versionOfFact(reader, fact, versionId);
  if (!version) return null;
  const current = await currentVersionSince(reader, fact, version, null);
  if (current === version.id) return null;
  return (await versionOfFact(reader, fact, current)) ? current : null;
}

/**
 * The version that is current for a based write whose base is `base`: the base itself
 * when nothing replaced it and no current write based on it was stored after it (and,
 * when `before` is given, before that version); otherwise the newest such write, or the
 * head of the base's own lineage when the base was replaced.
 *
 * Only versions of the base's own fact count: writes that named the same base, and the
 * base's lineage. Another current version under the same entity name, stored after the
 * base, is another fact about the entity, not a newer version of this one: a write
 * without a base replaces nothing (services/memory/fact-reads.ts), and a write based on
 * another version is a version of that version's fact.
 *
 * "Stored after" is the conflict model's order (services/memory/conflict.ts): creation
 * time, then `storedSeq`, which the INSERT takes from a sequence, so two versions never tie.
 * Never the id: two versions stored in one millisecond tie on `createdAt`, and a tie broken
 * by the random id told the version stored second it was stored first about half the time. Bounding by `before` is what makes the
 * version stored first win when two writes based on the same version are announced in
 * either order: the later one's row records the base before either announcement runs.
 */
async function currentVersionSince(
  reader: FactVersionReader,
  target: BasedWriteTarget,
  base: StoredVersion,
  before: StoredVersion | null,
): Promise<string> {
  const upperBound = before ? Prisma.sql`AND (c."createdAt", c."storedSeq") < ${orderSql(before)}` : Prisma.empty;
  const newer = await reader.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT c."id" FROM "memory_chunks" c
    WHERE c."orgId" = ${target.orgId}
      AND c."entityName" = ${target.entityName}
      AND c."scopePath" IS NOT DISTINCT FROM ${target.storedScopePath}
      AND ${factVersionSql("c")}
      AND c."baseVersionId" = ${base.id}
      AND (c."createdAt", c."storedSeq") > ${orderSql(base)}
      ${upperBound}
      AND NOT EXISTS (
        SELECT 1 FROM "fact_edges" e
        WHERE e."orgId" = c."orgId" AND e."toId" = c."id" AND e."kind" = 'supersedes'
      )
    ORDER BY c."createdAt" DESC, c."storedSeq" DESC
    LIMIT 1
  `);
  if (newer[0]) return newer[0].id;
  return (await currentVersionReplacing(reader, target.orgId, base.id)) ?? base.id;
}

/** One stored version, as the lookups here need it. */
interface StoredVersion {
  id: string;
  createdAt: Date;
  /** Where the row falls in the order rows were stored (`memory_chunks.storedSeq`), as
   * its decimal text: only ever handed back to SQL, so never parsed into a JavaScript number. */
  storedSeq: string;
  actorId: string | null;
  actorType: string;
}

/** A version's place in stored order, (`createdAt`, `storedSeq`), as a SQL row value. */
function orderSql(version: StoredVersion): Prisma.Sql {
  return Prisma.sql`(${version.createdAt}, ${version.storedSeq}::bigint)`;
}

/** Version `id` when it is a stored version of the target fact; otherwise null. */
async function versionOfFact(
  reader: FactVersionReader,
  target: BasedWriteTarget,
  id: string,
): Promise<StoredVersion | null> {
  const rows = await reader.$queryRaw<StoredVersion[]>(Prisma.sql`
    SELECT c."id", c."createdAt", c."storedSeq"::text AS "storedSeq", c."actorId", c."actorType" FROM "memory_chunks" c
    WHERE c."id" = ${id}
      AND c."orgId" = ${target.orgId}
      AND c."entityName" = ${target.entityName}
      AND c."scopePath" IS NOT DISTINCT FROM ${target.storedScopePath}
      AND ${factVersionSql("c")}
    LIMIT 1
  `);
  const row = rows[0];
  // node-postgres hands timestamps back as Date; a driver that returns strings would
  // otherwise compare as strings.
  return row ? { ...row, createdAt: new Date(row.createdAt) } : null;
}

/** The version that superseded `id`, by the earliest edge (same-millisecond edges by id, as
 * services/memory/current-versions.ts orders them), or null when nothing did. */
async function supersederOf(reader: FactVersionReader, orgId: string, id: string): Promise<string | null> {
  const rows = await reader.$queryRaw<{ fromId: string }[]>(Prisma.sql`
    SELECT "fromId" FROM "fact_edges"
    WHERE "orgId" = ${orgId} AND "toId" = ${id} AND "kind" = 'supersedes'
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  `);
  return rows[0]?.fromId ?? null;
}

/**
 * Follow `supersedes` edges forward from `id` to the version nothing has replaced, in one
 * query however long the lineage is. Each step takes the earliest edge, as `supersederOf`
 * does. Edges are only written between current versions, so a lineage has no cycle; the
 * CYCLE clause stops the walk anyway rather than looping if one were ever written by hand.
 */
async function currentOf(reader: FactVersionReader, orgId: string, id: string): Promise<string> {
  const rows = await reader.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE lineage("id", "depth") AS (
      SELECT ${id}::text, 0
      UNION ALL
      SELECT next."fromId", lineage."depth" + 1
      FROM lineage
      CROSS JOIN LATERAL (
        SELECT e."fromId" FROM "fact_edges" e
        WHERE e."orgId" = ${orgId} AND e."toId" = lineage."id" AND e."kind" = 'supersedes'
        ORDER BY e."createdAt" ASC, "id" ASC
        LIMIT 1
      ) next
    ) CYCLE "id" SET "looped" USING "path"
    SELECT "id" FROM lineage WHERE NOT "looped" ORDER BY "depth" DESC LIMIT 1
  `);
  return rows[0]?.id ?? id;
}

function nameOf(target: BasedWriteTarget): FactName {
  return { entityName: target.entityName, scopePath: target.eventScopePath };
}
