// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A read that one store could not answer says so, on memory_query and on
// POST /api/memory/query, instead of passing for a complete answer.
//
// Everything is real except the memory service: the note is written through the hosted
// MCP endpoint (app/api/mcp/route.ts) over a socket, pgvector's SQL runs against
// Postgres, and the graph and embedding calls cross a real HTTP socket to a fake
// memory service. The fake fails the way the hosted one does when it is down
// ("Application failed to respond", HTTP 502), for as many calls as a test arms it to:
// /search failing is the graph store failing; /embed failing on a read is the vector
// store failing, because a vector read embeds the question first.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
// The stand-in graph's facts here have no stored rows behind them, and this file is about
// what a read says when a store fails, not about which facts a stored source supports: the serve-time source check
// (services/memory/graph-fact-sources.ts) supports them all. It is proven against real rows in
// services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
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
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "degradedread";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.clinic`;
const ADMIN = "u-degraded-read-admin";
const CHILD = `${SCOPE}.radiology`;
const NOTE = "Elena's imaging appointment moved to Friday at 3:10 PM in suite B.";
const CHILD_NOTE = "Radiology confirmed suite B for the Friday scan.";
/** What the fake graph answers for a note written under `name`. */
const graphFact = (name: string) => `Graph fact about ${name}`;
const GRAPH_FACT = graphFact("Imaging");
const CHILD_GRAPH_FACT = graphFact("Suite");
/** Graphiti's partition for a scope path. */
const QUESTION = "When is the imaging appointment and where?";
const OUTAGE = { status: "error", code: 502, message: "Application failed to respond" };

/**
 * A memory service on a real socket that can be told to fail its next calls, or its
 * next searches of one partition.
 */
class FlakyMemoryService {
  /** The graph fact each partition answers with, from the note written there. */
  readonly facts = new Map<string, string>();
  readonly calls = { search: 0, embed: 0 };
  readonly failNext = { search: 0, embed: 0 };
  readonly failSearchOf = new Map<string, number>();
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const [status, payload] = this.answer(new URL(req.url ?? "/", "http://memory").pathname, body);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private answer(path: string, body: { group_id?: string; name?: string }): [number, unknown] {
    if (path === "/embed") {
      this.calls.embed++;
      if (this.failNext.embed > 0 && this.failNext.embed--) return [502, OUTAGE];
      return [200, { embedding: new Array(384).fill(0.01) }];
    }
    const group = body.group_id ?? "";
    if (path === "/ingest") {
      this.facts.set(group, graphFact(body.name ?? ""));
      return [200, { episode_id: `ep-${this.facts.size}` }];
    }
    if (path === "/search") {
      this.calls.search++;
      if (this.failNext.search > 0 && this.failNext.search--) return [502, OUTAGE];
      const failsLeft = this.failSearchOf.get(group) ?? 0;
      if (failsLeft > 0) {
        this.failSearchOf.set(group, failsLeft - 1);
        return [502, OUTAGE];
      }
      const fact = this.facts.get(group);
      const facts = fact
        ? [
            {
              uuid: `edge-${group}`,
              fact,
              valid_at: null,
              invalid_at: null,
              expired_at: null,
              actor_type: "agent",
              group_id: group,
            },
          ]
        : [];
      return [200, { facts }];
    }
    return [404, { detail: `no route ${path}` }];
  }
}

describe.skipIf(!QA_URL)("a read one store could not answer says so", () => {
  const service = new FlakyMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let reader: string;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let queryRoute: (typeof import("@/app/api/memory/query/route"))["POST"];

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

  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const client: Client = new ClientClass({ name: "degraded-read", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const result = await client.callTool({ name, arguments: args });
      // The tool's own answer. Each call here is a new connection, so a new session, and its
      // reply also carries the task-start block, which may name the very writes a degraded
      // search leaves out (mcp/connection-session.ts).
      const text = (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? "")
        .filter((part) => !part.startsWith("Before you start"))
        .join("\n");
      return { isError: Boolean(result.isError), text };
    } finally {
      await client.close();
    }
  }

  const memoryQuery = () => callTool(reader, "memory_query", { query: QUESTION, scopePath: SCOPE });

  async function restQuery(): Promise<{ facts: { fact: string }[]; degraded?: string[] }> {
    const res = await queryRoute(
      new Request("http://localhost/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUESTION, scope: SCOPE }),
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    // Run the queued graph write inline, so the note reaches the graph fake too.
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      await inngestModule.runMemoryIngest(event.data);
      return { ids: ["job"] };
    }) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    ({ POST: queryRoute } = await import("@/app/api/memory/query/route"));
    const mcp = await (await import("./http-test-server")).startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "clinic" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@degraded-read.test", role: "admin", clerkId: "clerk-degraded-read" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: await db.user.findUnique({ where: { id: ADMIN } }),
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
    reader = await mint("degraded-reader", "read");

    // The clinic scope has one registered scope below it, so a read of the clinic asks
    // the graph twice: once for the clinic, once for radiology.
    await db.scope.create({ data: { orgId: ORG, path: CHILD, name: "radiology" } });
    const writer = await mint("degraded-writer", "write");
    for (const [content, name, scopePath] of [
      [NOTE, "Imaging", SCOPE],
      [CHILD_NOTE, "Suite", CHILD],
    ]) {
      const write = await callTool(writer, "memory_ingest", { content, name, scopePath });
      expect(write.isError, write.text).toBe(false);
    }
  });

  beforeEach(() => {
    service.failSearchOf.clear();
    service.failNext.search = 0;
    service.failNext.embed = 0;
    service.calls.search = 0;
    service.calls.embed = 0;
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.$disconnect();
  });

  it("answers from both stores with no note, asking each store once per scope, when both answer", async () => {
    const read = await memoryQuery();

    expect(read.isError, read.text).toBe(false);
    for (const expected of [GRAPH_FACT, CHILD_GRAPH_FACT, NOTE, CHILD_NOTE]) expect(read.text).toContain(expected);
    expect(read.text).not.toMatch(/search was incomplete/i);
    expect(service.calls).toEqual({ search: 2, embed: 1 });
    expect(await restQuery()).not.toHaveProperty("degraded");
  });

  it("says the graph store did not answer when it fails twice for the scope asked, and still serves the rest", async () => {
    service.failSearchOf.set(toGid(SCOPE), 2);
    const read = await memoryQuery();

    expect(read.isError, read.text).toBe(false);
    for (const expected of [CHILD_GRAPH_FACT, NOTE, CHILD_NOTE]) expect(read.text).toContain(expected);
    expect(read.text).not.toContain(GRAPH_FACT);
    expect(read.text).toMatch(/^Note: search was incomplete: the graph store did not answer/m);

    service.failSearchOf.set(toGid(SCOPE), 2);
    const rest = await restQuery();
    expect(rest.degraded).toEqual(["graph"]);
    expect(rest.facts.map((f) => f.fact)).not.toContain(GRAPH_FACT);
  });

  it("says the graph store did not answer when it fails only for a scope below the one asked", async () => {
    service.failSearchOf.set(toGid(CHILD), 2);
    const read = await memoryQuery();

    for (const expected of [GRAPH_FACT, NOTE, CHILD_NOTE]) expect(read.text).toContain(expected);
    expect(read.text).not.toContain(CHILD_GRAPH_FACT);
    expect(read.text).toMatch(/^Note: search was incomplete: the graph store did not answer/m);

    service.failSearchOf.set(toGid(CHILD), 2);
    expect((await restQuery()).degraded).toEqual(["graph"]);
  });

  it("says the vector store did not answer when it fails twice, and still serves the graph store's answer", async () => {
    service.failNext.embed = 2;
    const read = await memoryQuery();

    expect(read.isError, read.text).toBe(false);
    for (const expected of [GRAPH_FACT, CHILD_GRAPH_FACT]) expect(read.text).toContain(expected);
    for (const missing of [NOTE, CHILD_NOTE]) expect(read.text).not.toContain(missing);
    expect(read.text).toMatch(/^Note: search was incomplete: the vector store did not answer/m);
    expect(service.calls.embed).toBe(2);

    service.failNext.embed = 2;
    const rest = await restQuery();
    expect(rest.degraded).toEqual(["semantic"]);
    expect(rest.facts.map((f) => f.fact).sort()).toEqual([GRAPH_FACT, CHILD_GRAPH_FACT].sort());
  });

  it("answers in full with no note when each store fails once and then answers", async () => {
    service.failNext.search = 1;
    service.failNext.embed = 1;
    const read = await memoryQuery();

    for (const expected of [GRAPH_FACT, CHILD_GRAPH_FACT, NOTE, CHILD_NOTE]) expect(read.text).toContain(expected);
    expect(read.text).not.toMatch(/search was incomplete/i);
    expect(service.calls).toEqual({ search: 3, embed: 2 });
  });

  it("asks a store that is down twice for the scope asked and once for each scope below it, not twice for every scope", async () => {
    service.failNext.search = 100;
    const read = await memoryQuery();

    expect(read.text).toMatch(/^Note: search was incomplete: the graph store did not answer/m);
    expect(service.calls.search).toBe(3);
  });
});
