// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A fact deleted before its queued ingest job writes the graph is not left in the graph.
// lib/inngest.delete-before-graph-write.realdb.test.ts proves this end to end through the
// delete and graph routes, a running memory-service and Neo4j, which CI's Node job does
// not have. This suite keeps the same rule checked in CI: the real request path stores the
// row, the row is deleted, and each job (`memoryIngest` and the inline `runMemoryIngest`)
// is run against a graph double that keeps what each write stamped.
//
// Real: Postgres, ingestMemory's request path, the pgvector row and its lookup, both jobs.
// Stand-ins: the graph store (an in-memory list of episodes keyed on their chunk stamp,
// retired by that stamp and scope as DELETE /chunks does), the embedding call, the episode
// cap, and the fact delete, which here removes the row directly.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The graph store, reduced to the episodes it holds and the chunk each was stamped with. */
const graph = vi.hoisted(() => {
  const episodes: { groupId: string; chunkId?: string; content: string }[] = [];
  let writes = 0;
  /** Runs inside every graph write, before it is recorded: where a test lands a delete. */
  let duringWrite: (() => Promise<void>) | null = null;
  const record = async (input: { content: string; scopePath?: string; groupId: string; readableId?: string }) => {
    if (duringWrite) await duringWrite();
    writes++;
    episodes.push({ groupId: input.scopePath ?? input.groupId, chunkId: input.readableId, content: input.content });
    return { episodeId: `episode-${writes}` };
  };
  return {
    episodes,
    writes: () => writes,
    reset() {
      episodes.length = 0;
      writes = 0;
      duringWrite = null;
    },
    onWrite(fn: (() => Promise<void>) | null) {
      duringWrite = fn;
    },
    memory: { ingest: record },
    store: {
      ingest: record,
      // What DELETE /chunks/{chunk_id}?group_id= retires: the chunk's episodes in that scope.
      removeChunkFacts: async ({ groupId, chunkId }: { groupId: string; chunkId: string }) => {
        const kept = episodes.filter((e) => !(e.groupId === groupId && e.chunkId === chunkId));
        episodes.splice(0, episodes.length, ...kept);
      },
    },
  };
});

vi.mock("@/services/memory/store", () => ({ memory: graph.memory, graphitiStore: graph.store }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
  GuardrailError: class extends Error {},
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-delete-before-graph-double";
const SCOPE = `org_${ORG}.deal_a`;

type StepCtx = {
  event: { data: unknown };
  runId?: string;
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a queued ingest job leaves no graph episode for a deleted fact", () => {
  let db: PrismaClient;
  let jobs: typeof import("./inngest");
  let queued: IngestInput[];

  const deleteRow = (id: string) => db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = ${id}`;

  /** An agent's short note: stored for reading on the request path, then queued. */
  async function storeAndQueue(text: string): Promise<IngestInput> {
    await jobs.ingestMemory({
      groupId: ORG,
      content: text,
      name: "Acme renewal",
      source: "text",
      actorType: "agent",
      origin: "mcp",
      actorId: "agent-1",
      actorName: "Agent",
      scopePath: SCOPE,
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].readableId).toBeDefined();
    return queued[0];
  }

  const runners = [
    [
      "memoryIngest",
      (data: IngestInput) =>
        (jobs.memoryIngest as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn({
          event: { data },
          runId: "run-1",
          step: { run: async (_name, fn) => fn() },
        }),
    ],
    ["runMemoryIngest", (data: IngestInput) => jobs.runMemoryIngest(data)],
  ] as const;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    stubEmbeddingService();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    jobs = await import("./inngest");
    vi.spyOn(jobs.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      queued.push(event.data);
      return { ids: [] };
    }) as never);
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    queued = [];
    graph.reset();
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
  });

  it.each(runners)("control: %s writes the fact's episode when nobody deleted it", async (_name, runJob) => {
    const data = await storeAndQueue("Acme renewal is due in March");

    await runJob(data);

    expect(graph.episodes).toEqual([{ groupId: SCOPE, chunkId: data.readableId, content: data.content }]);
  });

  it.each(runners)("%s writes nothing for a fact deleted before it ran", async (_name, runJob) => {
    const data = await storeAndQueue("Acme renewal is due in April");
    await deleteRow(data.readableId!);

    await runJob(data);

    expect(graph.writes()).toBe(0);
    expect(graph.episodes).toEqual([]);
  });

  it.each(runners)("%s retires the episode of a fact deleted while it was writing", async (_name, runJob) => {
    const data = await storeAndQueue("Acme renewal is due in May");
    graph.onWrite(async () => {
      graph.onWrite(null);
      await deleteRow(data.readableId!);
    });

    await runJob(data);

    expect(graph.writes()).toBe(1);
    expect(graph.episodes).toEqual([]);
  });

  // The withdrawn episodes were only in the graph, so no trigger sees them go: the job
  // moves the org's removal epoch itself (scopeCacheStamp(), services/access/check.ts),
  // after the delete's own bump, so a scan cached in between is not served again.
  it.each(runners)("%s moves the org's removal epoch once it retires the episode", async (_name, runJob) => {
    const data = await storeAndQueue("Acme renewal is due in June");
    const epoch = async () =>
      (
        await db.$queryRaw<{ e: bigint | null }[]>`SELECT "epoch" AS e FROM org_removal_epochs WHERE "orgId" = ${ORG}`
      )[0]?.e ?? BigInt(0);
    let afterDelete = BigInt(0);
    graph.onWrite(async () => {
      graph.onWrite(null);
      await deleteRow(data.readableId!);
      afterDelete = await epoch();
    });

    await runJob(data);

    expect(graph.episodes).toEqual([]);
    expect(await epoch()).toBeGreaterThan(afterDelete);
  });
});
