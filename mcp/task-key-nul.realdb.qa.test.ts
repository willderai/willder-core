// A task key is a client's hint and never authority, so no value of it may
// cost the write it rides on. Postgres text cannot hold a NUL byte; a `willder/task` value
// carrying one reaches the change event the write is announced by. The fact row is stored
// first (the write-through store), so a failed announcement leaves a version that reads can
// serve but that no change event, applied row or conflict rule ever saw.
//
// Real: the hosted MCP endpoint over a socket, check() against a live capability, the
// write-through store into Postgres. A fake memory service answers embeddings; the
// queue is a no-op. Set QA_DATABASE_URL to an ISOLATED, migrated test database; skips when unset.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

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
const ORG = "qa_task_key_nul";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;

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

describe.skipIf(!QA_URL)("a task key the database cannot store does not cost the write", () => {
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

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    const token = `wcap_test_nul_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "agent-nul",
        tokenHash: hashCapabilityToken(token),
        scopePath: WEB,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    client = new ClientClass({ name: "agent-nul", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await client?.close();
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("announces every stored version of a write whose task key holds a NUL byte", async () => {
    await client.callTool({
      name: "memory_ingest",
      arguments: { name: "Refund owner", content: "Refunds are owned by the payments team.", scopePath: WEB },
      _meta: { "willder/session": "s-nul", "willder/task": "WEB-1\u0000" },
    });
    const stored = await db.memoryChunk.findMany({
      where: { orgId: ORG, entityName: "Refund owner" },
      select: { id: true },
    });
    const announced = await db.changeEvent.findMany({
      where: { orgId: ORG, recordType: "fact", op: "create", recordId: { in: stored.map((row) => row.id) } },
      select: { recordId: true },
    });
    expect(announced.map((event) => event.recordId).sort()).toEqual(stored.map((row) => row.id).sort());
  });
});
