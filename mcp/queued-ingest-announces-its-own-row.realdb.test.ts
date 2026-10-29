// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A write stored once, under the id of the row that holds it, however the request path
// failed: by its ingest job when the embedding failed, by the agent's second call when the
// transaction that stores and announces it failed.
//
// memory_ingest stores the content in pgvector and announces it before it replies. When
// the embedding service refuses, the write is queued instead, and its ingest job stores and
// announces it. When the transaction that stores and announces the row fails, nothing
// landed: the write is refused as not stored, and the agent sends it again. The job must keep the request path's guarantees: one row per content
// (services/memory/ingest-content-key.ts), and an announcement that names that row, which
// is the version memory_version reads and the conflict rule (services/memory/conflict.ts)
// settles. A row another writer already announced is not announced again.
//
// Real: Postgres, the MCP tool handlers, check() against live capabilities, the
// request-path store and announcement, the ingest job (runMemoryIngest), the hybrid store
// and pgvector's SQL. Doubles: the embedding service (one fixed vector; it refuses when a
// test says so), the request path's announcement (it fails once when a test says so, as a
// dropped connection would, inside the transaction that stores the row), the distiller's
// model and the graph service (it accepts writes and finds nothing). Not simulated: the queued Inngest run of
// the job, and a job retried by the queue after a partial run.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";

/** Ingest jobs queued by `after()`, in queue order, waiting for a test to run them. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** How many of the next calls of each kind fail. */
const failNext = vi.hoisted(() => ({ embeddings: 0, announcements: 0, acknowledgements: 0, caps: 0 }));

// A transaction whose COMMIT reached the database but whose acknowledgement was lost, as when
// the connection drops right after it: the work is stored, and the caller is told it failed.
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  const transaction = real.db.$transaction.bind(real.db) as (...args: unknown[]) => Promise<unknown>;
  const db = new Proxy(real.db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const result = await transaction(...args);
        if (typeof args[0] === "function" && failNext.acknowledgements > 0) {
          failNext.acknowledgements -= 1;
          throw new Error("Connection terminated unexpectedly");
        }
        return result;
      };
    },
  });
  return { ...real, db };
});
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    queuedJobs.push(task);
  },
}));
vi.mock("@/services/memory/fact-change-event", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/memory/fact-change-event")>();
  return {
    ...real,
    announcedOnStore: (...args: Parameters<typeof real.announcedOnStore>) => {
      const announce = real.announcedOnStore(...args);
      return async (...announceArgs: Parameters<typeof announce>) => {
        if (failNext.announcements > 0) {
          failNext.announcements -= 1;
          throw new Error("Connection terminated unexpectedly");
        }
        return announce(...announceArgs);
      };
    },
  };
});
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const nothing = async () => null;
  let episodes = 0;
  const graph = {
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: IngestInput[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    entity: nothing,
    graph: async () => ({ nodes: [], edges: [] }),
    removeFact: async () => ({ removed: false }),
    removeEntity: async () => ({ removed: false }),
    transferEntity: async () => ({ transferred: 0 }),
    findFactById: nothing,
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async ({ messages }: { messages: { role: string; content: string }[] }) => {
          const written = messages.find((m) => m.role === "user")!.content;
          const distilled = {
            facts: [`The plan states that ${written}.`],
            entities: [],
            attributes: [],
            decisions: [],
          };
          return { choices: [{ message: { content: JSON.stringify(distilled) } }] };
        },
      },
    },
  }),
}));
vi.mock("@/services/guardrails", () => ({
  // The free plan's cap, refusing the next write when a test says so.
  checkEpisodeCap: async () => {
    if (failNext.caps > 0) {
      failNext.caps -= 1;
      throw new Error("the free plan's cap of stored writes is used up");
    }
  },
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "queuedingest";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)("a write the request path could not store or announce is stored and announced once", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];

  async function toolsFor(agentId: string): Promise<Tools> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "write",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const tools: Tools = new Map();
    const server = {
      registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath: ROOT });
    return tools;
  }
  const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
  const ingest = (tools: Tools, content: string, name: string) =>
    tools.get("memory_ingest")!({ content, name, scopePath: SCOPE });
  async function runQueuedJobs(): Promise<void> {
    for (const job of queuedJobs.splice(0)) await job();
  }

  /** The stored rows that hold `content`. */
  async function rowsHolding(content: string): Promise<string[]> {
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} AND content = ${content}`;
    return rows.map((row) => row.id);
  }
  /** The ids the change feed announced `content` under. */
  async function announcedIds(content: string): Promise<string[]> {
    const events = await db.changeEvent.findMany({
      where: { orgId: ORG, recordType: "fact", op: "create", summary: content },
      orderBy: { seq: "asc" },
      select: { recordId: true },
    });
    return events.map((event) => event.recordId);
  }
  /** What memory_version says of a version: its status, or null when it finds no version by that id. */
  async function statusOf(reader: Tools, versionId: string): Promise<string | null> {
    const reply = await reader.get("memory_version")!({ versionId });
    return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(textOf(reply))?.[1] ?? null;
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    // No queue: each write's job is handed to `after()`, as in a deployment without one.
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    ({ registerWillderTools } = await import("@/mcp/tools"));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });
  beforeEach(async () => {
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => {
        if (failNext.embeddings > 0) {
          failNext.embeddings -= 1;
          return new Response("embedding service unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }));
      });
    queuedJobs.length = 0;
    failNext.embeddings = 0;
    failNext.announcements = 0;
    failNext.acknowledgements = 0;
    failNext.caps = 0;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("announces the row its job stored when the embedding service refused the request path", async () => {
    const [writer, reader] = [await toolsFor("writer-a"), await toolsFor("reader")];
    const note = "Release train: the release train leaves on Monday";

    failNext.embeddings = 1;
    const reply = await ingest(writer, note, "Release train");
    await runQueuedJobs();

    expect(textOf(reply)).toMatch(/Queued for ingest/);
    const rows = await rowsHolding(note);
    expect(rows).toHaveLength(1);
    expect(await announcedIds(note)).toEqual(rows);
    expect(await statusOf(reader, rows[0]!)).toBe("current");
  }, 30_000);

  it("refuses a write whose announcement failed, having stored nothing, and stores it once when sent again", async () => {
    const [writer, reader] = [await toolsFor("writer-a"), await toolsFor("reader")];
    const note = "Release train: the release train leaves on Tuesday";

    failNext.announcements = 1;
    const reply = await ingest(writer, note, "Release train");
    await runQueuedJobs();

    // The row and its announcement commit together, so a failed announcement stored nothing,
    // and nothing was queued to store it later.
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toMatch(
      /^not_stored: "Release train" in \S+ was not stored: the database failed while storing it\./,
    );
    expect(await rowsHolding(note)).toEqual([]);

    await ingest(writer, note, "Release train");
    const rows = await rowsHolding(note);
    expect(rows).toHaveLength(1);
    expect(await announcedIds(note)).toEqual(rows);
    expect(await statusOf(reader, rows[0]!)).toBe("current");
  }, 30_000);

  it.each([
    {
      failure: "its transaction failed",
      why: "the database failed while storing it",
      setUp: async () => void (failNext.announcements = 1),
    },
    {
      failure: "it was refused before it was stored",
      why: "the free plan's cap of stored writes is used up",
      setUp: async () => void (failNext.caps = 1),
    },
  ])(
    "keeps one rule recorded when its fact copy was not stored because $failure, and the copy alone can be sent",
    async ({ why, setUp }) => {
      const writer = await toolsFor("writer-a");
      const rule = "Release train: deploys leave only on Tuesdays";
      await setUp();

      const reply = await writer.get("memory_ingest")!({
        content: rule,
        name: "Release train",
        scopePath: SCOPE,
        kind: "decision",
      });

      expect(reply.isError).not.toBe(true);
      expect(textOf(reply)).toMatch(/^Recorded decision \S+;/);
      expect(textOf(reply)).toContain(`the fact copy of its text that memory_query searches was not stored (${why}`);
      expect(textOf(reply)).toContain("Do not send this call again: it would record the rule a second time.");
      expect(await db.convention.count({ where: { orgId: ORG } })).toBe(1);
      expect(await rowsHolding(rule)).toEqual([]);
    },
    30_000,
  );

  it("stores a rule's failed copy when it is sent alone, as the reply says, without a second rule", async () => {
    const writer = await toolsFor("writer-a");
    const rule = "Release train: deploys leave only on Tuesdays";
    failNext.announcements = 1;
    await writer.get("memory_ingest")!({ content: rule, name: "Release train", scopePath: SCOPE, kind: "decision" });

    const copy = await ingest(writer, rule, "Release train");

    expect(textOf(copy)).toContain("Stored and readable now");
    expect(await rowsHolding(rule)).toHaveLength(1);
    expect(await db.convention.count({ where: { orgId: ORG } })).toBe(1);
  }, 30_000);

  it("leaves a write to its queued job, not answered as not stored, when the database cannot say whether it committed", async () => {
    const writer = await toolsFor("writer-a");
    const note = "Release train: the release train leaves on Friday";
    const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
    const realLookup = PgvectorMemoryStore.prototype.storedVersionOf;
    // The first lookup is the request path's replay check; the second asks, after the failed
    // transaction, whether the version was stored, and the database does not answer.
    const lookup = vi
      .spyOn(PgvectorMemoryStore.prototype, "storedVersionOf")
      .mockImplementationOnce(function (this: InstanceType<typeof PgvectorMemoryStore>, input) {
        return realLookup.call(this, input);
      })
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    failNext.acknowledgements = 1;
    const reply = await ingest(writer, note, "Release train");
    lookup.mockRestore();

    expect(reply.isError).not.toBe(true);
    expect(textOf(reply)).toMatch(/Queued for ingest/);
    expect(queuedJobs).toHaveLength(1);
    await runQueuedJobs();
    expect(await rowsHolding(note)).toHaveLength(1);
    expect(await announcedIds(note)).toHaveLength(1);
  }, 30_000);

  it("does not answer a write whose transaction committed as not stored, and its job still runs", async () => {
    const [writer, reader] = [await toolsFor("writer-a"), await toolsFor("reader")];
    const note = "Release train: the release train leaves on Thursday";

    failNext.acknowledgements = 1;
    const reply = await ingest(writer, note, "Release train");

    // The version and its announcement committed; only the acknowledgement was lost.
    expect(reply.isError).not.toBe(true);
    expect(textOf(reply)).toMatch(/Queued for ingest/);
    expect(queuedJobs).toHaveLength(1);
    await runQueuedJobs();
    const rows = await rowsHolding(note);
    expect(rows).toHaveLength(1);
    expect(await announcedIds(note)).toEqual(rows);
    expect(await statusOf(reader, rows[0]!)).toBe("current");
  }, 30_000);

  it("does not store or announce again a note another writer already stored and announced", async () => {
    const [a, b] = [await toolsFor("writer-a"), await toolsFor("writer-b")];
    const note = "Release train: the release train leaves on Wednesday";
    await ingest(a, note, "Release train");
    await runQueuedJobs();
    const fromA = await rowsHolding(note);

    failNext.embeddings = 1;
    await ingest(b, note, "Release train");
    await runQueuedJobs();

    expect(fromA).toHaveLength(1);
    expect(await rowsHolding(note)).toEqual(fromA);
    expect(await announcedIds(note)).toEqual(fromA);
  }, 30_000);

  it("stores and announces each of thirty notes once, under its own row, while a third of write-throughs fail each way", async () => {
    // Three agents write to one scope while the embedding service and the database each
    // drop one request in three, cycled write by write.
    const writers = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("writer-c")];
    const reader = await toolsFor("reader");
    const failures = ["embedding refused", "announcement failed", "none"] as const;
    const notes: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const failure = failures[i % failures.length];
      if (failure === "embedding refused") failNext.embeddings = 1;
      if (failure === "announcement failed") failNext.announcements = 1;
      const note = `Release note ${i}: car ${i} of the release train is ready`;
      notes.push(note);
      const writer = writers[i % writers.length]!;
      // A write refused as not stored is sent again, as its agent is told to.
      if ((await ingest(writer, note, `Release car ${i}`)).isError) await ingest(writer, note, `Release car ${i}`);
      await runQueuedJobs();
    }

    let duplicateRows = 0;
    let announcedElsewhere = 0;
    let unreadable = 0;
    for (const note of notes) {
      const rows = await rowsHolding(note);
      duplicateRows += rows.length - 1;
      const announced = await announcedIds(note);
      announcedElsewhere += announced.filter((id) => !rows.includes(id)).length;
      if (announced.length !== 1 || (await statusOf(reader, announced[0]!)) !== "current") unreadable += 1;
    }

    console.log(
      `of 30 notes: ${duplicateRows} duplicate rows, ${announcedElsewhere} announcements naming no stored row, ${unreadable} notes not readable by their announced id`,
    );
    expect({ duplicateRows, announcedElsewhere, unreadable }).toEqual({
      duplicateRows: 0,
      announcedElsewhere: 0,
      unreadable: 0,
    });
  }, 120_000);
});
