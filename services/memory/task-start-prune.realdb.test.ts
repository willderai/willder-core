// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// pruneIdleTaskStartDeliveries (services/memory/task-start.ts) at scale and under stale planner
// statistics. Its earlier single statement, a DELETE whose row search joined the table to
// itself, ran past a minute on 10,000 idle rows of one agent when the statistics were taken
// while the table held one row, as autovacuum can leave them early in a database's life. These
// tests seed that state, bound the prune's time, ask Postgres for the plan of every statement the
// prune runs, and check which rows it keeps.
//
// Real: Postgres, the prune's own statements, run through the app's database client. Time: rows
// are written with their lastCallAt already in the past, never a sleep.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_task_start_prune";
const OTHER_ORG = "qa_task_start_prune_other";
const AGENT = "prune-agent";
const ROWS = 10_000;
/** Generous: the prune takes well under a second here; the old statement ran past 60 s. */
const PRUNE_BUDGET_MS = 10_000;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Parent Relationship"?: string;
  Plans?: PlanNode[];
}

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

describe.skipIf(!QA_URL)(
  "pruneIdleTaskStartDeliveries at 10,000 idle rows of one agent, under stale statistics",
  () => {
    let db: PrismaClient;
    let appDb: (typeof import("@/lib/db"))["db"];
    let pruneIdleTaskStartDeliveries: (typeof import("@/services/memory/task-start"))["pruneIdleTaskStartDeliveries"];

    async function clean(): Promise<void> {
      for (const orgId of [ORG, OTHER_ORG]) {
        await db.taskStartDelivery.deleteMany({ where: { orgId } });
        await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
      }
    }

    /**
     * Leave the planner believing the table holds one of this file's rows, then write ROWS idle
     * rows of one agent, all with the same lastCallAt and with ids in ascending order: the layout
     * that made the old statement's per-row search longest. (Statistics from an empty table do not
     * reproduce it: Postgres then estimates from the table's real size.) Returns the row count the
     * planner's statistics record, so a test can check they really are stale.
     */
    async function seedUnderStaleStatistics(): Promise<number> {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      VALUES (${`${ORG}:seed`}, ${ORG}, ${AGENT}, 'seed', 'r', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))`;
      await db.$executeRaw`ANALYZE "task_start_deliveries"`;
      await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      SELECT ${`${ORG}:`} || lpad(n::text, 6, '0'), ${ORG}, ${AGENT}, 'mcp:idle-' || n, 'r',
             (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') - interval '2 days'
      FROM generate_series(1, ${ROWS}::int) AS n`;
      const [{ reltuples }] = await db.$queryRaw<{ reltuples: number }[]>`
      SELECT reltuples::float8 AS "reltuples" FROM pg_class WHERE oid = '"task_start_deliveries"'::regclass`;
      return reltuples;
    }

    /** Run the prune, and if it is still running after `ms`, cancel it and fail with a named error. */
    async function pruneWithin(ms: number): Promise<number> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`pruneIdleTaskStartDeliveries ran past ${ms} ms and was cancelled`)),
          ms,
        );
      });
      try {
        return await Promise.race([pruneIdleTaskStartDeliveries(), late]);
      } catch (error) {
        await db.$queryRaw`
        SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
          AND query LIKE '%task_start_deliveries%'`;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ db: appDb } = await import("@/lib/db"));
      ({ pruneIdleTaskStartDeliveries } = await import("@/services/memory/task-start"));
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      await clean();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      for (const orgId of [ORG, OTHER_ORG]) {
        await db.taskStartDelivery.deleteMany({ where: { orgId } });
        await db.org.deleteMany({ where: { id: orgId } });
      }
      await db.$disconnect();
      await appDb.$disconnect();
    });

    it(
      "prunes within its budget with statistics taken on a table holding one row, keeping only the newest row",
      async () => {
        expect(await seedUnderStaleStatistics()).toBeLessThan(ROWS / 10);

        expect(await pruneWithin(PRUNE_BUDGET_MS)).toBeGreaterThanOrEqual(ROWS - 1);

        // Every row has the same lastCallAt, so the greatest id is the newest.
        const kept = await db.taskStartDelivery.findMany({ where: { orgId: ORG }, select: { id: true } });
        expect(kept).toEqual([{ id: `${ORG}:${String(ROWS).padStart(6, "0")}` }]);
      },
      PRUNE_BUDGET_MS + 20_000,
    );

    it("finds idle rows behind more than a batch of live ones, so live sessions cannot fill the batch", async () => {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      SELECT ${`${ORG}:live-`} || n, ${ORG}, ${AGENT}, 'mcp:live-' || n, 'r',
             (now() AT TIME ZONE 'UTC') - interval '1 hour', (now() AT TIME ZONE 'UTC') - interval '1 hour'
      FROM generate_series(1, 6000) AS n
      UNION ALL
      SELECT ${`${ORG}:idle-`} || n, ${ORG}, ${AGENT}, 'mcp:idle-' || n, 'r',
             (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') - interval '3 days'
      FROM generate_series(1, 3) AS n`;

      expect(await pruneWithin(PRUNE_BUDGET_MS)).toBeGreaterThanOrEqual(3);

      expect(await db.taskStartDelivery.count({ where: { orgId: ORG, id: { startsWith: `${ORG}:idle-` } } })).toBe(0);
      expect(await db.taskStartDelivery.count({ where: { orgId: ORG } })).toBe(6000);
    }, 30_000);

    it("runs only statements with no join and no per-row subquery, under the same statistics", async () => {
      expect(await seedUnderStaleStatistics()).toBeLessThan(ROWS / 10);
      // Spies that call through, so the prune runs its own statements and the calls are kept.
      const search = vi.spyOn(appDb, "$queryRaw");
      const deletes = vi.spyOn(appDb, "$executeRaw");

      await pruneWithin(PRUNE_BUDGET_MS);

      const statements = [...search.mock.calls, ...deletes.mock.calls]
        .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values))
        .sort((a, b) => a.sql.localeCompare(b.sql));
      // Two batches of a search and a DELETE: 5,000 rows, then the other 4,999.
      expect(statements.map((s) => s.sql.trim().split(/\s/)[0])).toEqual(["DELETE", "DELETE", "SELECT", "SELECT"]);
      // Re-plan each statement against the stale statistics. EXPLAIN without ANALYZE runs nothing,
      // and the seeded rows are gone, so plan against a fresh copy of them.
      await seedUnderStaleStatistics();
      for (const statement of statements) {
        const [row] = await db.$queryRaw<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>`EXPLAIN (FORMAT JSON) ${statement}`;
        const nodes = nodesOf(row["QUERY PLAN"][0].Plan);
        // One scan of the table: the DELETE's own ModifyTable node names the table too, and reads nothing.
        const scans = nodes.filter(
          (node) => node["Relation Name"] === "task_start_deliveries" && node["Node Type"] !== "ModifyTable",
        );
        expect(scans, statement.sql).toHaveLength(1);
        expect(
          nodes.map((node) => node["Node Type"]),
          statement.sql,
        ).not.toEqual(expect.arrayContaining([expect.stringMatching(/Nested Loop|Hash Join|Merge Join/)]));
        expect(
          nodes.filter((node) => node["Parent Relationship"] === "SubPlan"),
          statement.sql,
        ).toEqual([]);
      }
    }, 60_000);

    it("keeps each agent's newest row in each org, even when that row is not idle, and nothing younger than the retention", async () => {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      SELECT id, org, agent, id, 'r', at, at FROM (VALUES
        ('qa-prune-a-old',     ${ORG}::text,       ${AGENT}::text, (now() AT TIME ZONE 'UTC') - interval '9 days'),
        ('qa-prune-a-mid',     ${ORG},             ${AGENT},       (now() AT TIME ZONE 'UTC') - interval '3 days'),
        ('qa-prune-a-live',    ${ORG},             ${AGENT},       (now() AT TIME ZONE 'UTC')),
        ('qa-prune-b-23h',     ${ORG},             'agent-b',      (now() AT TIME ZONE 'UTC') - interval '23 hours'),
        ('qa-prune-b-newest',  ${ORG},             'agent-b',      (now() AT TIME ZONE 'UTC') - interval '1 hour'),
        ('qa-prune-c-tie-a',   ${ORG},             'agent-c',      (now() AT TIME ZONE 'UTC') - interval '5 days'),
        ('qa-prune-c-tie-b',   ${ORG},             'agent-c',      (now() AT TIME ZONE 'UTC') - interval '5 days'),
        ('qa-prune-other-org', ${OTHER_ORG},       ${AGENT},       (now() AT TIME ZONE 'UTC') - interval '9 days')
      ) AS r(id, org, agent, at)`;

      expect(await pruneIdleTaskStartDeliveries()).toBeGreaterThanOrEqual(3);

      const kept = await db.taskStartDelivery.findMany({
        where: { orgId: { in: [ORG, OTHER_ORG] } },
        select: { id: true },
      });
      // a-old and a-mid go: a-live is newer, idle or not. b-23h is inside the retention. Of two rows
      // as new as each other, the greater id stays. The other org's row is its agent's newest there.
      expect(kept.map((row) => row.id).sort()).toEqual([
        "qa-prune-a-live",
        "qa-prune-b-23h",
        "qa-prune-b-newest",
        "qa-prune-c-tie-b",
        "qa-prune-other-org",
      ]);
    });

    it("never deletes a row a claim refreshed between the search and the DELETE", async () => {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      VALUES
        ('qa-prune-refreshed', ${ORG}, ${AGENT}, 'mcp:refreshed', 'r', (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') - interval '3 days'),
        ('qa-prune-newer',     ${ORG}, ${AGENT}, 'mcp:newer',     'r', (now() AT TIME ZONE 'UTC') - interval '2 days', (now() AT TIME ZONE 'UTC') - interval '2 days')`;
      const search = appDb.$queryRaw.bind(appDb);
      vi.spyOn(appDb, "$queryRaw").mockImplementationOnce((async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const found = await (
          search as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ id: string }[]>
        )(strings, ...values);
        expect(found.map((row) => row.id)).toContain("qa-prune-refreshed");
        // What claimTaskStartDelivery's ON CONFLICT DO UPDATE does, landing between the two statements.
        await db.$executeRaw`
        UPDATE "task_start_deliveries" SET "lastCallAt" = (now() AT TIME ZONE 'UTC'), "revision" = 'claimed'
        WHERE "id" = 'qa-prune-refreshed'`;
        return found;
      }) as never);

      await pruneIdleTaskStartDeliveries();

      const kept = await db.taskStartDelivery.findMany({ where: { orgId: ORG }, select: { id: true, revision: true } });
      expect(kept.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "qa-prune-newer", revision: "r" },
        { id: "qa-prune-refreshed", revision: "claimed" },
      ]);
    });

    it("never deletes a row a claim refreshed while the DELETE waited on its lock", async () => {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      VALUES
        ('qa-prune-held',  ${ORG}, ${AGENT}, 'mcp:held',  'r', (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') - interval '3 days'),
        ('qa-prune-newer', ${ORG}, ${AGENT}, 'mcp:newer', 'r', (now() AT TIME ZONE 'UTC') - interval '2 days', (now() AT TIME ZONE 'UTC') - interval '2 days')`;

      let prune: Promise<number> | undefined;
      await db.$transaction(
        async (tx) => {
          // What claimTaskStartDelivery's ON CONFLICT DO UPDATE does, held open: the search still
          // sees the idle row and picks it, and the DELETE then waits on this lock.
          await tx.$executeRaw`
          UPDATE "task_start_deliveries" SET "lastCallAt" = (now() AT TIME ZONE 'UTC'), "revision" = 'claimed'
          WHERE "id" = 'qa-prune-held'`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS "pid"`;
          prune = pruneIdleTaskStartDeliveries();
          for (let waited = 0; ; waited += 50) {
            const [{ blocked }] = await db.$queryRaw<{ blocked: number }[]>`
            SELECT count(*)::int AS "blocked" FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
            if (blocked > 0) break;
            if (waited > 10_000) throw new Error("the prune never waited on the claim's lock");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },
        { timeout: 20_000 },
      );
      await prune;

      // "newer" was the agent's newest row when the search ran, so it stays too.
      const kept = await db.taskStartDelivery.findMany({ where: { orgId: ORG }, select: { id: true, revision: true } });
      expect(kept.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "qa-prune-held", revision: "claimed" },
        { id: "qa-prune-newer", revision: "r" },
      ]);
    }, 30_000);

    it("returns 0 and deletes nothing when no row is past the retention", async () => {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      VALUES ('qa-prune-only', ${ORG}, ${AGENT}, 'mcp:only', 'r', (now() AT TIME ZONE 'UTC') - interval '9 days', (now() AT TIME ZONE 'UTC') - interval '9 days')`;
      await pruneIdleTaskStartDeliveries();
      const deletes = vi.spyOn(appDb, "$executeRaw");

      expect(await pruneIdleTaskStartDeliveries()).toBe(0);
      expect(deletes).not.toHaveBeenCalled();
      expect(await db.taskStartDelivery.count({ where: { orgId: ORG } })).toBe(1);
    });
  },
);
