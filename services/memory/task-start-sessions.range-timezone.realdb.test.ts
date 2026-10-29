// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The session-starts date range on Postgres sessions west and east of UTC. `servedAt` is a
// `timestamp without time zone` holding UTC; a bound compared through the session's TimeZone
// would move the range by hours, keeping a serving the range ends before or dropping one it
// starts at. Each zone runs on its own fresh module graph.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const SESSION_TIME_ZONES = ["America/Los_Angeles", "Asia/Tokyo"];
const ORG = "qa_sessions_range_tz";
const ROOT = `org_${ORG}`;
const SERVED_AT = new Date("2026-10-14T10:00:00Z");

/** QA_URL with every connection's session TimeZone set to `zone`. */
function inTimeZone(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

describe.skipIf(!QA_URL).each(SESSION_TIME_ZONES)("the session-starts range on a session in %s", (zone) => {
  let db: PrismaClient;
  let sessions: typeof import("./task-start-sessions");

  beforeAll(async () => {
    const url = inTimeZone(QA_URL!, zone);
    process.env.DATABASE_URL = url;
    // A fresh module graph and shared client per zone: lib/db.ts caches its client on globalThis.
    const cached = globalThis as unknown as { prisma?: PrismaClient };
    await cached.prisma?.$disconnect();
    cached.prisma = undefined;
    vi.resetModules();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    sessions = await import("./task-start-sessions");
    const { db: shared } = await import("@/lib/db");
    const [{ TimeZone }] = await shared.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
    expect(TimeZone).toBe(zone);

    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.taskStartServedItem.create({
      data: {
        orgId: ORG,
        agentId: "a",
        sessionKey: "s",
        scopePath: ROOT,
        taskKey: "",
        servingId: "srv-tz",
        position: 1,
        lineCount: 1,
        itemType: "convention",
        itemId: "rule",
        namedId: "rule",
        servedAt: SERVED_AT,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  const totalIn = async (from: string | null, to: string | null) =>
    (
      await sessions.readSessionStarts({
        orgId: ORG,
        scope: ROOT,
        page: 1,
        pageSize: 20,
        range: { from: from ? new Date(from) : null, to: to ? new Date(to) : null },
      })
    ).total;

  it("keeps a serving at the range's first instant and drops one at its end, whatever the zone", async () => {
    expect(await totalIn("2026-10-14T10:00:00Z", null)).toBe(1);
    expect(await totalIn("2026-10-14T10:00:00.001Z", null)).toBe(0);
    expect(await totalIn(null, "2026-10-14T10:00:00Z")).toBe(0);
    expect(await totalIn(null, "2026-10-14T10:00:00.001Z")).toBe(1);
  });
});
