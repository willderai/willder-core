// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The capability-revoke cascade in DELETE /api/access/grants/:id, against a
// real database.
//
// The mocked cascade coverage (app/api/access-routes.test.ts) asserts that
// `updateMany` was CALLED with a particular argument, which tests the call
// shape, not the relation. This file asserts on rows a REAL Postgres actually
// holds after the real route handler runs -- specifically the boundaries a
// mocked updateMany cannot see: the tenant boundary, the sibling-scope
// boundary, the separator boundary, and the agent-id boundary.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-124";
const OTHER_ORG = "org-qa-124-other";
const SCOPE = "org_1.dept_sales";
const ADMIN = "u-admin-124";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("grant revoke -> handoff capability cascade, real Postgres", () => {
  let db: PrismaClient;
  let DELETE: (typeof import("./[id]/route"))["DELETE"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let grantId: string;

  async function seedCapability(id: string, orgId: string, agentId: string, scopePath: string) {
    await db.capability.create({
      data: {
        id,
        orgId,
        agentId,
        scopePath,
        tokenHash: `hash-${id}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ DELETE } = await import("./[id]/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await db.capability.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.grant.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.scope.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.user.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });

    await db.org.create({ data: { id: ORG, name: "Case124" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Case124 other" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@case124.test", role: "admin", clerkId: "clerk-case124" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    // A real admin grant so the route's own access.manage check() genuinely
    // ALLOWS -- the permitted operation that must succeed, evaluated by the
    // real authorization evaluator, not a mock.
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    const grant = await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "read" },
    });
    grantId = grant.id;

    // The cascade's real decision surface.
    await seedCapability("cap-exact", ORG, "handoff-agent", SCOPE);
    await seedCapability("cap-descendant", ORG, "handoff-agent", `${SCOPE}.sub`);
    await seedCapability("cap-sibling", ORG, "handoff-agent", "org_1.engineering");
    // Separator boundary: a sibling whose label merely extends this one's,
    // with no dot boundary. Must NOT be revoked.
    await seedCapability("cap-bare-prefix", ORG, "handoff-agent", `${SCOPE}X`);
    // Underscore/hyphen sibling -- LIKE-wildcard equivalent. Must NOT be revoked.
    await seedCapability("cap-hyphen-sib", ORG, "handoff-agent", "org_1.dept-sales");
    // Broader ancestor: the grant being revoked does not cover it.
    await seedCapability("cap-ancestor", ORG, "handoff-agent", "org_1");
    // Another tenant, identical scope string. Must NOT be revoked.
    await seedCapability("cap-other-org", OTHER_ORG, "handoff-agent", SCOPE);
    // A non-handoff agent at the very same scope.
    await seedCapability("cap-other-agent", ORG, "qa-agent", SCOPE);

    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN }, role: "admin" },
    } as never);
  });

  afterAll(async () => {
    await db.capability.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.grant.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.scope.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.user.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  async function revoke() {
    const res = await DELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id: grantId }),
    } as never);
    return res;
  }

  async function revokedIds(): Promise<Set<string>> {
    const caps = await db.capability.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] }, NOT: { revokedAt: null } },
      select: { id: true },
    });
    return new Set(caps.map((c) => c.id));
  }

  it("revokes exactly the handoff capabilities this grant's scope covers, and nothing else", async () => {
    const res = await revoke();
    expect(res.status).toBe(200);
    expect(await revokedIds()).toEqual(new Set(["cap-exact", "cap-descendant"]));
  });

  it("never crosses the tenant boundary for an identical scope string", async () => {
    await revoke();
    const other = await db.capability.findUniqueOrThrow({ where: { id: "cap-other-org" } });
    expect(other.revokedAt).toBeNull();
  });

  it("does not revoke a bare-prefix or hyphen/underscore sibling scope (the #114 separator class)", async () => {
    await revoke();
    const rows = await db.capability.findMany({
      where: { id: { in: ["cap-bare-prefix", "cap-hyphen-sib", "cap-sibling"] } },
      select: { id: true, revokedAt: true },
    });
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });

  it("does not revoke a broader ancestor capability the grant does not cover", async () => {
    await revoke();
    const anc = await db.capability.findUniqueOrThrow({ where: { id: "cap-ancestor" } });
    expect(anc.revokedAt).toBeNull();
  });

  it("leaves a non-handoff agent's capability at the same scope untouched (documented boundary)", async () => {
    await revoke();
    const other = await db.capability.findUniqueOrThrow({ where: { id: "cap-other-agent" } });
    expect(other.revokedAt).toBeNull();
  });

  it("is idempotent: the grant is gone and a second delete does not resurrect or re-stamp", async () => {
    await revoke();
    const first = await db.capability.findUniqueOrThrow({ where: { id: "cap-exact" } });
    const res2 = await revoke();
    expect(res2.status).toBe(404);
    const second = await db.capability.findUniqueOrThrow({ where: { id: "cap-exact" } });
    expect(second.revokedAt).toEqual(first.revokedAt);
  });
});
