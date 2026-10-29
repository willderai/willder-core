// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A retried write as an MCP client meets it: a memory_ingest call times out on the client,
// and the client retries it with the same idempotencyKey while the first attempt is still
// running on the server. The client is a scripted SDK client that always sends a key; it
// stands in for an agent whose MCP client does, not for a model choosing to.
//
// The workflow: six agents, each with its own capability token and its own MCP client,
// write ten notes each, all agents at once, through the hosted endpoint
// (app/api/mcp/route.ts) over a real socket. The embedding service is in a partial outage:
// every request takes 800 ms and then fails, so the request path's own content-keyed store
// write never happens and each accepted call is queued, the path a retry duplicated on
// before the key. Every note's first call gives up after 300 ms. The client then sends two
// retries of it at once, which race each other and the first attempt, and repeats that
// until one succeeds. Pass: every note gets a success reply, every reply to one note is the
// same, and each note is queued exactly once (60 of 60), with the org's episode count at 60.
//
// Failures exercised: duplicate work (a retried call is the same work, not new work) and
// concurrent writes of one note (retries racing each other and the in-flight original).
//
// Real: the MCP SDK client and its request timeout, the hosted route and its bearer-token
// resolution, the registered tool, check(), the episode cap, the request path's store
// attempt against a real HTTP embedding server, and Postgres. Not simulated: the queue
// (it counts jobs instead of running graph extraction), the graph store, serverless
// function death mid-write (covered by the lease takeover case in
// mcp/ingest-idempotency.realdb.test.ts), and network partitions between the route and
// the database.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { IngestInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

// Letters only: the org id becomes an ltree label in its root scope path.
const ORG = "ingestRetryWorkflow";
const SCOPE = `org_${ORG}.notes`;
const AGENTS = ["writer-1", "writer-2", "writer-3", "writer-4", "writer-5", "writer-6"];
const NOTES_PER_AGENT = 10;
const EMBEDDING_DELAY_MS = 800;
const FIRST_CALL_TIMEOUT_MS = 300;
const RETRY_TIMEOUT_MS = 10_000;
const RETRY_PAUSE_MS = 100;

interface ToolReply {
  isError: boolean;
  text: string;
}

/** An embedding service in a partial outage: every request is slow, then fails. */
function startFailingEmbeddingService(): Promise<Server> {
  const server = createServer((req, res) => {
    req.resume();
    setTimeout(() => res.writeHead(503, { "content-type": "application/json" }).end("{}"), EMBEDDING_DELAY_MS);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe.skipIf(!QA_URL)("an MCP client retrying timed-out memory_ingest calls with one key per note", () => {
  let db: PrismaClient;
  let embedding: Server;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  const jobs: IngestInput[] = [];
  const clients: Client[] = [];

  async function connect(agentId: string): Promise<Client> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const client = new ClientClass({ name: `retrying-${agentId}`, version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, args: Record<string, unknown>, timeout: number): Promise<ToolReply> {
    const result = await client.callTool({ name: "memory_ingest", arguments: args }, undefined, { timeout });
    const content = result.content as { type: string; text?: string }[];
    return { isError: Boolean(result.isError), text: content[0]?.text ?? "" };
  }

  /**
   * One note, written the way a retrying client writes it: a first call that times out,
   * then two concurrent retries with the same key until one succeeds. Returns every reply
   * the client saw, in order, and every error message other than the first call's timeout.
   */
  async function writeWithRetries(client: Client, args: Record<string, unknown>) {
    const firstCall = await call(client, args, FIRST_CALL_TIMEOUT_MS).then(
      () => "answered",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    const errors: string[] = [];
    for (let round = 0; round < 50; round++) {
      const replies = await Promise.all([call(client, args, RETRY_TIMEOUT_MS), call(client, args, RETRY_TIMEOUT_MS)]);
      errors.push(...replies.filter((r) => r.isError).map((r) => r.text));
      const stored = replies.filter((r) => !r.isError);
      if (stored.length > 0) return { firstCall, stored, errors };
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
    throw new Error(`no retry of ${String(args.idempotencyKey)} succeeded; errors: ${errors.join(" | ")}`);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    embedding = await startFailingEmbeddingService();
    const address = embedding.address();
    if (!address || typeof address === "string") throw new Error("embedding service did not bind");
    // Read at import by the pgvector store, so set before the route is imported.
    process.env.GRAPHITI_SERVICE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      jobs.push(event.data);
      return { ids: [`job-${jobs.length}`] };
    }) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await new Promise((resolve) => embedding?.close(resolve));
    await db?.org.deleteMany({ where: { id: ORG } });
    await db?.$disconnect();
  });

  it("queues each of 60 notes once, and every retry of a note gets the same success reply", async () => {
    const outcomes = await Promise.all(
      AGENTS.map(async (agentId) => {
        const client = await connect(agentId);
        const perNote = [];
        for (let n = 0; n < NOTES_PER_AGENT; n++) {
          const args = {
            content: `${agentId} note ${n}: the renewal call moved to Thursday.`,
            name: `Renewal ${n}`,
            scopePath: SCOPE,
            idempotencyKey: `${agentId}-note-${n}`,
          };
          perNote.push({ agentId, content: args.content, ...(await writeWithRetries(client, args)) });
        }
        return perNote;
      }),
    );
    const notes = outcomes.flat();

    expect(notes).toHaveLength(AGENTS.length * NOTES_PER_AGENT);
    // The workflow really happened: the first call of every note timed out on the client.
    expect(notes.filter((note) => /timed out/i.test(note.firstCall))).toHaveLength(notes.length);
    for (const note of notes) {
      for (const reply of note.stored) expect(reply.text, note.content).toBe(note.stored[0]!.text);
      for (const error of note.errors) expect(error, note.content).toMatch(/idempotencyKey is still in progress/);
    }
    const queuedPerNote = new Map<string, number>();
    for (const job of jobs)
      queuedPerNote.set(`${job.actorId}|${job.content}`, (queuedPerNote.get(`${job.actorId}|${job.content}`) ?? 0) + 1);
    expect(jobs).toHaveLength(notes.length);
    for (const note of notes) expect(queuedPerNote.get(`${note.agentId}|${note.content}`), note.content).toBe(1);
    expect((await db.org.findUniqueOrThrow({ where: { id: ORG } })).episodeCount).toBe(notes.length);
  }, 120_000);
});
