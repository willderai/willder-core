// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Revision receipts on memory_query, against a real database.
//
// Everything below runs for real: an MCP client and server over an in-memory
// transport, the real tool registrations, check() against real capability rows, the
// ltree scope filter and the pgvector query. Only the two HTTP calls leave the
// process, the embedding service and the graph memory service, and those are stubbed:
// one fixed embedding, and a graph tier with no facts.
//
// The claims: a caller that sends back the revision it holds gets a short receipt
// instead of the same answer; a write in its scope gives it the full answer again; a
// revoked token or another tenant never gets a receipt for someone else's answer.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
// Skips cleanly without it, and also when memory_chunks has no `embedding` column
// (a database provisioned with `prisma db push` does not carry it).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_revision";
const OTHER_ORG = "qa_revision_other";
/** Scope paths sit under each org's root, `org_<orgId>` (services/access/check.ts). */
const SALES = "org_qa_revision.sales";
const OTHER_SALES = "org_qa_revision_other.sales";
const AGENT = "agent-reader";

/** A query and chunk embedding shaped like production's BGE-384 column. */
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const QUESTION = "what do we know about the Atlas launch?";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

describe.skipIf(!QA_URL)("memory_query revision receipts, against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let hasEmbeddingColumn = false;
  const openClients: Client[] = [];

  async function mintCapability(orgId: string, scopePath: string): Promise<{ id: string; token: string }> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    const { id } = await db.capability.create({
      data: {
        orgId,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { id, token };
  }

  async function connectAs(orgId: string, token: string, scopePath: string): Promise<Client> {
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    const ctx: AccessContext = { orgId, actor: { type: "agent", id: AGENT, capabilityToken: token }, origin: "mcp" };
    registerWillderTools(server, ctx, { orgId, agentId: AGENT, scopePath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  async function chunk(orgId: string, id: string, content: string, scopePath: string): Promise<void> {
    await db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","actorType","actorName","scopePath","embedding")
       VALUES ($1,$2,$3,'human','Dana',$4,$5::vector)`,
      id,
      orgId,
      content,
      scopePath,
      JSON.stringify(EMBEDDING),
    );
  }

  async function ask(client: Client, ifRevision?: string): Promise<ToolResult> {
    return (await client.callTool({
      name: "memory_query",
      arguments: { query: QUESTION, limit: 5, ...(ifRevision ? { ifRevision } : {}) },
    })) as ToolResult;
  }

  const revisionOf = (result: ToolResult) => result._meta?.["willder/revision"] as string | undefined;
  const allText = (result: ToolResult) => result.content.map((c) => c.text).join("\n");

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    // Both outbound services answer from one stub: the embedding service reads
    // `embedding`, the graph memory service's /search reads `facts`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ embedding: EMBEDDING, facts: [] }) })),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const columns = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_chunks' AND column_name = 'embedding'`;
    hasEmbeddingColumn = columns.length > 0;
    ({ registerWillderTools } = await import("./tools"));
  });

  beforeEach(async (context) => {
    if (!hasEmbeddingColumn) context.skip();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  afterAll(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    if (!db) return;
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
    }
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  it("answers in full once, then with a receipt that carries none of the facts", async () => {
    await chunk(ORG, "chunk-atlas-1", "Project Atlas launches on 15 October 2026 after the security review.", SALES);
    await chunk(ORG, "chunk-atlas-2", "The Atlas launch owner is Dana; legal signed off on 28 September.", SALES);
    const { token } = await mintCapability(ORG, SALES);
    const client = await connectAs(ORG, token, SALES);

    const first = await ask(client);
    expect(first.isError, allText(first)).not.toBe(true);
    expect(first.content[0].text).toContain("Project Atlas launches on 15 October 2026");
    expect(first.content[0].text).toContain("legal signed off");
    const held = revisionOf(first);
    expect(held).toMatch(/^[0-9a-f]{16}$/);

    const second = await ask(client, held);
    expect(second._meta?.["willder/unchanged"]).toBe(true);
    expect(allText(second)).not.toContain("Atlas");
    expect(allText(second).length).toBeLessThan(allText(first).length);
    // Both reads were checked and audited; the receipt skips the payload, not the gate.
    const reads = await db.auditLog.count({ where: { orgId: ORG, action: "memory.read", decision: "allow" } });
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("returns the full answer again after a write in the caller's scope", async () => {
    await chunk(ORG, "chunk-atlas-1", "Project Atlas launches on 15 October 2026 after the security review.", SALES);
    const { token } = await mintCapability(ORG, SALES);
    const client = await connectAs(ORG, token, SALES);
    const held = revisionOf(await ask(client));

    await chunk(ORG, "chunk-atlas-3", "Atlas launch moved to 22 October 2026.", SALES);
    const after = await ask(client, held);

    expect(after._meta?.["willder/unchanged"]).toBe(false);
    expect(after.content[0].text).toContain("moved to 22 October 2026");
    expect(revisionOf(after)).not.toBe(held);
  });

  it("denies a revoked token that sends the revision it held, and gives it no receipt", async () => {
    await chunk(ORG, "chunk-atlas-1", "Project Atlas launches on 15 October 2026 after the security review.", SALES);
    const { id, token } = await mintCapability(ORG, SALES);
    const client = await connectAs(ORG, token, SALES);
    const held = revisionOf(await ask(client));

    await db.capability.update({ where: { id }, data: { revokedAt: new Date() } });
    const denied = await ask(client, held);

    expect(denied.isError).toBe(true);
    expect(allText(denied)).toMatch(/^Access denied/);
    expect(allText(denied)).not.toContain("Unchanged");
    expect(revisionOf(denied)).toBeUndefined();
  });

  it("never gives another tenant a receipt for this tenant's answer", async () => {
    await chunk(ORG, "chunk-atlas-1", "Project Atlas launches on 15 October 2026 after the security review.", SALES);
    await chunk(OTHER_ORG, "chunk-other-1", "Project Atlas is a rival codename; no launch date is known.", OTHER_SALES);
    const own = await mintCapability(ORG, SALES);
    const held = revisionOf(await ask(await connectAs(ORG, own.token, SALES)));

    const other = await mintCapability(OTHER_ORG, OTHER_SALES);
    const foreign = await ask(await connectAs(OTHER_ORG, other.token, OTHER_SALES), held);

    expect(foreign._meta?.["willder/unchanged"]).toBe(false);
    expect(foreign.content[0].text).toContain("rival codename");
    expect(foreign.content[0].text).not.toContain("15 October");
  });
});
