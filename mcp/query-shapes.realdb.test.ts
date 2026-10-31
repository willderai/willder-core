// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query's answer shapes (services/memory/query-shapes.ts), on a real read: with
// RETRIEVAL_QUERY_SHAPES on, an advice question is also served the user's stated preferences as a
// labelled block, taken only from what a guarded read of the reader's own scope returned. So a
// preference turn that was erased, deleted or written in a scope the reader cannot read never
// appears in the block. With the flag off, memory_query makes the one read it always made.
//
// Real: Postgres, the MCP route, check(), memory_ingest's write, the pgvector store, the person
// erasure's suppression list, guardedMemory.removeFact. Doubles: the memory service (a fixed
// embedding, every graph write accepted, no graph facts) and the model.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { PREFERENCE_BLOCK_LABEL, RETRIEVAL_QUERY_SHAPES_FLAG } from "@/services/memory/query-shapes";
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
const ORG = "queryshapes";
const ROOT = `org_${ORG}`;
const PREFS = `${ROOT}.prefs`;
const PREFS_FORGET = `${PREFS}.forget1`;
const SIBLING = `${ROOT}.other`;

const DIMENSIONS = 384;
const VECTOR = `[${new Array(DIMENSIONS).fill(0.01).join(",")}]`;

const turn = (date: string, user: string) =>
  `Session date: ${date}\n\nuser: ${user}\n\nassistant: That sounds lovely. Thanks for telling me about your dinner plans.`;
const KEPT = turn("2023/04/02 (Sun) 18:00", "I love Thai food for dinner, and my favorite dish is a green curry.");
const ERASED = turn(
  "2023/04/03 (Mon) 18:00",
  "Dana Whitfield here. I really like the sushi dinner at Nobu on Fridays.",
);
const DELETED = turn("2023/04/04 (Tue) 18:00", "I usually order a ramen dinner from Ippudo.");
const HIDDEN = turn("2023/04/05 (Wed) 18:00", "I prefer a taco dinner from Taqueria Rosa.");
const ADVICE = "What should I order for dinner tonight?";
const AGGREGATE = "How many dinner places have I mentioned?";
const GENERAL = "Where does the green curry come from?";

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

describe.skipIf(!QA_URL)("memory_query's preference block, on a real read", { timeout: 60_000 }, () => {
  const service = new EmptyGraphMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let guardedMemory: (typeof import("@/services/memory"))["guardedMemory"];
  let erasure: typeof import("@/services/memory/erasure-suppression");
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

  async function insertChunk(scopePath: string, content: string): Promise<string> {
    const id = `c-${Math.random().toString(36).slice(2)}`;
    await db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', 'seed', $4, $5::vector, $6::timestamp)`,
      id,
      ORG,
      content,
      scopePath,
      VECTOR,
      new Date(Date.now() - 60_000).toISOString().replace("Z", ""),
    );
    return id;
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
    const result = await call(reader, "memory_query", { query, scopePath: PREFS, limit: 10 });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return own(result);
  }

  /** The labelled block of an answer, or "" when it has none. */
  function block(answer: string): string {
    const at = answer.indexOf(PREFERENCE_BLOCK_LABEL);
    return at < 0 ? "" : answer.slice(at, answer.indexOf("\n\n", at));
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
    erasure = await import("@/services/memory/erasure-suppression");
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, PREFS, PREFS_FORGET, SIBLING])
      await db.scope.create({ data: { orgId: ORG, path, name: path.split(".").at(-1)! } });
    reader = await mint("prefs-reader", PREFS, "read");
    baseline.push(await write(PREFS, KEPT), await write(SIBLING, HIDDEN));
  });

  afterEach(async () => {
    if (QA_URL === undefined) return;
    delete process.env[RETRIEVAL_QUERY_SHAPES_FLAG];
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id <> ALL (${baseline}::text[])`;
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("serves the user's stated preference as a labelled block, and never a sibling scope's", async () => {
    process.env[RETRIEVAL_QUERY_SHAPES_FLAG] = "1";
    const answer = await ask(ADVICE);
    expect(answer.startsWith(PREFERENCE_BLOCK_LABEL), answer).toBe(true);
    expect(block(answer)).toContain("I love Thai food for dinner, and my favorite dish is a green curry.");
    expect(answer).not.toContain("Taqueria Rosa");
  });

  it("never serves an erased preference turn in the block, which it served before the erasure", async () => {
    process.env[RETRIEVAL_QUERY_SHAPES_FLAG] = "1";
    await insertChunk(PREFS, ERASED);
    // The control: before the erasure the reader may read it, and the block carries it.
    expect(block(await ask(ADVICE))).toContain("Nobu");
    await erasure.recordSuppressions(db, ORG, "erasure-request-1", {
      emails: [],
      names: ["Dana Whitfield"],
      contactIds: [],
    });
    await erasure.markApplied(db, ORG, "test", { entries: (await erasure.listEntriesAsOf(ORG)).entries });
    const after = await ask(ADVICE);
    expect(after).not.toContain("Nobu");
    expect(after).not.toContain("Dana Whitfield");
    expect(block(after)).toContain("green curry");
  });

  it("never serves a deleted preference turn in the block, which it served before the delete", async () => {
    process.env[RETRIEVAL_QUERY_SHAPES_FLAG] = "1";
    const id = await write(PREFS_FORGET, DELETED);
    expect(block(await ask(ADVICE))).toContain("Ippudo");
    const deleter = {
      orgId: ORG,
      actor: { type: "agent" as const, id: `writer-${PREFS_FORGET}`, capabilityToken: writers.get(PREFS_FORGET)! },
      origin: "mcp" as const,
    };
    expect((await guardedMemory.removeFact(deleter, { groupId: ORG, factId: id }, PREFS_FORGET)).removed).toBe(true);
    expect(await ask(ADVICE)).not.toContain("Ippudo");
  });

  it("makes the one read it always made with the flag off, for every shape of question", async () => {
    const retrieve = vi.spyOn(guardedMemory, "retrieve");
    try {
      for (const query of [ADVICE, AGGREGATE, GENERAL]) {
        retrieve.mockClear();
        const answer = await ask(query);
        expect(answer).not.toContain(PREFERENCE_BLOCK_LABEL);
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(retrieve.mock.calls[0]![3]).toEqual({ checkNamedValues: true });
      }
    } finally {
      retrieve.mockRestore();
    }
  });

  it("answers a question of no shape to the byte with the flag on and off", async () => {
    const off = await ask(GENERAL);
    process.env[RETRIEVAL_QUERY_SHAPES_FLAG] = "1";
    expect(await ask(GENERAL)).toBe(off);
  });
});
