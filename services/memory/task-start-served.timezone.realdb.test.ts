// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The served-vs-used log's clock, on sessions west and east of UTC. A serving's time and a
// call's start are both read off the database's clock (services/memory/task-start-served.ts);
// if either went through the session's TimeZone, a serving would read hours older or newer
// than a call, and a call sent before the block was read would count as using it, or a real
// use would not count. Each zone runs the same checks on its own fresh module graph.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;
const SESSION_TIME_ZONES = ["America/Los_Angeles", "Asia/Tokyo"];
const ORG = "qa_served_tz";
const ROOT = `org_${ORG}`;
const RULE = "qaservedtzrule1";
const HOUR = 3_600_000;

/** QA_URL with every connection's session TimeZone set to `zone`. */
function inTimeZone(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

describe.skipIf(!QA_URL).each(SESSION_TIME_ZONES)("the served-vs-used log on a session in %s", (zone) => {
  let db: PrismaClient;
  let served: typeof import("./task-start-served");
  let tasks: typeof import("./task-start");
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "tz-agent", capabilityToken: "unused" },
    origin: "mcp",
  };
  const caller = { orgId: ORG, agentId: "tz-agent", sessionKey: "s-tz" };
  const naming = (startedMsAgo: number) => ({
    args: { briefId: RULE },
    result: { content: [] },
    startedAt: performance.now() - startedMsAgo,
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    const url = inTimeZone(QA_URL!, zone);
    process.env.DATABASE_URL = url;
    // A fresh module graph and shared client per zone: lib/db.ts caches its client on globalThis.
    const cached = globalThis as unknown as { prisma?: PrismaClient };
    await cached.prisma?.$disconnect();
    cached.prisma = undefined;
    vi.resetModules();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    served = await import("./task-start-served");
    tasks = await import("./task-start");
    const { db: shared } = await import("@/lib/db");
    const [{ TimeZone }] = await shared.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
    expect(TimeZone).toBe(zone);
  });

  beforeEach(async () => {
    await db.taskStartItemUse.deleteMany({ where: { orgId: ORG } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    if (!db) return;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("stamps a serving with the delivery's own UTC instant", async () => {
    await tasks.claimTaskStartDelivery(ctx, { sessionKey: "s-tz", scopePath: ROOT, taskKey: "" }, "rev", [
      [`convention:${RULE}@1`],
    ]);
    const [row] = await db.taskStartServedItem.findMany({ where: { orgId: ORG } });
    const delivery = await db.taskStartDelivery.findFirstOrThrow({ where: { orgId: ORG } });
    expect(row!.servedAt).toEqual(delivery.deliveredAt);
    expect(Math.abs(row!.servedAt.getTime() - Date.now())).toBeLessThan(HOUR / 60);
  });

  it("counts a call only once it began the margin after the serving", async () => {
    await tasks.claimTaskStartDelivery(ctx, { sessionKey: "s-tz", scopePath: ROOT, taskKey: "" }, "rev", [
      [`convention:${RULE}@1`],
    ]);
    expect(await served.recordItemUses(caller, naming(0))).toBe(0);

    await db.$executeRaw`UPDATE "task_start_served" SET "servedAt" = "servedAt" - make_interval(secs => ${(served.USE_AFTER_SERVE_MARGIN_MS + 2000) / 1000}::float8) WHERE "orgId" = ${ORG}`;
    // Begun three seconds ago: before the serving moved back by the margin and two seconds.
    expect(await served.recordItemUses(caller, naming(3000))).toBe(0);
    expect(await served.recordItemUses(caller, naming(0))).toBe(1);
    const [use] = await db.taskStartItemUse.findMany({ where: { orgId: ORG } });
    expect(Math.abs(use!.calledAt.getTime() - (Date.now() - served.USE_AFTER_SERVE_MARGIN_MS))).toBeLessThan(HOUR / 60);
  });

  it("never credits a call with a block served after it began, however long its reading waited", async () => {
    const startedAt = performance.now();
    await sleep(50);
    await tasks.claimTaskStartDelivery(ctx, { sessionKey: "s-tz", scopePath: ROOT, taskKey: "" }, "rev", [
      [`convention:${RULE}@1`],
    ]);
    // Another transaction holds the table, so the use's reading waits on the server, as it would
    // for a busy pool or a lock: the wait is longer than the margin.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "task_start_served" IN ACCESS EXCLUSIVE MODE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const recording = served.recordItemUses(caller, { args: { briefId: RULE }, result: { content: [] }, startedAt });
    await sleep(served.USE_AFTER_SERVE_MARGIN_MS + 500);
    release();
    await holder;
    expect(await recording).toBe(0);
  }, 20_000);
});
