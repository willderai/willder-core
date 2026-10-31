// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Revoking an agent's grant must deny that agent's tokens, whichever form the
// agent was named in when the grant and the token were issued.
//
// The access page's grant form used to submit an Agent row's database id while
// the token form took free text (in practice the agent's name, the only label
// the app shows), and the revoke cascade matches the two columns by equality. Both routes now store the key
// (services/access/agent-identity.ts). These cases drive the real POST, DELETE
// and check() against Postgres, so a route that stops canonicalizing fails here
// on the check() that should deny, not on a mocked call shape.
//
// The last describe block applies the backfill migration to rows stored the old
// way and asserts what it rewrites.
//
// Set QA_DATABASE_URL to an isolated test database. Skips cleanly without it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-agent-identity";
const OTHER_ORG = "org-agent-identity-other";
const SCOPE = "org_ai.sales";
const ADMIN = "u-admin-agent-identity";
const AGENT_KEY = "custom-researcher";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("agent grant revoke reaches tokens across identifier forms, real Postgres", () => {
  let db: PrismaClient;
  let grantsPOST: (typeof import("./route"))["POST"];
  let grantDELETE: (typeof import("./[id]/route"))["DELETE"];
  let capabilitiesPOST: (typeof import("../capabilities/route"))["POST"];
  let check: (typeof import("@/services/access"))["check"];
  let agentDbId: string;
  let otherOrgAgentDbId: string;

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.agent.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { orgId: orgs } });
    await deleteOrgsWithRetry(db, { where: { id: orgs } });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: grantsPOST } = await import("./route"));
    ({ DELETE: grantDELETE } = await import("./[id]/route"));
    ({ POST: capabilitiesPOST } = await import("../capabilities/route"));
    ({ check } = await import("@/services/access"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    await db.org.create({ data: { id: ORG, name: "agent identity" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "agent identity other" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@agent-identity.test", role: "admin", clerkId: "clerk-agent-identity" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    agentDbId = (
      await db.agent.create({
        data: { orgId: ORG, agentKey: AGENT_KEY, name: "Researcher", role: "research" },
      })
    ).id;
    otherOrgAgentDbId = (
      await db.agent.create({
        data: { orgId: OTHER_ORG, agentKey: "custom-foreign", name: "Foreign", role: "research" },
      })
    ).id;

    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  function post(body: unknown): Request {
    return new Request("http://t", { method: "POST", body: JSON.stringify(body) });
  }

  async function grantAgent(granteeId: string): Promise<{ id: string; granteeId: string }> {
    const res = await grantsPOST(post({ scopePath: SCOPE, granteeType: "agent", granteeId, permission: "read" }));
    expect(res.status).toBe(201);
    return (await res.json()).grant;
  }

  async function issueToken(agentId: string): Promise<{ agentId: string; token: string }> {
    const res = await capabilitiesPOST(post({ agentId, scopePath: SCOPE, permission: "read" }));
    expect(res.status).toBe(201);
    return res.json();
  }

  async function revoke(grantId: string) {
    const res = await grantDELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id: grantId }),
    });
    expect(res.status).toBe(200);
  }

  async function agentCanRead(cap: { agentId: string; token: string }): Promise<boolean> {
    const decision = await check(
      { orgId: ORG, actor: { type: "agent", id: cap.agentId, capabilityToken: cap.token }, origin: "mcp" },
      { action: "memory.read", scope: SCOPE },
    );
    return decision.allowed;
  }

  // The reported workflow: the grant form's dropdown submits the database id,
  // the token form is typed with the agent's key.
  it("grant by database id, token by key: revoking the grant denies the token's next check()", async () => {
    const grant = await grantAgent(agentDbId);
    const cap = await issueToken(AGENT_KEY);
    expect(await agentCanRead(cap)).toBe(true);

    await revoke(grant.id);

    expect(await agentCanRead(cap)).toBe(false);
  });

  it("grant by key, token by database id: revoking the grant denies the token's next check()", async () => {
    const grant = await grantAgent(AGENT_KEY);
    const cap = await issueToken(agentDbId);
    expect(await agentCanRead(cap)).toBe(true);

    await revoke(grant.id);

    expect(await agentCanRead(cap)).toBe(false);
  });

  it("stores the agent's key on both rows, whichever form each form submitted", async () => {
    const grant = await grantAgent(agentDbId);
    const cap = await issueToken(agentDbId);

    expect(grant.granteeId).toBe(AGENT_KEY);
    expect(cap.agentId).toBe(AGENT_KEY);
  });

  it("keeps a free-text agent with no Agent row as its own identifier", async () => {
    const grant = await grantAgent("mcp-client");
    const cap = await issueToken("mcp-client");

    expect(grant.granteeId).toBe("mcp-client");
    expect(cap.agentId).toBe("mcp-client");
  });

  it("stores a uniquely named agent's key when the token form is typed with its name", async () => {
    const cap = await issueToken("Researcher");

    expect(cap.agentId).toBe(AGENT_KEY);
  });

  it("refuses a name two agents share instead of guessing which one", async () => {
    await db.agent.create({
      data: { orgId: ORG, agentKey: "custom-researcher-2", name: "Researcher", role: "research" },
    });

    const tokenRes = await capabilitiesPOST(post({ agentId: "Researcher", scopePath: SCOPE, permission: "read" }));
    const grantRes = await grantsPOST(
      post({ scopePath: SCOPE, granteeType: "agent", granteeId: "Researcher", permission: "read" }),
    );

    expect(tokenRes.status).toBe(400);
    expect(grantRes.status).toBe(400);
    expect(await db.capability.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("does not resolve another org's Agent name to that org's key", async () => {
    const cap = await issueToken("Foreign");

    expect(cap.agentId).toBe("Foreign");
  });

  it("does not resolve another org's Agent id to that org's key", async () => {
    const cap = await issueToken(otherOrgAgentDbId);

    expect(cap.agentId).toBe(otherOrgAgentDbId);
  });
});

describe.skipIf(!QA_URL)("backfill migration 20260924_agent_grantee_canonical_key, real Postgres", () => {
  let db: PrismaClient;
  let agentDbId: string;
  let scopeId: string;
  let otherScopeId: string;

  const migrationStatements = readFileSync(
    join(process.cwd(), "prisma/migrations/20260924_agent_grantee_canonical_key/migration.sql"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  async function migrate() {
    for (const statement of migrationStatements) await db.$executeRawUnsafe(statement);
  }

  function capability(id: string, agentId: string, grantGoverned = false) {
    return db.capability.create({
      data: {
        id,
        orgId: ORG,
        agentId,
        scopePath: SCOPE,
        tokenHash: `hash-${id}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
        grantGoverned,
      },
    });
  }

  beforeEach(async () => {
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.agent.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await deleteOrgsWithRetry(db, { where: { id: orgs } });

    await db.org.create({ data: { id: ORG, name: "agent identity" } });
    scopeId = (await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } })).id;
    otherScopeId = (await db.scope.create({ data: { orgId: ORG, path: `${SCOPE}.east`, name: "east" } })).id;
    agentDbId = (
      await db.agent.create({ data: { orgId: ORG, agentKey: AGENT_KEY, name: "Researcher", role: "research" } })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("rewrites database-id grants and tokens to the key and ratchets the token's governance", async () => {
    const grant = await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: agentDbId, permission: "read" },
    });
    await capability("cap-by-key", AGENT_KEY);
    await capability("cap-by-id", agentDbId);
    await capability("cap-free-text", "mcp-client");

    await migrate();

    expect((await db.grant.findUniqueOrThrow({ where: { id: grant.id } })).granteeId).toBe(AGENT_KEY);
    const caps = await db.capability.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } });
    expect(caps.map((c) => [c.id, c.agentId, c.grantGoverned, c.derivedFromGrantId])).toEqual([
      ["cap-by-id", AGENT_KEY, true, grant.id],
      ["cap-by-key", AGENT_KEY, true, grant.id],
      ["cap-free-text", "mcp-client", false, null],
    ]);
  });

  it("folds a database-id grant into its key-form twin, keeping the longer expiry", async () => {
    const later = new Date(Date.now() + 7 * 86_400_000);
    const twin = await db.grant.create({
      data: {
        orgId: ORG,
        scopeId,
        granteeType: "agent",
        granteeId: AGENT_KEY,
        permission: "read",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: agentDbId, permission: "read", expiresAt: later },
    });
    // Same agent, different scope: no twin, so it is rewritten rather than folded.
    await db.grant.create({
      data: { orgId: ORG, scopeId: otherScopeId, granteeType: "agent", granteeId: agentDbId, permission: "read" },
    });

    await migrate();

    const grants = await db.grant.findMany({ where: { orgId: ORG }, orderBy: { scopeId: "asc" } });
    expect(grants).toHaveLength(2);
    expect(grants.every((g) => g.granteeId === AGENT_KEY)).toBe(true);
    const merged = grants.find((g) => g.id === twin.id);
    expect(merged?.expiresAt?.getTime()).toBe(later.getTime());
  });

  it("rewrites name-typed grants and tokens to the key, folding a grant already stored under the id", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: agentDbId, permission: "read" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: "Researcher", permission: "read" },
    });
    await capability("cap-by-name", "Researcher");

    await migrate();

    const grants = await db.grant.findMany({ where: { orgId: ORG } });
    expect(grants.map((g) => g.granteeId)).toEqual([AGENT_KEY]);
    const cap = await db.capability.findUniqueOrThrow({ where: { id: "cap-by-name" } });
    expect([cap.agentId, cap.grantGoverned, cap.derivedFromGrantId]).toEqual([AGENT_KEY, true, grants[0].id]);
  });

  it("leaves a name two agents share, and a name that is another agent's key, as written", async () => {
    await db.agent.create({ data: { orgId: ORG, agentKey: "custom-twin-a", name: "Twin", role: "research" } });
    await db.agent.create({ data: { orgId: ORG, agentKey: "custom-twin-b", name: "Twin", role: "research" } });
    await db.agent.create({ data: { orgId: ORG, agentKey: "custom-shadow", name: AGENT_KEY, role: "research" } });
    await capability("cap-shared-name", "Twin");
    await capability("cap-key-shaped-name", AGENT_KEY);

    await migrate();

    const caps = await db.capability.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } });
    expect(caps.map((c) => [c.id, c.agentId])).toEqual([
      ["cap-key-shaped-name", AGENT_KEY],
      ["cap-shared-name", "Twin"],
    ]);
  });

  it("drops its helper view", async () => {
    await migrate();

    const views = await db.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM information_schema.views WHERE table_name = 'agent_reference_rewrites'`,
    );
    expect(views).toHaveLength(0);
  });

  it("is a no-op when run a second time", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: agentDbId, permission: "read" },
    });
    await migrate();
    const before = await db.grant.findMany({ where: { orgId: ORG } });

    await migrate();

    expect(await db.grant.findMany({ where: { orgId: ORG } })).toEqual(before);
  });
});
