// Latency budget for the derived-write decision (services/access/derived-writes.ts), apart from
// the functional tests because a clock reading is only meaningful on a machine that is not busy.
//
// Skipped unless WILLDER_PERF_TESTS=1 and QA_DATABASE_URL names an isolated, migrated Postgres.
// CI does not set WILLDER_PERF_TESTS: its shards run many workers at once, and the bound failed
// there under load with the code unchanged. The claim behind the budget, that the decision's cost
// does not grow with the session, is pinned without a clock in derived-write.realdb.test.ts
// ("takes one database statement"), and that version runs in every CI shard.
//
// Run on a quiet machine:
//   WILLDER_PERF_TESTS=1 QA_DATABASE_URL=<test database> npx vitest run --project node mcp/derived-write.perf.realdb.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "derivedwriteperf";
const ROOT = `org_${ORG}`;
const TARGET = `${ROOT}.allstaff`;
const AGENT = "cost-probe";
const DECISIONS = 200;
const WARM_UP = 20;

describe.skipIf(!QA_URL || process.env.WILLDER_PERF_TESTS !== "1")("performance: the derived-write decision", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.$executeRaw`
      INSERT INTO "session_scope_reads" ("orgId", "agentId", "scopePath", "lastReadAt")
      SELECT ${ORG}, ${AGENT}, ${ROOT} || '.team' || n, (now() AT TIME ZONE 'UTC') FROM generate_series(1, 50) AS n
    `;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("decides a write against a session of 50 scopes with a 95th percentile under 50 ms", async () => {
    const { decideDerivedWrite } = await import("@/services/access/derived-writes");
    const { db: appDb } = await import("@/lib/db");
    const decide = () =>
      expect(decideDerivedWrite(appDb, { orgId: ORG, agentId: AGENT, target: TARGET })).rejects.toThrow(
        "derived_write",
      );
    for (let i = 0; i < WARM_UP; i++) await decide();
    const timings: number[] = [];
    for (let i = 0; i < DECISIONS; i++) {
      const started = performance.now();
      await decide();
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)]!;
    console.info(
      `derived-write decision, 50-scope session: p50 ${timings[DECISIONS / 2]!.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`,
    );
    expect(p95).toBeLessThan(50);
    // The timeout covers the 220 decisions, not the budget above: Vitest's 5 s default is shorter than the loop.
  }, 60_000);
});
