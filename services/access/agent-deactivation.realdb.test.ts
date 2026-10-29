// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Deactivating an agent stops every capability token issued to it, on the next call.
//
// An admin turns an agent off with PATCH /api/agents/:id { active: false }. The
// tokens already issued to that agent are a separate table, keyed by the agent's
// key, and nothing revokes them, so the refusal has to come from the access layer
// reading Agent.active on each use. This drives every entry point that accepts an
// agent's token, the hosted MCP endpoint, both change-feed routes, the token
// resolution the stdio server uses and check() itself, before and after the
// switch, against a real database, since the join between a token and its agent
// row only exists there.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll can point DATABASE_URL
// at the QA database.
import { hashCapabilityToken } from "./capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-agent-deactivation";
const SCOPE = "org_qa_agent_deactivation.sales";
const AGENT_KEY = "custom-qa-deactivated";
const BYSTANDER_KEY = "custom-qa-still-active";
/** An agent with no Agent row, such as an external MCP client: nothing to deactivate. */
const UNREGISTERED_AGENT = "mcp-client-qa-unregistered";

const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
const SEND_FEEDBACK =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_feedback","arguments":{"kind":"other","message":"still here"}}}';

describe.skipIf(!QA_URL)("a deactivated agent's capability tokens, against a real database", () => {
  let db: PrismaClient;
  let mcpPost: (typeof import("@/app/api/mcp/route"))["POST"];
  let changesGet: (typeof import("@/app/api/changes/route"))["GET"];
  let noticeGet: (typeof import("@/app/api/changes/notice/route"))["GET"];
  let access: typeof import("./check");
  let agentRowId = "";

  async function mint(agentId: string): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(raw),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }

  const setActive = (active: boolean) => db.agent.update({ where: { id: agentRowId }, data: { active } });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const mcp = (token: string, body: string) =>
    mcpPost(
      new Request("https://willder.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...bearer(token),
        },
        body,
      }),
    );
  const changes = (token: string) =>
    changesGet(new Request("https://willder.test/api/changes", { headers: bearer(token) }));
  const notice = (token: string) =>
    noticeGet(new Request("https://willder.test/api/changes/notice", { headers: bearer(token) }));

  /** check() as the agent `agentId` presenting `token`, reading the token's own scope. */
  const decide = (agentId: string, token: string) =>
    access.check(
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { action: "memory.read", scope: SCOPE },
    );

  /** Status of every token-authenticated entry point, for one token. */
  async function statuses(token: string) {
    return {
      mcpToolsList: (await mcp(token, TOOLS_LIST)).status,
      mcpSendFeedback: (await mcp(token, SEND_FEEDBACK)).status,
      changes: (await changes(token)).status,
      notice: (await notice(token)).status,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: mcpPost } = await import("@/app/api/mcp/route"));
    ({ GET: changesGet } = await import("@/app/api/changes/route"));
    ({ GET: noticeGet } = await import("@/app/api/changes/notice/route"));
    access = await import("./check");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.productFeedback.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const row = await db.agent.create({
      data: { orgId: ORG, agentKey: AGENT_KEY, name: "Deactivation probe", role: "custom" },
    });
    agentRowId = row.id;
    await db.agent.create({
      data: { orgId: ORG, agentKey: BYSTANDER_KEY, name: "Still active", role: "custom" },
    });
  });

  it("allows the token while the agent is active, and refuses it on every entry point once deactivated", async () => {
    const token = await mint(AGENT_KEY);
    const allowed = { mcpToolsList: 200, mcpSendFeedback: 200, changes: 200, notice: 200 };
    expect(await statuses(token)).toEqual(allowed);
    expect((await decide(AGENT_KEY, token)).allowed).toBe(true);

    await setActive(false);

    expect(await statuses(token)).toEqual({ mcpToolsList: 401, mcpSendFeedback: 401, changes: 401, notice: 401 });
    expect(await access.resolveCapability(token, "mcp")).toBeNull();
    // send_feedback runs no check(), so only the door stands between it and a
    // write: the one row is from before the switch.
    expect(await db.productFeedback.count({ where: { orgId: ORG } })).toBe(1);
  });

  it("refuses the token in check() itself, for an in-process run or a session opened before the switch", async () => {
    const token = await mint(AGENT_KEY);
    await setActive(false);

    const decision = await decide(AGENT_KEY, token);
    expect(decision.allowed).toBe(false);
    // The caller is told what to do about it, not only that it failed.
    expect(decision.reason).toMatch(/deactivated/);
    expect(decision.reason).toMatch(/reactivate/);
    const probe = await access.can(
      { orgId: ORG, actor: { type: "agent", id: AGENT_KEY, capabilityToken: token }, origin: "api" },
      { action: "memory.read", scope: SCOPE },
    );
    expect(probe.allowed).toBe(false);

    const row = await db.auditLog.findUniqueOrThrow({ where: { id: decision.auditLogId! } });
    expect(row).toMatchObject({ actorType: "agent", actorId: AGENT_KEY, decision: "deny" });
    expect(row.reason).toMatch(/deactivated/);
  });

  it("audits a refusal at the door like a revoked token's, naming the token", async () => {
    const token = await mint(AGENT_KEY);
    const capability = await db.capability.findUniqueOrThrow({ where: { tokenHash: hashCapabilityToken(token) } });
    await setActive(false);

    expect((await mcp(token, TOOLS_LIST)).status).toBe(401);

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "capability.refused" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "agent",
      actorId: AGENT_KEY,
      target: SCOPE,
      decision: "deny",
      metadata: { capabilityId: capability.id },
    });
    expect(rows[0].reason).toMatch(/deactivated/);
  });

  it("refuses a token stored under the agent's database id, not only its key", async () => {
    const token = await mint(agentRowId);
    await setActive(false);

    expect((await changes(token)).status).toBe(401);
    expect((await decide(agentRowId, token)).allowed).toBe(false);
  });

  it("restores the same token when the agent is reactivated, since nothing was revoked", async () => {
    const token = await mint(AGENT_KEY);
    await setActive(false);
    expect((await changes(token)).status).toBe(401);

    await setActive(true);

    expect((await changes(token)).status).toBe(200);
    expect((await decide(AGENT_KEY, token)).allowed).toBe(true);
  });

  it("leaves other agents' tokens alone, including an agent with no Agent row", async () => {
    const bystander = await mint(BYSTANDER_KEY);
    const unregistered = await mint(UNREGISTERED_AGENT);
    await setActive(false);

    expect((await changes(bystander)).status).toBe(200);
    expect((await decide(BYSTANDER_KEY, bystander)).allowed).toBe(true);
    expect((await changes(unregistered)).status).toBe(200);
    expect((await decide(UNREGISTERED_AGENT, unregistered)).allowed).toBe(true);
  });
});
