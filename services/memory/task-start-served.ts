// The task-start block's served-vs-used log: which items each block served, on which of its
// lines, and which of those a later call of the same session named or got back.
//
// It works like a search engine's click log. Serving writes an impression per item; a later
// tool call that carries one of those items' ids writes a use; the two are joined only when the
// log is read. That shows whether the deciding item was in the first three on real work, and
// gives a usefulness-weighted ranking its labels, with no staged experiment.
//
// The one rule this file enforces: the log holds ids and positions, never text, and a use is
// counted only for the session that was served the item, only from a call that began after the
// block was served. Concretely:
// - Serving adds no statement: the impressions are inserted by the statement that claims the
//   delivery ({@link servedLogInsert}), so a block is logged exactly when it is claimed.
// - A use row is written only for an id that this org, agent and session were served earlier,
//   matched as a whole token of the call's own arguments or of the tool's own reply, never of
//   the notices appended to it. A session with no name ("") is never matched: its calls cannot
//   be told apart from another session's.
// - "Began after the block was served" is judged on the database's clock, less
//   {@link USE_AFTER_SERVE_MARGIN_MS}, so the call that served the block and calls sent beside
//   it never count as using it.
// - A row about a fact version goes with the version: through the version foreign keys, and
//   through {@link forgetErasedVersions}, which the person erasure calls for the ids it removes.
// - Rows are kept {@link TASK_START_LOG_RETENTION_DAYS} days ({@link pruneTaskStartLog}).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import type { AccessContext } from "@/services/access";

/**
 * How long after a block was served a call must begin for it to count as using an item. A call
 * the agent sent before reading the block (the one that served it, or one sent in the same batch)
 * starts within milliseconds of it; reading the block and choosing a next call takes a model turn,
 * which is seconds. A batched call that starts later than this after the serving call is the one
 * case the margin cannot tell apart, and it is counted.
 */
export const USE_AFTER_SERVE_MARGIN_MS = 1000;

/** How long served and used rows are kept: one quarter, long enough to weigh a rule by its use. */
export const TASK_START_LOG_RETENTION_DAYS = 90;

/** What the delivery of one block is keyed on (services/memory/task-start.ts's TaskStartDeliveryKey). */
interface ServedTo {
  sessionKey: string;
  scopePath: string;
  taskKey: string;
}

/** One item as the log names it: the record type and id its revision key holds (services/memory/revision.ts). */
interface ItemKey {
  itemType: string;
  itemId: string;
}

/** The record type and id of a revision key `<type>:<id>@<revision>`, or null when it has another shape. */
export function itemOfRevisionKey(key: string): ItemKey | null {
  const typeEnd = key.indexOf(":");
  const revisionAt = key.lastIndexOf("@");
  if (typeEnd <= 0 || revisionAt <= typeEnd + 1) return null;
  return { itemType: key.slice(0, typeEnd), itemId: key.slice(typeEnd + 1, revisionAt) };
}

/**
 * The CTE that logs a block's items, joined to the claim CTE `claimed` (which returns
 * `"deliveredAt"` and `"servingId"`), so it inserts only when the claim did. `lines` holds the
 * revision keys of each item line in order; a line's position is its index plus one, and a line
 * showing several parts of one write logs each part at that position.
 *
 * The id a line names is resolved here rather than by the caller: a change line names the record
 * it changed, and a stale flag names its graph fact. The fact version a line shows is recorded
 * only while the version exists, and a line whose version is gone is not logged at all, so no row
 * outlives the text it was about.
 */
export function servedLogInsert(ctx: AccessContext, key: ServedTo, lines: readonly (readonly string[])[]): Prisma.Sql {
  const items = lines.flatMap((keys, index) =>
    keys.flatMap((revisionKey) => {
      const item = itemOfRevisionKey(revisionKey);
      return item ? [{ position: index + 1, ...item }] : [];
    }),
  );
  return Prisma.sql`
    "served" AS (
      INSERT INTO "task_start_served"
        ("id", "orgId", "agentId", "sessionKey", "scopePath", "taskKey", "servingId", "position", "lineCount",
         "itemType", "itemId", "namedId", "versionId", "servedAt")
      SELECT gen_random_uuid()::text, ${ctx.orgId}, ${ctx.actor.id}, ${key.sessionKey}, ${key.scopePath}, ${key.taskKey},
             claimed."servingId", i."position", ${lines.length}::int, i."itemType", i."itemId", named."namedId", version."id", claimed."deliveredAt"
      FROM claimed
      CROSS JOIN unnest(${items.map((i) => i.position)}::int[], ${items.map((i) => i.itemType)}::text[], ${items.map((i) => i.itemId)}::text[])
        AS i("position", "itemType", "itemId")
      LEFT JOIN "change_events" ce ON i."itemType" = 'change' AND ce."orgId" = ${ctx.orgId} AND ce."id" = i."itemId"
      LEFT JOIN "fact_provenance" fp ON i."itemType" = 'provenance' AND fp."orgId" = ${ctx.orgId} AND fp."id" = i."itemId"
      CROSS JOIN LATERAL (
        SELECT COALESCE(ce."recordId", fp."graphitiFactUuid", i."itemId") AS "namedId",
               CASE
                 WHEN i."itemType" = 'fact' THEN i."itemId"
                 WHEN ce."recordType" = 'fact' AND ce."op" = 'create' THEN ce."recordId"
               END AS "shownVersionId"
      ) named
      LEFT JOIN "memory_chunks" version ON version."orgId" = ${ctx.orgId} AND version."id" = named."shownVersionId"
      WHERE named."shownVersionId" IS NULL OR version."id" IS NOT NULL
    )`;
}

/** The claim CTE's RETURNING list that {@link servedLogInsert} reads. */
export const CLAIM_RETURNING = Prisma.sql`"deliveredAt", gen_random_uuid()::text AS "servingId"`;

/** Who made a tool call: the org, the capability's agent, and the session the call names. */
export interface Caller {
  orgId: string;
  agentId: string;
  /** The session the call belongs to, as the delivery keys it, or "" for none. */
  sessionKey: string;
}

/**
 * A whole token: a run of letters and digits of any script, `_` and `-`. Generated ids (cuid,
 * uuid) are made of these, and a letter of another script next to an id makes a longer token, so
 * `éabc` or `abcд` never matches `abc`.
 */
const TOKEN = /[\p{L}\p{N}\p{M}_-]+/gu;
const WHOLE_TOKEN = /^[\p{L}\p{N}\p{M}_-]+$/u;
const TOKEN_CHARACTER_BEFORE = /[\p{L}\p{N}\p{M}_-]$/u;
const TOKEN_CHARACTER_AFTER = /^[\p{L}\p{N}\p{M}_-]/u;

/** How deep into an argument's objects and arrays its strings are read. */
const ARGUMENT_DEPTH = 6;

/** Every string in `value`, down to {@link ARGUMENT_DEPTH} levels of objects and arrays. */
function stringsIn(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= ARGUMENT_DEPTH || typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((inner) => stringsIn(inner, depth + 1));
}

/** The field a use found in the tool's own reply is recorded under. */
export const RESULT_FIELD = "result";

/** Where each text of a call came from: its top-level argument names, and {@link RESULT_FIELD} for the tool's own reply. */
export function textsOfCall(args: unknown, result: Pick<CallToolResult, "content">): { field: string; text: string }[] {
  const fromArgs =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? Object.entries(args).flatMap(([field, value]) => stringsIn(value).map((text) => ({ field, text })))
      : [];
  const fromResult = result.content.flatMap((part) =>
    part.type === "text" ? [{ field: RESULT_FIELD, text: part.text }] : [],
  );
  return [...fromArgs, ...fromResult];
}

/**
 * Which of `ids` each text holds as a whole token ({@link TOKEN}): not inside a longer one, so
 * `abc` is not found in `abc-2`, `xabc` or `ABC`. An id made of other characters is found by an
 * occurrence with no token character on either side.
 */
export function idsNamedIn(
  texts: readonly { field: string; text: string }[],
  ids: readonly string[],
): { namedId: string; field: string }[] {
  const plain = new Set(ids.filter((id) => WHOLE_TOKEN.test(id)));
  const other = ids.filter((id) => !WHOLE_TOKEN.test(id) && id !== "");
  const found = new Map<string, { namedId: string; field: string }>();
  const add = (namedId: string, field: string) => found.set(`${field}\u0000${namedId}`, { namedId, field });
  for (const { field, text } of texts) {
    for (const [token] of text.matchAll(TOKEN)) if (plain.has(token)) add(token, field);
    for (const id of other) {
      for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
        const before = TOKEN_CHARACTER_BEFORE.test(text.slice(Math.max(0, at - 2), at));
        const after = TOKEN_CHARACTER_AFTER.test(text.slice(at + id.length, at + id.length + 2));
        if (!before && !after) {
          add(id, field);
          break;
        }
      }
    }
  }
  return [...found.values()];
}

/** A timestamp the database printed in UTC with `to_char(..., UTC_MS)`, as milliseconds since the epoch. */
const UTC_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Record which items served earlier to `caller`'s session this call used: named in its arguments,
 * or returned in the tool's own reply without being named in them. A call that failed, or a
 * session with no name, records nothing.
 *
 * `startedAt` is when the call began, on `clock` (default `performance.now`). Only an item served
 * more than {@link USE_AFTER_SERVE_MARGIN_MS} before that counts. The start is placed on the
 * database's clock from a reading taken by the same statement that reads the servings, less
 * everything that elapsed until that statement returned: the wait for a pooled connection is in
 * it, so the placed start can only be earlier than the true one, and a call is never credited
 * with an item served after it began.
 *
 * @returns how many use rows were written.
 */
export async function recordItemUses(
  caller: Caller,
  call: { args: unknown; result: CallToolResult; startedAt: number },
  clock: () => number = () => performance.now(),
): Promise<number> {
  if (caller.sessionKey === "" || call.result.isError) return 0;
  const texts = textsOfCall(call.args, call.result);
  if (texts.length === 0) return 0;
  // Timestamps come back as text in UTC, so both are on the database's clock whatever time zone
  // the driver or the session reads a timestamp in.
  const rows = await db.$queryRaw<
    { dbNow: string; namedId: string | null; versionId: string | null; firstServedAt: string | null }[]
  >`
    WITH "reading" AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "at")
    SELECT to_char("reading"."at", ${Prisma.raw(UTC_MS)}) AS "dbNow", s."namedId", s."versionId",
           to_char(s."firstServedAt", ${Prisma.raw(UTC_MS)}) AS "firstServedAt"
    FROM "reading"
    LEFT JOIN LATERAL (
      SELECT "namedId", "versionId", min("servedAt") AS "firstServedAt" FROM "task_start_served"
      WHERE "orgId" = ${caller.orgId} AND "agentId" = ${caller.agentId} AND "sessionKey" = ${caller.sessionKey}
        AND "servedAt" < "reading"."at"
      GROUP BY "namedId", "versionId"
    ) s ON true
  `;
  const elapsed = clock() - call.startedAt;
  const dbNow = rows[0] ? Date.parse(rows[0].dbNow) : Number.NaN;
  if (Number.isNaN(dbNow) || !Number.isFinite(elapsed)) return 0;
  const calledAt = dbNow - Math.max(0, elapsed) - USE_AFTER_SERVE_MARGIN_MS;
  // An id served both as a version's text and as a line naming it keeps the version.
  const versionOf = new Map<string, string | null>();
  for (const { namedId, versionId, firstServedAt } of rows) {
    if (namedId === null || firstServedAt === null || !(Date.parse(firstServedAt) < calledAt)) continue;
    if (!versionOf.get(namedId)) versionOf.set(namedId, versionId);
  }
  if (versionOf.size === 0) return 0;
  // An id the reply echoes from the arguments was already used by naming it; "result" is kept
  // for what the call got back without naming it, such as a query's answers.
  const found = idsNamedIn(texts, [...versionOf.keys()]);
  const named = new Set(found.filter((use) => use.field !== RESULT_FIELD).map((use) => use.namedId));
  const uses = found.filter((use) => use.field !== RESULT_FIELD || !named.has(use.namedId));
  if (uses.length === 0) return 0;
  const calledAtUtc = new Date(calledAt).toISOString().slice(0, -1);
  return db.$executeRaw`
    INSERT INTO "task_start_item_uses" ("id", "orgId", "agentId", "sessionKey", "namedId", "versionId", "field", "calledAt")
    SELECT gen_random_uuid()::text, ${caller.orgId}, ${caller.agentId}, ${caller.sessionKey}, u."namedId", u."versionId", u."field", ${calledAtUtc}::timestamp
    FROM unnest(${uses.map((u) => u.namedId)}::text[], ${uses.map((u) => versionOf.get(u.namedId) ?? null)}::text[], ${uses.map((u) => u.field)}::text[])
      AS u("namedId", "versionId", "field")
  `;
}

/**
 * Inside a person erasure's transaction: delete every served and used row naming one of the fact
 * versions it removed, including a change line that named the version without showing it.
 */
export async function forgetErasedVersions(
  tx: Prisma.TransactionClient,
  orgId: string,
  versionIds: readonly string[],
): Promise<void> {
  if (versionIds.length === 0) return;
  await tx.$executeRaw`DELETE FROM "task_start_served" WHERE "orgId" = ${orgId} AND "namedId" = ANY (${[...versionIds]}::text[])`;
  await tx.$executeRaw`DELETE FROM "task_start_item_uses" WHERE "orgId" = ${orgId} AND "namedId" = ANY (${[...versionIds]}::text[])`;
}

/** Rows deleted per statement, so a large backlog never holds one long lock. */
const PRUNE_BATCH = 5000;

/**
 * Delete served rows served, and use rows whose call began, more than `days` days ago, in every
 * org, in batches of {@link PRUNE_BATCH}.
 *
 * @returns how many rows of each went.
 */
export async function pruneTaskStartLog(
  days = TASK_START_LOG_RETENTION_DAYS,
): Promise<{ served: number; uses: number }> {
  if (!Number.isSafeInteger(days) || days < 1)
    throw new Error(`pruneTaskStartLog needs a whole number of days of at least 1; got ${days}.`);
  const cutoff = Prisma.sql`${sqlUtcNow} - make_interval(days => ${days}::int)`;
  const pruned = { served: 0, uses: 0 };
  for (;;) {
    const n = await db.$executeRaw`
      DELETE FROM "task_start_served" WHERE "id" IN (SELECT "id" FROM "task_start_served" WHERE "servedAt" < ${cutoff} LIMIT ${PRUNE_BATCH})`;
    pruned.served += n;
    if (n < PRUNE_BATCH) break;
  }
  for (;;) {
    const n = await db.$executeRaw`
      DELETE FROM "task_start_item_uses" WHERE "id" IN (SELECT "id" FROM "task_start_item_uses" WHERE "calledAt" < ${cutoff} LIMIT ${PRUNE_BATCH})`;
    pruned.uses += n;
    if (n < PRUNE_BATCH) break;
  }
  return pruned;
}
