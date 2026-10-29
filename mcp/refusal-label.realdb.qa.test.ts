// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// get_my_brief is the MCP entry point where the scope check()
// authorizes against is resolved by the SERVER (the brief's own scopePath) from
// an id the caller sent. Two tenants, two scopes, real check() against Postgres:
// a permitted read still answers, a forbidden one refuses without naming the
// brief's scope label, and a brief in another tenant is answered exactly like an
// id that was never issued.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-label-a";
const ORG_B = "org-qa-label-b";
const SUBJECT_LABEL = "Northwind_Holdings";
const A_PUBLIC = "org_a.public";
const A_SECRET = `org_a.${SUBJECT_LABEL}`;
const B_SECRET = `org_b.${SUBJECT_LABEL}`;
const AGENT = "agent-qa-label";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("get_my_brief refusals against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  const clients: Client[] = [];

  async function mint(orgId: string, scopePath: string): Promise<string> {
    const token = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function connect(orgId: string, scopePath: string): Promise<Client> {
    const token = await mint(orgId, scopePath);
    const server = new McpServer({ name: "qa", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId, actor: { type: "agent", id: AGENT, capabilityToken: token }, origin: "mcp" },
      { orgId, agentId: AGENT, scopePath },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "qa-client", version: "0.0.0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  const brief = (orgId: string, scopePath: string, title: string) =>
    db.brief.create({ data: { orgId, type: "handoff", scopePath, title, summary: "s", sections: [] } });

  const getBrief = async (client: Client, briefId: string) =>
    (await client.callTool({ name: "get_my_brief", arguments: { briefId } })) as ToolResult;

  const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
  });

  afterAll(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    for (const orgId of [ORG_A, ORG_B]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.brief.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  it("still answers a brief inside the caller's scope", async () => {
    const client = await connect(ORG_A, A_PUBLIC);
    const { id } = await brief(ORG_A, A_PUBLIC, "Public handoff");

    const result = await getBrief(client, id);

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Public handoff");
  });

  it("refuses a same-tenant brief outside the caller's scope exactly like an id never issued, and records it", async () => {
    const client = await connect(ORG_A, A_PUBLIC);
    const { id } = await brief(ORG_A, A_SECRET, "Acquisition plan");

    const result = await getBrief(client, id);
    const row = await db.auditLog.findFirst({
      where: { orgId: ORG_A, decision: "deny" },
      orderBy: { at: "desc" },
    });
    const absent = await getBrief(client, "brief-never-issued");

    expect(text(result)).not.toContain(SUBJECT_LABEL);
    expect(text(result)).not.toContain("Acquisition plan");
    expect(result.isError).toBe(absent.isError);
    expect(text(result).replace(id, "<id>")).toBe(text(absent).replace("brief-never-issued", "<id>"));

    expect(row?.reason).toContain(A_SECRET);
    expect(row?.target).toContain(A_SECRET);
  });

  it("answers another tenant's brief id exactly like one never issued", async () => {
    const client = await connect(ORG_A, A_PUBLIC);
    const { id } = await brief(ORG_B, B_SECRET, "Other tenant plan");

    const foreign = text(await getBrief(client, id));
    const absent = text(await getBrief(client, "brief-never-issued"));

    expect(foreign).not.toContain(SUBJECT_LABEL);
    expect(foreign).not.toContain("Other tenant plan");
    expect(foreign.replace(id, "<id>")).toBe(absent.replace("brief-never-issued", "<id>"));
  });
});
