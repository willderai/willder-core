// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The grant-revoke cascade matches agents by identity.
//
// Drives the flow the access page's two forms actually produce: the grant form's
// agent dropdown is filled from GET /api/agents, and the token form's "Agent ID"
// is typed by a person who can only see what the UI shows them. Also checks the
// backfill migration's tenant boundary and what its governance ratchet does to a
// token wider than the agent's grant.
//
// Set QA_DATABASE_URL to an isolated test database. Skips cleanly without it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-agent-identity-qa";
const OTHER_ORG = "org-agent-identity-qa-other";
const SCOPE = "org_aiqa.sales";
const CHILD_SCOPE = "org_aiqa.sales.east";
const ADMIN = "u-admin-agent-identity-qa";
const AGENT_KEY = "custom-1790000000000";
const AGENT_NAME = "Researcher";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

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

describe.skipIf(!QA_URL)("agent identity across the access page's two forms, real Postgres", () => {
  let db: PrismaClient;
  let grantsPOST: (typeof import("./route"))["POST"];
  let grantDELETE: (typeof import("./[id]/route"))["DELETE"];
  let capabilitiesPOST: (typeof import("../capabilities/route"))["POST"];
  let agentsGET: (typeof import("../../agents/route"))["GET"];
  let check: (typeof import("@/services/access"))["check"];
  let scopeId: string;
  let childScopeId: string;
  let agentDbId: string;
  let foreignAgentDbId: string;

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.agent.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { orgId: orgs } });
    await db.org.deleteMany({ where: { id: orgs } });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: grantsPOST } = await import("./route"));
    ({ DELETE: grantDELETE } = await import("./[id]/route"));
    ({ POST: capabilitiesPOST } = await import("../capabilities/route"));
    ({ GET: agentsGET } = await import("../../agents/route"));
    ({ check } = await import("@/services/access"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    await db.org.create({ data: { id: ORG, name: "qa" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "qa other" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@aiqa.test", role: "admin", clerkId: "clerk-aiqa" },
    });
    scopeId = (await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } })).id;
    childScopeId = (await db.scope.create({ data: { orgId: ORG, path: CHILD_SCOPE, name: "east" } })).id;
    await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    agentDbId = (
      await db.agent.create({ data: { orgId: ORG, agentKey: AGENT_KEY, name: AGENT_NAME, role: "research" } })
    ).id;
    foreignAgentDbId = (
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

  // The grant form: the agent <select>'s option value, exactly as the page builds it.
  async function dropdownValueFor(name: string): Promise<string> {
    const { agents } = await (await agentsGET()).json();
    const agent = agents.find((a: { name: string }) => a.name === name);
    return agent.agentKey;
  }

  async function grantViaForm(granteeId: string, scope = scopeId) {
    const res = await grantsPOST(post({ scopeId: scope, granteeType: "agent", granteeId, permission: "read" }));
    expect(res.status).toBe(201);
    return (await res.json()).grant as { id: string; granteeId: string };
  }

  async function tokenViaForm(agentId: string, scopePath = SCOPE) {
    const res = await capabilitiesPOST(post({ agentId, scopePath, permission: "read" }));
    expect(res.status).toBe(201);
    return (await res.json()) as { agentId: string; token: string };
  }

  async function revoke(grantId: string) {
    const res = await grantDELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id: grantId }),
    });
    expect(res.status).toBe(200);
  }

  async function canRead(cap: { agentId: string; token: string }, scope = SCOPE) {
    const decision = await check(
      { orgId: ORG, actor: { type: "agent", id: cap.agentId, capabilityToken: cap.token }, origin: "mcp" },
      { action: "memory.read", scope },
    );
    return decision.allowed;
  }

  it("dropdown grant + token typed with the stored key: revoke denies the next check()", async () => {
    const grant = await grantViaForm(await dropdownValueFor(AGENT_NAME));
    const cap = await tokenViaForm(AGENT_KEY);
    expect(await canRead(cap)).toBe(true);
    await revoke(grant.id);
    expect(await canRead(cap)).toBe(false);
  });

  // The only label for this agent the access page or the agents page ever shows
  // is its name. Its key ("custom-<ms>") is displayed nowhere, so this is what a
  // person issuing a token for it from the Tokens form can actually type.
  it("dropdown grant + token typed with the only label the UI shows: revoke denies the next check()", async () => {
    const grant = await grantViaForm(await dropdownValueFor(AGENT_NAME));
    const cap = await tokenViaForm(AGENT_NAME);
    expect(await canRead(cap)).toBe(true);
    await revoke(grant.id);
    expect(await canRead(cap)).toBe(false);
  });

  it("another org's Agent id is stored as free text on the grant too, never resolved across tenants", async () => {
    const grant = await grantViaForm(foreignAgentDbId);
    expect(grant.granteeId).toBe(foreignAgentDbId);
  });

  describe("backfill migration", () => {
    async function migrate() {
      for (const statement of migrationStatements) await db.$executeRawUnsafe(statement);
    }

    it("leaves a grant and token naming another org's Agent id untouched", async () => {
      const grant = await db.grant.create({
        data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: foreignAgentDbId, permission: "read" },
      });
      await db.capability.create({
        data: {
          id: "cap-foreign-ref",
          orgId: ORG,
          agentId: foreignAgentDbId,
          scopePath: SCOPE,
          tokenHash: "hash-cap-foreign-ref",
          permission: "read",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      await migrate();

      expect((await db.grant.findUniqueOrThrow({ where: { id: grant.id } })).granteeId).toBe(foreignAgentDbId);
      expect((await db.capability.findUniqueOrThrow({ where: { id: "cap-foreign-ref" } })).agentId).toBe(
        foreignAgentDbId,
      );
    });

    // Names collide across tenants far more easily than database ids: another
    // org's external client can simply be called what this org's agent is called.
    it("leaves another org's grant and token that share this org's agent name untouched", async () => {
      const foreignScopeId = (
        await db.scope.create({ data: { orgId: OTHER_ORG, path: "org_aiqa_other.ops", name: "ops" } })
      ).id;
      const grant = await db.grant.create({
        data: {
          orgId: OTHER_ORG,
          scopeId: foreignScopeId,
          granteeType: "agent",
          granteeId: AGENT_NAME,
          permission: "read",
        },
      });
      await db.capability.create({
        data: {
          id: "cap-foreign-name",
          orgId: OTHER_ORG,
          agentId: AGENT_NAME,
          scopePath: "org_aiqa_other.ops",
          tokenHash: "hash-cap-foreign-name",
          permission: "read",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      await migrate();

      expect((await db.grant.findUniqueOrThrow({ where: { id: grant.id } })).granteeId).toBe(AGENT_NAME);
      expect((await db.capability.findUniqueOrThrow({ where: { id: "cap-foreign-name" } })).agentId).toBe(AGENT_NAME);
    });

    it("folds a permanent legacy grant into a time-bounded twin as permanent", async () => {
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
        data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: agentDbId, permission: "read" },
      });

      await migrate();

      const agentGrants = await db.grant.findMany({ where: { orgId: ORG, granteeType: "agent" } });
      expect(agentGrants.map((g) => [g.id, g.expiresAt])).toEqual([[twin.id, null]]);
    });

    // The documented behaviour change: a key-typed token minted while its agent's
    // grant sat under the database id was ungoverned. After the ratchet it is
    // judged against the grant, so its reach beyond the grant is cut, and a later
    // revoke of that grant reaches it.
    it("governs a mismatched legacy token: reach beyond the grant is denied, and revoke then denies it", async () => {
      const grant = await db.grant.create({
        data: { orgId: ORG, scopeId: childScopeId, granteeType: "agent", granteeId: agentDbId, permission: "read" },
      });
      const wide = await tokenViaForm(AGENT_KEY, SCOPE);
      // Unrelated to the grant under the database id, the token reads the parent scope.
      expect(await canRead(wide, SCOPE)).toBe(true);

      await migrate();

      expect(await canRead(wide, SCOPE)).toBe(false);
      expect(await canRead(wide, CHILD_SCOPE)).toBe(true);
      await revoke(grant.id);
      expect(await canRead(wide, CHILD_SCOPE)).toBe(false);
    });
  });
});
