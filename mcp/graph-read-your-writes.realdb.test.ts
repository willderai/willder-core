// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Read-your-writes on the graph path: an agent's very next memory_entity call
// includes the fact it just wrote about that entity, with nothing passed between the two
// calls. Graph extraction is asynchronous, so the server serves the writer's own stored,
// not-yet-extracted version beside what the graph holds
// (services/memory/own-pending-facts.ts). Only the writer gets that; every other reader
// sees the fact once the graph holds it, the way it always has.
//
// Real: the hosted MCP endpoint over a socket, check() against live capabilities, the
// write-through store into Postgres and the overlay's SQL. The memory service is a stand-in
// on a real socket holding one entity. Extraction never runs on its own (the queue is a
// no-op), which is exactly the window this criterion is about; a test that needs the graph
// to have caught up says so with `extract`, which adds the reworded fact stamped with the
// stored version's id, the way the real service stamps an extracted edge.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
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
const ORG = "graphryw";
const ROOT = `org_${ORG}`;
/** The scope the entity's graph partition belongs to. */
const SCOPE = `${ROOT}.ops`;
/** A child scope: a write here is extracted into its own partition, not the entity's. */
const CHILD = `${SCOPE}.north`;
const ENTITY_ID = "ent-kestrel";
const ENTITY_NAME = "Kestrel Logistics";
const SEED_FACT = "Kestrel Logistics runs the north depot in Tromso.";

/** A fact the graph holds about the entity. */
interface HeldFact {
  uuid: string;
  fact: string;
  chunkIds: string[];
}

/** A memory service holding one entity in SCOPE's partition, whose facts the test controls. */
class OneEntityMemoryService {
  private readonly held: HeldFact[] = [{ uuid: "edge-seed", fact: SEED_FACT, chunkIds: [] }];
  private server: Server | null = null;

  /** The graph has caught up on stored version `chunkId`, worded its own way. */
  extract(chunkId: string, wording: string): void {
    this.held.push({ uuid: `edge-${chunkId}`, fact: wording, chunkIds: [chunkId] });
  }

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
    const url = new URL(req.url ?? "/", "http://memory");
    if (url.pathname === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (url.pathname === "/ingest") return [200, { episode_id: "ep-1" }];
    if (url.pathname === "/search") return [200, { facts: [] }];
    if (url.pathname === `/entities/${ENTITY_ID}`) {
      if (url.searchParams.get("group_id") !== toGid(SCOPE)) return [404, { detail: "entity not found" }];
      const facts = this.held.map((f) => ({
        uuid: f.uuid,
        fact: f.fact,
        valid_at: null,
        invalid_at: null,
        expired_at: null,
        chunk_ids: f.chunkIds,
      }));
      return [200, { uuid: ENTITY_ID, name: ENTITY_NAME, type: "Organization", summary: "", facts }];
    }
    return [404, { detail: `no route ${url.pathname}` }];
  }
}

describe.skipIf(!QA_URL)("memory_entity includes the caller's own write before the graph does", () => {
  const service = new OneEntityMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  const tokens = { writer: "", colleague: "" };

  async function mint(agentId: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission,
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  /** One tool call in a session of its own: the tool's own answer, without the notices. */
  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const client: Client = new ClientClass({ name: "graph-read-your-writes", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const result = await client.callTool({ name, arguments: args });
      const texts = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "");
      return { isError: Boolean(result.isError), answer: texts[0] ?? "" };
    } finally {
      await client.close();
    }
  }

  /** memory_ingest as the writer; returns the version id the reply names. */
  async function write(content: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const reply = await callTool(tokens.writer, "memory_ingest", { content, name, scopePath: SCOPE, ...extra });
    expect(reply.isError, reply.answer).toBe(false);
    const versionId = /Version: (\S+)\.$/.exec(reply.answer)?.[1];
    expect(versionId, reply.answer).toBeDefined();
    return versionId!;
  }

  const readEntity = async (token: string) => {
    const read = await callTool(token, "memory_entity", { entityId: ENTITY_ID, scopePath: SCOPE });
    expect(read.isError, read.answer).toBe(false);
    return read.answer;
  };

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    // Extraction never runs: every write stays in the window this criterion is about.
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "ops" } });
    await db.scope.create({ data: { orgId: ORG, path: CHILD, name: "north" } });
    // The entity's seed fact was a direct write stored before episodes carried a chunk stamp,
    // which the graph holds verbatim. A graph fact is served only while a stored source stands
    // behind it (services/memory/graph-fact-sources.ts), so it is stored, with no embedding.
    await db.$executeRaw`INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt") VALUES ('seed-row', ${ORG}, ${SEED_FACT}, 'text', 'human', ${SCOPE}, now())`;
    tokens.writer = await mint("ryw-writer", "write");
    tokens.colleague = await mint("ryw-colleague", "read");
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("the writer's next memory_entity includes the fact it just wrote", async () => {
    const content = "Kestrel Logistics opened a south depot in Bergen.";
    await write(content, "kestrel-south-depot");

    const answer = await readEntity(tokens.writer);

    expect(answer).toContain(SEED_FACT);
    expect(answer).toContain(content);
  });

  it("another agent reading the same scope does not get the writer's not-yet-extracted fact", async () => {
    const content = "Kestrel Logistics hired a depot manager in Stavanger.";
    await write(content, "kestrel-stavanger-hire");

    const answer = await readEntity(tokens.colleague);

    expect(answer).toContain(SEED_FACT);
    expect(answer).not.toContain(content);
  });

  it("a write that does not name the entity is not served on it", async () => {
    const content = "Osprey Freight opened a cold-storage hub in Trondheim.";
    await write(content, "osprey-hub");

    expect(await readEntity(tokens.writer)).not.toContain(content);
  });

  it("a write to another scope's partition is not served on this partition's entity", async () => {
    // The graph extracts a CHILD write into CHILD's own partition, so this entity never
    // holds it; serving it here would show the writer something no read will ever confirm.
    const content = "Kestrel Logistics leases a yard in Narvik.";
    await write(content, "kestrel-narvik-yard", { scopePath: CHILD });

    expect(await readEntity(tokens.writer)).not.toContain(content);
  });

  it("a version the writer has since replaced is not served, its replacement is", async () => {
    const first = "Kestrel Logistics' head office is in Alesund.";
    const second = "Kestrel Logistics' head office is in Molde.";
    const firstVersion = await write(first, "kestrel-head-office");
    await write(second, "kestrel-head-office", { baseVersion: firstVersion });

    const answer = await readEntity(tokens.writer);

    expect(answer).toContain(second);
    expect(answer).not.toContain(first);
  });

  it("once the graph holds the write, the entity shows it once, in the graph's words", async () => {
    const content = "Kestrel Logistics signed a rail contract with Bane NOR.";
    const wording = "Kestrel Logistics has a rail contract with Bane NOR";
    const versionId = await write(content, "kestrel-rail-contract");
    service.extract(versionId, wording);

    const answer = await readEntity(tokens.writer);

    expect(answer).toContain(wording);
    expect(answer).not.toContain(content);
  });

  it("a write older than the extraction window is left to the graph", async () => {
    const content = "Kestrel Logistics retired its Kirkenes route.";
    const versionId = await write(content, "kestrel-kirkenes-route");
    await db.memoryChunk.update({
      where: { id: versionId },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect(await readEntity(tokens.writer)).not.toContain(content);
  });
});
