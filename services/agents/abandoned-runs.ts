// Agent runs that stopped without saying so.
//
// A run is advanced by a driver inside one server invocation. When the platform ends
// that invocation between steps (a timeout, a crash, a redeploy), nothing writes the
// run's terminal state, and its row says `running` for good: the nav badge counts it
// and the agents page shows work in progress that ended long ago.
//
// The one rule this file enforces: a run still marked running is abandoned once
// nothing has happened on it, no event on the run itself or on a run it started, for
// longer than a live run goes quiet. That is an hour while the run works, and seven
// days while it, or a run it started, waits on a person to answer. Every count of
// running runs leaves abandoned runs out (runAbandonedSql), and a scheduled sweep
// marks them failed and says why in the run's own event log (failAbandonedRuns).
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { flattenSql } from "@/services/access";
import { emit } from "@/services/agents/run-events";

/**
 * How long a working run may go without an event. A driver invocation ends within the
 * platform's function time limit, minutes, and writes an event per step, so an hour of
 * silence means no invocation is driving the run.
 */
const WORKING_RUN_QUIET_LIMIT_MS = 60 * 60 * 1000;

/** How long a run paused on a question to a person stays live without an answer. */
const WAITING_RUN_QUIET_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/** What a failed abandoned run tells whoever opens it. */
const ABANDONED_RUN_MESSAGE =
  "This run stopped responding and was marked failed. Nothing was lost; start a new run to continue.";

/**
 * True for a row of `"agent_runs"` that is marked running but abandoned at `now`.
 *
 * The predicate names the table, so the query it goes into must read `"agent_runs"`
 * without an alias. A run's activity is its start, its newest event, and the newest
 * event of any run that names it as `meta.parentRunId`: a manager writes nothing
 * itself while its children work.
 */
export function runAbandonedSql(now: Date): Prisma.Sql {
  const childOf = Prisma.sql`child."orgId" = "agent_runs"."orgId" AND child."meta"->>'parentRunId' = "agent_runs"."id"`;
  const lastActivity = Prisma.sql`GREATEST(
    "agent_runs"."startedAt",
    (SELECT MAX(e."createdAt") FROM "agent_run_events" e WHERE e."runId" = "agent_runs"."id"),
    (SELECT MAX(e."createdAt") FROM "agent_run_events" e JOIN "agent_runs" child ON child."id" = e."runId" WHERE ${childOf})
  )`;
  const waitingOnPerson = Prisma.sql`("agent_runs"."phase" = 'paused' OR EXISTS (
    SELECT 1 FROM "agent_runs" child WHERE ${childOf} AND child."status" = 'running' AND child."phase" = 'paused'
  ))`;
  const quietSince = Prisma.sql`CASE WHEN ${waitingOnPerson}
    THEN ${utcTimestamp(new Date(now.getTime() - WAITING_RUN_QUIET_LIMIT_MS))}
    ELSE ${utcTimestamp(new Date(now.getTime() - WORKING_RUN_QUIET_LIMIT_MS))} END`;
  return Prisma.sql`("agent_runs"."status" = 'running' AND ${lastActivity} < ${quietSince})`;
}

/**
 * Mark every abandoned run failed, in every org, and append the reason and the
 * terminal phase to each run's event log. Returns the runs it failed.
 *
 * The update re-tests the rule in the same statement, so a run that wrote an event
 * after the scheduler picked a time is left alone rather than failed under it.
 */
export async function failAbandonedRuns(now: Date = new Date()): Promise<{ runId: string; orgId: string }[]> {
  // A reviewed exception to the raw-SQL rule: this statement reads no memory and returns
  // only run ids, and the rule needs each run compared with its own and its children's
  // newest event, a correlated query the typed layer cannot state.
  // eslint-disable-next-line no-restricted-syntax -- see the comment above.
  const failed = await db.$queryRaw<{ runId: string; orgId: string }[]>(
    ...flattenSql(Prisma.sql`
      UPDATE "agent_runs" SET "status" = 'failed', "phase" = 'failed', "finishedAt" = ${utcTimestamp(now)}
      WHERE ${runAbandonedSql(now)}
      RETURNING "id" AS "runId", "orgId"`),
  );
  for (const { runId } of failed) {
    await emit(runId, { type: "error", message: ABANDONED_RUN_MESSAGE });
    await emit(runId, { type: "phase", phase: "failed" });
  }
  return failed;
}

/** `at` as the UTC wall-clock value the `timestamp(3)` columns store, whatever the session time zone. */
export function utcTimestamp(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
