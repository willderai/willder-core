// What each agent session got at its start, and which of it the session then used: the
// served-vs-used log (services/memory/task-start-served.ts) read back one serving at a time,
// for the audit page's "Session starts" view.
//
// This file reads; it does not decide who may. The caller has already been allowed
// `access.manage` by check(), the same gate as the rest of the audit page, and passes a scope
// inside its own org. Like the log, the answer carries ids, positions and times, never the
// text of a record: a record's text is read one at a time through the audited change detail.
//
// The one rule this file enforces is the served-vs-used measurement's: a use
// counts for a serving only when its call began after that serving and before the same session
// was served the same task's block again, so a re-served session's later uses go to the later
// serving. A session with no name is shown as served, never as having used nothing: its calls
// cannot be told apart from another session's.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import type { TimeRange } from "@/lib/date-range";
import { sqlUtcAt } from "@/lib/sql-utc-now";

/** One line of a block as served, and whether the session used it. */
export interface ServedLineView {
  /** The 1-based position of the line among the block's item lines. */
  position: number;
  /** What the line shows: "convention", "fact", "change", "note" or "provenance". */
  itemType: string;
  /** The ids the line names: one, or each part of a write served whole on one line. */
  namedIds: string[];
  /** How a later call of the session carried it: "named" in its arguments, "returned" in a reply, or null for unused. */
  use: "named" | "returned" | null;
  /** The change that wrote the record, to open its detail, or null when none is recorded. */
  changeId: string | null;
}

/** One block served to one session. */
export interface SessionStartView {
  servingId: string;
  agentId: string;
  /** "" when the session had no name, so its uses cannot be known. */
  sessionKey: string;
  scopePath: string;
  /** The task the session named, or "". */
  taskKey: string;
  servedAt: string;
  /** How many item lines the block had when served, including any whose record was erased since. */
  lineCount: number;
  /** The lines still on record, in block order. */
  lines: ServedLineView[];
}

export interface SessionStartsPage {
  sessions: SessionStartView[];
  /** Servings in the scope and range, across all pages. */
  total: number;
}

/** The record types a change event names that a served line can point at. */
const LINKED_RECORD_TYPES = ["fact", "convention", "note"];

/** A timestamp printed by the database in UTC. */
const UTC_MS = Prisma.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);

/**
 * The servings of `scope` (the scope or below it) in `orgId`, newest first, one page of
 * `pageSize`, each with its lines and how they were used. `range` keeps the servings served
 * from `from` (inclusive) to `to` (exclusive); it narrows the list, never a serving's uses.
 */
export async function readSessionStarts(input: {
  orgId: string;
  scope: string;
  page: number;
  pageSize: number;
  range?: TimeRange;
}): Promise<SessionStartsPage> {
  const { orgId, scope, page, pageSize, range } = input;
  const servedInRange = Prisma.join(
    [
      range?.from ? Prisma.sql`"servedAt" >= ${sqlUtcAt(range.from)}` : Prisma.sql`TRUE`,
      range?.to ? Prisma.sql`"servedAt" < ${sqlUtcAt(range.to)}` : Prisma.sql`TRUE`,
    ],
    " AND ",
  );
  const servingsInScope = Prisma.sql`
    SELECT DISTINCT ON ("servingId") "servingId", "agentId", "sessionKey", "scopePath", "taskKey", "servedAt", "lineCount"
    FROM "task_start_served"
    WHERE "orgId" = ${orgId} AND "scopePath" <> '' AND "scopePath"::ltree <@ ${scope}::ltree
    ORDER BY "servingId"`;

  const [counted] = await db.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS "total" FROM (${servingsInScope}) servings WHERE ${servedInRange}`;
  const total = counted?.total ?? 0;
  if (total === 0) return { sessions: [], total };

  // The bound is computed over every serving of the session's task, not only this page's or this
  // range's, so neither a page break nor the range's end stretches a serving's uses into the
  // next serving's time.
  const rows = await db.$queryRaw<
    {
      servingId: string;
      agentId: string;
      sessionKey: string;
      scopePath: string;
      taskKey: string;
      servedAt: string;
      lineCount: number;
      position: number;
      itemType: string;
      itemId: string;
      namedIds: string[];
      usedIn: string[];
    }[]
  >`
    WITH "servings" AS (${servingsInScope}),
    "bounded" AS (
      SELECT g.*, lead(g."servedAt") OVER (
        PARTITION BY g."agentId", g."sessionKey", g."scopePath", g."taskKey" ORDER BY g."servedAt", g."servingId"
      ) AS "until"
      FROM "servings" g
    ),
    "page" AS (
      SELECT * FROM "bounded" WHERE ${servedInRange} ORDER BY "servedAt" DESC, "servingId" DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    )
    SELECT p."servingId", p."agentId", p."sessionKey", p."scopePath", p."taskKey",
           to_char(p."servedAt", ${UTC_MS}) AS "servedAt", p."lineCount", s."position",
           min(s."itemType") AS "itemType", min(s."itemId") AS "itemId",
           array_agg(DISTINCT s."namedId" ORDER BY s."namedId") AS "namedIds",
           COALESCE(array_agg(DISTINCT u."field" ORDER BY u."field") FILTER (WHERE u."field" IS NOT NULL), '{}') AS "usedIn"
    FROM "page" p
    JOIN "task_start_served" s ON s."orgId" = ${orgId} AND s."servingId" = p."servingId"
    LEFT JOIN "task_start_item_uses" u
      ON p."sessionKey" <> '' AND u."orgId" = ${orgId} AND u."agentId" = p."agentId" AND u."sessionKey" = p."sessionKey"
     AND u."namedId" = s."namedId" AND u."calledAt" > p."servedAt" AND (p."until" IS NULL OR u."calledAt" < p."until")
    GROUP BY p."servingId", p."agentId", p."sessionKey", p."scopePath", p."taskKey", p."servedAt", p."lineCount", s."position"
    ORDER BY p."servedAt" DESC, p."servingId" DESC, s."position"`;

  const changeIds = await changesThatWrote(orgId, rows);
  const sessions = new Map<string, SessionStartView>();
  for (const row of rows) {
    let session = sessions.get(row.servingId);
    if (!session) {
      session = {
        servingId: row.servingId,
        agentId: row.agentId,
        sessionKey: row.sessionKey,
        scopePath: row.scopePath,
        taskKey: row.taskKey,
        servedAt: row.servedAt,
        lineCount: row.lineCount,
        lines: [],
      };
      sessions.set(row.servingId, session);
    }
    const namedInCall = row.usedIn.some((field) => field !== "result");
    session.lines.push({
      position: row.position,
      itemType: row.itemType,
      namedIds: row.namedIds,
      use: namedInCall ? "named" : row.usedIn.length > 0 ? "returned" : null,
      changeId: row.itemType === "change" ? row.itemId : (changeIds.get(row.namedIds[0]!) ?? null),
    });
  }
  return { sessions: [...sessions.values()], total };
}

/**
 * The newest change that wrote each record a line names, for lines that show a record rather
 * than a change (a change line's own item id is its change). A graph fact has no change event
 * of its own and is left unlinked.
 */
async function changesThatWrote(
  orgId: string,
  rows: readonly { itemType: string; namedIds: string[] }[],
): Promise<Map<string, string>> {
  const recordIds = [...new Set(rows.filter((r) => r.itemType !== "change").map((r) => r.namedIds[0]!))];
  if (recordIds.length === 0) return new Map();
  const found = await db.$queryRaw<{ recordId: string; id: string }[]>`
    SELECT DISTINCT ON ("recordId") "recordId", "id" FROM "change_events"
    WHERE "orgId" = ${orgId} AND "recordId" = ANY (${recordIds}::text[]) AND "recordType" = ANY (${LINKED_RECORD_TYPES}::text[])
    ORDER BY "recordId", "seq" DESC`;
  return new Map(found.map((f) => [f.recordId, f.id]));
}
