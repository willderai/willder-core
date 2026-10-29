// A refused agent request names the person the agent acts for.
//
// Every refusal's audit row must to name the principal and the delegating
// person. For an agent the delegating person is whoever provisioned its token, kept
// as `metadata.triggeredBy`. Before this, the commonest agent refusal, a token asked
// for a scope it does not cover, named the agent alone: the decision query found no
// capability row for an uncovered scope, so it had no one to name.
//
// Each case drives a real refusal against Postgres and reads back the one deny row it
// wrote. Needs QA_DATABASE_URL naming an isolated, migrated test database; skipped
// without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `orgdelegation${RUN}`;
const OTHER_ORG = `orgdelegationother${RUN}`;
const PERSON = `user-delegation-${RUN}`;
const AGENT = `agent-delegation-${RUN}`;
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const OTHER_DEAL = `${ROOT}.deal_b`;

describe.skipIf(!QA_URL)("a refused agent request names its delegating person (real database)", () => {
  let db: PrismaClient;
  let access: typeof import("@/services/access");
  let token: string;
  let revokedToken: string;

  const agentCtx = (capabilityToken: string) => ({
    orgId: ORG,
    actor: { type: "agent" as const, id: AGENT, capabilityToken },
    origin: "mcp" as const,
  });

  /** The deny rows written since `since`, oldest first. */
  const denials = (since: Date) =>
    db.auditLog.findMany({ where: { orgId: ORG, decision: "deny", at: { gte: since } }, orderBy: { chainSeq: "asc" } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    access = await import("@/services/access");
    await db.org.createMany({
      data: [
        { id: ORG, name: "Delegation QA" },
        { id: OTHER_ORG, name: "Other" },
      ],
    });
    await db.user.create({
      data: { id: PERSON, orgId: ORG, email: `${RUN}@delegation.test`, role: "admin", clerkId: `clerk-${RUN}` },
    });
    for (const path of [ROOT, DEAL, OTHER_DEAL]) {
      await db.scope.create({ data: { orgId: ORG, path, name: path } });
    }
    // A token is never wider than its issuer, so PERSON administers the org.
    const root = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG, path: ROOT } } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: PERSON, permission: "admin" },
    });
    token = access.generateCapabilityToken();
    revokedToken = access.generateCapabilityToken();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: access.hashCapabilityToken(token),
        scopePath: DEAL,
        permission: "read",
        expiresAt,
        createdBy: PERSON,
      },
    });
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: access.hashCapabilityToken(revokedToken),
        scopePath: DEAL,
        permission: "read",
        expiresAt,
        revokedAt: new Date(),
        createdBy: PERSON,
      },
    });
  });

  afterAll(async () => {
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { id: PERSON } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  it("check(): a token asked for a scope it does not cover", async () => {
    const since = new Date();
    const decision = await access.check(agentCtx(token), { action: "memory.read", scope: OTHER_DEAL });
    expect(decision.allowed).toBe(false);
    const rows = await denials(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "agent", actorId: AGENT, action: "memory.read", target: OTHER_DEAL });
    expect(rows[0].metadata).toMatchObject({ triggeredBy: PERSON, origin: "mcp" });
  });

  it("check(): a covered scope without the permission still names them, and does not widen the decision", async () => {
    const since = new Date();
    expect((await access.check(agentCtx(token), { action: "memory.write", scope: DEAL })).allowed).toBe(false);
    expect((await access.check(agentCtx(token), { action: "memory.read", scope: DEAL })).allowed).toBe(true);
    const rows = await denials(since);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ triggeredBy: PERSON });
  });

  it("check(): a token presented under another agent's name is refused as before", async () => {
    const since = new Date();
    const ctx = { ...agentCtx(token), actor: { type: "agent" as const, id: "someone-else", capabilityToken: token } };
    const decision = await access.check(ctx, { action: "memory.read", scope: OTHER_DEAL });
    expect(decision.allowed).toBe(false);
    expect(await denials(since)).toHaveLength(1);
  });

  it("resolveCallerScopePath(): a malformed scope on a write", async () => {
    const cap = await access.resolveCapability(token, "mcp");
    expect(cap).not.toBeNull();
    const since = new Date();
    await expect(
      access.resolveCallerScopePath(agentCtx(token), "not a path", cap!, {
        onInvalid: "refuse",
        action: "memory.write",
      }),
    ).rejects.toBeInstanceOf(access.AccessDeniedError);
    const rows = await denials(since);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ triggeredBy: PERSON });
  });

  it("resolveCapability(): a revoked token refused at the door", async () => {
    const since = new Date();
    expect(await access.resolveCapability(revokedToken, "api")).toBeNull();
    const rows = await denials(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "capability.refused", actorId: AGENT });
    expect(rows[0].metadata).toMatchObject({ triggeredBy: PERSON });
  });

  it("the guarded store: a partition outside the caller's tenant, refused before check()", async () => {
    const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
    const store = new GuardedMemoryStore({} as never);
    const since = new Date();
    await expect(
      store.retrieve(agentCtx(token), { groupId: OTHER_ORG, query: "q", limit: 5 } as never),
    ).rejects.toBeInstanceOf(access.AccessDeniedError);
    const rows = await denials(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: AGENT, action: "memory.read", target: OTHER_ORG });
    expect(rows[0].metadata).toMatchObject({ triggeredBy: PERSON });
  });

  it("recordRefusal(): a person refused names no one else", async () => {
    const since = new Date();
    await access.recordRefusal(
      { orgId: ORG, actor: { type: "human", id: PERSON, role: "member" }, origin: "app" },
      { action: "access.refused", target: `${ROOT}/settings:x`, auditReason: "role member" },
    );
    const rows = await denials(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "human", actorId: PERSON });
    expect(rows[0].metadata).toEqual({ origin: "app" });
  });
});
