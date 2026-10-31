// GET /api/audit?q=: the audit log's text search, against a real Postgres.
//
// A search narrows the rows the log may show; it never reaches past them. A row the
// visibility rule hides, a row of another org, or a row outside the chosen scope is
// never returned, never counted in `total` or the allowed/denied counts, and never
// shortens a page. Only what the log shows is searchable: never the rest of a row's
// metadata. Names resolve inside the caller's org only.
//
// Runs the shipping route against a real database with the real check(), so the
// access.manage gate is decided by real grants. Authentication is mocked. Set
// QA_DATABASE_URL to an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "auditq";
const OTHER_ORG = "auditqother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.dept_sales`;
// Differs from SALES only where SALES has `_`: matched by an unescaped LIKE.
const IMPOSTOR = `${ROOT}.deptXsales`;

const ADMIN = "u-aq-admin";
const SALES_ADMIN = "u-aq-sales-admin";
const MEMBER = "u-aq-member";
const DANA = "u-aq-dana";
const OTHER_ADMIN = "u-aq-other-admin";

const SECRET = "Renewal floor is 160k";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Listed = {
  entries: { id: string; action: string; target: string | null; actorName: string }[];
  total: number;
  counts: { allowed: number; denied: number };
  totalPages: number;
};

describe.skipIf(!QA_URL)("the audit log's search never reaches rows the log does not show", { timeout: 30_000 }, () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let GET: (typeof import("./route"))["GET"];
  let minutesAgo = 10_000;

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  async function search(query: string): Promise<Listed> {
    const res = await GET(new Request(`http://t/api/audit?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Listed;
  }

  /** One audit row, each newer than the last. */
  async function row(data: {
    orgId?: string;
    action?: string;
    target: string;
    decision?: "allow" | "deny";
    reason?: string;
    actorType?: string;
    actorId?: string;
    metadata?: Record<string, string>;
  }): Promise<string> {
    minutesAgo -= 1;
    const created = await db.auditLog.create({
      data: {
        orgId: data.orgId ?? ORG,
        actorType: data.actorType ?? "human",
        actorId: data.actorId ?? ADMIN,
        action: data.action ?? "memory.read",
        target: data.target,
        decision: data.decision ?? "allow",
        reason: data.reason ?? null,
        metadata: data.metadata ?? {},
        at: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
    return created.id;
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      for (const t of ["auditLog", "grant", "agent", "orgMembership", "scope"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await db.user.deleteMany({ where: { orgId: org } });
      await deleteOrgsWithRetry(db, { where: { id: org } });
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
    minutesAgo = 10_000;
    for (const org of [ORG, OTHER_ORG]) await db.org.create({ data: { id: org, name: org } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: ORG, path: IMPOSTOR, name: "impostor" } });
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "root" } });

    const people: [string, string, string | null, string, "admin" | "read", string][] = [
      [ADMIN, ORG, "Ada Admin", "ada@aq.test", "admin", root.id],
      [SALES_ADMIN, ORG, "Sam Sales", "sam@aq.test", "admin", sales.id],
      [MEMBER, ORG, "Mo Member", "mo@aq.test", "read", sales.id],
      [DANA, ORG, "Dana Ruiz", "dana@aq.test", "read", sales.id],
      [OTHER_ADMIN, OTHER_ORG, "Dana Other", "dana@other.test", "admin", otherRoot.id],
    ];
    for (const [id, orgId, name, email, permission, scopeId] of people) {
      await db.user.create({ data: { id, orgId, name, email, role: "member", clerkId: `c-${id}` } });
      await db.grant.create({ data: { orgId, scopeId, granteeType: "user", granteeId: id, permission } });
    }
    // The same agent key in both orgs, under different names.
    await db.agent.create({ data: { orgId: ORG, agentKey: "research-agent", name: "Scout", role: "research" } });
    await db.agent.create({
      data: { orgId: OTHER_ORG, agentKey: "research-agent", name: "Acme Bot", role: "research" },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("lists and counts only the matching rows the log shows, in the caller's org", async () => {
    const allowed = await row({ target: `${SALES}/acme-renewal` });
    const denied = await row({ target: `${SALES}/acme-pilot`, decision: "deny" });
    await row({ target: `${SALES}/globex` });
    // Hidden by the visibility rule, whatever they contain.
    await row({ action: "memory.write.applied", target: `${SALES}/acme-hidden` });
    await row({ action: "brief.acknowledged", target: `${SALES}/brief`, reason: "acme" });
    // Another org, byte-identical target.
    await row({ orgId: OTHER_ORG, actorId: OTHER_ADMIN, target: `${SALES}/acme-renewal` });

    actAs(ORG, ADMIN);
    const found = await search("q=ACME");
    expect(found.entries.map((e) => e.id)).toEqual([denied, allowed]);
    expect(found.total).toBe(2);
    expect(found.counts).toEqual({ allowed: 1, denied: 1 });

    const deniedOnly = await search("q=acme&decision=deny");
    expect(deniedOnly.entries.map((e) => e.id)).toEqual([denied]);
    expect(deniedOnly.total).toBe(1);
    expect(deniedOnly.counts).toEqual({ allowed: 1, denied: 1 });
  });

  it("text that only hidden rows contain is neither listed nor counted", async () => {
    await row({ target: `${SALES}/globex` });
    await row({ action: "memory.write.applied", target: `${SALES}/zephyr-landed` });
    await row({ action: "brief.acknowledged", target: `${SALES}/brief`, reason: "zephyr acknowledged" });
    // Reading the log is itself recorded as an access.manage row the log hides.
    actAs(ORG, ADMIN);
    for (const q of ["zephyr", "audit:list"]) {
      expect(await search(`q=${encodeURIComponent(q)}`)).toMatchObject({
        entries: [],
        total: 0,
        counts: { allowed: 0, denied: 0 },
        totalPages: 0,
      });
    }
  });

  it("newer hidden matches never push a visible match off the first page", async () => {
    const visible = await row({ target: `${SALES}/acme-old` });
    for (let i = 0; i < 55; i += 1) await row({ action: "memory.write.applied", target: `${SALES}/acme-${i}` });

    actAs(ORG, ADMIN);
    const found = await search("q=acme");
    expect(found.entries.map((e) => e.id)).toEqual([visible]);
    expect(found.total).toBe(1);
    expect(found.totalPages).toBe(1);
  });

  it("searches the token id but never the rest of a row's metadata", async () => {
    const tokenRow = await row({
      action: "capability.refused",
      target: SALES,
      decision: "deny",
      metadata: { capabilityId: "cktoken7x9q", prompt: SECRET, authHeader: "Bearer qa-secret" },
    });

    actAs(ORG, ADMIN);
    expect((await search("q=TOKEN7X9")).entries.map((e) => e.id)).toEqual([tokenRow]);
    for (const secret of [SECRET, "160k", "qa-secret", "authHeader", "prompt"]) {
      expect(await search(`q=${encodeURIComponent(secret)}`)).toMatchObject({ entries: [], total: 0 });
    }
  });

  it("matches a person by name or email and an agent by its name in this org only", async () => {
    const danaRow = await row({ actorId: DANA, target: `${SALES}/q3-plan` });
    const scoutRow = await row({ actorType: "agent", actorId: "research-agent", target: `${SALES}/q3-plan` });

    actAs(ORG, ADMIN);
    expect((await search("q=dana%20ruiz")).entries.map((e) => e.id)).toEqual([danaRow]);
    expect((await search("q=dana%40aq")).entries.map((e) => e.id)).toEqual([danaRow]);
    expect((await search("q=scout")).entries.map((e) => e.id)).toEqual([scoutRow]);
    // Another org's names select nothing here, though its agent shares the key.
    expect(await search("q=acme%20bot")).toMatchObject({ entries: [], total: 0 });
    expect(await search("q=dana%20other")).toMatchObject({ entries: [], total: 0 });
  });

  it("matches the person a row records as triggering an agent's action", async () => {
    const triggered = await row({
      actorType: "agent",
      actorId: "research-agent",
      target: `${SALES}/q4`,
      metadata: { triggeredBy: DANA },
    });
    actAs(ORG, ADMIN);
    expect((await search("q=dana%20ruiz")).entries.map((e) => e.id)).toEqual([triggered]);
    // Another org's person of the same name triggers nothing here.
    expect(await search("q=dana%20other")).toMatchObject({ entries: [], total: 0 });
  });

  it("refuses a NUL in any parameter with 400, never a server error", async () => {
    actAs(ORG, ADMIN);
    for (const query of [
      "scope=a%00b",
      "actorType=human&actorId=a%00b",
      "actorType=a%00&actorId=x",
      "ids=a%00b",
      "decision=allow%00",
    ]) {
      const res = await GET(new Request(`http://t/api/audit?${query}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/must not contain a NUL character$/);
    }
  });

  it("treats % and _ as literal characters", async () => {
    const sales = await row({ target: `${SALES}/q3` });
    await row({ target: `${IMPOSTOR}/q3` });

    actAs(ORG, ADMIN);
    expect((await search("q=dept_sales")).entries.map((e) => e.id)).toEqual([sales]);
    expect(await search("q=%25")).toMatchObject({ entries: [], total: 0 });
    expect(await search("q=dept%25sales")).toMatchObject({ entries: [], total: 0 });
    const backslash = await row({ target: `${SALES}/C:\\temp`, reason: "path C:\\temp" });
    expect((await search(`q=${encodeURIComponent("C:\\t")}`)).entries.map((e) => e.id)).toEqual([backslash]);
    expect(await search(`q=${encodeURIComponent("\\%")}`)).toMatchObject({ entries: [], total: 0 });
  });

  it("a search inside a scope never returns the sibling that differs at an `_`", async () => {
    const inSales = await row({ target: `${SALES}/acme` });
    await row({ target: `${IMPOSTOR}/acme` });
    await row({ target: `${IMPOSTOR}.eu/acme` });

    actAs(ORG, ADMIN);
    const found = await search(`scope=${encodeURIComponent(SALES)}&q=acme`);
    expect(found.entries.map((e) => e.id)).toEqual([inSales]);
    expect(found.total).toBe(1);
    expect(found.counts).toEqual({ allowed: 1, denied: 0 });
  });

  it("a member, or an admin of one team scope, is refused before any search runs", async () => {
    await row({ target: `${SALES}/acme` });
    for (const user of [MEMBER, SALES_ADMIN]) {
      actAs(ORG, user);
      const res = await GET(new Request("http://t/api/audit?q=acme"));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("acme");
    }
  });

  it("a role grant of admin on the root allows the search; an expired one does not", async () => {
    const found = await row({ target: `${SALES}/acme` });
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    const roleGrant = await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: root.id,
        granteeType: "role",
        granteeId: "member",
        permission: "admin",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    actAs(ORG, MEMBER);
    expect((await GET(new Request("http://t/api/audit?q=acme"))).status).toBe(403);

    await db.grant.update({ where: { id: roleGrant.id }, data: { expiresAt: null } });
    expect((await search("q=acme")).entries.map((e) => e.id)).toEqual([found]);
  });

  it("another org's admin finds only its own rows", async () => {
    await row({ target: `${SALES}/acme` });
    const theirs = await row({ orgId: OTHER_ORG, actorId: OTHER_ADMIN, target: `org_${OTHER_ORG}/acme` });

    actAs(OTHER_ORG, OTHER_ADMIN);
    const found = await search("q=acme");
    expect(found.entries.map((e) => e.id)).toEqual([theirs]);
    expect(found.total).toBe(1);
  });

  it("pages rows recorded in the same instant without repeating or skipping one", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    await db.auditLog.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: ORG,
        actorType: "human",
        actorId: ADMIN,
        action: "memory.read",
        target: `${SALES}/tie-${i}`,
        decision: "allow" as const,
        at,
      })),
    });
    actAs(ORG, ADMIN);
    for (const order of ["desc", "asc"]) {
      const first = await search(`q=tie-&order=${order}&page=1`);
      const second = await search(`q=tie-&order=${order}&page=2`);
      expect(first.entries).toHaveLength(50);
      expect(second.entries).toHaveLength(10);
      expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(60);
    }
  });

  it("orders oldest first on request and refuses a bad order or an overlong search", async () => {
    const first = await row({ target: `${SALES}/acme-1` });
    const second = await row({ target: `${SALES}/acme-2` });

    actAs(ORG, ADMIN);
    expect((await search("q=acme&order=asc")).entries.map((e) => e.id)).toEqual([first, second]);
    expect((await search("q=acme")).entries.map((e) => e.id)).toEqual([second, first]);
    for (const query of ["order=sideways", `q=${"a".repeat(101)}`, "q=a%00", "page=0", "page=2.5", "page=1e9"]) {
      const res = await GET(new Request(`http://t/api/audit?${query}`));
      expect(res.status).toBe(400);
    }
  });
});
