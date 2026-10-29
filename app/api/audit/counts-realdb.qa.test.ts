// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Audit summary counts and the token short id, against a real database.
//
// The mocked tests stub $queryRaw. This file drives the real GET /api/audit
// against a real Postgres 16 and checks each summary number against a COUNT(*)
// taken directly at the same scope, so the claim "allowed and denied cover every
// page at the list's scope" is decided by the database, not by a fake.
//
// More than one page of allowed rows (PAGE_SIZE is 50) is what makes a
// page-scoped count visible: a Denied tile computed from page 1 alone reads 0
// whenever page 1 holds only allows.
//
// Set QA_DATABASE_URL to an isolated test database. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "310";
const OTHER_ORG = "311";
const SALES = "org_310.dept_sales";
const SIBLING = "org_310.dept_salesforce";
const ADMIN = "u-admin-310";
const AGENT = "agent-310";
const TOKEN = "case310-token-plaintext";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("audit counts and token short id, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let capabilityId: string;

  async function sqlCount(where: { scope?: string; decision?: "allow" | "deny"; actorId?: string }) {
    return db.auditLog.count({
      where: {
        orgId: ORG,
        // Reading the page is itself audited: its access.manage gate writes a row the
        // visibility rule hides (no mutation marker). The seed writes none of these.
        NOT: { action: "access.manage" },
        ...(where.decision ? { decision: where.decision } : {}),
        ...(where.actorId ? { actorId: where.actorId, actorType: "agent" } : {}),
        ...(where.scope
          ? {
              OR: [
                { target: where.scope },
                { target: { startsWith: `${where.scope}.` } },
                { target: { startsWith: `${where.scope}/` } },
              ],
            }
          : {}),
      },
    });
  }

  async function audit(query: string) {
    const res = await GET(new Request(`http://t/api/audit${query}`));
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      entries: Array<{ id: string; decision: string; capabilityId?: string }>;
      total: number;
      counts: { allowed: number; denied: number };
    }>;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    const { hashCapabilityToken } = await import("@/services/access/capabilities");

    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
    await db.org.create({ data: { id: ORG, name: "Case310" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Case310 other" } });
    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@case310.test", role: "admin", clerkId: "clerk-case310" },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: "org_310", name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    const at = new Date("2026-09-01T00:00:00Z");
    const row = (orgId: string, target: string, decision: "allow" | "deny", actorId = ADMIN) => ({
      orgId,
      actorType: actorId === ADMIN ? "human" : "agent",
      actorId,
      action: "memory.read",
      target,
      decision,
      at,
    });
    // SALES: 60 allows (newest), 7 denies (older, so page 1 is allow-only).
    await db.auditLog.createMany({ data: Array.from({ length: 60 }, () => row(ORG, `${SALES}.sub`, "allow")) });
    await db.auditLog.createMany({
      data: Array.from({ length: 7 }, () => ({ ...row(ORG, SALES, "deny"), at: new Date("2026-08-01T00:00:00Z") })),
    });
    // SIBLING: a LIKE-prefix neighbour that must not be counted under SALES.
    await db.auditLog.createMany({ data: Array.from({ length: 5 }, () => row(ORG, SIBLING, "deny")) });
    await db.auditLog.createMany({ data: Array.from({ length: 3 }, () => row(ORG, SIBLING, "allow", AGENT)) });
    // Another tenant with byte-identical targets.
    await db.auditLog.createMany({ data: Array.from({ length: 9 }, () => row(OTHER_ORG, SALES, "deny")) });

    // A real revoked token, refused through the shipping resolveCapability(),
    // so the audit row carrying capabilityId is the one production writes.
    const cap = await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(TOKEN),
        scopePath: SIBLING,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: new Date(),
      },
    });
    capabilityId = cap.id;
    const { resolveCapability } = await import("@/services/access/check");
    expect(await resolveCapability(TOKEN, "mcp")).toBeNull();

    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("unfiltered: counts equal COUNT(*) per decision, sum to total, and exclude the other org", async () => {
    const body = await audit("");
    expect(body.counts.allowed).toBe(await sqlCount({ decision: "allow" }));
    expect(body.counts.denied).toBe(await sqlCount({ decision: "deny" }));
    expect(body.counts.allowed + body.counts.denied).toBe(body.total);
    expect(body.total).toBe(await sqlCount({}));
    expect(body.counts).toEqual({ allowed: 63, denied: 13 });
  });

  it("scope filter: counts cover every page at that scope, not the sibling prefix", async () => {
    const body = await audit(`?scope=${encodeURIComponent(SALES)}`);
    expect(body.entries.every((e) => e.decision === "allow")).toBe(true); // page 1 is allow-only
    expect(body.counts).toEqual({
      allowed: await sqlCount({ scope: SALES, decision: "allow" }),
      denied: await sqlCount({ scope: SALES, decision: "deny" }),
    });
    expect(body.counts).toEqual({ allowed: 60, denied: 7 });
    expect(body.total).toBe(67);
  });

  it("decision filter narrows the list and total but not the counts", async () => {
    const deny = await audit(`?scope=${encodeURIComponent(SALES)}&decision=deny`);
    expect(deny.total).toBe(7);
    expect(deny.entries.every((e) => e.decision === "deny")).toBe(true);
    expect(deny.counts).toEqual({ allowed: 60, denied: 7 });
    const allow = await audit(`?scope=${encodeURIComponent(SALES)}&decision=allow`);
    expect(allow.total).toBe(60);
    expect(allow.counts).toEqual({ allowed: 60, denied: 7 });
  });

  it("identity filter: counts follow actorId+actorType", async () => {
    const body = await audit(`?actorId=${AGENT}&actorType=agent`);
    expect(body.counts).toEqual({
      allowed: await sqlCount({ actorId: AGENT, decision: "allow" }),
      denied: await sqlCount({ actorId: AGENT, decision: "deny" }),
    });
    expect(body.counts).toEqual({ allowed: 3, denied: 1 });
  });

  it("the refused-token row carries capabilityId whose short id matches the Tokens tab", async () => {
    const { tokenShortId } = await import("@/components/audit/format");
    const body = await audit(`?decision=deny&actorId=${AGENT}&actorType=agent`);
    const refused = body.entries.filter((e) => e.capabilityId);
    expect(refused).toHaveLength(1);
    expect(refused[0].capabilityId).toBe(capabilityId);
    const { GET: listCaps } = await import("@/app/api/access/capabilities/route");
    const caps = (await (await listCaps(new Request("http://localhost/api/access/capabilities"))).json()) as
      | Array<{ id: string }>
      | { capabilities: Array<{ id: string }> };
    const ids = (Array.isArray(caps) ? caps : caps.capabilities).map((c) => c.id);
    expect(ids).toContain(capabilityId);
    expect(tokenShortId(refused[0].capabilityId!)).toBe(capabilityId.slice(-8));
    expect(ids.map(tokenShortId)).toContain(tokenShortId(refused[0].capabilityId!));
  });
});
