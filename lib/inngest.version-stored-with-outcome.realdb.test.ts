// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A fact version and its outcome become readable together.
//
// The stale write-back race: A reads a fact, B writes a new version, and A writes
// back from its stale read without naming a version. The product decides A's write-back
// lost (superseded by B's) when it announces it, under the org's change-feed lock
// (services/memory/fact-change-event.ts). The row used to be stored in one transaction
// and announced in a second, so between the two it was a committed version with nothing
// retiring it: every read served A's stale value as current beside B's. The gap lasted
// as long as the announcement waited for the lock, which any other write in the org can
// hold, and when the announcement failed, until the queued job announced the row.
//
// When that transaction cannot finish (it outlives its time limit waiting on the lock), it
// rolls back and the writer is told the write was not stored and why, with or without a
// queue; a queued write whose job cannot store it fails the job with the same reason.
//
// Each race here holds the lock the way a concurrent write does while A's write-back is
// in flight, and reads the fact through memory_version and memory_query meanwhile. A also
// reads B's version while its own write-back waits, as a parallel tool call would: that read
// came after A wrote, so it must not make A's write-back an informed update of B's.
//
// Real: Postgres, the memory_ingest, memory_query and memory_version tool handlers,
// check() against live capabilities, the request-path store and announcement, the
// winner and stale-read rules, the queued ingest job (run when the test says, as
// `after()` runs it), pgvector's SQL. Doubles: the embedding service (a deterministic
// bag-of-words vector, so a fact's own text is its closest match) and the graph service
// (accepts writes, finds nothing).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";

/** Ingest jobs queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** How many of the next embedding calls the memory service refuses. */
const refuseEmbeddings = vi.hoisted(() => ({ next: 0 }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    queuedJobs.push(task);
  },
}));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const nothing = async () => null;
  let episodes = 0;
  const graph = {
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: unknown[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    entity: nothing,
    graph: async () => ({ nodes: [], edges: [] }),
    removeFact: async () => ({ removed: false }),
    findFactById: nothing,
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
  createLLMClient: () => ({
    chat: {
      completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }) },
    },
  }),
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "versionwithoutcome";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;
const RACES = 100;
/** Longer than an interactive transaction may stay open (Prisma's default, 5 s). */
const PAST_TRANSACTION_TIMEOUT_MS = 6_000;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

/** One bucket per word, normalized, so a text's own words are its closest match. */
function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
    vector[hash] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}

describe.skipIf(!QA_URL)("a fact version and its outcome become readable together", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let lockOrgChangeFeed: (typeof import("@/services/memory/change-events"))["lockOrgChangeFeed"];
  let inngest: (typeof import("@/lib/inngest/client"))["inngest"];
  let memoryIngest: (typeof import("@/lib/inngest/memory-ingest"))["memoryIngest"];
  let VersionNotStoredError: (typeof import("@/services/memory/pgvector-store"))["VersionNotStoredError"];

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
  const versionIn = (reply: string) => /Version: (\S+?)\./.exec(reply)?.[1];
  async function runQueuedJobs(): Promise<void> {
    for (const job of queuedJobs.splice(0)) await job();
  }

  /** What `reader` is told of `versionId`: current, superseded or retired; null when not found. */
  async function statusOf(reader: Tools, versionId: string): Promise<string | null> {
    const reply = await reader.get("memory_version")!({ versionId });
    return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(textOf(reply))?.[1] ?? null;
  }

  /**
   * Hold the org's change-feed lock, as another write in the org does while it announces,
   * until `release` is called. Resolves once the lock is held.
   */
  async function holdOrgLock(): Promise<{ release: () => Promise<void> }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await lockOrgChangeFeed(tx, ORG);
        held();
        await released;
      },
      { timeout: 60_000 },
    );
    await isHeld;
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  }

  /** Resolves when a session of this test's database waits on an advisory lock, or `settled` does first. */
  async function blockedOnLock(settled: Promise<unknown>): Promise<boolean> {
    let done = false;
    void settled.finally(() => (done = true));
    while (!done) {
      const [{ waiting }] = await db.$queryRaw<[{ waiting: bigint }]>`
        SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
      `;
      if (Number(waiting) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  /** What a reader is served, now, of the versions stored under `name` with `text`. */
  async function servedNow(reader: Tools, name: string, text: string): Promise<{ current: number; queried: boolean }> {
    const rows = await db.memoryChunk.findMany({
      where: { orgId: ORG, entityName: name, content: text },
      select: { id: true },
    });
    let current = 0;
    for (const { id } of rows) if ((await statusOf(reader, id)) === "current") current += 1;
    const answer = textOf(await reader.get("memory_query")!({ query: text, scopePath: SCOPE, limit: 10 }));
    return { current, queried: answer.split("\n").some((line) => line.startsWith("•") && line.includes(text)) };
  }

  /** A seeds a fact, A and B read it, B writes a new version. Returns B's version and A's stale write-back text. */
  async function upToTheWriteBack(tools: { a: Tools; b: Tools }, race: number) {
    const name = `Release train ${race}`;
    const text = (day: string) => `Release train ${race} leaves on ${day}`;
    const ingest = (agent: Tools, content: string) => agent.get("memory_ingest")!({ content, name, scopePath: SCOPE });
    await ingest(tools.a, text("Monday"));
    await tools.a.get("memory_query")!({ query: text("Monday"), scopePath: SCOPE, limit: 10 });
    await tools.b.get("memory_query")!({ query: text("Monday"), scopePath: SCOPE, limit: 10 });
    const bVersion = versionIn(textOf(await ingest(tools.b, text("Tuesday"))));
    if (!bVersion) throw new Error(`race ${race}: B's write was not stored`);
    return {
      name,
      bVersion,
      staleText: text("Wednesday"),
      writeBack: () => ingest(tools.a, text("Wednesday")),
      aReadsB: () => tools.a.get("memory_query")!({ query: text("Tuesday"), scopePath: SCOPE, limit: 10 }),
    };
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (refuseEmbeddings.next > 0) {
          refuseEmbeddings.next -= 1;
          return new Response("embedding service unavailable", { status: 503 });
        }
        const { text } = JSON.parse(String(init?.body)) as { text: string };
        return new Response(JSON.stringify({ embedding: embed(text) }));
      }),
    );
    ({ registerWillderTools } = await import("@/mcp/tools"));
    ({ lockOrgChangeFeed } = await import("@/services/memory/change-events"));
    ({ inngest } = await import("@/lib/inngest/client"));
    ({ memoryIngest } = await import("@/lib/inngest/memory-ingest"));
    ({ VersionNotStoredError } = await import("@/services/memory/pgvector-store"));
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });
  beforeEach(async () => {
    queuedJobs.length = 0;
    refuseEmbeddings.next = 0;
    vi.stubEnv("INNGEST_BYPASS", "1");
    vi.spyOn(inngest, "send")
      .mockClear()
      .mockResolvedValue({ ids: ["job"] } as never);
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it(`serves no stale write-back as current while its announcement waits, in ${RACES} races`, async () => {
    const tools = { a: await toolsFor("writer-a"), b: await toolsFor("writer-b") };
    const reader = await toolsFor("reader");
    const leaks: string[] = [];
    const lost: number[] = [];
    let exercised = 0;
    // A race whose write-back reached the pre-store check more than the contention window
    // after B's write is refused before it stores anything, so it never waits on the lock
    // and tests nothing here: it is not counted, and another race runs in its place.
    for (let race = 1; exercised < RACES && race <= 2 * RACES; race += 1) {
      const { name, bVersion, staleText, writeBack, aReadsB } = await upToTheWriteBack(tools, race);
      const lock = await holdOrgLock();
      const back = writeBack();
      const waited = await blockedOnLock(back);
      if (waited) {
        exercised += 1;
        await aReadsB();
        const during = await servedNow(reader, name, staleText);
        if (during.current > 0 || during.queried)
          leaks.push(`race ${race}: current ${during.current}, served by memory_query ${during.queried}`);
      }
      await lock.release();
      await back;
      await runQueuedJobs();
      const after = await servedNow(reader, name, staleText);
      if ((await statusOf(reader, bVersion)) !== "current" || after.current > 0 || after.queried) lost.push(race);
    }

    expect(exercised).toBe(RACES);
    expect(leaks).toEqual([]);
    expect(lost).toEqual([]);
  }, 600_000);

  /** Run `write` while another write holds the org's lock past the write's transaction time limit. */
  async function pastTheTimeLimit<T>(write: () => Promise<T>): Promise<T> {
    const lock = await holdOrgLock();
    const result = write().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    // Usually the write waits on the lock until its transaction expires. Under heavy load it
    // can instead fail to start its transaction at all; either way it ran out of time.
    await blockedOnLock(result);
    await new Promise((resolve) => setTimeout(resolve, PAST_TRANSACTION_TIMEOUT_MS));
    await lock.release();
    const settled = await result;
    if ("error" in settled) throw settled.error;
    return settled.value;
  }
  const storedRows = (content: string) => db.memoryChunk.count({ where: { orgId: ORG, content } });

  it.each([
    { queue: "without a queue (INNGEST_BYPASS, the self-host default)", bypass: "1" },
    { queue: "with the Inngest queue", bypass: "" },
  ])(
    "refuses a write its transaction could not finish, says it was not stored, and queues nothing, $queue",
    async ({ bypass }) => {
      vi.stubEnv("INNGEST_BYPASS", bypass);
      const writer = await toolsFor("writer-a");
      const write = { content: "Release train 1 leaves on Monday", name: "Release train 1", scopePath: SCOPE };

      const reply = await pastTheTimeLimit(() => writer.get("memory_ingest")!(write));

      expect(reply.isError).toBe(true);
      expect(textOf(reply)).toMatch(
        /^not_stored: "Release train 1" in org_versionwithoutcome\.release was not stored: the database did not finish storing it in time\. Nothing of it was kept\. Send the same call again to store it\./,
      );
      expect(await storedRows(write.content)).toBe(0);
      expect(queuedJobs).toEqual([]);
      expect(inngest.send).not.toHaveBeenCalled();

      // The agent sends the same call again, and it is stored once.
      expect(textOf(await writer.get("memory_ingest")!(write))).toContain("Stored and readable now");
      expect(await storedRows(write.content)).toBe(1);
    },
    60_000,
  );

  it.each([
    { queue: "without a queue (INNGEST_BYPASS): the job `after()` runs logs it as not stored", bypass: "1" },
    { queue: "with the Inngest queue: the function's run fails with the reason, so the queue retries it", bypass: "" },
  ])(
    "fails a queued write's job loudly when its transaction cannot finish, $queue",
    async ({ bypass }) => {
      vi.stubEnv("INNGEST_BYPASS", bypass);
      const failures = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const writer = await toolsFor("writer-a");
      const write = { content: "Release train 2 leaves on Monday", name: "Release train 2", scopePath: SCOPE };
      // The memory service refuses the request path's embedding, so the write is queued for its job.
      refuseEmbeddings.next = 1;
      expect(textOf(await writer.get("memory_ingest")!(write))).toContain("Queued for ingest");

      const notStored = /^"Release train 2" in \S+ was not stored: the database did not finish storing it in time\./;
      if (bypass) {
        expect(queuedJobs).toHaveLength(1);
        await pastTheTimeLimit(() => runQueuedJobs());
        const logged = failures.mock.calls.find(([line]) => String(line).startsWith("[memory] ingest failed"));
        expect(logged?.[1]).toBeInstanceOf(VersionNotStoredError);
        expect((logged?.[1] as Error).message).toMatch(notStored);
      } else {
        const [[event]] = vi.mocked(inngest.send).mock.calls as unknown as [[{ id?: string; data: IngestInput }]];
        type Handler = { fn: (ctx: unknown) => Promise<unknown> };
        const run = () =>
          (memoryIngest as unknown as Handler).fn({
            event,
            step: { run: async (_step: string, fn: () => unknown) => fn() },
            runId: "run-1",
            attempt: 0,
          });
        const attempt = pastTheTimeLimit(run);
        await expect(attempt).rejects.toBeInstanceOf(VersionNotStoredError);
        await expect(attempt).rejects.toThrow(notStored);
      }
      expect(await storedRows(write.content)).toBe(0);
      failures.mockRestore();
    },
    60_000,
  );
});
