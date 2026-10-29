// What agents did through the access layer, for the agents dashboard: how many of
// their access decisions were allowed and denied, and per connected agent, its
// token calls per day. Read from the audit log, so only an access manager may see
// it (the same authority GET /api/audit requires); the caller decides that.
//
// Rows are counted under the audit trail's own visibility rule
// (services/audit/visibility.ts), so these numbers are the ones a reader of the
// audit page can reproduce, and allowed and denied always count the same set.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { flattenSql } from "./scope-containment";
import { visibleAuditRowSql } from "@/services/audit/visibility";

/** Every agent access decision in a window, split by outcome. */
export interface AgentDecisionCounts {
  allowed: number;
  denied: number;
}

/** `at` as the UTC wall-clock value the `timestamp(3)` column stores. */
function utc(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Allowed and denied audit rows written by any agent since `since`. */
export async function countAgentDecisions(orgId: string, since: Date): Promise<AgentDecisionCounts> {
  const rows = await db.$queryRaw<AgentDecisionCounts[]>(
    ...flattenSql(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE "decision" = 'allow')::int AS "allowed",
        COUNT(*) FILTER (WHERE "decision" = 'deny')::int AS "denied"
      FROM "audit_log"
      WHERE "orgId" = ${orgId} AND "actorType" = 'agent' AND "at" >= ${utc(since)} AND ${visibleAuditRowSql()}`),
  );
  return { allowed: rows[0]?.allowed ?? 0, denied: rows[0]?.denied ?? 0 };
}

/**
 * Audit rows per agent id per whole day before `now`: `ago` 0 is the last 24 hours.
 * `failed` counts the denied ones. Only the ids asked for, and only `days` back.
 */
export async function dailyAgentDecisions(
  orgId: string,
  actorIds: string[],
  now: Date,
  days: number,
): Promise<{ actorId: string; ago: number; total: number; failed: number }[]> {
  if (actorIds.length === 0) return [];
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return db.$queryRaw(
    ...flattenSql(Prisma.sql`
      SELECT "actorId",
        FLOOR(EXTRACT(EPOCH FROM (${utc(now)} - "at")) / 86400)::int AS "ago",
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (WHERE "decision" = 'deny')::int AS "failed"
      FROM "audit_log"
      WHERE "orgId" = ${orgId} AND "actorType" = 'agent' AND "actorId" IN (${Prisma.join(actorIds)})
        AND "at" >= ${utc(since)} AND "at" <= ${utc(now)} AND ${visibleAuditRowSql()}
      GROUP BY 1, 2`),
  );
}
