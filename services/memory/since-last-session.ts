// What changed in an agent's scope while it was away: the counts behind the line the
// task-start block opens a returning session with (mcp/task-start-notice.ts).
//
// "Away" is measured from what Willder already records, and this file writes nothing. The
// agent's last call is the newest `lastCallAt` among its task-start deliveries in the org
// (services/memory/task-start.ts), read in the task-start read, before the new session claims
// its own delivery. A session is a return only when that call is older than the product's
// session boundary (SESSION_IDLE_MS): a reconnect a few minutes later is the same stretch of
// work, not a return.
//
// What changed is read from the change feed (services/memory/change-feed.ts): changes by
// anyone but the agent, inside the scope the block is read for, made after that last call and
// not yet served to the agent (past its cursor), so a change it was already told about is
// never announced again. Working-note posts are left out: the block lists the notes live
// now, and a note's renewal is not a change to memory.
//
// The one rule this file enforces: the counts cover only what a read of the same scope would
// serve, and carry no record's text. Nothing outside `scopePath` or the org is counted, so a
// change in a scope the caller cannot read never shows in a number, and a line built from
// these counts cannot name a fact, a person or a scope. The caller must already have been
// allowed to read `scopePath`; the filter uses it as given.
import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { scopeContainsSql, type AccessContext } from "@/services/access";
import { MAX_WAITING_COUNTED } from "./change-feed";
import { WORKING_NOTE_RECORD_TYPE } from "./working-notes";

/** What changed in the agent's scope between its last call and this session. */
export interface SinceLastSession {
  /** The agent's last recorded call before this session, on the database's clock. */
  lastCallAt: Date;
  /** Changes counted, at most {@link MAX_WAITING_COUNTED}. */
  changes: number;
  /** True when counting stopped at {@link MAX_WAITING_COUNTED}: there may be more. */
  capped: boolean;
  /** How many different actors made the changes counted. */
  writers: number;
  /** How many of the changes counted were made under the session's task; 0 when it names none. */
  onTask: number;
}

/** The counts as {@link sinceLastSessionSql} returns them, the instant as JSON text. */
export interface SinceLastSessionRow {
  lastCallAt: string | null;
  changes: number;
  writers: number;
  onTask: number;
}

/**
 * One scalar subquery, for a column of the task-start read: the counts of what changed in
 * `scopePath` since `ctx`'s agent last called, as {@link SinceLastSessionRow}. Its
 * `lastCallAt` is null when the agent has no earlier call in the org; its counts are 0 when
 * that call is within `sessionIdleMs`, or when nothing it would be told about changed.
 *
 * @param taskKey the task the session names, or "" when it names none.
 * @param sessionIdleMs the session boundary (SESSION_IDLE_MS in services/memory/task-start.ts).
 */
export function sinceLastSessionSql(
  ctx: AccessContext,
  scopePath: string,
  taskKey: string,
  sessionIdleMs: number,
): Prisma.Sql {
  const inScope = scopeContainsSql(Prisma.raw('e."scopePath"'), scopePath, { relation: "within", mode: "ltree" });
  return Prisma.sql`(
    WITH "lastCall" AS (
      SELECT max("lastCallAt") AS "at" FROM "task_start_deliveries"
      WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id}
    ),
    "changed" AS (
      SELECT e."actorId", e."task"
      FROM "change_events" e, "lastCall" l
      WHERE e."orgId" = ${ctx.orgId}
        AND l."at" < ${sqlUtcNow} - make_interval(secs => ${sessionIdleMs / 1000})
        AND e."seq" > COALESCE(
          (SELECT "lastSeq" FROM "agent_cursors" WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id}),
          0
        )
        -- At or after: a change stamped in the last call's millisecond was not served by it
        -- unless the cursor passed it, which the filter above already checks.
        AND e."createdAt" >= l."at"
        AND e."actorId" <> ${ctx.actor.id}
        AND e."recordType" <> ${WORKING_NOTE_RECORD_TYPE}
        AND ${inScope}
      -- Walks the (orgId, seq) index forward from the cursor and stops at the cap.
      ORDER BY e."seq"
      LIMIT ${MAX_WAITING_COUNTED}
    )
    SELECT json_build_object(
      -- Stored as UTC without a zone, spelled out so it parses back to the same instant.
      'lastCallAt', to_char(l."at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'changes', (SELECT count(*)::int FROM "changed"),
      'writers', (SELECT count(DISTINCT "actorId")::int FROM "changed"),
      'onTask', ${taskKey === "" ? Prisma.sql`0` : Prisma.sql`(SELECT count(*)::int FROM "changed" WHERE "task" = ${taskKey})`}
    )
    FROM "lastCall" l
  )`;
}

/** What {@link sinceLastSessionSql} found, or null when the session is not a return or nothing changed. */
export function sinceLastSessionOf(row: SinceLastSessionRow | null): SinceLastSession | null {
  if (row === null || row.lastCallAt === null || row.changes === 0) return null;
  return {
    lastCallAt: new Date(row.lastCallAt),
    changes: row.changes,
    capped: row.changes >= MAX_WAITING_COUNTED,
    writers: row.writers,
    onTask: row.onTask,
  };
}
