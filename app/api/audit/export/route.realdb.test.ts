// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/audit/export against a real Postgres, with the shipping check() evaluator and
// real SQL; only the Clerk session is stubbed. Proves: an org admin exports a date range
// as JSON and CSV with exact boundaries; a member, and an admin of another org, are
// refused without learning anything; every request is itself audited; and a range far
// larger than one response follows the cursor to every row exactly once, with each
// response under Vercel's 4.5 MB limit.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ORG = `aexp-${RUN}`;
const OTHER_ORG = `aexp-other-${RUN}`;
const ADMIN = `u-aexp-admin-${RUN}`;
const MEMBER = `u-aexp-member-${RUN}`;
const OTHER_ADMIN = `u-aexp-other-${RUN}`;
const TEAM_ADMIN = `u-aexp-team-admin-${RUN}`;
const VERCEL_RESPONSE_LIMIT = 4.5 * 1024 * 1024;

const day = (d: number, ms = 0) => new Date(Date.UTC(2026, 6, d, 0, 0, 0, ms));

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("GET /api/audit/export, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  const sessionAs = async (userId: string, orgId: string) => {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    requireAccessContext.mockResolvedValue({
      org: await db.org.findUniqueOrThrow({ where: { id: orgId } }),
      user,
      ctx: { orgId, actor: { type: "human", id: userId, role: user.role } },
    });
  };

  const exportOnce = (query: string) => GET(new Request(`http://t/api/audit/export?${query}`));

  /** Follows the cursor to the end; returns every page's body size and all rows. */
  async function exportAll(query: string, format: "json" | "csv") {
    const sizes: number[] = [];
    const rows: { id: string; at: string }[] = [];
    let csv = "";
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await exportOnce(`${query}&format=${format}${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      sizes.push(Buffer.byteLength(text));
      if (format === "json") {
        const body = JSON.parse(text);
        rows.push(...body.rows);
        cursor = body.nextCursor;
      } else {
        csv += text;
        cursor = res.headers.get("X-Next-Cursor");
      }
      if (!cursor) return { sizes, rows, csv };
    }
    throw new Error("export did not finish in 100 pages");
  }

  const wipe = async () => {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER, OTHER_ADMIN, TEAM_ADMIN] } } });
    await db.org.deleteMany({ where: { id: orgs } });
  };

  const row = (orgId: string, at: Date, over: Record<string, unknown> = {}) => ({
    orgId,
    actorType: "agent",
    actorId: "agent-a",
    action: "memory.read",
    target: `org_${orgId}.team/query:x`,
    decision: "allow" as const,
    at,
    ...over,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });
    await wipe();

    for (const [orgId, adminId] of [
      [ORG, ADMIN],
      [OTHER_ORG, OTHER_ADMIN],
    ]) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      await db.user.create({
        data: { id: adminId, orgId, email: `${adminId}@t.test`, role: "admin", clerkId: `clerk-${adminId}` },
      });
      const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
      await db.grant.create({
        data: { orgId, scopeId: root.id, granteeType: "user", granteeId: adminId, permission: "admin" },
      });
    }
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@t.test`, role: "member", clerkId: `clerk-${MEMBER}` },
    });
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: `org_${ORG}` } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });

    // Admin of one team scope only: may manage that team, may not read the rest of the org.
    await db.user.create({
      data: {
        id: TEAM_ADMIN,
        orgId: ORG,
        email: `${TEAM_ADMIN}@t.test`,
        role: "member",
        clerkId: `clerk-${TEAM_ADMIN}`,
      },
    });
    const team = await db.scope.create({ data: { orgId: ORG, path: `org_${ORG}.team`, name: "team" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: team.id, granteeType: "user", granteeId: TEAM_ADMIN, permission: "admin" },
    });

    // Boundary rows for the July 10..July 11 range: one a millisecond before, one exactly
    // at from, one a millisecond before to, one exactly at to.
    await db.auditLog.createMany({
      data: [
        row(ORG, day(9, 86_399_999), { actorId: "before" }),
        row(ORG, day(10), { actorId: "at-from", reason: '=HYPERLINK("http://x"), "quoted"\nnext line' }),
        row(ORG, day(10, 86_399_999), { actorId: "last-ms", decision: "deny" }),
        row(ORG, day(11), { actorId: "at-to" }),
        row(OTHER_ORG, day(10, 1000), { actorId: "other-org" }),
      ],
    });

    // A large range: 2,500 small rows, many sharing a timestamp so pages cut inside a tie,
    // and 900 rows of about 4 KB of metadata each, about 3.6 MB as one JSON page.
    const small = Array.from({ length: 2500 }, (_, i) =>
      row(ORG, day(20, Math.floor(i / 7)), { actorId: `small-${i}` }),
    );
    await db.auditLog.createMany({ data: small });
    const bulky = Array.from({ length: 900 }, (_, i) =>
      row(ORG, day(25, i), { actorId: `bulky-${i}`, metadata: { blob: `"q",${"x".repeat(4000)}` } }),
    );
    await db.auditLog.createMany({ data: bulky });
  }, 60_000);

  beforeEach(async () => {
    vi.unstubAllEnvs();
    await sessionAs(ADMIN, ORG);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  const RANGE = `from=2026-07-10&to=2026-07-11`;

  it("exports the range as JSON: from inclusive, to exclusive, this org only", async () => {
    const res = await exportOnce(RANGE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.map((r: { actorId: string }) => r.actorId)).toEqual(["at-from", "last-ms"]);
    expect(body.nextCursor).toBeNull();
    expect(body.from).toBe("2026-07-10T00:00:00.000Z");
    expect(body.to).toBe("2026-07-11T00:00:00.000Z");
    expect(body.rows[0]).toMatchObject({
      at: "2026-07-10T00:00:00.000Z",
      action: "memory.read",
      decision: "allow",
      chainSeq: expect.any(Number),
      rowHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("reports the retention in force: forever by default, never below six months", async () => {
    expect((await (await exportOnce(RANGE)).json()).retention).toEqual({ keep: "forever", floorDays: 184 });
    vi.stubEnv("AUDIT_LOG_RETENTION_DAYS", "400");
    expect((await (await exportOnce(RANGE)).json()).retention).toEqual({ keep: "days", days: 400, floorDays: 184 });
    vi.stubEnv("AUDIT_LOG_RETENTION_DAYS", "90");
    const bad = await exportOnce(RANGE);
    expect(bad.status).toBe(500);
    expect((await bad.json()).error).toMatch(
      /AUDIT_LOG_RETENTION_DAYS must be "forever" or a whole number of days of at least 184/,
    );
  });

  it("exports the same range as CSV with escaped, formula-safe cells", async () => {
    const res = await exportOnce(`${RANGE}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="audit-2026-07-10-2026-07-11.csv"');
    expect(res.headers.get("X-Next-Cursor")).toBeNull();
    const text = await res.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toMatch(/^id,at,actorType,actorId,action,target,decision,reason,/);
    expect(text).toContain(`"'=HYPERLINK(""http://x""), ""quoted""\nnext line"`);
    expect(text).not.toContain("before");
    expect(text).not.toContain("at-to");
    expect(text).not.toContain("other-org");
  });

  it("audits every export request with the range it named", async () => {
    await exportOnce(RANGE);
    const audited = await db.auditLog.findFirst({
      where: { orgId: ORG, actorId: ADMIN, action: "access.manage" },
      orderBy: { at: "desc" },
    });
    expect(audited).toMatchObject({
      decision: "allow",
      target: `org_${ORG}/audit:export:2026-07-10T00:00:00.000Z..2026-07-11T00:00:00.000Z`,
    });
  });

  it("refuses a member, and audits the refusal, without naming any scope", async () => {
    await sessionAs(MEMBER, ORG);
    const res = await exportOnce(RANGE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    const audited = await db.auditLog.findFirst({ where: { orgId: ORG, actorId: MEMBER }, orderBy: { at: "desc" } });
    expect(audited).toMatchObject({ action: "access.manage", decision: "deny" });
  });

  // The export carries every row in the org, internal rows included, so only a person who
  // can already read the whole org may take it: admin on the org root, which covers
  // memory.read on every scope. An admin of one team is refused, as GET /api/audit refuses them.
  it("refuses an admin of a single team scope, who cannot read the rest of the org", async () => {
    await sessionAs(TEAM_ADMIN, ORG);
    const res = await exportOnce(RANGE);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(JSON.stringify({ error: "forbidden" }));
    const audited = await db.auditLog.findFirst({
      where: { orgId: ORG, actorId: TEAM_ADMIN },
      orderBy: { at: "desc" },
    });
    expect(audited).toMatchObject({ action: "access.manage", decision: "deny" });
  });

  it("refuses an admin of another org acting in this one, and never mixes orgs", async () => {
    // Admin of OTHER_ORG, with a session pointed at ORG: holds no grant here.
    const otherAdmin = await db.user.findUniqueOrThrow({ where: { id: OTHER_ADMIN } });
    requireAccessContext.mockResolvedValue({
      org: await db.org.findUniqueOrThrow({ where: { id: ORG } }),
      user: otherAdmin,
      ctx: { orgId: ORG, actor: { type: "human", id: OTHER_ADMIN, role: "admin" } },
    });
    const refused = await exportOnce(RANGE);
    expect(refused.status).toBe(403);
    const text = await refused.text();
    expect(text).toBe(JSON.stringify({ error: "forbidden" }));
    expect(text).not.toContain(ORG);

    // The same admin in their own org sees only their own org's row.
    await sessionAs(OTHER_ADMIN, OTHER_ORG);
    const own = await (await exportOnce(RANGE)).json();
    expect(own.rows.map((r: { actorId: string }) => r.actorId)).toEqual(["other-org"]);
  });

  it("does not let a cursor reach another org's rows", async () => {
    // A cursor positioned before every row: still only this org's rows come back.
    const cursor = Buffer.from(JSON.stringify(["2026-07-01T00:00:00.000Z", "a"])).toString("base64url");
    await sessionAs(OTHER_ADMIN, OTHER_ORG);
    const body = await (await exportOnce(`${RANGE}&cursor=${cursor}`)).json();
    expect(body.rows.map((r: { actorId: string }) => r.actorId)).toEqual(["other-org"]);
  });

  it("refuses a malformed range, format or cursor with a 400 naming the fix", async () => {
    expect((await exportOnce("from=2026-07-11&to=2026-07-10")).status).toBe(400);
    expect((await exportOnce("from=2026-07-10")).status).toBe(400);
    expect((await exportOnce(`${RANGE}&format=xml`)).status).toBe(400);
    const badCursor = await exportOnce(`${RANGE}&cursor=nope`);
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({ error: "cursor is not one this endpoint returned" });
  });

  it("returns 401 without a session", async () => {
    requireAccessContext.mockResolvedValue(null);
    expect((await exportOnce(RANGE)).status).toBe(401);
  });

  it.each(["json", "csv"] as const)(
    "pages a 2,500-row range in %s through every row exactly once, cutting inside a tie",
    async (format) => {
      const { sizes, rows, csv } = await exportAll("from=2026-07-20&to=2026-07-21", format);
      expect(sizes.length).toBe(3);
      const ids =
        format === "json"
          ? rows.map((r) => (r as unknown as { actorId: string }).actorId)
          : csv
              .split("\r\n")
              .filter((l) => l !== "")
              .slice(1)
              .map((l) => l.split(",")[3]);
      expect(ids).toHaveLength(2500);
      expect(new Set(ids).size).toBe(2500);
      expect(new Set(ids)).toEqual(new Set(Array.from({ length: 2500 }, (_, i) => `small-${i}`)));
      if (format === "csv") expect(csv.match(/^id,at,/gm)).toHaveLength(1);
    },
    60_000,
  );

  it.each(["json", "csv"] as const)(
    "keeps every %s response under 4.5 MB when rows are large",
    async (format) => {
      const { sizes, rows, csv } = await exportAll("from=2026-07-25&to=2026-07-26", format);
      expect(sizes.length).toBeGreaterThan(1);
      for (const size of sizes) expect(size).toBeLessThan(VERCEL_RESPONSE_LIMIT);
      const count =
        format === "json" ? rows.length : csv.split("\r\n").filter((l) => l.includes(",agent,bulky-")).length;
      expect(count).toBe(900);
    },
    60_000,
  );
});
