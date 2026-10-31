// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// "Switching an agent back on is an access decision", with the agent configuration gate.
// Deactivating an agent stops its
// capability tokens; before the configuration gate, PATCH /api/agents/:id took no
// access decision, so any signed-in member could send `{ active: true }` and revive
// every token the agent held. The other suites prove the switch off and prompt or
// scope rewrites. This file proves the switch back on, end to end:
//
// - a member with no grant, a root writer and another org's admin each fail to
//   reactivate, and the agent's token stays refused at the door and in check();
// - a concurrent burst of reactivations from a root writer changes nothing;
// - an org admin can reactivate, and the same token works again on its next call.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "./capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-react-a";
const OTHER_ORG = "org-qa-react-b";
const ORG_ROOT = `org_${ORG}`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const SCOPE = `${ORG_ROOT}.sales`;
const ADMIN = "user-qa-react-admin";
const WRITER = "user-qa-react-writer";
const NOBODY = "user-qa-react-nobody";
const OTHER_ADMIN = "user-qa-react-other-admin";
const AGENT_KEY = "custom-qa-react";

type Role = "admin" | "member";

describe.skipIf(!QA_URL)("agent reactivation against a real database", () => {
  let db: PrismaClient;
  let agentPatch: (typeof import("@/app/api/agents/[id]/route"))["PATCH"];
  let changesGet: (typeof import("@/app/api/changes/route"))["GET"];
  let access: typeof import("./check");
  let agentRowId = "";
  let token = "";

  async function signIn(orgId: string, userId: string, role: Role) {
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role }, origin: "app" },
    } as never);
  }

  const patch = async (id: string, body: unknown) => {
    const res = await agentPatch(
      new Request("http://test.local/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
    return { status: res.status, body: await res.text() };
  };

  const changes = (bearer: string) =>
    changesGet(new Request("https://willder.test/api/changes", { headers: { authorization: `Bearer ${bearer}` } }));

  const decide = () =>
    access.check(
      { orgId: ORG, actor: { type: "agent", id: AGENT_KEY, capabilityToken: token }, origin: "mcp" },
      { action: "memory.read", scope: SCOPE },
    );

  const isActive = async () => (await db.agent.findUniqueOrThrow({ where: { id: agentRowId } })).active;

  /** The token is refused exactly like one never issued, and check() denies it. */
  async function expectTokenRefused() {
    const refused = await changes(token);
    const unknown = await changes("wcap_" + "qa_react_never_issued");
    expect(refused.status).toBe(401);
    expect([refused.status, await refused.text()]).toEqual([unknown.status, await unknown.text()]);
    const decision = await decide();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/deactivated/);
  }

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.agent.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PATCH: agentPatch } = await import("@/app/api/agents/[id]/route"));
    ({ GET: changesGet } = await import("@/app/api/changes/route"));
    access = await import("./check");
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.user.createMany({
      data: [
        { id: ADMIN, orgId: ORG, email: "admin@react.qa.test", role: "admin", clerkId: "clerk-qa-react-admin" },
        { id: WRITER, orgId: ORG, email: "writer@react.qa.test", role: "member", clerkId: "clerk-qa-react-writer" },
        { id: NOBODY, orgId: ORG, email: "nobody@react.qa.test", role: "member", clerkId: "clerk-qa-react-nobody" },
        {
          id: OTHER_ADMIN,
          orgId: OTHER_ORG,
          email: "admin@react-b.qa.test",
          role: "admin",
          clerkId: "clerk-qa-react-oadmin",
        },
      ],
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ORG_ROOT, name: "Org" } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "Sales" } });
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "Other" } });
    await db.grant.createMany({
      data: [
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: WRITER, permission: "write" },
        { orgId: OTHER_ORG, scopeId: otherRoot.id, granteeType: "user", granteeId: OTHER_ADMIN, permission: "admin" },
      ],
    });
    agentRowId = (
      await db.agent.create({
        data: { orgId: ORG, agentKey: AGENT_KEY, name: "Reactivation QA", role: "custom", active: false },
      })
    ).id;
    token = `wcap_qa_react_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT_KEY,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  it("starts from a switched-off agent whose token is refused", async () => {
    expect(await isActive()).toBe(false);
    await expectTokenRefused();
  });

  it("a member with no grant gets the same refusal as a never-issued id and cannot switch the agent back on", async () => {
    await signIn(ORG, NOBODY, "member");
    const res = await patch(agentRowId, { active: true });
    const missing = await patch("agent-never-issued", { active: true });
    expect(res.status).toBe(403);
    expect(res).toEqual(missing);
    expect(await isActive()).toBe(false);
    await expectTokenRefused();
  });

  it("a root writer, who reads the whole org, is refused with 403 and the token stays dead", async () => {
    await signIn(ORG, WRITER, "member");
    const res = await patch(agentRowId, { active: true });
    expect(res.status).toBe(403);
    expect(await isActive()).toBe(false);
    await expectTokenRefused();
  });

  it("another org's admin gets the never-issued answer for this org's agent", async () => {
    await signIn(OTHER_ORG, OTHER_ADMIN, "admin");
    const res = await patch(agentRowId, { active: true });
    const missing = await patch("agent-never-issued", { active: true });
    expect(res.status).toBe(404);
    expect(res).toEqual(missing);
    expect(await isActive()).toBe(false);
    await expectTokenRefused();
  });

  it("a concurrent burst of reactivations from a root writer changes nothing, one deny row each", async () => {
    await signIn(ORG, WRITER, "member");
    const before = await db.auditLog.count({ where: { orgId: ORG, decision: "deny", actorId: WRITER } });
    const results = await Promise.all(Array.from({ length: 10 }, () => patch(agentRowId, { active: true })));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(403));
    expect(await db.auditLog.count({ where: { orgId: ORG, decision: "deny", actorId: WRITER } })).toBe(before + 10);
    expect(await isActive()).toBe(false);
    await expectTokenRefused();
  });

  it("an org admin switches the agent back on, and the same token works on its next call", async () => {
    await signIn(ORG, ADMIN, "admin");
    const res = await patch(agentRowId, { active: true });
    expect(res.status).toBe(200);
    expect(await isActive()).toBe(true);
    expect((await changes(token)).status).toBe(200);
    expect((await decide()).allowed).toBe(true);
  });
});
