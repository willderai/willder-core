// The change feed's read side.
//
// Answers "what has changed since I last looked" for one agent, filtered to what
// that agent may read RIGHT NOW. Events are stored unfiltered
// (services/memory/change-events.ts); the authorization happens here, on every
// read, so a grant revoked after an event was written applies to that event too.
//
// The one rule this file enforces: a caller is never shown an event outside the
// scope its live capability covers, and never learns that one exists.
//
// That second half is why nothing a caller receives carries `seq`. `seq` counts
// every write in the org, so the distance between two readable seqs is exactly the
// number of writes in between — handing it out would count the org's hidden writes
// out loud, timestamped on either side. A caller that wants to resume explicitly
// passes back the `id` of a change it was served, which orders against nothing.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { type AccessContext, AccessDeniedError, check, flattenSql, scopeContainsSql } from "@/services/access";
import type { ChangeOp } from "./change-events";
import { recordScopesRead } from "@/services/access/derived-writes";
import { factVersionsIn, recordVersionsSighted } from "./fact-reads";
import { markSupersededWrites } from "./superseded-facts";
import { WORKING_NOTE_RECORD_TYPE } from "./working-notes";
import { CLAIM_OVERLAP_RECORD_TYPE } from "./claim-overlap";
import { SESSION_STATE_NAME_OPENING } from "./session-state";

/** Largest page a single read will return. */
export const MAX_CHANGES_PER_READ = 50;
const DEFAULT_CHANGES_PER_READ = 20;

/** One change, as a reader sees it. */
export interface Change {
  /**
   * This change's own identity, and the only cursor a caller ever holds. Opaque
   * and unordered by construction (a random UUID, `ChangeEvent.id`): two of them
   * cannot be subtracted, compared, or read as a position in the org's history.
   */
  id: string;
  scopePath: string;
  recordType: string;
  recordId: string;
  op: ChangeOp;
  actorId: string;
  /**
   * What changed, in a line. For the write of a fact version that has since lost a
   * conflict, it starts with `[superseded by <id>]`, so the log lists the write without
   * presenting its text as the fact's current value.
   */
  summary: string;
  createdAt: Date;
  /** For the write of a fact version since superseded, the version that superseded it; else null. */
  supersededById: string | null;
}

export interface ReadChangesOptions {
  /**
   * Resume immediately after the change with this `id`. Omitted means "resume from
   * this agent's own server-held cursor", which is both the default and the cheaper
   * path: it has already moved past events this agent could not read, while an
   * explicit `after` rescans them.
   */
  after?: string;
  /** Page size, capped at {@link MAX_CHANGES_PER_READ}. */
  limit?: number;
  /**
   * How many of the page's changes, from the start, to serve. The rest stay unread: the
   * cursor moves past the last change served and no further, so a caller that can only
   * describe part of a page leaves the remainder for its next read. Given the whole page
   * in feed order, before the cursor moves, so a `take` that throws loses nothing. Its
   * answer must be a whole number; it is raised to 1 and capped at the page's length, so
   * a read that finds anything always moves forward. Omitted means the whole page.
   */
  take?: (page: readonly FeedChange[]) => number | Promise<number>;
  /**
   * The records, among the changes served, whose lines the caller shows its reader, by
   * `recordId`. Each fact version among them is recorded as a sighting for the reading
   * agent (services/memory/fact-reads.ts), which puts its later writes to that fact under
   * the stale-read rule; each working note among them adds its scope to the agent's
   * session for the derived-write rule (services/access/derived-writes.ts). So a caller
   * that shows fewer lines than it serves names only the records it shows. Only versions a
   * line can show count (factVersionsIn). Omitted means every one served.
   */
  sightings?: (served: readonly Change[]) => readonly string[];
}

/** A change as {@link ReadChangesOptions.take} sees it: before superseded writes are marked. */
export type FeedChange = Omit<Change, "supersededById">;

export interface ChangeFeedPage {
  changes: Change[];
  /**
   * True when a change this caller may read already exists past this page. Read
   * from one row beyond the page rather than inferred from the page being full, so
   * a page that ends exactly on the last change does not claim there is more.
   */
  hasMore: boolean;
}

/**
 * Thrown when `after` names no change this read may resume from: unknown, another
 * tenant's, or inside a scope this read did not authorize. One error for all three,
 * so a cursor cannot be used to probe what exists.
 */
export class UnknownChangeCursorError extends Error {
  constructor() {
    super(
      "Unknown change cursor. Pass the `id` of a change this token was served, " +
        "or omit it to resume from your own position.",
    );
    this.name = "UnknownChangeCursorError";
  }
}

/**
 * Read one page of the change feed as `ctx`'s actor, scoped to `scopePath`.
 *
 * Authorizes first, then filters by ltree containment against the same scope it
 * authorized — so the deny and the filter can never disagree. The caller's own
 * cursor advances past everything this read scanned, not just what it was shown;
 * widening an agent's scope therefore reveals changes from the widening forward,
 * not the history it could not previously read. Narrowing takes effect on the very
 * next read, because nothing about visibility was decided when the event was written.
 *
 * @throws AccessDeniedError when the actor may not read `scopePath` right now.
 * @throws UnknownChangeCursorError when `options.after` is not a change this read
 * may resume from.
 */
export async function readChanges(
  ctx: AccessContext,
  scopePath: string,
  options: ReadChangesOptions = {},
): Promise<ChangeFeedPage> {
  const decision = await check(ctx, { action: "memory.read", scope: scopePath });
  if (!decision.allowed) throw new AccessDeniedError(decision);

  // Clamped at both ends. The cap is the contract; the floor is what keeps a page
  // size of 0 from returning nothing while reporting more waiting, which is a loop
  // a caller driving on `hasMore` never leaves.
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_CHANGES_PER_READ, 1), MAX_CHANGES_PER_READ);
  const containment = scopeContainsSql(Prisma.raw('"scopePath"'), scopePath, {
    relation: "within",
    mode: "ltree",
  });
  const after = options.after === undefined ? null : await resolveCursor(ctx.orgId, options.after, containment);
  const { cursor, horizon, scanned } = await readPage(ctx, scopePath, after, limit);
  const page = scanned.length > limit ? scanned.slice(0, limit) : scanned;
  const rows = page.slice(0, options.take && page.length > 0 ? await servedCount(options.take, page) : page.length);
  const hasMore = scanned.length > rows.length;

  // The cursor always clears the last row actually served, and that row has to come
  // from the page rather than the horizon alone: when more changes wait, the page ends
  // before the horizon, and setting the cursor there would skip readable changes that
  // were never served.
  //
  // When more readable changes wait, the last served row is the whole answer. When
  // none do, the scan also reached the horizon, so the cursor clears that too:
  // everything in between was an event this read filtered out, and skipping it
  // costs the agent nothing it was allowed to see.
  const lastServed = rows.length > 0 ? BigInt(rows[rows.length - 1]!.seq) : cursor;
  const served = hasMore ? lastServed : maxBigInt(lastServed, maxBigInt(horizon, cursor));
  // Everything that can fail runs before the cursor moves: a read that fails here leaves
  // the run unread, to be served again, rather than consumed and never shown.
  const changes = await markSupersededWrites(ctx.orgId, rows.map(toChange));
  // Every fact version this read shows is a sighting for the agent reading it, which
  // puts its later writes under the stale-read rule (services/memory/fact-reads.ts).
  // Every other agent's working note it shows is content from the note's scope, which
  // joins the agent's session for the derived-write rule (services/access/derived-writes.ts).
  if (ctx.actor.type === "agent") {
    const who = { orgId: ctx.orgId, agentId: ctx.actor.id };
    const lines = options.sightings ? new Set(options.sightings(changes)) : null;
    const isLine = (recordId: string) => lines === null || lines.has(recordId);
    await recordVersionsSighted(db, { ...who, versionIds: factVersionsIn(rows).filter(isLine) });
    await recordScopesRead(db, who, noteScopesShown(changes, ctx.actor.id, isLine));
  }
  await advanceCursor(ctx.orgId, ctx.actor.id, served, { endDenial: true });

  return { changes, hasMore };
}

/**
 * The scopes of the working notes among `changes` that another agent wrote and the reader
 * is shown. A note's post carries its body and its release names its task, so both are
 * content from the note's scope; the reader's own notes are its own text, as a write's
 * reply is (services/memory/fact-reads.ts, `ownWrite`). An overlap between two claims names
 * both, and is filed under the scope that covers them (services/memory/claim-overlap.ts).
 */
function noteScopesShown(
  changes: readonly Change[],
  readerId: string,
  isLine: (recordId: string) => boolean,
): string[] {
  const aboutNotes = (recordType: string) =>
    recordType === WORKING_NOTE_RECORD_TYPE || recordType === CLAIM_OVERLAP_RECORD_TYPE;
  return changes
    .filter((change) => aboutNotes(change.recordType) && change.actorId !== readerId && isLine(change.recordId))
    .map((change) => change.scopePath);
}

/**
 * Move `ctx`'s agent's cursor past the unseen changes a notice for `scopePath` would
 * not show, and say whether one it would show is still waiting.
 *
 * The cheap question to ask before {@link readChanges} on a hot path. A notice
 * shows another actor's change inside the caller's scope; the agent's own writes
 * and changes outside `scopePath` disclose nothing, so a call whose only news is
 * one of those should cost no `check()` and write no audit row. Only the leading
 * run of such changes is skipped; the first change a notice would show stops it,
 * so nothing it could show is ever passed over unread. Skipping a change outside
 * `scopePath` is what {@link readChanges} does to it anyway: it filters it out and
 * moves the cursor past it.
 *
 * The caller must already have decided (with can()) that the agent may read
 * `scopePath`: the filter uses it as given. The answer never leaves the server, so
 * it reveals nothing to the caller either way.
 */
export async function skipUnshownChanges(ctx: AccessContext, scopePath: string): Promise<boolean> {
  const inScope = scopeContainsSql(Prisma.raw('e."scopePath"'), scopePath, {
    relation: "within",
    mode: "ltree",
  });
  const query = Prisma.sql`
    WITH "cursor" AS (
      SELECT COALESCE(
        (SELECT "lastSeq" FROM "agent_cursors" WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id}),
        0
      ) AS "lastSeq"
    ),
    "firstShown" AS (
      SELECT MIN(e."seq") AS "seq"
      FROM "change_events" e, "cursor" c
      WHERE e."orgId" = ${ctx.orgId}
        AND e."seq" > c."lastSeq"
        AND e."actorId" <> ${ctx.actor.id}
        AND ${inScope}
    )
    SELECT
      f."seq" IS NOT NULL AS "shownUnseen",
      (
        SELECT MAX(e."seq")
        FROM "change_events" e, "cursor" c
        WHERE e."orgId" = ${ctx.orgId}
          AND e."seq" > c."lastSeq"
          AND (f."seq" IS NULL OR e."seq" < f."seq")
      ) AS "unshownThrough"
    FROM "firstShown" f
  `;
  const [{ shownUnseen, unshownThrough }] = await db.$queryRaw<
    [{ shownUnseen: boolean; unshownThrough: bigint | string | null }]
  >(...flattenSql(query));
  if (unshownThrough !== null) {
    await advanceCursor(ctx.orgId, ctx.actor.id, BigInt(unshownThrough), { endDenial: false });
  }
  return shownUnseen;
}

/** The most waiting changes {@link countWaitingChanges} counts; past it, it answers this. */
export const MAX_WAITING_COUNTED = 1000;

/**
 * How many changes by actors other than `ctx`'s agent wait past its cursor inside
 * `scopePath`, up to {@link MAX_WAITING_COUNTED}.
 *
 * Counts only what a later read of the same scope would serve, so the number never
 * includes a change outside the caller's scope. The caller must already have been
 * allowed to read `scopePath` (by {@link readChanges}, just before): the count uses it
 * as given.
 */
export async function countWaitingChanges(ctx: AccessContext, scopePath: string): Promise<number> {
  const inScope = scopeContainsSql(Prisma.raw('e."scopePath"'), scopePath, { relation: "within", mode: "ltree" });
  const query = Prisma.sql`
    SELECT count(*)::int AS "waiting" FROM (
      SELECT 1 FROM "change_events" e
      WHERE e."orgId" = ${ctx.orgId}
        AND e."seq" > COALESCE(
          (SELECT "lastSeq" FROM "agent_cursors" WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id}),
          0
        )
        AND e."actorId" <> ${ctx.actor.id}
        AND ${inScope}
      -- Ordered by seq so the planner walks the (orgId, seq) index forward from the
      -- cursor and stops at the cap, instead of scanning the scope's whole history.
      ORDER BY e."seq"
      LIMIT ${MAX_WAITING_COUNTED}
    ) waiting
  `;
  const [{ waiting }] = await db.$queryRaw<[{ waiting: number }]>(...flattenSql(query));
  return waiting;
}

/**
 * Of `versionIds`, the session-state captures, each with whether it replaced its session's earlier
 * capture: a `progress` version named as the willder init hook names one (`Session state: …`), and
 * whether it names the version it replaced. Read inside `scopePath` only, like
 * {@link factNamesOf}; a version removed since is left out.
 */
export async function captureVersionsOf(
  orgId: string,
  scopePath: string,
  versionIds: readonly string[],
): Promise<Map<string, { replaced: boolean }>> {
  if (versionIds.length === 0) return new Map();
  const inScope = scopeContainsSql(Prisma.raw('"scopePath"'), scopePath, { relation: "within", mode: "ltree" });
  const query = Prisma.sql`
    SELECT "id", "baseVersionId" IS NOT NULL AS "replaced" FROM "memory_chunks"
    WHERE "orgId" = ${orgId}
      AND "id" IN (${Prisma.join([...versionIds])})
      AND "role" = 'progress'
      AND starts_with("entityName", ${SESSION_STATE_NAME_OPENING})
      AND ${inScope}
  `;
  const rows = await db.$queryRaw<{ id: string; replaced: boolean }[]>(...flattenSql(query));
  return new Map(rows.map((row) => [row.id, { replaced: row.replaced }]));
}

/**
 * The fact each of `versionIds` is a version of, by the name it was stored under, for the
 * versions stored inside `scopePath` that have one. A fact is its name in its scope: the
 * versions that share both are the ones the conflict rule and memory_version treat as one
 * fact (services/memory/conflict.ts). A version removed since, or stored without a name,
 * is left out.
 *
 * The caller must already have been allowed to read `scopePath`: the filter uses it as
 * given, and nothing outside it is read.
 */
export async function factNamesOf(
  orgId: string,
  scopePath: string,
  versionIds: readonly string[],
): Promise<Map<string, string>> {
  if (versionIds.length === 0) return new Map();
  const inScope = scopeContainsSql(Prisma.raw('"scopePath"'), scopePath, { relation: "within", mode: "ltree" });
  const query = Prisma.sql`
    SELECT "id", "entityName" FROM "memory_chunks"
    WHERE "orgId" = ${orgId}
      AND "id" IN (${Prisma.join([...versionIds])})
      AND "entityName" IS NOT NULL
      AND ${inScope}
  `;
  const rows = await db.$queryRaw<{ id: string; entityName: string }[]>(...flattenSql(query));
  return new Map(rows.map((row) => [row.id, row.entityName]));
}

/**
 * Record that `ctx`'s agent was just denied reading its own scope, and move its
 * cursor past everything written so far.
 *
 * Returns true only for the call that starts a denial, so a caller polling on every
 * tool call can audit the denial once instead of once per poll. The denial ends the
 * next time the agent is allowed ({@link endDeniedRead}, or {@link readChanges}).
 *
 * The cursor moves for the same reason {@link readChanges} moves it past events a
 * read filtered out: a grant restored later reveals changes from then on, not the
 * ones written while the agent could not read them.
 */
export async function recordDeniedRead(ctx: AccessContext): Promise<boolean> {
  await advanceCursor(ctx.orgId, ctx.actor.id, await latestSeq(ctx.orgId), { endDenial: false });
  const started = await db.$executeRaw`
    UPDATE "agent_cursors" SET "deniedSince" = ${sqlUtcNow}
    WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id} AND "deniedSince" IS NULL
  `;
  return started === 1;
}

/**
 * Record that `ctx`'s agent was just allowed to read its own scope, so its next
 * denial is a new one and is audited again.
 *
 * A caller that decides with can() and then answers without reading the feed (the
 * quiet answer) must call this: {@link readChanges} ends a denial on its own, but a
 * quiet org is never read, and a denial left standing across a regrant would hide
 * the revoke that follows it from the audit log.
 */
export async function endDeniedRead(ctx: AccessContext): Promise<void> {
  await db.$executeRaw`
    UPDATE "agent_cursors" SET "deniedSince" = NULL
    WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id} AND "deniedSince" IS NOT NULL
  `;
}

interface ChangeRow {
  id: string;
  seq: bigint | string;
  scopePath: string;
  recordType: string;
  recordId: string;
  op: ChangeOp;
  actorId: string;
  summary: string;
  createdAt: Date;
}

// Field by field rather than a spread, so `seq` stays on the row type and off the
// caller's: adding a column to `change_events` cannot start leaking it by accident.
const toChange = (row: ChangeRow): Omit<Change, "supersededById"> => ({
  id: row.id,
  scopePath: row.scopePath,
  recordType: row.recordType,
  recordId: row.recordId,
  op: row.op,
  actorId: row.actorId,
  summary: row.summary,
  createdAt: row.createdAt,
});

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** How many of a non-empty `page` to serve, as `take` asks: at least one, at most all. */
async function servedCount(take: NonNullable<ReadChangesOptions["take"]>, page: ChangeRow[]): Promise<number> {
  const wanted = await take(page.map(toChange));
  if (!Number.isInteger(wanted)) {
    throw new Error(`readChanges: take must return a whole number of changes to serve, got ${wanted}`);
  }
  const atLeastOne = Math.max(wanted, 1);
  return Math.min(atLeastOne, page.length);
}

/**
 * The seq to resume after, for a caller-supplied change id.
 *
 * Bound by the org AND by the same containment this read already authorized, so a
 * change id from elsewhere in the org is exactly as unusable as one that was never
 * issued — a caller cannot learn an unreadable event's position by handing its id
 * back. node-postgres returns BIGINT as a string, hence the conversion.
 */
async function resolveCursor(orgId: string, changeId: string, containment: Prisma.Sql): Promise<bigint> {
  const query = Prisma.sql`
    SELECT "seq" FROM "change_events"
    WHERE "orgId" = ${orgId} AND "id" = ${changeId} AND ${containment}
  `;
  const rows = await db.$queryRaw<{ seq: bigint | string }[]>(...flattenSql(query));
  const found = rows[0];
  if (!found) throw new UnknownChangeCursorError();
  return BigInt(found.seq);
}

/**
 * One page of the feed for `ctx`'s agent inside `scopePath`, read in one statement: where it
 * resumes (`after`, or the agent's own cursor, 0 if it has never read the feed), the org's
 * newest seq (the horizon), and up to `limit + 1` changes past the resume point, one row past
 * the page so `hasMore` reports a change that really exists rather than a page that happened
 * to fill exactly.
 *
 * One statement is one snapshot, and every agent call that carries a notice runs this, so
 * it is one round trip where it used to be three. The horizon comes from the same snapshot
 * as the page, never a newer one: within an org `seq` order is commit order (the change-feed
 * lock, services/memory/change-events.ts), so every change at or below the horizon is in the
 * snapshot, and advancing the cursor to it after a page that left nothing readable skips only
 * changes the read filtered out. The horizon can still sit behind a row the page served, which
 * is why the caller does not take the cursor from it alone. Neither the horizon nor any seq
 * leaves the server.
 */
async function readPage(
  ctx: AccessContext,
  scopePath: string,
  after: bigint | null,
  limit: number,
): Promise<{ cursor: bigint; horizon: bigint; scanned: ChangeRow[] }> {
  const inScope = scopeContainsSql(Prisma.raw('e."scopePath"'), scopePath, { relation: "within", mode: "ltree" });
  const resume =
    after === null
      ? Prisma.sql`COALESCE((SELECT "lastSeq" FROM "agent_cursors" WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id}), 0)`
      : Prisma.sql`${after}::bigint`;
  const query = Prisma.sql`
    WITH "cursor" AS (SELECT ${resume} AS "seq"),
    "horizon" AS (SELECT COALESCE(MAX("seq"), 0) AS "seq" FROM "change_events" WHERE "orgId" = ${ctx.orgId})
    SELECT c."seq" AS "cursorSeq", h."seq" AS "horizonSeq",
           p."id", p."seq", p."scopePath", p."recordType", p."recordId", p."op", p."actorId", p."summary", p."createdAt"
    FROM "cursor" c
    CROSS JOIN "horizon" h
    LEFT JOIN LATERAL (
      SELECT e."id", e."seq", e."scopePath", e."recordType", e."recordId", e."op", e."actorId", e."summary", e."createdAt"
      FROM "change_events" e
      WHERE e."orgId" = ${ctx.orgId}
        AND e."seq" > c."seq"
        AND ${inScope}
      ORDER BY e."seq"
      LIMIT ${limit + 1}
    ) p ON true
    ORDER BY p."seq"
  `;
  const rows = await db.$queryRaw<
    (Omit<ChangeRow, "id"> & { id: string | null; cursorSeq: bigint | string; horizonSeq: bigint | string })[]
  >(...flattenSql(query));
  // The resume point and the horizon are on every row; with no change past the cursor the
  // one row the join returns carries them alone.
  const first = rows[0]!;
  const scanned = rows
    .filter((row): row is typeof row & { id: string } => row.id !== null)
    .map(({ cursorSeq: _c, horizonSeq: _h, ...row }) => row);
  return { cursor: BigInt(first.cursorSeq), horizon: BigInt(first.horizonSeq), scanned };
}

/** The org's newest event seq, or 0 if it has none. Never returned to a caller:
 * it counts every write in the org, including in scopes the caller cannot read. */
async function latestSeq(orgId: string): Promise<bigint> {
  const [{ latest }] = await db.$queryRaw<[{ latest: bigint | string }]>`
    SELECT COALESCE(MAX("seq"), 0) AS latest FROM "change_events" WHERE "orgId" = ${orgId}
  `;
  return BigInt(latest);
}

/** Move the agent's cursor forward. Never backward: a caller replaying an older
 * page with `after`, or two reads racing, must not let the slower position win and
 * replay events this agent was already served. `endDenial` is set by a read that
 * was allowed, so the next denial is a new one and is audited again. */
async function advanceCursor(
  orgId: string,
  agentId: string,
  seq: bigint,
  { endDenial }: { endDenial: boolean },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "agent_cursors" ("id", "orgId", "agentId", "lastSeq", "updatedAt")
    VALUES (gen_random_uuid()::text, ${orgId}, ${agentId}, ${seq}, ${sqlUtcNow})
    ON CONFLICT ("orgId", "agentId")
    DO UPDATE SET
      "lastSeq" = GREATEST("agent_cursors"."lastSeq", EXCLUDED."lastSeq"),
      "deniedSince" = CASE WHEN ${endDenial} THEN NULL ELSE "agent_cursors"."deniedSince" END,
      "updatedAt" = ${sqlUtcNow}
  `;
}
