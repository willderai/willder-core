// What each agent has read of each fact, and the check that makes the safe path the
// default: a write that names no `baseVersion` is still refused when it comes from a
// stale read.
//
// `baseVersion` (services/memory/fact-update.ts) lets a writer say which version it
// read. Most clients will never send it. So the server keeps its own record of every
// version it showed each agent, of two kinds, and of the versions the agent wrote:
//
// - A READ is a version served whole with its id: every fact in a memory_query or
//   memory_entity answer that is not an excerpt, every memory_version answer, every
//   memory_ingest reply that names a version.
// - A SIGHTING is a version shown with its id but with text that may not be the whole
//   version: a `create fact` line of the change feed (in memory_changes, in a change
//   notice on any tool reply or from the client hook at app/api/changes/notice, in GET
//   /api/changes, or in the task-start block's recent writes), whose text is an event
//   summary cut at a fixed length (services/memory/change-events.ts); and a memory_query
//   fact served as an excerpt to fit the page's token budget (`excerptOfChars`,
//   services/memory/query-excerpt.ts). A read of the version later upgrades the sighting.
//
// THE ONE RULE: a write without a base is from a stale read when the fact (same name,
// same scope) has a current version its writer neither read nor wrote, stored after the
// writer's horizon and more than the contention window before the write. The horizon is
// the newest version the writer read or wrote; a writer that has done neither, but has
// sighted a version of the fact, takes the oldest version it sighted. Only what the
// writer had been shown before its write counts. Such a write never quietly joins or
// displaces that newer version:
//
// - Before anything is stored (`assertNoUnreadVersion`) it is refused, naming the
//   version the writer has not read. Nothing is stored, embedded, extracted or announced.
// - When it raced that version past the first check, it is decided again under the
//   per-org change-feed lock (`recordUnbasedWrite`): kept, superseded by the version the
//   writer had not read, and announced to its writer.
//
// A version stored inside the window is a concurrent write, which the winner rule
// settles instead (services/memory/conflict.ts): two writers naming one entity within a
// second contend, and only a write after that is refused.
//
// So an agent that read version 1 by any path (a read tool, the feed, a notice), saw
// another agent store version 2, and writes back without a base is refused and told to
// read version 2: the lost update this file exists to stop. Inside the window the same write-back
// is stored, superseded by version 2, and told so in its reply. A sighting never counts
// as reading the version it shows, so seeing version 2 only in a notice is not enough to
// write past it. A notice reaching a tool call is read before that call's handler runs
// (mcp/change-notices.ts), so the write-back that carries the notice of version 2 is
// still refused.
//
// A writer that has neither read, written nor sighted the fact has nothing to be stale
// against; its write is an ordinary new version, as before. A write without a base still
// replaces nothing: a fact's name names an entity, so a second write about it may be a
// new fact rather than an update, and only `baseVersion` says which. get_my_brief serves
// a brief, not a stored fact version, so it records nothing.
import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { sqlIdentifier } from "@/lib/sql-identifier";
import type { AuditOrigin } from "@/services/access/origin";
import {
  CONTENTION_WINDOW_MS,
  factVersionSql,
  receivedAtSql,
  recordSupersession,
  storedBySql,
  type ConflictTransaction,
  type StoredWriter,
} from "./conflict";
import { FACT_RECORD_TYPE } from "./change-events";
import { recordScopesOfVersions } from "@/services/access/derived-writes";
import { newerVersionOfFactOf } from "./fact-update";
import { changeTheRule, personRuleCopyOf, personRuleCopySentence, type PersonRuleCopy } from "./person-rule-copy";

/** The slice of a Prisma client or transaction the reads here need. */
export type FactReadsClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** The slice of a transaction that records a stale write's outcome. */
export type UnbasedWriteTransaction = FactReadsClient & ConflictTransaction;

/** One fact, as one agent writes it. */
export interface FactWriter {
  orgId: string;
  agentId: string;
  /** Entity name the ingest named; with the scope, what makes two versions one fact. */
  entityName: string;
  /** The scope as `memory_chunks` stores it, which is null when the ingest named none. */
  storedScopePath: string | null;
  /** The scope the fact is read and announced under. */
  eventScopePath: string;
  /** When the server received the write, before it is stored (IngestInput.receivedAt);
   * absent, the check before storing takes the present moment instead. */
  receivedAt?: string;
}

/**
 * Thrown when a write without `baseVersion` comes from a stale read: the fact has a
 * current version its writer was never served, stored after the newest one it was.
 *
 * When the write had already been stored (it raced that version), `storedVersionId`
 * names the stored copy, which is superseded and readable by id.
 *
 * The refusal names the unread version, so its writer can read it, but advises a
 * `baseVersion` only when one is known to be a version of the fact the writer read
 * (`replaceVersionId`, {@link unreadVersionError}). The unread version is just the newest
 * row under the entity name the writer has not read, and a name holds many facts: naming
 * it as the base to write against told the writer to retire whatever unrelated fact about
 * the entity was stored last.
 */
export class UnreadVersionError extends Error {
  readonly unreadVersionId: string;
  readonly lastReadVersionId?: string;
  readonly storedVersionId?: string;
  /** The current version of the fact the writer last read, when that moved on; else absent. */
  readonly replaceVersionId?: string;

  constructor(
    fact: Pick<FactWriter, "entityName" | "eventScopePath">,
    input: {
      unreadVersionId: string;
      lastReadVersionId?: string;
      horizonSighted?: boolean;
      storedVersionId?: string;
      replaceVersionId?: string;
      /** Set when the version a refusal would point at copies a person's rule. */
      rule?: PersonRuleCopy;
    },
  ) {
    const after = !input.lastReadVersionId
      ? ""
      : input.horizonSighted
        ? `, stored after ${input.lastReadVersionId}, which you saw only in part (a change-feed line or an excerpt)`
        : `, stored after ${input.lastReadVersionId}, the newest version of it you read or wrote`;
    const stored = input.storedVersionId
      ? ` Your write was stored as ${input.storedVersionId} and is superseded by ${input.unreadVersionId}; both are readable by id.`
      : " Nothing was stored.";
    const replace = input.replaceVersionId;
    // The advised base is always the current version of a fact the writer read, named with
    // the version it read, so the writer can tell whether that fact is the one it is writing.
    const repeats = input.storedVersionId ? " The same text again without a baseVersion only repeats this answer." : "";
    const copy = replace ?? input.unreadVersionId;
    const advice = input.rule
      ? `${personRuleCopySentence(copy, input.rule)} To keep yours beside it, pass baseVersion ${copy}; to change the ${input.rule.kind} itself, ${changeTheRule(input.rule)}${repeats}`
      : !replace
        ? `nothing shows ${input.unreadVersionId} is a version of the fact you read (one name holds many facts), ` +
          `so no baseVersion is named here: to replace a version, pass the id of the version you mean to replace.` +
          repeats
        : replace === input.unreadVersionId
          ? `it is the current version of ${input.lastReadVersionId}'s fact; to replace it, pass baseVersion ${replace}.`
          : `${input.lastReadVersionId}'s fact is now ${replace}; to replace that fact, pass baseVersion ${replace}.`;
    super(
      `"${fact.entityName}" in ${fact.eventScopePath} has a version you have not read: ${input.unreadVersionId}${after}.${stored} ` +
        `Read ${input.unreadVersionId} with memory_version, then write again; ${advice}`,
    );
    this.name = "UnreadVersionError";
    this.unreadVersionId = input.unreadVersionId;
    this.lastReadVersionId = input.lastReadVersionId;
    this.storedVersionId = input.storedVersionId;
    this.replaceVersionId = replace;
  }
}

/** Which versions an agent was shown, for {@link recordVersionsRead} and {@link recordVersionsSighted}. */
export interface VersionsShown {
  orgId: string;
  agentId: string;
  versionIds: readonly string[];
  /**
   * The versions are the reply to the agent's own write: the text it sent, not text it
   * was shown. They count as read for the stale-read rule, but add no scope to the
   * agent's session for the derived-write rule (services/access/derived-writes.ts).
   */
  ownWrite?: boolean;
}

/**
 * Record that `versionIds` were served whole to `agentId`, now. Ids that are not stored
 * versions in the org (a graph fact's stale episode stamp, a rule id) are skipped. A
 * version already read keeps its row and its first read time; one only sighted until now
 * is upgraded to a read made now, since the whole version was not shown before.
 *
 * Unless they answer the agent's own write, the scopes the versions are stored in join
 * the agent's session for the derived-write rule.
 */
export async function recordVersionsRead(client: FactReadsClient, input: VersionsShown): Promise<void> {
  const ids = [...new Set(input.versionIds)];
  if (ids.length === 0) return;
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "fact_version_reads" ("id", "orgId", "agentId", "versionId", "readAt")
    SELECT gen_random_uuid()::text, c."orgId", ${input.agentId}, c."id", ${sqlUtcNow}
    FROM "memory_chunks" c
    WHERE c."orgId" = ${input.orgId} AND c."id" IN (${Prisma.join(ids)})
    ON CONFLICT ("orgId", "agentId", "versionId") DO UPDATE SET "sightingOnly" = false, "readAt" = EXCLUDED."readAt"
    WHERE "fact_version_reads"."sightingOnly"
  `);
  if (!input.ownWrite) await recordScopesOfVersions(client, input, ids);
}

/**
 * Record that `versionIds` were shown to `agentId` only in part: as change-feed lines or
 * as excerpts (the sightings at the top of this file). Ids that are not stored versions in the org are
 * skipped; a version already read or sighted keeps its row unchanged.
 *
 * A part of a version is still its content: the scopes they are stored in join the
 * agent's session for the derived-write rule, as a whole read's do.
 */
export async function recordVersionsSighted(client: FactReadsClient, input: VersionsShown): Promise<void> {
  const ids = [...new Set(input.versionIds)];
  if (ids.length === 0) return;
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "fact_version_reads" ("id", "orgId", "agentId", "versionId", "readAt", "sightingOnly")
    SELECT gen_random_uuid()::text, c."orgId", ${input.agentId}, c."id", ${sqlUtcNow}, true
    FROM "memory_chunks" c
    WHERE c."orgId" = ${input.orgId} AND c."id" IN (${Prisma.join(ids)})
    ON CONFLICT ("orgId", "agentId", "versionId") DO NOTHING
  `);
  await recordScopesOfVersions(client, input, ids);
}

/**
 * The fact-version half of {@link recordVersionsSighted}, as one CTE named `name` for a
 * statement that records it alongside its own work: the task-start claim
 * (services/memory/task-start.ts), which records the scope half in the same statement with
 * services/access/derived-writes.ts's scopesShownCte. It inserts only while `gate` holds, and
 * writes exactly the rows recordVersionsSighted's first statement would.
 *
 * @returns null when there is nothing to record.
 */
export function versionsSightedCte(name: string, input: VersionsShown, gate: Prisma.Sql): Prisma.Sql | null {
  const ids = [...new Set(input.versionIds)];
  if (ids.length === 0) return null;
  return Prisma.sql`${sqlIdentifier(name)} AS (
      INSERT INTO "fact_version_reads" ("id", "orgId", "agentId", "versionId", "readAt", "sightingOnly")
      SELECT gen_random_uuid()::text, c."orgId", ${input.agentId}, c."id", ${sqlUtcNow}, true
      FROM "memory_chunks" c
      WHERE c."orgId" = ${input.orgId} AND c."id" = ANY (${ids}::text[]) AND ${gate}
      ON CONFLICT ("orgId", "agentId", "versionId") DO NOTHING
    )`;
}

/**
 * The fact versions a list of change-feed entries shows: the record of every `create`
 * of a fact, whose line carries the version's id and text. A `supersede` or `delete`
 * line names a version without showing its text, so it is not a sighting of one.
 */
export function factVersionsIn(changes: readonly { recordType: string; recordId: string; op: string }[]): string[] {
  return changes.filter((c) => c.recordType === FACT_RECORD_TYPE && c.op === "create").map((c) => c.recordId);
}

/** A current version the writer has not read, and the writer's horizon (the rule at the top of this file). */
export interface UnreadVersion {
  unreadVersionId: string;
  lastReadVersionId: string;
  /** The horizon is a version the writer only sighted, having read and written none. */
  horizonSighted?: boolean;
}

/**
 * Refuse a write without a base before it is stored when its writer has not read the
 * fact's newest current version (the rule at the top of this file).
 *
 * Not authoritative on its own: a newer version can be stored after this returns, so
 * `recordUnbasedWrite` decides again under the per-org lock.
 *
 * @throws UnreadVersionError when the write comes from a stale read.
 */
export async function assertNoUnreadVersion(client: FactReadsClient, writer: FactWriter): Promise<void> {
  const unread = await newestUnreadVersion(client, writer, null);
  if (!unread) return;
  const replaceVersionId = await replaceableVersion(client, writer, unread.lastReadVersionId);
  const rule = await personRuleCopyOf(client, writer.orgId, replaceVersionId ?? unread.unreadVersionId);
  throw new UnreadVersionError(writer, { ...unread, replaceVersionId, ...(rule ? { rule } : {}) });
}

/**
 * The refusal for a write without a base that was stored as `storedVersionId` and is
 * superseded by `current`, a version its writer had not read. The writer's horizon is
 * worked out as `recordUnbasedWrite` worked it out, from what it was shown before the
 * write was stored, so the advice names the same fact the decision did.
 */
export async function unreadVersionError(
  client: FactReadsClient,
  writer: FactWriter,
  input: { storedVersionId: string; current: string },
): Promise<UnreadVersionError> {
  const unread = await newestUnreadVersion(client, writer, input.storedVersionId);
  const horizon = unread ? { lastReadVersionId: unread.lastReadVersionId, horizonSighted: unread.horizonSighted } : {};
  const replaceVersionId = unread ? await replaceableVersion(client, writer, unread.lastReadVersionId) : undefined;
  const rule = await personRuleCopyOf(client, writer.orgId, replaceVersionId ?? input.current);
  return new UnreadVersionError(writer, {
    unreadVersionId: input.current,
    storedVersionId: input.storedVersionId,
    ...horizon,
    replaceVersionId,
    ...(rule ? { rule } : {}),
  });
}

/**
 * The version a refused writer can name as `baseVersion` without retiring another fact:
 * the current version of the fact its horizon is a version of, judged the way a based
 * write is (services/memory/fact-update.ts), when that fact moved on past the horizon.
 * Undefined when it did not: the unread version is then another fact under the same name,
 * or a write without a base, which nothing ties to the fact the writer read.
 */
async function replaceableVersion(
  client: FactReadsClient,
  writer: FactWriter,
  horizonId: string,
): Promise<string | undefined> {
  return (await newerVersionOfFactOf(client, writer, horizonId)) ?? undefined;
}

/**
 * Inside the caller's transaction, after its change event took the per-org lock: when
 * version `versionId`, written without a base, comes from a stale read, record it as
 * superseded by the version its writer had not read and announce that to its writer.
 *
 * Only versions stored more than the contention window before this write was received
 * count: a version stored after it is a later write, which its own announcement settles,
 * and one in flight with it is settled by the winner rule (services/memory/conflict.ts).
 *
 * @returns the version current instead of this one, or null when this write is not stale.
 */
export async function recordUnbasedWrite(
  tx: UnbasedWriteTransaction,
  writer: FactWriter & { versionId: string; origin: AuditOrigin },
): Promise<string | null> {
  const unread = await newestUnreadVersion(tx, writer, writer.versionId);
  if (!unread) return null;
  // A replayed announcement finds the supersession recorded and announces nothing again.
  await recordSupersession(tx, {
    orgId: writer.orgId,
    eventScopePath: writer.eventScopePath,
    entityName: writer.entityName,
    origin: writer.origin,
    winner: { id: unread.unreadVersionId, actorId: unread.unreadActorId, actorType: unread.unreadActorType },
    loserId: writer.versionId,
    how: "superseded",
  });
  return unread.unreadVersionId;
}

/** An unread version, with the writer who stored it. */
interface UnreadVersionRow extends UnreadVersion {
  unreadActorId: StoredWriter["actorId"];
  unreadActorType: StoredWriter["actorType"];
}

/** A write's `receivedAt` as SQL, never later than now; now when it has none or it is not a date. */
function receivedOrNow(receivedAt: string | undefined): Prisma.Sql {
  // Rounded to the column precision as `memory_chunks.receivedAt` will hold it (received-at.ts).
  if (receivedAt === undefined || Number.isNaN(Date.parse(receivedAt))) return sqlUtcNow;
  return Prisma.sql`LEAST((${receivedAt}::timestamptz AT TIME ZONE 'UTC')::timestamp(3), ${sqlUtcNow})`;
}

/**
 * The newest current version of the fact that `writer` has neither been served nor
 * written, stored after the newest version it has; null when there is none, or when the
 * writer has read and written nothing of the fact. With `self`, that version is left out
 * of what the writer has seen.
 *
 * Only versions stored more than the contention window before this write was received
 * count: `self`'s `receivedAt` once it is stored (its `createdAt` on a row with none), and
 * before then the write's `receivedAt`, or now when it has none. Any other version stored
 * before it was in flight with it (services/memory/conflict.ts, `inFlightTogether`), and
 * the winner rule settles the pair; the two rules are exact complements, so no pair falls
 * between them. Only what the writer was shown before that moment counts as
 * read or sighted, so a read made after the write was received, which could not have
 * informed it, cannot excuse it.
 */
async function newestUnreadVersion(
  reader: FactReadsClient,
  writer: FactWriter,
  self: string | null,
): Promise<UnreadVersionRow | null> {
  const excludeSelf = self ? Prisma.sql`AND c."id" <> ${self}` : Prisma.empty;
  const writtenAt = self
    ? Prisma.sql`(SELECT ${receivedAtSql("m")} FROM "memory_chunks" m WHERE m."id" = ${self})`
    : receivedOrNow(writer.receivedAt);
  const ownVersion = storedBySql("c", { actorType: "agent", actorId: writer.agentId });
  const windowSeconds = CONTENTION_WINDOW_MS / 1000;
  const rows = await reader.$queryRaw<UnreadVersionRow[]>(Prisma.sql`
    WITH fact AS (
      SELECT c."id", c."createdAt", c."storedSeq", c."actorId", c."actorType",
        (${ownVersion} OR COALESCE(NOT r."sightingOnly", false)) AS "seen",
        (COALESCE(r."sightingOnly", false) AND NOT ${ownVersion}) AS "sighted"
      FROM "memory_chunks" c
      LEFT JOIN "fact_version_reads" r
        ON r."orgId" = c."orgId" AND r."agentId" = ${writer.agentId} AND r."versionId" = c."id"
        -- At or before: timestamps hold milliseconds, and a read in the millisecond the
        -- write was received in is taken as made before it, as in conflict.ts.
        AND r."readAt" <= ${writtenAt}
      WHERE c."orgId" = ${writer.orgId}
        AND c."entityName" = ${writer.entityName}
        AND c."scopePath" IS NOT DISTINCT FROM ${writer.storedScopePath}
        AND ${factVersionSql("c")}
        ${excludeSelf}
    ),
    -- The newest version read or written; failing that, the oldest version sighted.
    -- "Newest" and "oldest" are stored order: creation time, then the order the rows
    -- were inserted in ("storedSeq"), which never ties. A millisecond can hold two
    -- versions, and their random ids say nothing about which was stored first.
    horizon AS (
      SELECT "id", "createdAt", "storedSeq", "seen" IS NOT TRUE AS "sighted" FROM fact
      WHERE "seen" OR "sighted"
      ORDER BY "seen" IS TRUE DESC,
        CASE WHEN "seen" THEN "createdAt" END DESC, CASE WHEN "seen" THEN "storedSeq" END DESC,
        "createdAt" ASC, "storedSeq" ASC
      LIMIT 1
    )
    SELECT f."id" AS "unreadVersionId", f."actorId" AS "unreadActorId", f."actorType" AS "unreadActorType",
      h."id" AS "lastReadVersionId", h."sighted" AS "horizonSighted"
    FROM fact f, horizon h
    WHERE NOT f."seen"
      AND (f."createdAt", f."storedSeq") > (h."createdAt", h."storedSeq")
      AND f."createdAt" < ${writtenAt} - make_interval(secs => ${windowSeconds})
      AND NOT EXISTS (
        SELECT 1 FROM "fact_edges" e
        WHERE e."orgId" = ${writer.orgId} AND e."toId" = f."id" AND e."kind" = 'supersedes'
      )
    ORDER BY f."createdAt" DESC, f."storedSeq" DESC
    LIMIT 1
  `);
  return rows[0] ?? null;
}
