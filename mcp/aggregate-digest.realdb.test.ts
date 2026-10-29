// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query's aggregate digest (services/memory/aggregate-digest.ts), on a real read: with
// RETRIEVAL_AGGREGATE_DIGEST on, an aggregate question's page is laid out by day under a header,
// every served record keeps its own cited line, a restatement within one day is served once, and
// only rows the guarded read returned appear: a record in a scope the reader cannot read, or one
// deleted, never does. With the flag off, or for a question that is not aggregate, the answer is
// the one memory_query always gave.
//
// Real: Postgres, the MCP route, check(), memory_ingest's write, the pgvector store,
// guardedMemory.removeFact. Doubles: the memory service (a fixed embedding, every graph write
// accepted, no graph facts) and the model.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { RETRIEVAL_AGGREGATE_DIGEST_FLAG } from "@/services/memory/aggregate-digest";

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
const ORG = "aggdigest";
const ROOT = `org_${ORG}`;
const HOBBY = `${ROOT}.hobby`;
const HOBBY_FORGET = `${HOBBY}.forget1`;
const SIBLING = `${ROOT}.other`;

const DIMENSIONS = 384;

const turn = (date: string, user: string) =>
  `Session date: ${date}\n\nuser: ${user}\n\nassistant: That sounds like a fun project. Thanks for telling me about the birdhouses.`;
const FIRST = turn("2024/05/04 (Sat) 10:00", "I built a cedar birdhouse for the wrens this morning.");
const RESTATED = turn("2024/05/04 (Sat) 10:20", "Like I said, I built a cedar birdhouse for the wrens this morning.");
const SECOND = turn("2024/06/15 (Sat) 09:00", "I built a pine birdhouse with my niece today.");
const HIDDEN = turn("2024/06/20 (Thu) 09:00", "I built a walnut birdhouse at the community workshop.");
const DELETED = turn("2024/07/01 (Mon) 09:00", "I built an oak birdhouse for the porch.");
const AGGREGATE = "How many birdhouses have I built?";
const GENERAL = "What wood was the first birdhouse made of?";
const HEADER = /^\d+ records? matching this question/;

/** A memory service on a real socket: a fixed embedding, every graph write and delete accepted, no graph facts. */
class EmptyGraphMemoryService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const path = new URL(req.url ?? "/", "http://memory").pathname;
        const send = (status: number, payload: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
        if (path === "/embed") return send(200, { embedding: new Array(DIMENSIONS).fill(0.01) });
        if (path === "/ingest") return send(200, { episode_id: `ep-${Math.random().toString(36).slice(2)}` });
        if (path === "/search") return send(200, { facts: [] });
        if (req.method === "DELETE" && path.startsWith("/chunks/"))
          return send(200, { removed_facts: 0, removed_episodes: 0 });
        if (req.method === "DELETE" && path.startsWith("/facts/")) return send(404, { detail: "no such fact" });
        if (path === "/graph") return send(200, { nodes: [], edges: [] });
        return send(404, { detail: `no route ${path}` });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  _meta?: Record<string, unknown>;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  _meta?: Record<string, unknown>;
}

describe.skipIf(!QA_URL)("memory_query's aggregate digest, on a real read", { timeout: 60_000 }, () => {
  const service = new EmptyGraphMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let guardedMemory: (typeof import("@/services/memory"))["guardedMemory"];
  let reader = "";
  const writers = new Map<string, string>();
  const baseline: string[] = [];

  async function mint(agentId: string, scopePath: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = new Client({ name: "willder-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    try {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    } finally {
      await client.close();
    }
  }

  async function write(scopePath: string, content: string): Promise<string> {
    if (!writers.has(scopePath)) writers.set(scopePath, await mint(`writer-${scopePath}`, scopePath, "write"));
    const written = await call(writers.get(scopePath)!, "memory_ingest", {
      content,
      scopePath,
      name: `turn ${Math.random().toString(36).slice(2)}`,
    });
    expect(written.isError, JSON.stringify(written.content)).toBeFalsy();
    const row = await db.memoryChunk.findFirstOrThrow({
      where: { orgId: ORG, scopePath, content },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return row.id;
  }

  /** memory_query's own answer up to its revision, the change notices after it left out. */
  function own(result: ToolResult): string {
    const end = result.content.findIndex((c) => c.text?.startsWith("revision: "));
    return result.content
      .slice(0, end < 0 ? undefined : end + 1)
      .map((c) => c.text ?? "")
      .join("\n");
  }

  async function ask(query: string): Promise<string> {
    const result = await call(reader, "memory_query", { query, scopePath: HOBBY, limit: 10 });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return own(result);
  }

  /** The answer's lines up to its first note, its revision and notes left out. */
  function page(answer: string): string[] {
    const lines = answer.split("\n");
    const end = lines.findIndex((l) => l.startsWith("Note:") || l.startsWith("revision: "));
    return lines.slice(0, end < 0 ? undefined : end).filter((l) => l.trim() !== "");
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ guardedMemory } = await import("@/services/memory"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, HOBBY, HOBBY_FORGET, SIBLING])
      await db.scope.create({ data: { orgId: ORG, path, name: path.split(".").at(-1)! } });
    reader = await mint("hobby-reader", HOBBY, "read");
    for (const [scope, text] of [
      [HOBBY, FIRST],
      [HOBBY, RESTATED],
      [HOBBY, SECOND],
      [SIBLING, HIDDEN],
    ] as const)
      baseline.push(await write(scope, text));
  });

  afterEach(async () => {
    if (QA_URL === undefined) return;
    delete process.env[RETRIEVAL_AGGREGATE_DIGEST_FLAG];
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id <> ALL (${baseline}::text[])`;
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("lays an aggregate question's page out by day, each record on its own cited line, a restatement once", async () => {
    process.env[RETRIEVAL_AGGREGATE_DIGEST_FLAG] = "1";
    const lines = page(await ask(AGGREGATE));
    expect(lines[0]).toMatch(HEADER);
    expect(lines[0]).toContain("2 records matching this question on 2 days from 2024-05-04 to 2024-06-15");
    const may = lines.indexOf("2024-05-04 (Sat), 1 record:");
    const june = lines.indexOf("2024-06-15 (Sat), 1 record:");
    expect(may, lines.join("\n")).toBeGreaterThan(0);
    expect(june).toBeGreaterThan(may);
    const bullets = lines.filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(2);
    for (const b of bullets) expect(b).toMatch(/ — from: .* · version \S+$/);
    // The one May conversation said it twice: whichever record ranked first is served, the other not.
    expect(lines[may + 1]).toContain("I built a cedar birdhouse for the wrens this morning.");
    expect(lines.join("\n").match(/cedar birdhouse/g)).toHaveLength(1);
    expect(lines[june + 1]).toContain("I built a pine birdhouse with my niece today.");
  });

  it("never serves a record of a scope the reader cannot read, nor one deleted, which it served before", async () => {
    process.env[RETRIEVAL_AGGREGATE_DIGEST_FLAG] = "1";
    expect(await ask(AGGREGATE)).not.toContain("walnut");
    const id = await write(HOBBY_FORGET, DELETED);
    expect(await ask(AGGREGATE)).toContain("oak birdhouse");
    const deleter = {
      orgId: ORG,
      actor: { type: "agent" as const, id: `writer-${HOBBY_FORGET}`, capabilityToken: writers.get(HOBBY_FORGET)! },
      origin: "mcp" as const,
    };
    expect((await guardedMemory.removeFact(deleter, { groupId: ORG, factId: id }, HOBBY_FORGET)).removed).toBe(true);
    const after = await ask(AGGREGATE);
    expect(after).not.toContain("oak birdhouse");
    expect(after).toMatch(HEADER);
  });

  it("makes the read it always made with the flag off", async () => {
    const retrieve = vi.spyOn(guardedMemory, "retrieve");
    try {
      const answer = await ask(AGGREGATE);
      expect(answer).not.toMatch(HEADER);
      expect(answer).toContain("Like I said, I built a cedar birdhouse");
      expect(answer).toContain("I built a cedar birdhouse for the wrens this morning.");
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve.mock.calls[0]![3]).toEqual({ checkNamedValues: true });
    } finally {
      retrieve.mockRestore();
    }
  });

  it("answers a question that is not aggregate to the byte with the flag on and off", async () => {
    const off = await ask(GENERAL);
    process.env[RETRIEVAL_AGGREGATE_DIGEST_FLAG] = "1";
    expect(await ask(GENERAL)).toBe(off);
  });
});
