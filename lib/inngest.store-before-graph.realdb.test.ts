// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An ingest job stores and announces its content before any graph step, so a graph that
// fails past the queue's retries cannot lose it.
//
// A person's write is stored by its job, not by the request path, because the entity
// resolver may rewrite it first. A correction's job runs after the fact it corrects was
// removed. The job used to write every graph episode before the text: a graph outage that
// outlasted the retries then lost the correction along with the fact it replaced, and on
// the undistilled path the text landed but was never announced, so the correction was not
// recorded as the fact's replacement.
//
// Real: Postgres, PATCH /api/memory/facts/:id and its check(), ingestMemory's request path,
// the `memoryIngest` job's handler (retried the way the queue retries it: steps that
// finished are not run again) and the inline `runMemoryIngest`, the pgvector store, the
// change feed and lineage. Doubles: the signed-in session, the graph store (it fails when
// a test says so, and records what it was sent), the distiller's model, the entity
// resolver (it returns the text as written), the embedding service, the contradiction
// search, the episode counter, and the queue's send.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** Ingest jobs queued by `after()` (INNGEST_BYPASS), waiting for a test to run them. */
const afterJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
const session = vi.hoisted(() => ({ current: null as unknown }));
const graph = vi.hoisted(() => ({
  /** Graph writes to fail before the graph recovers; Infinity fails all of them. */
  failWrites: 0,
  /** Runs once, inside the first graph write after it is set. */
  onWrite: null as null | (() => Promise<void>),
  /** Every write the graph accepted, as sent. */
  writes: [] as IngestInput[],
  removedChunks: [] as string[],
}));
const distilled = vi.hoisted(() => ({ facts: [] as string[] }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    afterJobs.push(task);
  },
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => session.current }));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  let episodes = 0;
  const write = async (input: IngestInput) => {
    if (graph.onWrite) {
      const hook = graph.onWrite;
      graph.onWrite = null;
      await hook();
    }
    if (graph.failWrites > 0) {
      graph.failWrites -= 1;
      throw new MemoryServiceError("memory service unavailable", 503);
    }
    graph.writes.push(input);
    return `graph-episode-${(episodes += 1)}`;
  };
  const store = {
    ingest: async (input: IngestInput) => ({ episodeId: await write(input) }),
    ingestBulk: async (inputs: IngestInput[]) => {
      const ids: string[] = [];
      for (const input of inputs) ids.push(await write(input));
      return ids;
    },
    removeFact: async () => ({ removed: false }),
    removeChunkFacts: async ({ chunkId }: { chunkId: string }) => {
      graph.removedChunks.push(chunkId);
    },
    findFactById: async () => null,
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    dedupeNodes: async () => 0,
  };
  return { graphitiStore: store, memory: new HybridMemoryStore(store as never, new PgvectorMemoryStore()) };
});
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ facts: distilled.facts, entities: [], attributes: [], decisions: [] }),
              },
            },
          ],
        }),
      },
    },
  }),
}));
vi.mock("@/services/resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/resolver")>()),
  resolveEntities: async (_org: string, _actor: string, text: string) => ({
    resolvedText: text,
    resolutions: [],
    changed: false,
  }),
}));
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: async () => ({ contradiction: null, complete: true }),
}));
vi.mock("@/services/guardrails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/guardrails")>()),
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "storefirst";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const WRITER = "u-storefirst-writer";
const AGENT_FACT = "Escalations go to the on-call engineer.";
const CORRECTION = "Escalations go to the support lead.";
/** What the distiller derives from the correction when a test lets it derive anything. */
const DERIVED = ["The support lead handles escalations.", "Escalations are routed to the support lead."];
/** The queue runs a job once and retries it three times (`memoryIngest`'s `retries: 3`). */
const ATTEMPTS = 4;

type JobStep = { run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T> };
type JobHandler = (ctx: { event: { data: IngestInput }; step: JobStep }) => Promise<unknown>;

describe.skipIf(!QA_URL)("an ingest job stores its text before any graph step", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let runJob: JobHandler;
  let factRoute: typeof import("@/app/api/memory/facts/[id]/route");
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];
  /** Events the request path sent to the queue, waiting for a test to run them. */
  const sent: IngestInput[] = [];

  /**
   * Run one queued event the way the queue does: up to ATTEMPTS attempts, where a step
   * that finished in an earlier attempt returns its recorded result instead of running.
   * Returns whether an attempt succeeded.
   */
  async function runQueued(data: IngestInput): Promise<boolean> {
    const finished = new Map<string, unknown>();
    const step: JobStep = {
      run: async (id, fn) => {
        if (finished.has(id)) return finished.get(id) as never;
        // The queue keeps a step's result as JSON.
        const result = JSON.parse(JSON.stringify((await fn()) ?? null));
        finished.set(id, result);
        return result;
      },
    };
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        await runJob({ event: { data }, step });
        return true;
      } catch {
        // The queue retries the run.
      }
    }
    return false;
  }

  async function drainQueue(): Promise<boolean[]> {
    const outcomes: boolean[] = [];
    while (sent.length > 0) outcomes.push(await runQueued(sent.shift()!));
    return outcomes;
  }

  async function drainAfterJobs(): Promise<void> {
    while (afterJobs.length > 0) await afterJobs.shift()!();
  }

  /** An agent's fact, stored and fully ingested while the graph is up. */
  async function agentWrites(content: string): Promise<string> {
    const ack = await ingestMemory({
      groupId: ORG,
      content,
      name: "Escalations",
      scopePath: DEAL,
      actorType: "agent",
      actorId: "agent-ops",
      actorName: "agent-ops",
      source: "mcp",
      origin: "mcp",
    });
    await drainQueue();
    await drainAfterJobs();
    graph.writes.length = 0;
    return ack.versionId!;
  }

  async function correct(factId: string, fact: string): Promise<number> {
    session.current = {
      org: { id: ORG, name: ORG },
      user: { id: WRITER, name: WRITER },
      ctx: { orgId: ORG, actor: { type: "human", id: WRITER, role: "member" }, origin: "app" } as AccessContext,
    };
    const res = await factRoute.PATCH(
      new Request(`http://t/api/memory/facts/${factId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact, scope: DEAL }),
      }),
      { params: Promise.resolve({ id: factId }) },
    );
    return res.status;
  }

  async function stored(content: string): Promise<string[]> {
    const rows = await db.memoryChunk.findMany({ where: { orgId: ORG, content }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async function served(): Promise<string[]> {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "escalations",
      limit: 50,
      scopePath: DEAL,
    });
    return facts.map((f) => f.fact).sort();
  }

  async function edges(): Promise<string[]> {
    const rows = await db.factEdge.findMany({
      where: { orgId: ORG, kind: "supersedes" },
      select: { fromId: true, toId: true },
    });
    return rows.map((e) => `${e.fromId}>${e.toId}`).sort();
  }

  async function createEvents(recordId: string): Promise<number> {
    return db.changeEvent.count({ where: { orgId: ORG, op: "create", recordId } });
  }

  async function wipe(): Promise<void> {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: WRITER } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const inngestModule = await import("@/lib/inngest");
    ingestMemory = inngestModule.ingestMemory;
    runJob = (inngestModule.memoryIngest as unknown as { fn: JobHandler }).fn;
    const { inngest } = await import("@/lib/inngest/client");
    vi.spyOn(inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      sent.push(event.data);
      return { ids: ["queued"] };
    }) as never);
    factRoute = await import("@/app/api/memory/facts/[id]/route");
    ({ PgvectorMemoryStore } = await import("@/services/memory/pgvector-store"));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await wipe();
      await db.$disconnect();
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    sent.length = 0;
    afterJobs.length = 0;
    Object.assign(graph, { failWrites: 0, onWrite: null, writes: [], removedChunks: [] });
    distilled.facts = [];
    vi.unstubAllEnvs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const deal = await db.scope.create({ data: { orgId: ORG, path: DEAL, name: "deal_a" } });
    await db.user.create({
      data: { id: WRITER, orgId: ORG, email: `${WRITER}@storefirst.test`, role: "member", clerkId: `clerk-${WRITER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: WRITER, permission: "write" },
    });
  });

  /** The correction is served in the fact's place, announced once, and recorded as its replacement. */
  async function expectCorrectionKept(original: string): Promise<string> {
    const versions = await stored(CORRECTION);
    expect(versions).toHaveLength(1);
    expect(await stored(AGENT_FACT)).toEqual([]);
    expect(await served()).toEqual([CORRECTION]);
    expect(await createEvents(versions[0])).toBe(1);
    expect(await edges()).toEqual([`${versions[0]}>${original}`]);
    return versions[0];
  }

  it("a distilled correction whose graph is down through every retry is still served, as the fact's replacement", async () => {
    const original = await agentWrites(AGENT_FACT);
    distilled.facts = DERIVED;
    graph.failWrites = Infinity;

    expect(await correct(original, CORRECTION)).toBe(202);
    expect(await drainQueue()).toEqual([false]);

    await expectCorrectionKept(original);
  });

  it("an undistilled correction whose graph is down through every retry is announced, so it is recorded as the replacement", async () => {
    const original = await agentWrites(AGENT_FACT);
    graph.failWrites = Infinity;

    expect(await correct(original, CORRECTION)).toBe(202);
    expect(await drainQueue()).toEqual([false]);

    await expectCorrectionKept(original);
  });

  it("a correction whose graph recovers on a retry is stored and announced once, and every graph write names its row", async () => {
    const original = await agentWrites(AGENT_FACT);
    distilled.facts = DERIVED;
    graph.failWrites = 2; // the first two attempts each fail at their first graph write

    expect(await correct(original, CORRECTION)).toBe(202);
    expect(await drainQueue()).toEqual([true]);

    const version = await expectCorrectionKept(original);
    // Two distilled facts and the raw episode, each stamped with the row it came from, so
    // a delete of the row retires them and a read can tell them superseded.
    expect(graph.writes.map((w) => [w.content, w.readableId])).toEqual([
      [DERIVED[0], version],
      [DERIVED[1], version],
      [CORRECTION, version],
    ]);
  });

  it("without a queue (INNGEST_BYPASS), a correction whose graph is down is still served, as the fact's replacement", async () => {
    vi.stubEnv("INNGEST_BYPASS", "1");
    const original = await agentWrites(AGENT_FACT);
    distilled.facts = DERIVED;
    graph.failWrites = Infinity;

    expect(await correct(original, CORRECTION)).toBe(202);
    await drainAfterJobs();

    await expectCorrectionKept(original);
    expect(graph.writes).toEqual([]);
  });

  it.each([
    ["the queued job, distilled", false, DERIVED],
    ["the queued job, undistilled", false, []],
    ["the job without a queue, distilled", true, DERIVED],
    ["the job without a queue, undistilled", true, []],
  ])(
    "a row %s stored and that is deleted during its graph steps has those steps' writes retired",
    async (_name, bypass, facts) => {
      if (bypass) vi.stubEnv("INNGEST_BYPASS", "1");
      distilled.facts = facts;
      let deleted: string | undefined;
      graph.onWrite = async () => {
        [deleted] = await stored(CORRECTION);
        await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = ${deleted}`;
      };

      await ingestMemory({
        groupId: ORG,
        content: CORRECTION,
        name: "Escalations",
        scopePath: DEAL,
        actorType: "human",
        actorId: WRITER,
        actorName: WRITER,
        source: "app",
        origin: "app",
      });
      if (bypass) await drainAfterJobs();
      else expect(await drainQueue()).toEqual([true]);

      expect(deleted).toBeDefined();
      expect(graph.removedChunks).toEqual([deleted]);
    },
  );

  it("the job's retry after its text was stored stores and announces nothing twice, for a write the request path did not store", async () => {
    distilled.facts = DERIVED;
    graph.failWrites = 1;

    await ingestMemory({
      groupId: ORG,
      content: CORRECTION,
      name: "Escalations",
      scopePath: DEAL,
      actorType: "human",
      actorId: WRITER,
      actorName: WRITER,
      source: "app",
      origin: "app",
    });
    // Run the same event twice, as a redelivery does: the second run finds the row stored.
    const [event] = sent;
    sent.push({ ...event });
    expect(await drainQueue()).toEqual([true, true]);

    const versions = await stored(CORRECTION);
    expect(versions).toHaveLength(1);
    expect(await createEvents(versions[0])).toBe(1);
  });
});
