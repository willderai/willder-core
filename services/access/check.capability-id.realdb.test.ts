// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Every audit row check() writes for an agent's own live token names that token.
//
// The claim: when check() matched the capability token the agent presented, and
// that token was issued to the agent the context names, the audit row carries
// `metadata.capabilityId` = that token's id, so the Tokens tab can say when a
// token was last used and an audit row leads back to the token behind it. A row
// for a token that matched nothing (wrong scope, wrong tenant, expired) or that
// was issued to a different agent never names one: on a mismatch the row is
// attributed to the claimed actor, so naming the presented token there would
// credit that token with a use by someone it was never issued to.
//
// Which token covers which scope is decided by the ltree containment and expiry
// predicates in Postgres, so a double would only restate this file's own
// assumptions. This runs the shipping check() against a real database.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "./member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-capability-id";
const OTHER_ORG = "org-qa-capability-id-other";
const ROOT = "org_qa_capability_id";
const ENG = `${ROOT}.eng`;
const SALES = `${ROOT}.sales`;
const OTHER_ROOT = "org_qa_capability_id_other";

const AGENT = "agent-qa-capability-id";
const OTHER_AGENT = "agent-qa-capability-id-2";
const TOKEN = "qa-capability-id-live-token";
const EXPIRED_TOKEN = "qa-capability-id-expired-token";
const OTHER_TENANT_TOKEN = "qa-capability-id-other-tenant-token";
const GOVERNED_AGENT = "agent-qa-capability-id-governed";
const STALE_TOKEN = "qa-capability-id-stale-token";

describe.skipIf(!QA_URL)("check() names the agent's own live token on its audit row, real Postgres", () => {
  let db: PrismaClient;
  let check: (typeof import("./check"))["check"];
  let liveCapabilityId: string;
  let staleCapabilityId: string;

  /** Runs check() as `actor`, then reads back the one audit row it wrote. */
  async function decide(
    orgId: string,
    actor: { type: "agent"; id: string; capabilityToken: string } | { type: "human"; id: string; role: "admin" },
    scope: string,
  ) {
    const decision = await check(
      { orgId, actor, origin: actor.type === "human" ? "app" : "mcp" },
      { action: "memory.read", scope },
    );
    const row = await db.auditLog.findUniqueOrThrow({ where: { id: decision.auditLogId! } });
    return { allowed: decision.allowed, metadata: (row.metadata ?? {}) as Record<string, unknown> };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ check } = await import("./check"));
    const { hashCapabilityToken } = await import("./capabilities");

    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.org.deleteMany({ where: { id: orgs } });

    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    await seedMember(db, { orgId: ORG, userId: "u-qa-admin", role: "admin" });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: ENG, name: "eng" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: "u-qa-admin", permission: "admin" },
    });

    const inADay = new Date(Date.now() + 86_400_000);
    const live = await db.capability.create({
      data: { orgId: ORG, agentId: AGENT, tokenHash: hashCapabilityToken(TOKEN), scopePath: ENG, expiresAt: inADay },
    });
    liveCapabilityId = live.id;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(EXPIRED_TOKEN),
        scopePath: ENG,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    // Grant-governed, but no grant on file covers it any more: a token that
    // outlived the grant it was minted from.
    const stale = await db.capability.create({
      data: {
        orgId: ORG,
        agentId: GOVERNED_AGENT,
        tokenHash: hashCapabilityToken(STALE_TOKEN),
        scopePath: ENG,
        expiresAt: inADay,
        grantGoverned: true,
      },
    });
    staleCapabilityId = stale.id;
    await db.capability.create({
      data: {
        orgId: OTHER_ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(OTHER_TENANT_TOKEN),
        scopePath: OTHER_ROOT,
        expiresAt: inADay,
      },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const agent = (capabilityToken: string, id = AGENT) => ({ type: "agent" as const, id, capabilityToken });

  it("an allowed read at the token's own scope names the token", async () => {
    const { allowed, metadata } = await decide(ORG, agent(TOKEN), ENG);
    expect(allowed).toBe(true);
    expect(metadata.capabilityId).toBe(liveCapabilityId);
  });

  it("an allowed read below the token's scope names the token", async () => {
    const { allowed, metadata } = await decide(ORG, agent(TOKEN), `${ENG}.platform`);
    expect(allowed).toBe(true);
    expect(metadata.capabilityId).toBe(liveCapabilityId);
  });

  it("a read outside the token's scope is denied and names no token", async () => {
    const { allowed, metadata } = await decide(ORG, agent(TOKEN), SALES);
    expect(allowed).toBe(false);
    expect(metadata).not.toHaveProperty("capabilityId");
  });

  it("a token presented in another tenant is denied and names no token", async () => {
    const { allowed, metadata } = await decide(OTHER_ORG, agent(TOKEN), OTHER_ROOT);
    expect(allowed).toBe(false);
    expect(metadata).not.toHaveProperty("capabilityId");
  });

  it("an expired token is denied and names no token", async () => {
    const { allowed, metadata } = await decide(ORG, agent(EXPIRED_TOKEN), ENG);
    expect(allowed).toBe(false);
    expect(metadata).not.toHaveProperty("capabilityId");
  });

  it("a token presented by an agent it was not issued to is denied and is not credited with the use", async () => {
    const { allowed, metadata } = await decide(ORG, agent(TOKEN, OTHER_AGENT), ENG);
    expect(allowed).toBe(false);
    expect(metadata).not.toHaveProperty("capabilityId");
  });

  it("a token that outlived its grant is denied, and the deny names the token its own agent presented", async () => {
    const { allowed, metadata } = await decide(ORG, agent(STALE_TOKEN, GOVERNED_AGENT), ENG);
    expect(allowed).toBe(false);
    expect(metadata.capabilityId).toBe(staleCapabilityId);
  });

  it("a human's decision names no token", async () => {
    const { allowed, metadata } = await decide(ORG, { type: "human", id: "u-qa-admin", role: "admin" }, ENG);
    expect(allowed).toBe(true);
    expect(metadata).not.toHaveProperty("capabilityId");
  });
});
