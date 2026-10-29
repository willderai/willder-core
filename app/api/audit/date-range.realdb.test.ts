// GET /api/audit?from=&to=: the audit log's date range, against a real Postgres.
//
// A range is `from` inclusive and `to` exclusive. It is one more filter in the WHERE clause,
// so it narrows the rows before the page is cut and before the allowed/denied counts are
// taken: a row outside the range never fills a page, never counts, and the summary beside
// a range never counts the whole log. It narrows what the log may show; it never widens it.
//
// Runs the shipping route with the real check(), so the access.manage gate is decided by
// real grants. Authentication is mocked. Set QA_DATABASE_URL to an isolated test database;
// the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "auditrange";
const OTHER_ORG = "auditrangeother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.dept_sales`;
const ADMIN = "u-ar-admin";
const OTHER_ADMIN = "u-ar-other-admin";

const FROM = "2026-10-14T10:00:00.000Z";
const TO = "2026-10-14T11:00:00.000Z";

type Listed = {
  entries: { id: string }[];
  total: number;
  counts: { allowed: number; denied: number };
  totalPages: number;
};

describe.skipIf(!QA_URL)("the audit log's date range", { timeout: 30_000 }, () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let GET: (typeof import("./route"))["GET"];

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "admin" } },
    } as never);
  }

  async function list(query: string): Promise<Listed> {
    const res = await GET(new Request(`http://t/api/audit?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Listed;
  }

  async function row(at: string, data: { orgId?: string; target?: string; decision?: "allow" | "deny" } = {}) {
    return (
      await db.auditLog.create({
        data: {
          orgId: data.orgId ?? ORG,
          actorType: "human",
          actorId: ADMIN,
          action: "memory.read",
          target: data.target ?? SALES,
          decision: data.decision ?? "allow",
          metadata: {},
          at: new Date(at),
        },
      })
    ).id;
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      for (const t of ["auditLog", "grant", "orgMembership", "scope"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await db.user.deleteMany({ where: { orgId: org } });
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    ({ GET } = await import("./route"));
  });

  beforeEach(async () => {
    await clear();
    for (const [orgId, userId] of [
      [ORG, ADMIN],
      [OTHER_ORG, OTHER_ADMIN],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      await seedMember(db, { orgId, userId, role: "admin" });
      const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
      await db.grant.create({
        data: { orgId, scopeId: root.id, granteeType: "user", granteeId: userId, permission: "admin" },
      });
    }
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    actAs(ORG, ADMIN);
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("keeps a row at the range's first instant and drops one at its end", async () => {
    await row("2026-10-14T09:59:59.999Z");
    const first = await row(FROM);
    const last = await row("2026-10-14T10:59:59.999Z", { decision: "deny" });
    await row(TO);

    const listed = await list(`from=${FROM}&to=${TO}`);
    expect(listed.entries.map((e) => e.id)).toEqual([last, first]);
    expect(listed.total).toBe(2);
    expect(listed.counts).toEqual({ allowed: 1, denied: 1 });
  });

  it("counts only the range in the summary, with or without a decision filter", async () => {
    await row("2026-10-13T12:00:00Z", { decision: "deny" });
    await row("2026-10-14T10:10:00Z", { decision: "deny" });
    await row("2026-10-14T10:20:00Z");
    await row("2026-10-14T10:30:00Z");
    await row("2026-10-15T12:00:00Z");

    const denied = await list(`decision=deny&from=${FROM}&to=${TO}`);
    expect(denied.total).toBe(1);
    expect(denied.counts).toEqual({ allowed: 2, denied: 1 });

    // An open end narrows only the side it names.
    expect((await list(`from=${FROM}`)).counts).toEqual({ allowed: 3, denied: 1 });
    expect((await list(`to=${TO}`)).counts).toEqual({ allowed: 2, denied: 2 });
  });

  it("narrows before the page is cut, so rows outside the range never fill a page", async () => {
    // 55 rows inside, then 5 newer ones outside that a newest-first page would show first.
    const inside: string[] = [];
    for (let i = 0; i < 55; i++) inside.push(await row(new Date(Date.parse(FROM) + i * 1000).toISOString()));
    for (let i = 0; i < 5; i++) await row(new Date(Date.parse(TO) + i * 1000).toISOString());

    const first = await list(`from=${FROM}&to=${TO}`);
    expect(first.total).toBe(55);
    expect(first.totalPages).toBe(2);
    expect(first.entries.map((e) => e.id)).toEqual(inside.slice(5).reverse());
    const second = await list(`from=${FROM}&to=${TO}&page=2`);
    expect(second.entries.map((e) => e.id)).toEqual(inside.slice(0, 5).reverse());
  });

  it("never widens past the scope filter or into another org", async () => {
    const sales = await row("2026-10-14T10:05:00Z");
    await row("2026-10-14T10:06:00Z", { target: `${ROOT}.finance` });
    await row("2026-10-14T10:07:00Z", { orgId: OTHER_ORG, target: `org_${OTHER_ORG}` });

    const listed = await list(`scope=${SALES}&from=${FROM}&to=${TO}`);
    expect(listed.entries.map((e) => e.id)).toEqual([sales]);
    expect(listed.counts).toEqual({ allowed: 1, denied: 0 });
    expect((await list(`from=${FROM}&to=${TO}`)).total).toBe(2);
  });

  it.each([
    ["a value that is not a date", "from=yesterday"],
    ["a timestamp with no zone", "to=2026-10-14T10:00:00"],
    ["a day that does not exist", "from=2026-02-30"],
    ["a bound past the year 9999 once its offset is applied", "to=9999-12-31T23:00:00-05:00"],
    ["from equal to to", `from=${FROM}&to=${FROM}`],
    ["from after to", `from=${TO}&to=${FROM}`],
  ])("refuses %s with a 400 that names the fix", async (_, query) => {
    const res = await GET(new Request(`http://t/api/audit?${query}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be/);
  });
});
