// Storage errors never reach an MCP client as database text. Postgres cannot store a NUL
// byte, so a NUL in any argument that reaches a query fails inside the driver; before
// this test the client was sent that failure verbatim ("Invalid `prisma.$queryRaw()`
// invocation ... invalid byte sequence for encoding "UTF8": 0x00"), which names
// internals and no fix. Every registered tool is called with a NUL in the argument
// that reaches storage, and every reply must be the shared plain-words error.
//
// Real: the hosted MCP endpoint over a socket, check() against a live capability,
// Postgres. A fake memory service answers embeddings; the queue is a no-op. Set
// QA_DATABASE_URL to an ISOLATED, migrated test database; skips when unset.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NO_DRIFT, toolListDrift } from "./tool-list-drift.testsupport";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "mcp_storage_errors";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;
const NUL = "\u0000";

/** Each registered tool, with arguments whose NUL byte reaches a database query. */
const NUL_ARGS: Record<string, Record<string, unknown>> = {
  memory_ingest: { name: `Refund${NUL} owner`, content: "Refunds are owned by payments.", scopePath: WEB },
  memory_query: { query: `refunds${NUL}` },
  memory_entity: { entityId: `entity${NUL}` },
  memory_version: { versionId: `version${NUL}` },
  memory_changes: { scopePath: `${WEB}${NUL}` },
  memory_note: { kind: "status", task: "refunds", body: `halfway${NUL}` },
  get_my_brief: { briefId: `brief${NUL}` },
  // Falls back to the token's scope, as every read does with a malformed one, so no NUL reaches a query.
  memory_stale: { scopePath: `${WEB}${NUL}` },
  fact_link_source: { graphitiFactUuid: `fact${NUL}`, sourceType: "pr", sourceRef: "owner/repo#1" },
  contact_search: { query: `acme${NUL}` },
  contact_read: { contactId: `contact${NUL}` },
  contact_upsert: { idempotencyKey: `key${NUL}`, name: "Ada", email: "ada@example.com" },
  send_feedback: { kind: "bug", message: `broken${NUL}` },
};

/** What a database or driver failure looks like when it leaks. */
const STORAGE_TEXT = /prisma|\$queryRaw|invalid byte sequence|UTF8|0x00|SQLSTATE|22021|P20\d\d|DriverAdapter/i;

function replyText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
}

/** A memory service on a real socket: a fixed embedding, an accepted ingest, an empty graph. */
class EmptyGraphMemoryService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ([status, body]) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
        (e: unknown) => res.writeHead(500).end(String(e)),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    req.resume();
    const path = new URL(req.url ?? "/", "http://memory").pathname;
    if (path === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (path === "/ingest") return [200, { episode_id: "ep-1" }];
    if (path === "/search") return [200, { facts: [] }];
    if (path === "/graph") return [200, { nodes: [], edges: [] }];
    return [404, { detail: `no route ${path}` }];
  }
}

describe.skipIf(!QA_URL)("MCP tools answer storage errors in plain words", () => {
  const service = new EmptyGraphMemoryService();
  let db: PrismaClient;
  let client: Client;
  let closeMcp: () => Promise<void>;

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    const { Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport: Transport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    const token = `wcap_test_storage_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "agent-storage",
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    client = new ClientClass({ name: "agent-storage", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await client?.close();
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("covers every registered tool", async () => {
    const { tools } = await client.listTools();
    expect(
      toolListDrift(
        tools.map((tool) => tool.name),
        Object.keys(NUL_ARGS),
      ),
    ).toEqual(NO_DRIFT);
  });

  it.each(Object.entries(NUL_ARGS))("%s answers a NUL byte without database text", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = replyText(result);
    expect(text).not.toMatch(STORAGE_TEXT);
    if (result.isError) expect(text).toMatch(/^Access denied: |^invalid_input: .*NUL/);
  });

  it("refuses a NUL in the fact name with a reply that names the fix, and stores nothing", async () => {
    const result = await client.callTool({ name: "memory_ingest", arguments: NUL_ARGS.memory_ingest });
    expect(result.isError).toBe(true);
    expect(replyText(result)).toMatch(/^invalid_input: .*NUL \(\\u0000\).*remove/i);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses a NUL in the content with a reply that names the fix, and queues and stores nothing", async () => {
    const send = vi.mocked((await import("@/lib/inngest")).inngest.send);
    send.mockClear();
    const result = await client.callTool({
      name: "memory_ingest",
      arguments: { name: "Refund owner", content: `Refunds are owned${NUL} by payments.`, scopePath: WEB },
    });
    expect(replyText(result)).toMatch(/^invalid_input: .*NUL \(\\u0000\).*remove/i);
    expect(result.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses a NUL in the idempotency key, which fails in the driver rather than the query engine", async () => {
    const result = await client.callTool({
      name: "memory_ingest",
      arguments: {
        name: "Refund owner",
        content: "Refunds are owned by payments.",
        scopePath: WEB,
        idempotencyKey: `retry-1${NUL}`,
      },
    });
    expect(result.isError).toBe(true);
    expect(replyText(result)).toMatch(/^invalid_input: .*NUL/);
  });
});
