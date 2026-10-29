// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A deleted fact leaves the task-start block.
//
// An agent writes two facts on a task; a person, or an agent holding write, deletes one.
// Every new session after that must be served neither the deleted fact as standing nor
// its create as recent run state, while the fact that stayed is still served. Before
// this behaviour the delete removed the stored row, so the fact left the block's
// "facts this task touched" section, and its create, which that section had been
// hiding, came back under "recent writes". The delete's own event carries no summary,
// so it never ranked in beside it: the block announced a fact that no longer existed.
// A person's correction removes the fact the same way, recorded as a supersede, and
// its old version's create must leave the block too.
//
// Real: the hosted MCP endpoint over a socket, check() against live capabilities, the
// write-through store into Postgres, the guarded delete with its change event, and the
// task-start read. A fake memory service answers the embedding call with a fixed
// vector, the graph with nothing, and graph deletes as having nothing to remove; the
// queue is a no-op. Not simulated: the signed-in person's REST route, whose delete is
// the same guardedMemory.removeFact call made here with an agent's write capability.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

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
const ORG = "deleted_fact";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;

const TASK = "WEB-518";
/**
 * The two facts one case writes. Each text names the task, as a writer's note on it does,
 * so its create ranks as a recent write of the task; `n` keeps each case's facts apart.
 */
const factsOfCase = (n: number) => ({
  deleted: { name: `Checkout cache key ${n}`, content: `${TASK}: checkout cache ${n} keys on the cart id alone.` },
  kept: { name: `Checkout cache owner ${n}`, content: `${TASK}: the payments team owns checkout cache ${n}.` },
});

/** A memory service on a real socket: a fixed embedding, an accepted ingest, an empty graph. */
class EmptyGraphMemoryService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const [status, body] = this.handle(req);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(req: IncomingMessage): [number, unknown] {
    req.resume();
    const path = new URL(req.url ?? "/", "http://memory").pathname;
    if (path === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (path === "/ingest") return [200, { episode_id: "ep-1" }];
    if (path === "/search") return [200, { facts: [] }];
    if (path === "/graph") return [200, { nodes: [], edges: [] }];
    if (req.method === "DELETE" && path.startsWith("/chunks/")) return [200, { retired: 0 }];
    if (req.method === "DELETE" && path.startsWith("/facts/")) return [200, { removed: false }];
    return [404, { detail: `no route ${path}` }];
  }
}

describe.skipIf(!QA_URL)("a deleted fact leaves the task-start block of every later session", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let guardedMemory: (typeof import("@/services/memory"))["guardedMemory"];
  let sessions = 0;

  async function mint(agentId: string, scopePath: string): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function connect(agentId: string, scopePath: string): Promise<Client> {
    const token = await mint(agentId, scopePath);
    const client: Client = new ClientClass({ name: agentId, version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    return client;
  }

  /** One tool call's answer and the task-start block it carried ("" for none). */
  async function call(client: Client, name: string, args: Record<string, unknown>, meta: Record<string, string>) {
    const result = await client.callTool({ name, arguments: args, _meta: meta });
    const [answer = "", ...extra] = (result.content as { text?: string }[]).map((part) => part.text ?? "");
    expect(result.isError, answer).toBeFalsy();
    const block =
      extra.find((text) => text.startsWith("Before you start"))?.split("\n\nChanged in your scope")[0] ?? "";
    return { answer, block };
  }

  /** Write one fact on the task as the writer agent; returns the version it stored. */
  async function write(writer: Client, fact: { name: string; content: string }): Promise<string> {
    const { answer } = await call(
      writer,
      "memory_ingest",
      { ...fact, scopePath: WEB },
      { "willder/session": "writer", "willder/task": TASK },
    );
    const version = /Version: (\S+)\./.exec(answer)?.[1];
    if (!version) throw new Error(`no version in: ${answer}`);
    return version;
  }

  /** The block a reader's new session is served: naming the task, or naming none and asking about it. */
  async function firstBlock(reader: Client, namesTask: boolean): Promise<string> {
    const meta: Record<string, string> = { "willder/session": `read-${++sessions}` };
    if (namesTask) meta["willder/task"] = TASK;
    return (await call(reader, "memory_query", { query: `${TASK} checkout cache` }, meta)).block;
  }

  /** Whether `block` shows `versionId` at all: as a standing fact, or as a write of it. */
  const shows = (block: string, versionId: string) => block.includes(versionId);

  /**
   * Delete `versionId` through the guarded store, as `agentId` holding write on `scope`.
   * With `correction`, the delete is a person's edit: the fact is removed and replaced by
   * the corrected text, and the change feed records a supersede rather than a delete.
   */
  async function remove(agentId: string, scope: string, versionId: string, correction?: string): Promise<void> {
    const token = await mint(agentId, scope);
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const { removed } = await guardedMemory.removeFact(ctx, { groupId: ORG, factId: versionId }, scope, correction);
    expect(removed).toBe(true);
  }

  /** Whether `block` lists the create of `versionId` among its recent writes. */
  const showsCreateOf = (block: string, versionId: string) => block.includes(`- create fact ${versionId} `);

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    ({ guardedMemory } = await import("@/services/memory"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  // Each case writes its own pair, so no case depends on another's delete.
  it.each([
    { session: "naming the task", namesTask: true, deleteAt: WEB },
    { session: "naming no task", namesTask: false, deleteAt: WEB },
    // The delete's event is recorded at org root, outside the reader's scope.
    { session: "naming the task, after a delete authorized at org root", namesTask: true, deleteAt: ROOT },
  ])("serves a session $session the kept fact and not the deleted one", async ({ namesTask, deleteAt }) => {
    const n = sessions;
    const writer = await connect(`writer-${n}`, WEB);
    const reader = await connect(`reader-${n}`, WEB);
    const facts = factsOfCase(n);
    const deleted = await write(writer, facts.deleted);
    const kept = await write(writer, facts.kept);

    // The control: before the delete, a new session is shown both.
    const before = await firstBlock(reader, namesTask);
    expect(shows(before, deleted), before).toBe(true);
    expect(shows(before, kept), before).toBe(true);

    await remove(`deleter-${n}`, deleteAt, deleted);

    const after = await firstBlock(reader, namesTask);
    expect(shows(after, deleted), after).toBe(false);
    expect(shows(after, kept), after).toBe(true);
  });

  // A correction removes the stored version as a delete does, so its create must leave
  // the block too. The event it records is a supersede, the op a conflict also records,
  // but a conflict keeps the losing version stored and serves its create marked
  // (mcp/task-start-deleted-fact.realdb.qa.test.ts). The corrected text arrives later,
  // as the create of its own ingest, which the edit route queues; these cases read the
  // block before it lands.
  it.each([
    { session: "naming the task", namesTask: true, correctAt: WEB },
    { session: "naming no task", namesTask: false, correctAt: WEB },
    { session: "naming the task, after a correction authorized at org root", namesTask: true, correctAt: ROOT },
  ])("serves a session $session no create of a corrected fact's old version", async ({ namesTask, correctAt }) => {
    const n = sessions;
    const writer = await connect(`writer-${n}`, WEB);
    const reader = await connect(`reader-${n}`, WEB);
    const facts = factsOfCase(n);
    const corrected = await write(writer, facts.deleted);
    const kept = await write(writer, facts.kept);

    const before = await firstBlock(reader, namesTask);
    expect(shows(before, corrected), before).toBe(true);
    expect(shows(before, kept), before).toBe(true);

    await remove(
      `editor-${n}`,
      correctAt,
      corrected,
      `${TASK}: checkout cache ${n} keys on the cart id and the currency.`,
    );

    const after = await firstBlock(reader, namesTask);
    expect(showsCreateOf(after, corrected), after).toBe(false);
    expect(shows(after, kept), after).toBe(true);
  });
});
