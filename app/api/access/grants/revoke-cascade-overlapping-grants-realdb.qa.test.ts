// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Valid agent tokens must not be revoked. If the agent cascade in DELETE
// /api/access/grants/:id revoked every live capability matching scope
// containment alone, with no check for whether another still-active grant
// independently authorizes that same token, deleting one grant could strip a
// credential a broader or differently scoped grant still covers. The route
// checks survivorship with a NOT EXISTS leg on the raw UPDATE rather than
// grantId provenance, since capabilities are minted off the admin's own
// access.manage authority at issue time, never off a specific Grant row.
//
// app/api/access-routes.test.ts mocks db.$executeRaw and asserts on the
// returned count and the SQL text; it cannot exercise the NOT EXISTS
// predicate against real overlapping rows. This file seeds two real grants
// for the same agent at different scopes/permissions and checks which
// capabilities actually end up revoked in Postgres.
//
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly without it.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-overrev";
const AGENT = "agent-qa-overrev";
const BROADER_SCOPE = "org_1.dept_sales";
const NARROWER_SCOPE = "org_1.dept_sales.team_a";
const ADMIN = "u-admin-overrev";
// A scope in the same org that does NOT cover NARROWER_SCOPE (a sibling
// subtree), for the containment leg.
const UNRELATED_SCOPE = "org_1.dept_eng";
// A second tenant reusing the same path text as BROADER_SCOPE. scopes are
// @@unique([orgId, path]), so the ltree containment leg matches identically
// and only the orgId leg separates the two orgs.
const OTHER_ORG = "org-qa-overrev-other";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("agent cascade does not over-revoke across independent grants", () => {
  let db: PrismaClient;
  let DELETE: (typeof import("./[id]/route"))["DELETE"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let narrowScopeId: string;
  let broadScopeId: string;

  async function seedCapability(id: string, scopePath: string, permission: "read" | "write" | "admin" = "read") {
    await db.capability.create({
      data: {
        id,
        orgId: ORG,
        agentId: AGENT,
        scopePath,
        permission,
        tokenHash: `hash-${id}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  async function deleteNarrowGrant() {
    const grant = await db.grant.findFirstOrThrow({
      where: { orgId: ORG, scopeId: narrowScopeId, granteeType: "agent", granteeId: AGENT },
    });
    const res = await DELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id: grant.id }),
    } as never);
    expect(res.status).toBe(200);
    return res;
  }

  async function revokedAt(id: string): Promise<Date | null> {
    const cap = await db.capability.findUniqueOrThrow({ where: { id } });
    return cap.revokedAt;
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
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });

    await db.org.create({ data: { id: ORG, name: "QA overrev" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@overrev.test", role: "admin", clerkId: "clerk-overrev" },
    });
    const broad = await db.scope.create({ data: { orgId: ORG, path: BROADER_SCOPE, name: "dept_sales" } });
    const narrow = await db.scope.create({ data: { orgId: ORG, path: NARROWER_SCOPE, name: "team_a" } });
    broadScopeId = broad.id;
    narrowScopeId = narrow.id;
    // A real admin grant so the route's own access.manage check() genuinely
    // ALLOWS, evaluated by the real authorization evaluator, not a mock.
    await db.grant.create({
      data: { orgId: ORG, scopeId: narrowScopeId, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // The grant that will be deleted: narrow scope, this agent.
    await db.grant.create({
      data: { orgId: ORG, scopeId: narrowScopeId, granteeType: "agent", granteeId: AGENT, permission: "read" },
    });

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
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  it("revokes the agent's token when no other grant survives it", async () => {
    await seedCapability("cap-no-survivor", NARROWER_SCOPE);
    await deleteNarrowGrant();
    expect(await revokedAt("cap-no-survivor")).not.toBeNull();
  });

  it("survives a token when a second live grant at a broader scope still covers its scope and permission", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId: broadScopeId, granteeType: "agent", granteeId: AGENT, permission: "read" },
    });
    await seedCapability("cap-survives", NARROWER_SCOPE, "read");
    await deleteNarrowGrant();
    expect(await revokedAt("cap-survives")).toBeNull();
  });

  it("still revokes when the only other grant covering the scope has already expired", async () => {
    await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: broadScopeId,
        granteeType: "agent",
        granteeId: AGENT,
        permission: "read",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await seedCapability("cap-expired-survivor", NARROWER_SCOPE);
    await deleteNarrowGrant();
    expect(await revokedAt("cap-expired-survivor")).not.toBeNull();
  });

  it("still revokes when the surviving grant's permission does not cover the token's own permission", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId: broadScopeId, granteeType: "agent", granteeId: AGENT, permission: "read" },
    });
    await seedCapability("cap-underpermissioned-survivor", NARROWER_SCOPE, "write");
    await deleteNarrowGrant();
    expect(await revokedAt("cap-underpermissioned-survivor")).not.toBeNull();
  });

  it("survives when the surviving grant's permission is strictly higher than the token needs", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId: broadScopeId, granteeType: "agent", granteeId: AGENT, permission: "admin" },
    });
    await seedCapability("cap-overpermissioned-survivor", NARROWER_SCOPE, "read");
    await deleteNarrowGrant();
    expect(await revokedAt("cap-overpermissioned-survivor")).toBeNull();
  });

  it("does not treat a different agent's grant at the same scope as a survivor", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId: broadScopeId, granteeType: "agent", granteeId: "agent-other", permission: "read" },
    });
    await seedCapability("cap-other-agent-grant", NARROWER_SCOPE);
    await deleteNarrowGrant();
    expect(await revokedAt("cap-other-agent-grant")).not.toBeNull();
  });
  it("does not treat a same-org grant on an unrelated scope as a survivor", async () => {
    // The surviving-grant check must still be a containment test. A live grant
    // for this agent on a sibling subtree authorizes nothing at NARROWER_SCOPE,
    // so it must not keep the token alive. Without the containment leg the
    // EXISTS matches any grant this agent holds anywhere in the org.
    const unrelated = await db.scope.create({
      data: { orgId: ORG, path: UNRELATED_SCOPE, name: "dept_eng" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: unrelated.id, granteeType: "agent", granteeId: AGENT, permission: "admin" },
    });
    await seedCapability("cap-unrelated-scope-grant", NARROWER_SCOPE);
    await deleteNarrowGrant();
    expect(await revokedAt("cap-unrelated-scope-grant")).not.toBeNull();
  });

  it("does not treat another tenant's grant as a survivor", async () => {
    // Cross-tenant: the other org's scope reuses BROADER_SCOPE's exact path and
    // its grant names the same agent at a covering permission, so every leg of
    // the survivorship check matches EXCEPT the tenant one. This org's token
    // must still be revoked; a foreign tenant can never keep it alive.
    await db.org.create({ data: { id: OTHER_ORG, name: "QA overrev other tenant" } });
    const foreign = await db.scope.create({
      data: { orgId: OTHER_ORG, path: BROADER_SCOPE, name: "dept_sales" },
    });
    await db.grant.create({
      data: { orgId: OTHER_ORG, scopeId: foreign.id, granteeType: "agent", granteeId: AGENT, permission: "admin" },
    });
    await seedCapability("cap-foreign-org-grant", NARROWER_SCOPE);
    await deleteNarrowGrant();
    expect(await revokedAt("cap-foreign-org-grant")).not.toBeNull();
  });
});
