// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An ingest that names a source with no connection writes nothing, on every job
// that can carry a source id.
//
// "No connection" means the `Source` row a connect creates is missing, reads
// `disconnected`, belongs to another org, or points at another scope than the
// one the ingest writes into. Each case is driven through the real job:
//   - `sourceSync`, the connector sync, for a source id with no row and for a
//     source disconnected before its queued run started;
//   - `fileIngest`, the file job a connector event can carry a source id on;
//   - `memoryIngest`, `runMemoryIngest` and `ingestMemory`, the memory write
//     jobs.
// "Writes nothing" is counted in both stores and on the change feed: zero
// `memory_chunks` rows, zero graph writes, zero `change_events` rows.
//
// Real: Postgres, the `Source` rows, pgvector's write path, the change feed.
// Stand-ins: the graph store (an in-memory double counting every write), the
// embedding call, the GitHub listing and the file extractor, which are remote.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The graph store, reduced to a count of what reached it. */
const graph = vi.hoisted(() => {
  const writes: { content: string; sourceId?: string; groupId?: string }[] = [];
  let next = 0;
  /** Runs inside every graph write, before it is recorded: where a test lands a disconnect. */
  let duringWrite: (() => Promise<void>) | null = null;
  const record = async (input: { content: string; sourceId?: string; scopePath?: string }) => {
    if (duringWrite) await duringWrite();
    writes.push({ content: input.content, sourceId: input.sourceId, groupId: input.scopePath });
    return { episodeId: `episode-${++next}` };
  };
  return {
    writes,
    reset() {
      writes.length = 0;
      next = 0;
      duringWrite = null;
    },
    onWrite(fn: (() => Promise<void>) | null) {
      duringWrite = fn;
    },
    memory: { ingest: record },
    store: {
      ingest: record,
      ingestBulk: async (inputs: { content: string; sourceId?: string }[]) => {
        for (const i of inputs) await record(i);
      },
      extractFile: async () => ({ chunks: ["A passage from a connected file."] }),
      // Removes what a source wrote into one scope, as the memory service does.
      removeGroupFacts: async ({ groupId, sourceId }: { groupId: string; sourceId?: string }) => {
        const kept = writes.filter((w) => !(w.groupId === groupId && (!sourceId || w.sourceId === sourceId)));
        const removedCount = writes.length - kept.length;
        writes.splice(0, writes.length, ...kept);
        return { removedCount };
      },
      removeEpisode: async () => ({ removed: false }),
      dedupeNodes: async () => 0,
    },
  };
});

vi.mock("@/services/memory/store", () => ({ memory: graph.memory, graphitiStore: graph.store }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
  GuardrailError: class extends Error {},
}));
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "github-token" }) }));
// The file-ingest job deletes its raw blob once extracted; these files hold no real blob.
vi.mock("@vercel/blob", () => ({ del: async () => undefined }));
vi.mock("@/services/connectors/github", () => ({
  listRepositoryItems: async () => ({
    items: [{ id: "README.md", text: "The release train leaves on Monday.", checksum: "r1" }],
    unreadable: [],
    gone: [],
    cursor: { issues: {}, pulls: {}, commits: {}, probeOffset: 0 },
  }),
  parseCursor: () => null,
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-no-connect";
const OTHER_ORG = "org-qa-no-connect-other";
const SCOPE = "org_org-qa-no-connect.engineering";
const CONNECTED = "src-qa-no-connect-live";
const DISCONNECTED = "src-qa-no-connect-gone";
const FOREIGN = "src-qa-no-connect-foreign";
const MISSING = "src-qa-no-connect-missing";

type StepCtx = {
  event: { data: unknown };
  runId?: string;
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};
type JobFn = (ctx: StepCtx) => Promise<Record<string, unknown>>;

describe.skipIf(!QA_URL)("an ingest that names a source with no connection writes nothing", () => {
  let db: PrismaClient;
  let jobs: typeof import("./inngest");

  const run = (job: unknown, data: unknown) =>
    (job as { fn: JobFn }).fn({ event: { data }, runId: "run-1", step: { run: async (_name, fn) => fn() } });

  /** Everything both stores and the feed hold for the org. */
  const written = async () => ({
    chunks: await db.memoryChunk.count({ where: { orgId: ORG } }),
    graph: graph.writes.length,
    changes: await db.changeEvent.count({ where: { orgId: ORG } }),
  });
  const NOTHING = { chunks: 0, graph: 0, changes: 0 };

  /** An agent's ingest, the kind the request path stores in pgvector before queueing. */
  const agentIngest = (sourceId: string, scopePath: string | undefined) => ({
    groupId: ORG,
    content: `A note from ${sourceId}.`,
    name: "Release",
    source: "text",
    actorType: "agent" as const,
    origin: "mcp" as const,
    actorId: "agent-1",
    actorName: "Agent",
    scopePath,
    sourceId,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    // ingestMemory then runs the job inline instead of sending an event nothing receives.
    vi.stubEnv("INNGEST_BYPASS", "1");
    stubEmbeddingService();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    jobs = await import("./inngest");
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    graph.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.source.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    const source = (id: string, orgId: string, status: "active" | "disconnected") => ({
      id,
      orgId,
      type: "github" as const,
      externalId: `acme/${id}`,
      name: `acme/${id}`,
      scopePath: SCOPE,
      status,
      encryptedTokens: "sealed",
    });
    await db.source.create({ data: source(CONNECTED, ORG, "active") });
    await db.source.create({ data: source(DISCONNECTED, ORG, "disconnected") });
    await db.source.create({ data: source(FOREIGN, OTHER_ORG, "active") });
  });

  describe("memory write jobs", () => {
    const refusals = [
      ["a source id with no row", MISSING, SCOPE],
      ["a disconnected source", DISCONNECTED, SCOPE],
      ["another org's source", FOREIGN, SCOPE],
      ["a connected source at another scope", CONNECTED, "org_org-qa-no-connect.sales"],
      ["a connected source with no scope", CONNECTED, undefined],
    ] as const;

    it.each(refusals)("ingestMemory refuses %s and writes nothing", async (_label, sourceId, scopePath) => {
      await expect(jobs.ingestMemory(agentIngest(sourceId, scopePath))).rejects.toBeInstanceOf(
        jobs.SourceNotConnectedError,
      );
      expect(await written()).toEqual(NOTHING);
    });

    it.each(refusals)("the queued memoryIngest job writes nothing for %s", async (_label, sourceId, scopePath) => {
      const result = await run(jobs.memoryIngest, agentIngest(sourceId, scopePath));
      expect(result).toMatchObject({ refused: "source not connected" });
      expect(await written()).toEqual(NOTHING);
    });

    it.each(refusals)("runMemoryIngest writes nothing for %s", async (_label, sourceId, scopePath) => {
      await jobs.runMemoryIngest(agentIngest(sourceId, scopePath));
      expect(await written()).toEqual(NOTHING);
    });

    it("control: a connected source at its own scope writes to both stores and the feed", async () => {
      await jobs.ingestMemory(agentIngest(CONNECTED, SCOPE));
      const after = await written();
      expect(after.chunks).toBe(1);
      expect(after.graph).toBe(1);
      expect(after.changes).toBeGreaterThanOrEqual(1);
    });

    it("control: an ingest that names no source is not a connector write and is unaffected", async () => {
      const { sourceId: _none, ...manual } = agentIngest(CONNECTED, SCOPE);
      await jobs.ingestMemory(manual);
      expect((await written()).chunks).toBe(1);
    });
  });

  describe("a disconnect that lands while a memory write job is writing", () => {
    // The check before the first write cannot see a disconnect that commits after it.
    // The disconnect route retires the source's content when it runs, so a write that
    // lands after that retirement would stay. Each job checks again after its last
    // write and removes what the source wrote into the scope when it finds the source
    // gone, which is what closes the window between the first check and the write.
    const disconnect = async () => {
      await db.source.update({ where: { id: CONNECTED }, data: { status: "disconnected" } });
    };
    const leftBySource = async () => ({
      chunks: await db.memoryChunk.count({ where: { orgId: ORG, sourceId: CONNECTED } }),
      graph: graph.writes.filter((w) => w.sourceId === CONNECTED).length,
    });

    it("the queued memoryIngest job removes what it wrote when the source was disconnected mid-write", async () => {
      graph.onWrite(disconnect);
      const result = await run(jobs.memoryIngest, agentIngest(CONNECTED, SCOPE));
      expect(result).toMatchObject({ refused: "source not connected" });
      expect(await leftBySource()).toEqual({ chunks: 0, graph: 0 });
    });

    it("runMemoryIngest removes what it wrote when the source was disconnected mid-write", async () => {
      graph.onWrite(disconnect);
      await jobs.runMemoryIngest(agentIngest(CONNECTED, SCOPE));
      expect(await leftBySource()).toEqual({ chunks: 0, graph: 0 });
    });

    it("the queued job removes the row the request path stored when the source was disconnected before the job ran", async () => {
      const { pgvectorStore } = await import("@/services/memory/pgvector-store");
      const { episodeId } = await pgvectorStore.ingestOnce(agentIngest(CONNECTED, SCOPE));
      await disconnect();
      const result = await run(jobs.memoryIngest, { ...agentIngest(CONNECTED, SCOPE), readableId: episodeId });
      expect(result).toMatchObject({ refused: "source not connected" });
      expect(await leftBySource()).toEqual({ chunks: 0, graph: 0 });
    });

    it("runMemoryIngest removes the row the request path stored when the source was disconnected before it ran", async () => {
      const { pgvectorStore } = await import("@/services/memory/pgvector-store");
      const { episodeId } = await pgvectorStore.ingestOnce(agentIngest(CONNECTED, SCOPE));
      await disconnect();
      await jobs.runMemoryIngest({ ...agentIngest(CONNECTED, SCOPE), readableId: episodeId });
      expect(await leftBySource()).toEqual({ chunks: 0, graph: 0 });
    });

    it("control: a source still connected after the write keeps what it wrote", async () => {
      const { pgvectorStore } = await import("@/services/memory/pgvector-store");
      const { episodeId } = await pgvectorStore.ingestOnce(agentIngest(CONNECTED, SCOPE));
      await run(jobs.memoryIngest, { ...agentIngest(CONNECTED, SCOPE), readableId: episodeId });
      await jobs.runMemoryIngest({ ...agentIngest(CONNECTED, SCOPE), readableId: episodeId });
      expect(await leftBySource()).toEqual({ chunks: 1, graph: 2 });
    });

    it("never removes another org's content when a refused ingest names that org's source and scope", async () => {
      const foreignScope = "org_org-qa-no-connect-other.engineering";
      graph.writes.push({ content: "the other org's own fact", sourceId: FOREIGN, groupId: foreignScope });
      const result = await run(jobs.memoryIngest, {
        ...agentIngest(FOREIGN, foreignScope),
        readableId: "chunk-of-another-org",
      });
      expect(result).toMatchObject({ refused: "source not connected" });
      expect(graph.writes).toEqual([{ content: "the other org's own fact", sourceId: FOREIGN, groupId: foreignScope }]);
    });
  });

  describe("the connector sync", () => {
    it("writes nothing for a source id with no row", async () => {
      await expect(run(jobs.sourceSync, { sourceId: MISSING, orgId: ORG })).rejects.toThrow();
      expect(await written()).toEqual(NOTHING);
    });

    it("writes nothing for a source disconnected before its queued run started, and leaves it disconnected", async () => {
      const result = await run(jobs.sourceSync, { sourceId: DISCONNECTED, orgId: ORG });
      expect(result).toMatchObject({ disconnected: true, synced: 0 });
      expect(await written()).toEqual(NOTHING);
      expect((await db.source.findUniqueOrThrow({ where: { id: DISCONNECTED } })).status).toBe("disconnected");
    });

    it("writes nothing for another org's source id", async () => {
      await expect(run(jobs.sourceSync, { sourceId: FOREIGN, orgId: ORG })).rejects.toThrow();
      expect(await written()).toEqual(NOTHING);
    });

    it("control: a connected source's sync writes its item", async () => {
      const result = await run(jobs.sourceSync, { sourceId: CONNECTED, orgId: ORG });
      expect(result).toMatchObject({ synced: 1 });
      expect(graph.writes.map((w) => w.sourceId)).toEqual([CONNECTED]);
    });
  });

  describe("the file job", () => {
    const fileEvent = (sourceId: string) => ({
      groupId: ORG,
      blobUrl: "https://blob.example/x.pdf",
      filename: "x.pdf",
      fileType: "pdf",
      actorId: "sync",
      actorType: "extraction",
      scopePath: SCOPE,
      sourceId,
    });

    it.each([
      ["a source id with no row", MISSING],
      ["a disconnected source", DISCONNECTED],
      ["another org's source", FOREIGN],
    ])("writes nothing for %s", async (_label, sourceId) => {
      const result = await run(jobs.fileIngest, fileEvent(sourceId));
      expect(result).toMatchObject({ ingested: 0, superseded: true });
      expect(await written()).toEqual(NOTHING);
    });

    it("control: a connected source's file is written", async () => {
      await run(jobs.fileIngest, fileEvent(CONNECTED));
      expect((await written()).chunks).toBe(1);
    });
  });
});
