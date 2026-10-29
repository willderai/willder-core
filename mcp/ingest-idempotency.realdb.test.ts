// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_ingest with an idempotency key, against a real database: unit tests, a few rows
// each, one rule per test. The workflow at volume (six agents, timed-out calls retried
// through the hosted endpoint) is mcp/ingest-retry-workflow.realdb.test.ts.
//
// The claim under test: a caller that retries a memory_ingest call with the same
// idempotencyKey gets one memory, however the retries arrive (one after another or all
// at once), and a call that reuses a key for a different write is refused. The key is
// scoped to the calling agent in its org, so other agents and other orgs are unaffected.
//
// The store keeps its own replay protection keyed on the content (services/memory/
// ingest-content-key.ts), but only on the request path's immediate store write. When that
// write fails, the ingest is queued and every retry queues another job, each of which
// stores the note again. These tests run in exactly that state: the embedding service
// refuses, so the immediate store write never happens, and the queued jobs counted here
// are the memories that would be written. Only the key can keep that path to one write.
//
// Real: the MCP client and server over an in-memory transport, the registered tool and its
// input schema, check() against minted capability rows, and Postgres. Doubles: the graph
// store, the episode cap, the queue (it counts jobs) and the embedding service (it refuses).
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL,
// which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { IngestInput } from "@/types/memory";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-ingest-idempotency";
const OTHER_ORG = "org-ingest-idempotency-other";
const SCOPE = "org_ingest.idempotency";
const WRITER = "agent-ingest-writer";
const OTHER_WRITER = "agent-ingest-other-writer";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const renewal = { content: "Acme renewed its contract for 2027.", name: "Acme Corp", scopePath: SCOPE };

describe.skipIf(!QA_URL)("memory_ingest with an idempotency key, against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  /** Every job the queue accepted, in order: each one stores its note when it runs. */
  let jobs: IngestInput[];
  /** Replaces the queue's send for one test; the default accepts at once. */
  let send: (input: IngestInput) => Promise<void>;
  const openClients: Client[] = [];

  async function connectAs(agentId: string, orgId = ORG): Promise<Client> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId, agentId, scopePath: SCOPE },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  const ingest = async (client: Client, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name: "memory_ingest", arguments: args })) as ToolResult;

  /** A reply's own text, without the change notices a later call may append. */
  const replyText = (result: ToolResult) => result.content[0]?.text ?? "";

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    // The embedding service refuses, so the request path's immediate store write fails
    // and every accepted ingest is queued (see the file header).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      await send(event.data);
      jobs.push(event.data);
      return { ids: [`job-${jobs.length}`] };
    }) as never);
    ({ registerWillderTools } = await import("./tools"));
  });

  afterAll(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    jobs = [];
    send = async () => undefined;
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });
  });

  it("a call retried three times with one key writes once, and every retry gets the first reply", async () => {
    const writer = await connectAs(WRITER);
    const replies = [];
    for (let i = 0; i < 3; i++) replies.push(await ingest(writer, { ...renewal, idempotencyKey: "renewal-1" }));

    expect(replies.map((r) => r.isError ?? false)).toEqual([false, false, false]);
    expect(replyText(replies[1]!)).toBe(replyText(replies[0]!));
    expect(replyText(replies[2]!)).toBe(replyText(replies[0]!));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ content: renewal.content, name: renewal.name, scopePath: SCOPE });
  });

  it("calls with one key arriving together write once; each other call gets the first reply or is told to retry", async () => {
    // The first call to reach the queue is held there, so every other call arrives while
    // that write is still in flight: the window a check-then-insert lets through.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered = 0;
    send = async () => {
      entered += 1;
      await held;
    };
    const writer = await connectAs(WRITER);
    const calls = Array.from({ length: 5 }, () => ingest(writer, { ...renewal, idempotencyKey: "renewal-burst" }));
    await vi.waitFor(() => expect(entered).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const replies = await Promise.all(calls);

    expect(jobs).toHaveLength(1);
    const stored = replies.filter((r) => !r.isError);
    expect(stored.length).toBeGreaterThan(0);
    for (const reply of stored) expect(replyText(reply)).toBe(replyText(stored[0]!));
    for (const reply of replies.filter((r) => r.isError)) {
      expect(replyText(reply)).toMatch(/idempotencyKey .*still in progress.*retry/i);
    }
  });

  it("refuses a key reused for a different write, names the fix, and writes nothing for it", async () => {
    const writer = await connectAs(WRITER);
    const first = await ingest(writer, { ...renewal, idempotencyKey: "renewal-2" });
    const reused = await ingest(writer, {
      ...renewal,
      content: "Acme cancelled its contract.",
      idempotencyKey: "renewal-2",
    });

    expect(first.isError ?? false).toBe(false);
    expect(reused.isError).toBe(true);
    expect(replyText(reused)).toMatch(/idempotencyKey .*different write.*new idempotencyKey/i);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.content).toBe(renewal.content);
  });

  it("refuses the same key with the same note in another scope or of another kind", async () => {
    const writer = await connectAs(WRITER);
    await ingest(writer, { ...renewal, idempotencyKey: "renewal-3" });
    const elsewhere = await ingest(writer, { ...renewal, scopePath: `${SCOPE}.deal_a`, idempotencyKey: "renewal-3" });
    const asRule = await ingest(writer, { ...renewal, kind: "decision", idempotencyKey: "renewal-3" });

    expect(elsewhere.isError).toBe(true);
    expect(asRule.isError).toBe(true);
    expect(jobs).toHaveLength(1);
  });

  it("refuses the same key with another event time, and replays one that names the same instant", async () => {
    const writer = await connectAs(WRITER);
    const first = await ingest(writer, {
      ...renewal,
      occurredAt: "2026-03-13T08:00:00-07:00",
      idempotencyKey: "renewal-dated",
    });
    const sameInstant = await ingest(writer, {
      ...renewal,
      occurredAt: "2026-03-13T15:00:00Z",
      idempotencyKey: "renewal-dated",
    });
    const otherDay = await ingest(writer, {
      ...renewal,
      occurredAt: "2026-03-14T15:00:00Z",
      idempotencyKey: "renewal-dated",
    });
    const undated = await ingest(writer, { ...renewal, idempotencyKey: "renewal-dated" });

    expect(first.isError ?? false).toBe(false);
    expect(replyText(sameInstant)).toBe(replyText(first));
    expect(otherDay.isError).toBe(true);
    expect(undated.isError).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.occurredAt).toBe("2026-03-13T15:00:00.000Z");
  });

  it("treats different keys as different writes", async () => {
    const writer = await connectAs(WRITER);
    await ingest(writer, { ...renewal, idempotencyKey: "renewal-a" });
    await ingest(writer, { ...renewal, content: "Acme opened an office in Lyon.", idempotencyKey: "renewal-b" });

    expect(jobs.map((job) => job.content)).toEqual([renewal.content, "Acme opened an office in Lyon."]);
  });

  it("keeps one agent's key from answering for another agent or another org", async () => {
    const writer = await connectAs(WRITER);
    const otherAgent = await connectAs(OTHER_WRITER);
    const otherOrg = await connectAs(WRITER, OTHER_ORG);
    const replies = [
      await ingest(writer, { ...renewal, idempotencyKey: "shared-key" }),
      await ingest(otherAgent, { ...renewal, content: "Acme moved its renewal to Q3.", idempotencyKey: "shared-key" }),
      await ingest(otherOrg, { ...renewal, content: "Globex renewed for 2027.", idempotencyKey: "shared-key" }),
    ];

    expect(replies.map((r) => r.isError ?? false)).toEqual([false, false, false]);
    expect(jobs.map((job) => [job.groupId, job.actorId])).toEqual([
      [ORG, WRITER],
      [ORG, OTHER_WRITER],
      [OTHER_ORG, WRITER],
    ]);
  });

  it("frees the key when the write fails, so the retry writes", async () => {
    send = async () => {
      throw new Error("queue unavailable");
    };
    const writer = await connectAs(WRITER);
    const failed = await ingest(writer, { ...renewal, idempotencyKey: "renewal-4" });
    send = async () => undefined;
    const retried = await ingest(writer, { ...renewal, idempotencyKey: "renewal-4" });

    expect(failed.isError).toBe(true);
    expect(retried.isError ?? false).toBe(false);
    expect(jobs).toHaveLength(1);
  });

  it("refuses a retry once the agent's write access is gone, though the key was claimed", async () => {
    const writer = await connectAs(WRITER);
    await ingest(writer, { ...renewal, idempotencyKey: "renewal-7" });
    await db.capability.updateMany({ where: { orgId: ORG, agentId: WRITER }, data: { permission: "read" } });
    const retried = await ingest(writer, { ...renewal, idempotencyKey: "renewal-7" });

    expect(retried.isError).toBe(true);
    expect(replyText(retried)).toMatch(/^Access denied/);
    expect(jobs).toHaveLength(1);
  });

  it("keeps a write that outlived its lease from freeing the key a retry took over", async () => {
    // The first attempt is still writing when its lease ends, as it can be on a host that
    // enforces no maxDuration. A retry takes the key over, and while that retry is still
    // writing, the first attempt fails. Each of the first two writes waits at the queue.
    const gates: { release: () => void; fail: (e: Error) => void }[] = [];
    send = () =>
      gates.length < 2
        ? new Promise<void>((resolve, reject) => gates.push({ release: resolve, fail: reject }))
        : Promise.resolve();
    const writer = await connectAs(WRITER);
    const outlived = ingest(writer, { ...renewal, idempotencyKey: "renewal-5" });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    await db.memoryIngestKey.updateMany({
      where: { orgId: ORG },
      data: { claimedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const takeover = ingest(writer, { ...renewal, idempotencyKey: "renewal-5" });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]!.fail(new Error("queue unavailable"));
    expect((await outlived).isError).toBe(true);

    // The retry still holds the key, so a third call is told to wait instead of writing.
    const third = await ingest(writer, { ...renewal, idempotencyKey: "renewal-5" });
    expect(third.isError).toBe(true);
    expect(replyText(third)).toMatch(/still in progress/);

    gates[1]!.release();
    expect((await takeover).isError ?? false).toBe(false);
    expect(jobs).toHaveLength(1);
  });

  it("stores no content with the key, only a digest of the request", async () => {
    const writer = await connectAs(WRITER);
    await ingest(writer, { ...renewal, idempotencyKey: "renewal-6" });
    const row = await db.memoryIngestKey.findFirstOrThrow({ where: { orgId: ORG } });

    expect(JSON.stringify(row)).not.toContain(renewal.content);
    expect(row).toMatchObject({ orgId: ORG, actorType: "agent", actorId: WRITER, key: "renewal-6" });
  });
});
