// Conflicting writes: which version of a fact is current, and what happened to the
// other one.
//
// Two agents can write the same fact at the same moment. Before this file, both
// versions were stored and neither was marked, so a reader got two contradictory
// live answers and no way to tell which the product considered true.
//
// THE WINNER RULE, and it is the only one: of two versions of the same fact — the same
// entity name in the same scope — whose writes were IN FLIGHT TOGETHER (neither stored
// more than the contention window before the other was received), from DIFFERENT writers,
// where neither writer had been served the
// other's version before its own write was received, the version the server stored FIRST
// wins and stays current, and the later one is recorded as superseded by it. "Stored
// first" is creation time, and where two versions share a millisecond, the order their
// rows were inserted in (`memory_chunks.storedSeq`, taken from a sequence by the INSERT),
// never the random id, which named a winner by chance rather than by which was stored first.
//
// Two instants per write, on purpose. Whether two writes compete is judged by when each was
// received (`memory_chunks.receivedAt`, taken on the database's clock at the request's
// entry, services/memory/received-at.ts) as well as when it was stored, because storing
// waits on the embedding call: judged by creation time alone, one slow embedding moved a
// write sent at the same moment as another out of the window, and the race went unrecorded
// (two such writes landed 1.5 s apart once stored). Judged by received time alone, a write received while a slow
// one was still in flight, and stored before it, would escape instead. Which one wins
// stays stored order, because the version stored first was already announced to its
// writer as current, and served as current, before the other was stored; letting a write
// received earlier but stored later retire it would make the readers who were served it,
// and its own writer's acknowledgement, wrong after the fact. Stored order is also how the
// rules path below settles a race. A row with no `receivedAt` (stored before the column
// existed) is taken as received when it was stored.
//
// Two writes from the same writer never compete. An agent that records three facts about
// one customer in one burst means three facts, not three attempts at one, so none of
// them may hide another. A writer is one principal: the actor type and actor id
// `memory_chunks` stores with each version. A version with no recorded actor id matches
// no one, not even another such version, because nothing shows the two share a writer;
// versions of unknown origin therefore still contend. Inside one window the rule runs in
// stored order and a version that already lost never wins: each version is superseded by
// the earliest still-current version another writer stored, or is current itself.
//
// A version is a row the fact path stored as one (`factVersionSql` below). Other code
// stores rows under a fact's name too (a file passage, a connector item, a seed); they are
// not writes to the fact, and neither this rule nor the stale-read checks in
// fact-reads.ts and fact-update.ts count them.
//
// First-stored-wins between writers is the rule the rules path already enforces through
// the unique index on `conventions.supersedesId` (the writer whose replacement commits
// first keeps it), so both paths resolve a conflict between writers the same way and a
// reader learns one rule, not two.
//
// Nothing is deleted. The outcome is written as a `supersedes` edge in the dependency
// graph (services/memory/edges.ts), winner to loser, and announced on the change feed as
// a `supersede` event on the loser attributed to the winner's writer, so the losing
// writer hears about it on its next tool call (`recordSupersession`, which the update and
// stale-read paths in fact-update.ts and fact-reads.ts record through too). Both versions
// stay readable by id (services/memory/versions.ts).
import { Prisma } from "@/lib/generated/prisma/client";
import type { AuditOrigin } from "@/services/access/origin";
import type { ActorType } from "@/types/memory";
import { UNKNOWN_ACTOR_ID } from "@/services/access/system-actors";
import { recordEdge, type FactEdgeWriter } from "./edges";
import { FACT_RECORD_TYPE, recordChangeEvent, type ChangeEventTransaction } from "./change-events";

/**
 * How close together two writes to one fact must land to count as a conflict rather
 * than an ordinary later update: two agents writing the same fact within one second.
 *
 * Measured over each write's flight, from when the server received it
 * (`memory_chunks.receivedAt`, services/memory/received-at.ts) to when it was stored
 * ({@link inFlightTogether}): storing waits on the embedding call, and one slow embedding
 * must not turn two writes sent at the same moment into an ordinary later update
 * (two such writes were seen 1.5 s apart once stored).
 */
export const CONTENTION_WINDOW_MS = 1000;

/**
 * Most versions of one fact considered in a single window. A burst longer than this
 * resolves over the versions it can see; the bound keeps one hot entity from turning
 * every ingest into an unbounded scan.
 */
export const MAX_VERSIONS_IN_WINDOW = 50;

/** The slice of a transaction conflict resolution needs. */
export type ConflictTransaction = ChangeEventTransaction & FactEdgeWriter;

/** Who stored a version: the actor type and actor id `memory_chunks` records with it. */
export interface StoredWriter {
  actorId: string | null;
  /** The writer's principal type as `memory_chunks` stored it. */
  actorType: string;
}

/** One stored version of a fact, as the contention query returns it. */
export interface FactVersionRow extends StoredWriter {
  id: string;
  createdAt: Date;
  /** When the server received the write that stored it (`memory_chunks.receivedAt`, which
   * reads as `createdAt` on a row stored before it existed): what the contention window
   * is judged by. Absent, as in a caller that builds rows by hand, no pair is held apart
   * by it. */
  receivedAt?: Date;
  /** The row's place, from 1, among the versions read with it, in the order they were
   * stored: `createdAt`, then `memory_chunks.storedSeq`, which is unique, so no two
   * versions the winner rule compares ever tie. */
  storedOrder: number;
  /** The other versions in the window whose writer had been served this one whole
   * (services/memory/fact-reads.ts) before its write was received; a feed sighting is not
   * counted, and nor is a read made after the write was received, which could not have
   * informed it. Absent reads as none. */
  readBeforeStoring?: readonly string[];
}

export interface FactContentionInput {
  orgId: string;
  /** The version just stored. */
  versionId: string;
  /** Entity name the ingest named; the contention key. */
  entityName: string | null | undefined;
  /** The scope as `memory_chunks` stores it, which is null when the ingest named none. */
  storedScopePath: string | null;
  /** The scope the fact's change events are written under. */
  eventScopePath: string;
  /** The entry point of the ingest whose store triggered this resolution. A supersede
   * it records is that request's consequence, so it carries the same origin. */
  origin: AuditOrigin;
}

/** What one resolution decided. */
export interface ContentionOutcome {
  /** The version current in place of the one just stored: the version that superseded
   * it, or the stored version itself when nothing did. */
  winnerId: string;
  /** Every version in the window the winner rule supersedes; empty when there was no conflict. */
  supersededIds: string[];
}

/** One version the winner rule retired, and the version that retired it. */
export interface Supersession {
  winner: FactVersionRow;
  loser: FactVersionRow;
}

/**
 * Order two versions of one fact by the winner rule: stored first wins (`storedOrder`:
 * creation time, then the order the rows were inserted in, which never ties). A
 * millisecond holds many versions, and their random ids say nothing about which was
 * stored first, so the insert order, not the id, settles a pair that shares one.
 * Exported because it is the rule itself — a reader should be able to find it in one
 * place and check it.
 */
export function compareByWinnerRule(a: FactVersionRow, b: FactVersionRow): number {
  return a.storedOrder - b.storedOrder;
}

/**
 * Whether two versions were stored by one writer: the same actor type and the same
 * actor id. A version with no recorded actor id, or a blank one, matches no version at
 * all, so two versions of unknown origin are never mistaken for one writer's.
 *
 * {@link storedBySql} is the same test in SQL, for queries that cannot load every
 * version of a fact to apply this one.
 */
export function sameWriter(a: StoredWriter, b: StoredWriter): boolean {
  if (a.actorId === null || a.actorId.trim() === "") return false;
  return a.actorId === b.actorId && a.actorType === b.actorType;
}

/**
 * {@link sameWriter} as a SQL boolean: whether the `memory_chunks` row `row` (a table
 * alias) was stored by `writer`. Never NULL, so a row with no recorded actor id reads as
 * another writer's instead of dropping out of a `NOT`.
 */
export function storedBySql(row: "c", writer: { actorType: ActorType; actorId: string }): Prisma.Sql {
  const alias = Prisma.raw(`"${row}"`);
  return Prisma.sql`COALESCE(
    btrim(${alias}."actorId") <> '' AND ${alias}."actorId" = ${writer.actorId} AND ${alias}."actorType" = ${writer.actorType},
    false
  )`;
}

/**
 * Whether the `memory_chunks` row `row` (a table alias) is a version of the fact its
 * `entityName` names, as a SQL boolean. Never NULL.
 *
 * A row stored since versions were marked says so itself: `factVersion` is set in the
 * INSERT that stores it (services/memory/pgvector-store.ts), so a version counts from the
 * moment it is stored, inside the transaction that announces it, and a row any other
 * writer stored under the same name never counts. A row stored before the column existed has no mark,
 * and counts exactly when the change feed announced it as a fact `create`: the fact path
 * announced every version it stored under the version's own id, and no other writer
 * announced a `memory_chunks` row's id as a fact.
 */
export function factVersionSql(row: "c"): Prisma.Sql {
  const alias = Prisma.raw(`"${row}"`);
  return Prisma.sql`COALESCE(${alias}."factVersion", EXISTS (
    SELECT 1 FROM "change_events" announced
    WHERE announced."orgId" = ${alias}."orgId" AND announced."recordId" = ${alias}."id"
      AND announced."recordType" = ${FACT_RECORD_TYPE} AND announced."op" = 'create'
  ))`;
}

/** Whether `later`'s writer had been served `read` whole before `later`'s write was received. */
function readBeforeStoring(read: FactVersionRow, later: FactVersionRow): boolean {
  return (read.readBeforeStoring ?? []).includes(later.id);
}

/**
 * Whether two versions compete: different writers, and neither writer had been served
 * the other's version before storing its own. A write made after reading a version is a
 * later write, not a concurrent one, however quickly it follows; a read made after
 * storing proves nothing about the write. Checked both ways, so the outcome does not
 * depend on which of the two is announced first.
 */
function contend(a: FactVersionRow, b: FactVersionRow): boolean {
  return !sameWriter(a, b) && inFlightTogether(a, b) && !readBeforeStoring(a, b) && !readBeforeStoring(b, a);
}

/**
 * Whether two versions' writes were concurrent: neither was stored more than the
 * contention window before the other was received. A write is in flight from when it is
 * received to when it is stored, so a write whose embedding was slow overlaps every write
 * received and stored meanwhile, in either order. When both were
 * stored as they were received this is the old test, stored within the window of each
 * other; since a write is never stored before it is received, it never calls a pair
 * concurrent that the old test did not.
 *
 * Checked for each pair, not only against the version just stored: the window query
 * collects every version concurrent with that one, and two of those need not be concurrent
 * with each other. So a version already announced current is never retired later through a
 * third: any concurrent pair stored before it was settled when the later of the two was stored.
 */
export function inFlightTogether(a: FactVersionRow, b: FactVersionRow): boolean {
  const window = CONTENTION_WINDOW_MS;
  const received = (v: FactVersionRow) => (v.receivedAt ?? v.createdAt).getTime();
  return !(a.createdAt.getTime() < received(b) - window) && !(b.createdAt.getTime() < received(a) - window);
}

/**
 * Apply the winner rule to the versions of one fact in one contention window.
 *
 * Versions are taken in {@link compareByWinnerRule} order. Each one is superseded by the
 * earliest version still current that it competes with ({@link contend}); when there is
 * none, it is current itself. So one writer's versions never retire each other, a
 * version written after reading another is never retired by it, nor by a third writer's
 * version through it, every other writer's later version loses to the first current one
 * it competes with, and a version that has already lost never wins.
 */
export function supersessionsAmong(versions: readonly FactVersionRow[]): Supersession[] {
  const current: FactVersionRow[] = [];
  const supersessions: Supersession[] = [];
  for (const version of [...versions].sort(compareByWinnerRule)) {
    const winner = current.find((candidate) => contend(candidate, version));
    if (winner) supersessions.push({ winner, loser: version });
    else current.push(version);
  }
  return supersessions;
}

/**
 * Record the outcome of any conflict the version just stored is part of, inside the
 * caller's transaction.
 *
 * Runs under the per-org advisory lock `recordChangeEvent` takes, so two writers in
 * one org resolve one after the other and both compute the same winner from the same
 * committed rows, whichever of them gets there second.
 *
 * An ingest that named no entity has no contention key and is left alone: there is
 * nothing to say two versions are versions of the same fact.
 *
 * @returns what was decided, or null when the ingest has no contention key. When an
 * earlier announcement already superseded this version, nothing is decided again and the
 * outcome names the version that superseded it.
 */
export async function resolveFactContention(
  tx: ConflictTransaction,
  input: FactContentionInput,
): Promise<ContentionOutcome | null> {
  const entityName = input.entityName?.trim();
  if (!entityName) return null;

  const versions = await versionsInWindow(tx, input, entityName);
  // Every version in the window is current except, possibly, this one: an announcement
  // that ran first may already have decided this version lost. Then there is nothing
  // left to decide, and deciding again could make a superseded version a winner.
  const self = versions.find((version) => version.id === input.versionId);
  if (self?.supersededBy) return { winnerId: self.supersededBy, supersededIds: [] };

  const supersessions = supersessionsAmong(versions);
  const ownWinner = supersessions.find(({ loser }) => loser.id === input.versionId)?.winner;
  const outcome: ContentionOutcome = {
    winnerId: ownWinner?.id ?? input.versionId,
    supersededIds: supersessions.map(({ loser }) => loser.id),
  };
  // A replayed ingest, or the second writer's resolution of the same pair, finds every
  // supersession already recorded and announces nothing again.
  for (const { winner, loser } of supersessions) {
    await recordSupersession(tx, {
      orgId: input.orgId,
      eventScopePath: input.eventScopePath,
      entityName,
      origin: input.origin,
      winner,
      loserId: loser.id,
      how: "superseded",
    });
  }
  return outcome;
}

/** One supersession to record: which version stays current, over which. */
export interface SupersessionInput {
  orgId: string;
  /** The scope the fact's change events are written under. */
  eventScopePath: string;
  entityName: string;
  /** The entry point of the ingest whose announcement decided this. */
  origin: AuditOrigin;
  /** The version that stays current, with the writer who stored it. */
  winner: { id: string } & StoredWriter;
  loserId: string;
  /** `replaced` when the winner was written as an update of the loser (its
   * `baseVersion`); `superseded` when the loser lost to it. The feed line says which, so
   * a reader can tell an intended update from a lost race. */
  how: "replaced" | "superseded";
}

/**
 * Record that `winner` supersedes `loserId`, and announce it on the change feed as a
 * `supersede` event on the loser attributed to the winner's writer. Attributed to the
 * winner's writer because the loser's own writes are filtered out of its change notices:
 * attributing it to the loser would hide the one line the loser's writer needs to see.
 *
 * Replay-safe: an edge already recorded is left as it is and nothing is announced, so a
 * retried announcement never says the same thing twice.
 *
 * @returns whether this call recorded the supersession.
 */
export async function recordSupersession(tx: ConflictTransaction, input: SupersessionInput): Promise<boolean> {
  const writer = { type: asActorType(input.winner.actorType), id: input.winner.actorId ?? UNKNOWN_ACTOR_ID };
  const recorded = await recordEdge(tx, {
    orgId: input.orgId,
    fromId: input.winner.id,
    toId: input.loserId,
    kind: "supersedes",
    scopePath: input.eventScopePath,
    actor: writer,
  });
  if (!recorded) return false;
  await recordChangeEvent(tx, {
    orgId: input.orgId,
    scopePath: input.eventScopePath,
    recordType: FACT_RECORD_TYPE,
    recordId: input.loserId,
    op: "supersede",
    actorId: writer.id,
    actorType: writer.type,
    origin: input.origin,
    title: `${supersessionOpening(input.how)}${input.winner.id}: ${input.entityName}`,
  });
  return true;
}

/**
 * How the `supersede` event on a retired version opens, which says how it was retired:
 * `replaced by ` when a write based on it replaced it, `superseded by ` when it lost to
 * another writer's version. The summary keeps it whole (it is the title's first characters),
 * so a reader that must tell a lost conflict from an intended update reads it here, and the
 * task-start block does (services/memory/task-start.ts).
 */
export function supersessionOpening(how: SupersessionInput["how"]): string {
  return `${how} by `;
}

/**
 * A stored chunk's actor type as a change event records it. The column is written from
 * an ingest's own actor type; anything else is a row no current writer produces, and is
 * named as the system rather than passed off as a person or an agent.
 */
export function asActorType(stored: string): ActorType {
  return stored === "human" || stored === "agent" ? stored : "extraction";
}

/**
 * Every current version of this fact whose write was in flight with the new one's
 * ({@link inFlightTogether}; `receivedAt` reads as `createdAt` on a row stored before it
 * existed), plus
 * the new one itself with the version that superseded it, if one already has, each with
 * the versions in the window whose writer had read it before storing them.
 *
 * A version already superseded is not a contender: it lost a race or was replaced by a
 * write based on it (services/memory/fact-update.ts). Leaving it out means an edge is
 * only ever written between two current versions, so no pair of versions can each be
 * recorded as superseding the other.
 */
async function versionsInWindow(
  tx: ConflictTransaction,
  input: FactContentionInput,
  entityName: string,
): Promise<(FactVersionRow & { supersededBy: string | null })[]> {
  const windowSeconds = CONTENTION_WINDOW_MS / 1000;
  const rows = await tx.$queryRaw<(FactVersionRow & { supersededBy: string | null })[]>(Prisma.sql`
    WITH stored AS (
      SELECT ${receivedAtSql("m")} AS "receivedAt", m."createdAt" FROM "memory_chunks" m
      WHERE "id" = ${input.versionId} AND "orgId" = ${input.orgId}
    ),
    in_window AS (
      SELECT c."id", c."orgId", c."createdAt", ${receivedAtSql("c")} AS "receivedAt", c."storedSeq", c."actorId", c."actorType"
      FROM "memory_chunks" c, stored s
      WHERE c."orgId" = ${input.orgId}
        AND c."entityName" = ${entityName}
        AND c."scopePath" IS NOT DISTINCT FROM ${input.storedScopePath}
        -- In flight together (inFlightTogether): neither stored more than the window
        -- before the other was received. The first bound also lets the
        -- (orgId, entityName, createdAt) index bound the scan.
        AND c."createdAt" >= s."receivedAt" - make_interval(secs => ${windowSeconds})
        AND ${receivedAtSql("c")} <= s."createdAt" + make_interval(secs => ${windowSeconds})
        AND ${factVersionSql("c")}
    ),
    versions AS (
      SELECT v."id", v."createdAt", v."receivedAt", v."storedSeq", v."actorId", v."actorType",
        (
          SELECT e."fromId" FROM "fact_edges" e
          WHERE e."orgId" = v."orgId" AND e."toId" = v."id" AND e."kind" = 'supersedes'
          ORDER BY e."createdAt" ASC, "id" ASC
          LIMIT 1
        ) AS "supersededBy",
        -- Reads are recorded for agents only, by the agent id their capability names. At or
        -- before: timestamps hold milliseconds, and a read in the millisecond its writer's
        -- next write was received in was made before it (an agent reads, then writes).
        ARRAY(
          SELECT w."id" FROM in_window w
          JOIN "fact_version_reads" r
            ON r."orgId" = v."orgId" AND r."versionId" = v."id" AND r."agentId" = w."actorId"
          WHERE w."actorType" = 'agent' AND NOT r."sightingOnly" AND r."readAt" <= w."receivedAt"
          -- A version kept beside a person's rule copy names it as what it was written from.
          UNION
          SELECT w."id" FROM in_window w
          JOIN "fact_edges" d ON d."orgId" = v."orgId" AND d."toId" = v."id" AND d."fromId" = w."id" AND d."kind" = 'derivedFrom'
        ) AS "readBeforeStoring"
      FROM in_window v
    )
    SELECT "id", "createdAt", "receivedAt", "actorId", "actorType", "supersededBy", "readBeforeStoring",
      (row_number() OVER (ORDER BY "createdAt", "storedSeq"))::int AS "storedOrder"
    FROM versions
    WHERE "id" = ${input.versionId} OR "supersededBy" IS NULL
    ORDER BY "createdAt" ASC, "storedSeq" ASC
    LIMIT ${MAX_VERSIONS_IN_WINDOW}
  `);
  // node-postgres hands timestamps back as Date; a driver that returns strings would
  // otherwise compare as strings. `storedOrder` is an int4, which every driver returns as
  // a number.
  return rows.map((row) => ({
    ...row,
    createdAt: new Date(row.createdAt),
    // Never null from the query (receivedAtSql); a row built without it reads as absent.
    receivedAt: row.receivedAt == null ? undefined : new Date(row.receivedAt),
    storedOrder: Number(row.storedOrder),
  }));
}

/**
 * When the `memory_chunks` row `row` (a table alias) was received, as a SQL timestamp:
 * its `receivedAt`, or its `createdAt` on a row stored before that column existed, or by a
 * writer that sets none. Never NULL.
 */
export function receivedAtSql(row: "c" | "m"): Prisma.Sql {
  const alias = Prisma.raw(`"${row}"`);
  return Prisma.sql`COALESCE(${alias}."receivedAt", ${alias}."createdAt")`;
}
