// How many facts agents wrote, for the agents dashboard. Counted from the change
// feed (change_events), where every governed write leaves one row with its scope,
// so the count covers only scopes the caller holds a read grant on: a count over
// the whole org would tell a member how much agents write where they cannot look.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { flattenSql, scopeContainsSql } from "@/services/access";
import { FACT_RECORD_TYPE } from "./change-events";

/**
 * Facts created by an agent since `since` inside the scopes in `readablePaths`
 * (from readableScopePaths()): the `create` events a fact write records once per
 * stored version (recordFactCreateOnce, change-events.ts). Removals and supersedes
 * are not writes of a fact and are left out.
 */
export async function countAgentFactWrites(orgId: string, readablePaths: string[], since: Date): Promise<number> {
  if (readablePaths.length === 0) return 0;
  const within = [...new Set(readablePaths)]
    .map((path) => scopeContainsSql(Prisma.raw('"scopePath"'), path, { relation: "within", mode: "ltree" }))
    .reduce((all, leg) => Prisma.sql`${all} OR ${leg}`);
  const rows = await db.$queryRaw<{ n: number }[]>(
    ...flattenSql(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM "change_events"
      WHERE "orgId" = ${orgId} AND "actorType" = 'agent' AND "recordType" = ${FACT_RECORD_TYPE}
        AND "op" = 'create' AND "createdAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND (${within})`),
  );
  return rows[0]?.n ?? 0;
}
