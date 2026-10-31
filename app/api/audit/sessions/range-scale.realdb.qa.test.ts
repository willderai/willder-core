// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/audit/sessions with a date range at 1,000+ servings: the count and every page
// stay inside the range, the range's first instant is kept and its last dropped, each
// serving in range appears exactly once across the pages, and a second org's servings at
// the same instants never count. Only the Clerk session is stubbed.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_sessions_scale_a";
const OTHER_ORG = "qa_sessions_scale_b";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.b`;
const ADMIN = "u-admin-sessions-scale";
const HOURS = 1200;
const START = Date.UTC(2026, 6, 1);
const hour = (h: number) => new Date(START + h * 3_600_000);

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("GET /api/audit/sessions date range at 1,200 servings, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  /** The serving id of the ORG serving at each hour. */
  const servingAt: string[] = [];

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.taskStartItemUse.deleteMany({ where: { orgId: orgs } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: orgs } });
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await deleteOrgsWithRetry(db, { where: { id: orgs } });
  }

  async function page(query: string) {
    const res = await GET(new Request(`http://t/api/audit/sessions?scope=${SCOPE}&${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as { total: number; sessions: { servingId: string; servedAt: string }[] };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    const org = await db.org.create({ data: { id: ORG, name: "Sessions scale QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Sessions scale QA other" } });
    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@sessions-scale.test", role: "admin", clerkId: "clerk-sessions-scale-a" },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    requireAccessContext.mockResolvedValue({
      org,
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });

    // One serving an hour for 50 days in each org, at the same instants and with the same ids
    // for agent, session and task, so only the org filter tells them apart.
    const rows = [];
    for (let h = 0; h < HOURS; h++) {
      servingAt.push(randomUUID());
      for (const [orgId, servingId, scopePath] of [
        [ORG, servingAt[h], SCOPE],
        [OTHER_ORG, randomUUID(), `org_${OTHER_ORG}.b`],
      ]) {
        rows.push({
          orgId,
          agentId: "scale-agent",
          sessionKey: `mcp:conn-${h % 7}`,
          scopePath,
          taskKey: `TASK-${h % 11}`,
          servingId,
          position: 1,
          lineCount: 1,
          itemType: "convention",
          itemId: "scale-rule",
          namedId: "scale-rule",
          versionId: null,
          servedAt: hour(h),
        });
      }
    }
    await db.taskStartServedItem.createMany({ data: rows });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("counts and pages only the servings in the range, keeping its first instant and dropping its last", async () => {
    // Days 10 through 19: hour 240 is the range's first instant, hour 480 its exclusive end.
    const range = `from=${hour(240).toISOString()}&to=${hour(480).toISOString()}`;
    const first = await page(range);
    expect(first.total).toBe(240);

    const seen: string[] = [];
    for (let p = 1; p <= Math.ceil(first.total / 20); p++) {
      seen.push(...(await page(`${range}&page=${p}`)).sessions.map((s) => s.servingId));
    }
    // Newest first, each once: hours 479 down to 240.
    expect(seen).toEqual(Array.from({ length: 240 }, (_, i) => servingAt[479 - i]));
    // The page after the last is empty, not a wrap-around into servings outside the range.
    expect((await page(`${range}&page=${Math.ceil(first.total / 20) + 1}`)).sessions).toEqual([]);
  }, 60_000);

  it("keeps an open-ended range to its one bound", async () => {
    expect((await page(`from=${hour(1100).toISOString()}`)).total).toBe(100);
    expect((await page(`to=${hour(100).toISOString()}`)).total).toBe(100);
    expect((await page("")).total).toBe(HOURS);
  });
});
