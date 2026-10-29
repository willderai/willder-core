// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// "Deactivating an agent stops its capability tokens on the next call." The
// main suite drives each entry
// point in one tenant with a read token. This file covers what that leaves open:
//
// - the switch made through the real admin path (POST /api/access/capabilities,
//   then PATCH /api/agents/:id), not a direct column update;
// - a session that resolved its token before the switch keeps running through
//   a real MCP tool, and its next call is refused with the fix named;
// - tenant isolation: another org's deactivated agent sharing this agent's key,
//   or carrying this agent's key as its database id, stops nothing here;
// - a root writer cannot switch a deactivated agent back on (only an org admin can);
// - write and admin tokens, not only read;
// - a concurrent burst after the switch, interleaved with a bystander;
// - the refusal at the door is indistinguishable from an unknown token, and its
//   audit row names the token and nothing the caller did not already hold.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { Permission } from "@/lib/generated/prisma/enums";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "./capabilities";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-deact-a";
const OTHER_ORG = "org-qa-deact-b";
const SCOPE = "org_qa_deact_a.sales";
/** The org root scope (orgRootPath), where configuring an agent is decided. */
const ORG_ROOT = `org_${ORG}`;
const OTHER_SCOPE = "org_qa_deact_b.sales";
const ADMIN = "user-qa-deact-admin";
/** The same agentKey in both tenants: keys are unique per org, not globally. */
const SHARED_KEY = "custom-qa-deact-shared";
const BYSTANDER_KEY = "custom-qa-deact-bystander";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("agent deactivation against a real database", () => {
  let db: PrismaClient;
  let mcpPost: (typeof import("@/app/api/mcp/route"))["POST"];
  let changesGet: (typeof import("@/app/api/changes/route"))["GET"];
  let capabilitiesPost: (typeof import("@/app/api/access/capabilities/route"))["POST"];
  let agentPatch: (typeof import("@/app/api/agents/[id]/route"))["PATCH"];
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let access: typeof import("./check");
  const clients: Client[] = [];
  /** Database id of ORG's agent keyed SHARED_KEY. */
  let agentRowId = "";

  async function mint(orgId: string, agentId: string, scopePath: string, permission: Permission = "read") {
    const token = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  const deactivate = (id: string) => db.agent.update({ where: { id }, data: { active: false } });

  const changes = (token: string) =>
    changesGet(new Request("https://willder.test/api/changes", { headers: { authorization: `Bearer ${token}` } }));

  const toolsList = (token: string) =>
    mcpPost(
      new Request("https://willder.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      }),
    );

  /** check() as `agentId` presenting `token`, for `action` on `scope`. */
  const decide = (
    orgId: string,
    agentId: string,
    token: string,
    action: "memory.read" | "memory.write" | "access.manage",
    scope: string,
  ) =>
    access.check(
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { action, scope },
    );

  /** An MCP session whose token was resolved once, up front, as the stdio server does. */
  async function openSession(orgId: string, agentId: string, token: string, scopePath: string): Promise<Client> {
    const server = new McpServer({ name: "qa", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId, agentId, scopePath },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "qa-client", version: "0.0.0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.brief.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.agent.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: mcpPost } = await import("@/app/api/mcp/route"));
    ({ GET: changesGet } = await import("@/app/api/changes/route"));
    ({ POST: capabilitiesPost } = await import("@/app/api/access/capabilities/route"));
    ({ PATCH: agentPatch } = await import("@/app/api/agents/[id]/route"));
    ({ registerWillderTools } = await import("@/mcp/tools"));
    access = await import("./check");
  });

  afterAll(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    if (!db) return;
    await wipe();
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await wipe();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@deact.qa.test", role: "admin", clerkId: "clerk-qa-deact-admin" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // Switching an agent off is an agent configuration change, decided as
    // access.manage at the org root, so the admin holds admin there too.
    const root = await db.scope.create({ data: { orgId: ORG, path: ORG_ROOT, name: "Org" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    agentRowId = (
      await db.agent.create({ data: { orgId: ORG, agentKey: SHARED_KEY, name: "Deactivation QA", role: "custom" } })
    ).id;
    await db.agent.create({ data: { orgId: ORG, agentKey: BYSTANDER_KEY, name: "Bystander QA", role: "custom" } });

    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    });
  });

  it("refuses the next call after an admin switches the agent off through the app, for a token minted through the app", async () => {
    // The issue form accepts the agent's database id and stores its canonical key.
    const issued = await capabilitiesPost(
      new Request("http://t", {
        method: "POST",
        body: JSON.stringify({ agentId: agentRowId, scopePath: SCOPE, permission: "read" }),
      }),
    );
    expect(issued.status).toBe(201);
    const { token, agentId } = (await issued.json()) as { token: string; agentId: string };
    expect(agentId).toBe(SHARED_KEY);
    expect((await toolsList(token)).status).toBe(200);

    const patched = await agentPatch(
      new Request("http://t", { method: "PATCH", body: JSON.stringify({ active: false }) }),
      { params: Promise.resolve({ id: agentRowId }) },
    );
    expect(patched.status).toBe(200);

    expect((await toolsList(token)).status).toBe(401);
    expect((await changes(token)).status).toBe(401);
  });

  it("refuses a root writer who switches the agent back on, so its token stays refused until an admin does", async () => {
    const token = await mint(ORG, SHARED_KEY, SCOPE);
    await deactivate(agentRowId);
    expect((await changes(token)).status).toBe(401);

    // A member who can write at the org root but cannot manage it.
    const writer = "user-qa-deact-root-writer";
    await db.user.create({
      data: { id: writer, orgId: ORG, email: "writer@deact.qa.test", role: "member", clerkId: "clerk-qa-deact-writer" },
    });
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ORG_ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: writer, permission: "write" },
    });
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValueOnce({
      org: { id: ORG },
      user: { id: writer },
      ctx: { orgId: ORG, actor: { type: "human", id: writer, role: "member" }, origin: "app" },
    });
    const switchOn = () =>
      agentPatch(new Request("http://t", { method: "PATCH", body: JSON.stringify({ active: true }) }), {
        params: Promise.resolve({ id: agentRowId }),
      });

    expect((await switchOn()).status).toBe(403);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentRowId } })).active).toBe(false);
    expect((await changes(token)).status).toBe(401);
    expect((await toolsList(token)).status).toBe(401);

    // The same request from the org admin succeeds and the same token works again,
    // so the 403 above was the access decision, not a broken route.
    expect((await switchOn()).status).toBe(200);
    expect((await changes(token)).status).toBe(200);
  });

  it("refuses the next tool call of a session that resolved its token before the switch, naming the fix", async () => {
    const token = await mint(ORG, SHARED_KEY, SCOPE);
    const brief = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: SCOPE, title: "Pipeline review", summary: "s", sections: [] },
    });
    const session = await openSession(ORG, SHARED_KEY, token, SCOPE);
    const read = async () =>
      (await session.callTool({ name: "get_my_brief", arguments: { briefId: brief.id } })) as ToolResult;

    const before = await read();
    expect(before.isError).toBeFalsy();
    expect(text(before)).toContain("Pipeline review");

    await deactivate(agentRowId);

    const after = await read();
    expect(after.isError).toBe(true);
    expect(text(after)).not.toContain("Pipeline review");
    expect(text(after)).toMatch(/deactivated/);
    expect(text(after)).toMatch(/reactivate/);
    // The refusal is a real check() decision, audited as one.
    const denial = await db.auditLog.findFirst({
      where: { orgId: ORG, actorId: SHARED_KEY, decision: "deny", action: "memory.read" },
      orderBy: { at: "desc" },
    });
    expect(denial?.reason).toMatch(/deactivated/);
  });

  it("is tenant-scoped: another org's deactivated agent with the same key, or with this key as its id, stops nothing here", async () => {
    // OTHER_ORG holds both shapes a token's agentId is matched by: an agent row
    // keyed SHARED_KEY, and an agent row whose database id is SHARED_KEY.
    await db.agent.create({
      data: { orgId: OTHER_ORG, agentKey: SHARED_KEY, name: "Foreign same key", role: "custom", active: false },
    });
    await db.agent.create({
      data: {
        id: SHARED_KEY,
        orgId: OTHER_ORG,
        agentKey: "custom-qa-deact-foreign-id",
        name: "Foreign id",
        role: "custom",
        active: false,
      },
    });
    const ours = await mint(ORG, SHARED_KEY, SCOPE);
    const theirs = await mint(OTHER_ORG, SHARED_KEY, OTHER_SCOPE);

    expect((await changes(ours)).status).toBe(200);
    expect((await toolsList(ours)).status).toBe(200);
    expect((await decide(ORG, SHARED_KEY, ours, "memory.read", SCOPE)).allowed).toBe(true);

    // And the switch in the other tenant does stop that tenant's own token.
    expect((await changes(theirs)).status).toBe(401);
    expect((await decide(OTHER_ORG, SHARED_KEY, theirs, "memory.read", OTHER_SCOPE)).allowed).toBe(false);
  });

  it("refuses write and admin tokens too, not only read", async () => {
    const write = await mint(ORG, SHARED_KEY, SCOPE, "write");
    const admin = await mint(ORG, SHARED_KEY, SCOPE, "admin");
    expect((await decide(ORG, SHARED_KEY, write, "memory.write", SCOPE)).allowed).toBe(true);
    expect((await decide(ORG, SHARED_KEY, admin, "access.manage", SCOPE)).allowed).toBe(true);

    await deactivate(agentRowId);

    const writeDecision = await decide(ORG, SHARED_KEY, write, "memory.write", SCOPE);
    const adminDecision = await decide(ORG, SHARED_KEY, admin, "access.manage", SCOPE);
    expect(writeDecision.allowed).toBe(false);
    expect(writeDecision.reason).toMatch(/deactivated/);
    expect(adminDecision.allowed).toBe(false);
    expect(adminDecision.reason).toMatch(/deactivated/);
  });

  it("refuses every call in a concurrent burst after the switch, while a bystander's interleaved calls all pass", async () => {
    const target = await mint(ORG, SHARED_KEY, SCOPE);
    const bystander = await mint(ORG, BYSTANDER_KEY, SCOPE);
    await deactivate(agentRowId);

    const BURST = 12;
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        i % 2 === 0
          ? Promise.all([changes(target), decide(ORG, SHARED_KEY, target, "memory.read", SCOPE)]).then(
              ([res, decision]) => ({ who: "target", status: res.status, allowed: decision.allowed }),
            )
          : Promise.all([changes(bystander), decide(ORG, BYSTANDER_KEY, bystander, "memory.read", SCOPE)]).then(
              ([res, decision]) => ({ who: "bystander", status: res.status, allowed: decision.allowed }),
            ),
      ),
    );

    const targetRuns = results.filter((r) => r.who === "target");
    const bystanderRuns = results.filter((r) => r.who === "bystander");
    expect(targetRuns).toHaveLength(BURST / 2);
    expect(targetRuns.filter((r) => r.status !== 401 || r.allowed)).toEqual([]);
    expect(bystanderRuns.filter((r) => r.status !== 200 || !r.allowed)).toEqual([]);
  });

  it("answers a deactivated agent's token exactly like an unknown one, and audits it without disclosing anything new", async () => {
    const token = await mint(ORG, SHARED_KEY, SCOPE);
    const capability = await db.capability.findUniqueOrThrow({ where: { tokenHash: hashCapabilityToken(token) } });
    await deactivate(agentRowId);

    const refused = await changes(token);
    const unknown = await changes("wcap_qa_never_issued");
    expect(refused.status).toBe(unknown.status);
    expect(await refused.text()).toBe(await unknown.text());

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "capability.refused" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "agent",
      actorId: SHARED_KEY,
      target: SCOPE,
      decision: "deny",
      reason: "agent deactivated: token refused before any action ran",
      metadata: { capabilityId: capability.id },
    });
  });
});
