// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// What the ingest job derives from a write is not a version of the fact the write names.
//
// Every memory_ingest is stored and announced on the request path, then handed to the
// ingest job, which in a deployment without a queue runs after the reply (`after()`),
// seconds later. The job distils the content into graph records: facts, attributes and,
// for a stated decision, the decision verbatim. Those records are sentences about the
// version, already stored, not new versions of the fact. The contention rule
// (services/memory/conflict.ts) and the stale-read check (services/memory/fact-reads.ts)
// treat every stored row under a fact's name as a version, so a derived record stored
// there with its writer's id is one more version nobody announced and no other writer
// read: it superseded a second writer's update, it got a writer who had read the newest
// version refused, and it hid a newer version from the stale-read check of its own writer.
//
// The races below are the lost-update race, unbased: A seeds, A and B read with memory_query, B writes, A writes back at once
// without a base. The job of each write is queued as `after()` would queue it and run at
// the moment a test chooses, which is how its timing varies in production.
//
// Real: Postgres, the MCP tool handlers, check() against live capabilities, the
// request-path store and announcement, the per-org lock, the ingest job itself
// (runMemoryIngest), the hybrid store and pgvector's SQL. Doubles: the embedding service
// (one fixed vector), the distiller's model (it returns the write as one fact and one
// decision, as a model does for a one-line decision) and the graph service (it accepts
// writes and finds nothing).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";

/** Ingest jobs queued by `after()`, in queue order, waiting for a test to run them. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** Every write the graph service received. */
const graphWrites = vi.hoisted(() => [] as IngestInput[]);

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
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
  const graph = {
    ingest: async (input: IngestInput) => {
      graphWrites.push(input);
      return { episodeId: `graph-episode-${graphWrites.length}` };
    },
    ingestBulk: async (inputs: IngestInput[]) => {
      graphWrites.push(...inputs);
      return inputs.map((_, i) => `graph-episode-bulk-${graphWrites.length}-${i}`);
    },
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
            decisions: [{ decision: written }],
          };
          return { choices: [{ message: { content: JSON.stringify(distilled) } }] };
        },
      },
    },
  }),
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "jobrecords";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;
const PAST_CONTENTION_WINDOW_MS = 1_100;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)("what the ingest job derives from a write is not a version of the fact", () => {
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
  const versionIn = (reply: ToolReply) => /\bVersion: (\S+?)\.?(?:\s|$)/.exec(textOf(reply))?.[1];
  const pastContentionWindow = () => new Promise((resolve) => setTimeout(resolve, PAST_CONTENTION_WINDOW_MS));

  /** Take the jobs queued so far, to run later. */
  const takeQueuedJobs = () => queuedJobs.splice(0);
  async function runJobs(jobs: (() => Promise<unknown>)[]): Promise<void> {
    for (const job of jobs) await job();
  }

  /** One fact, as the agents of one race write and read it. */
  function factIn(scopePath: string, name: string) {
    const text = (day: string) => `${name}: the release train leaves on ${day}`;
    return {
      text,
      ingest: (tools: Tools, day: string) => tools.get("memory_ingest")!({ content: text(day), name, scopePath }),
      lookUp: (tools: Tools) => tools.get("memory_query")!({ query: text("Monday"), limit: 10, scopePath }),
      async statusOf(reader: Tools, versionId: string): Promise<string | null> {
        const reply = await reader.get("memory_version")!({ versionId });
        return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(textOf(reply))?.[1] ?? null;
      },
      async served(reader: Tools, day: string): Promise<boolean> {
        const answer = textOf(await reader.get("memory_query")!({ query: text(day), limit: 10, scopePath }));
        return answer.split("\n").some((line) => line.startsWith("•") && line.includes(text(day)));
      },
    };
  }

  /** Whether the job of a write stored its decision, so the component under test was present. */
  const jobStoredDecisionOf = (content: string) =>
    graphWrites.some((write) => write.recordType === "decision" && write.content.includes(content));

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
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    queuedJobs.length = 0;
    graphWrites.length = 0;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("keeps B's update current when A's job stores its records between B's read and B's write", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    const seedJob = takeQueuedJobs();
    await fact.lookUp(a);
    await fact.lookUp(b);
    await runJobs(seedJob);

    const fromB = versionIn(await fact.ingest(b, "Tuesday"))!;
    const back = await fact.ingest(a, "Wednesday");
    await runJobs(takeQueuedJobs());

    expect(jobStoredDecisionOf(fact.text("Monday"))).toBe(true);
    expect(await fact.statusOf(reader, fromB)).toBe("current");
    expect(await fact.served(reader, "Tuesday")).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^Stored, but superseded by ${fromB}`));
    expect(await fact.statusOf(reader, versionIn(back)!)).toBe("superseded");
  }, 30_000);

  it("accepts B's update when B read the newest version and A's job stored its records after that read", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    const seedJob = takeQueuedJobs();
    await fact.lookUp(b);
    await runJobs(seedJob);
    await pastContentionWindow();

    const fromB = await fact.ingest(b, "Tuesday");

    expect(jobStoredDecisionOf(fact.text("Monday"))).toBe(true);
    expect(textOf(fromB)).not.toMatch(/stale_version/);
    expect(await fact.statusOf(reader, versionIn(fromB)!)).toBe("current");
  }, 30_000);

  it("refuses A's stale write-back when A's own job stored its records after B's update", async () => {
    const [a, b] = [await toolsFor("writer-a"), await toolsFor("writer-b")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    const seedJob = takeQueuedJobs();
    await fact.lookUp(b);
    const fromB = versionIn(await fact.ingest(b, "Tuesday"))!;
    await runJobs(seedJob);
    await pastContentionWindow();

    const back = await fact.ingest(a, "Wednesday");

    expect(jobStoredDecisionOf(fact.text("Monday"))).toBe(true);
    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));
  }, 30_000);

  it("keeps every note of one writer's burst current, with each note's job run between them", async () => {
    const [a, reader] = [await toolsFor("writer-a"), await toolsFor("reader")];
    const name = "Release train";
    const notes = [
      "The release train has twelve cars.",
      "The release train stops at Lyon.",
      "The release train is late on Fridays.",
    ];
    const versions: string[] = [];
    for (const content of notes) {
      versions.push(versionIn(await a.get("memory_ingest")!({ content, name, scopePath: SCOPE }))!);
      await runJobs(takeQueuedJobs());
    }

    const fact = factIn(SCOPE, name);
    for (const version of versions) expect(await fact.statusOf(reader, version)).toBe("current");
  }, 30_000);

  it("loses no update in thirty races, whenever in the race A's job stores its records", async () => {
    // Where A's seed job lands, cycled race by race: the job runs after A's reply, so in
    // production it can land at any of these points.
    const slots = [
      "before B reads",
      "between B's read and B's write",
      "between B's write and A's write-back",
      "after A's write-back",
    ] as const;
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const lost: string[] = [];
    for (let race = 0; race < 30; race += 1) {
      // One scope per race, so the fixed embedding cannot serve one race's versions to another.
      const scopePath = `${SCOPE}.r${race}`;
      await db.scope.create({ data: { orgId: ORG, path: scopePath, name: `r${race}` } });
      const slot = slots[race % slots.length];
      const fact = factIn(scopePath, `Release train ${race}`);
      const seedJobLandsAt = async (point: (typeof slots)[number], jobs: (() => Promise<unknown>)[]) => {
        if (slot === point) await runJobs(jobs);
      };

      await fact.ingest(a, "Monday");
      const seedJob = takeQueuedJobs();
      await fact.lookUp(a);
      await seedJobLandsAt("before B reads", seedJob);
      await fact.lookUp(b);
      await seedJobLandsAt("between B's read and B's write", seedJob);
      const fromB = versionIn(await fact.ingest(b, "Tuesday"))!;
      await seedJobLandsAt("between B's write and A's write-back", seedJob);
      const back = await fact.ingest(a, "Wednesday");
      await seedJobLandsAt("after A's write-back", seedJob);
      await runJobs(takeQueuedJobs());

      const aVersion = back.isError ? null : versionIn(back);
      const staleAcceptedCurrent =
        !back.isError && (aVersion === undefined || (await fact.statusOf(reader, aVersion!)) === "current");
      const bCurrent = (await fact.statusOf(reader, fromB)) === "current";
      const bServed = await fact.served(reader, "Tuesday");
      if (!jobStoredDecisionOf(fact.text("Monday"))) throw new Error(`race ${race}: A's seed job did not run`);
      if (!bCurrent || !bServed || staleAcceptedCurrent) lost.push(`race ${race} (${slot})`);
    }

    console.log(`lost updates: ${lost.length} of 30 races${lost.length ? `: ${lost.join(", ")}` : ""}`);
    expect(lost).toEqual([]);
  }, 180_000);
});
