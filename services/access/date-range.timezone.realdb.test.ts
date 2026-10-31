// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The audit log's and the usage list's date range on Postgres sessions west and east of UTC.
// `audit_log.at` and `artifact_usage.createdAt` are `timestamp without time zone` columns
// holding UTC; a bound compared through the session's TimeZone would move the range by hours,
// keeping a row the range ends before or dropping one it starts at. Each zone runs on its own
// fresh module graph.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const SESSION_TIME_ZONES = ["America/Los_Angeles", "Asia/Tokyo"];
const ORG = "qa_audit_usage_range_tz";
const ROOT = `org_${ORG}`;
const RECORDED_AT = new Date("2026-10-14T10:00:00Z");

/** QA_URL with every connection's session TimeZone set to `zone`. */
function inTimeZone(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

describe.skipIf(!QA_URL).each(SESSION_TIME_ZONES)("the audit and usage range on a session in %s", (zone) => {
  let db: PrismaClient;
  let audit: typeof import("./audit-query");
  let usage: typeof import("./readable-rows");

  async function clear() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.artifactUsage.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    const url = inTimeZone(QA_URL!, zone);
    process.env.DATABASE_URL = url;
    // A fresh module graph and shared client per zone: lib/db.ts caches its client on globalThis.
    const cached = globalThis as unknown as { prisma?: PrismaClient };
    await cached.prisma?.$disconnect();
    cached.prisma = undefined;
    vi.resetModules();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    audit = await import("./audit-query");
    usage = await import("./readable-rows");
    const { db: shared } = await import("@/lib/db");
    const [{ TimeZone }] = await shared.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
    expect(TimeZone).toBe(zone);

    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.auditLog.create({
      data: {
        orgId: ORG,
        actorType: "human",
        actorId: "u",
        action: "memory.read",
        target: ROOT,
        decision: "allow",
        metadata: {},
        at: RECORDED_AT,
      },
    });
    await db.artifactUsage.create({
      data: {
        orgId: ORG,
        artifactType: "handoff",
        credits: 1,
        overage: false,
        scopePath: ROOT,
        createdAt: RECORDED_AT,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await clear();
    await db.$disconnect();
  });

  const range = (from: string | null, to: string | null) => ({
    from: from ? new Date(from) : null,
    to: to ? new Date(to) : null,
  });

  const auditTotalIn = async (from: string | null, to: string | null) =>
    (await audit.queryAuditLog({ orgId: ORG, range: range(from, to), page: 1, pageSize: 20 })).total;

  const usageTotalIn = async (from: string | null, to: string | null) =>
    (
      await usage.readableUsagePage(ORG, [ROOT], {
        search: "",
        artifactType: null,
        sort: "date",
        order: "desc",
        range: range(from, to),
        page: 1,
        pageSize: 20,
      })
    ).total;

  it.each([
    ["the audit log", auditTotalIn],
    ["the usage list", usageTotalIn],
  ])("%s keeps a row at the range's first instant and drops one at its end", async (_, totalIn) => {
    expect(await totalIn("2026-10-14T10:00:00Z", null)).toBe(1);
    expect(await totalIn("2026-10-14T10:00:00.001Z", null)).toBe(0);
    expect(await totalIn(null, "2026-10-14T10:00:00Z")).toBe(0);
    expect(await totalIn(null, "2026-10-14T10:00:00.001Z")).toBe(1);
  });
});
