// Database-gated like lib/inngest.graph-extraction-retry.realdb.test.ts, whose setup this copies:
// runs only with QA_DATABASE_URL naming an isolated, migrated Postgres.
//
// Claims under test, beyond the builder's file:
//   1. A late extraction is dated when the version was written, not when the retry ran. The
//      graph's reference time decides which of two contradicting edges is retired
//      (types/memory.ts, IngestInput.occurredAt), so an older write extracted hours late must
//      not outrank a newer one extracted on time.
//   2. While an org's deletion is open (#800), nothing of that org is extracted into the graph,
//      and its owed rows do not stop another org's rows from being attempted in the same pass.
//   3. A version erased while its retry is extracting does not keep its graph copy.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";
import type { VersionTransaction } from "@/services/memory/pgvector-store";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-graph-retry-qa";
const OTHER_ORG = "org-qa-graph-retry-qa-other";
const SCOPE = "org_qa_graph_retry_qa.eng";

// The memory service's answer while its provider's quota is used up (memory-service
// app/extraction_status.py), as the Node client reports it.
const QUOTA_DETAIL =
  "graph extraction unavailable: the model provider refused the call because the account's quota or spend limit is used up; raise the limit or fund the key, then retry";

const stores = vi.hoisted(() => ({
  client: null as null | import("@/lib/generated/prisma/client").PrismaClient,
  chunks: 0,
}));

vi.mock("@/services/memory", async () => {
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return {
    MemoryServiceError,
    memory: { ingest: vi.fn() },
    graphitiStore: { ingest: vi.fn(), ingestBulk: vi.fn(), removeChunkFacts: vi.fn() },
    pgvectorStore: {
      // The write-through store, without the embedding call: a real row, as ingestOnce writes
      // one, in one transaction with the caller's announcement.
      ingestOnce: vi.fn(async (input: IngestInput, options?: { sameTransaction?: VersionTransaction<unknown> }) => {
        const id = `chunk-qa-graph-retry-qa-${++stores.chunks}`;
        return stores.client!.$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "entityName", "scopePath", "factVersion")
            VALUES (${id}, ${input.groupId}, ${input.content}, ${input.source ?? "text"}, ${input.actorType}, ${input.actorId},
                    ${input.name ?? null}, ${input.scopePath ?? null}, true)`;
          return { episodeId: id, inserted: true, decided: await options?.sameTransaction?.(tx, id) };
        });
      }),
      isStored: vi.fn(async (input: { groupId: string; chunkId: string }) => {
        const rows = await stores.client!.$queryRaw<{ id: string }[]>`
          SELECT id FROM memory_chunks WHERE id = ${input.chunkId} AND "orgId" = ${input.groupId}`;
        return rows.length > 0;
      }),
      storedVersionOf: vi.fn(async () => null),
    },
  };
});
// The Node distiller's own model call, refused the same way: it falls back to the raw text.
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-extract",
  createLLMClient: () => ({
    chat: { completions: { create: vi.fn().mockRejectedValue(new Error("429 insufficient_quota")) } },
  }),
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

function agentWrite(content: string, groupId = ORG): IngestInput {
  return {
    groupId,
    content,
    name: "Acme renewal",
    actorType: "agent",
    origin: "mcp",
    actorId: "agent-qa-graph-retry",
    actorName: "QA agent",
    source: "mcp",
    scopePath: SCOPE,
    occurredAt: "2026-10-16T08:00:00.000Z",
  };
}

describe.skipIf(!QA_URL)("QA: owed graph extractions against ordering, org deletion and erasure", () => {
  let db: PrismaClient;
  let jobs: typeof import("./inngest");
  let retry: typeof import("@/services/memory/graph-extraction-retry");
  let memory: typeof import("@/services/memory");

  beforeAll(async () => {
    // Before the import, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    stores.client = db;
    jobs = await import("./inngest");
    retry = await import("@/services/memory/graph-extraction-retry");
    memory = await import("@/services/memory");
  });

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM org_deletions WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("INNGEST_BYPASS", "1");
    await db.$executeRaw`DELETE FROM org_deletions WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$executeRaw`DELETE FROM change_events WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
  });

  const owed = (orgId = ORG) =>
    db.$queryRaw<
      {
        chunkId: string;
        orgId: string;
        job: Record<string, unknown>;
        attempts: number;
        lastError: string;
        nextAttemptAt: Date;
      }[]
    >`
      SELECT "chunkId", "orgId", "job", "attempts", "lastError", "nextAttemptAt"
      FROM graph_extraction_retries WHERE "orgId" = ${orgId} ORDER BY "chunkId"`;

  const refuseExtraction = () =>
    vi
      .mocked(memory.graphitiStore.ingest)
      .mockRejectedValue(
        new memory.MemoryServiceError(`memory service /ingest failed: {"detail":"${QUOTA_DETAIL}"}`, 503),
      );

  /** Store one acknowledged write whose extraction the memory service refuses; returns its version. */
  async function acknowledgedButUnextracted(content: string, groupId = ORG): Promise<string> {
    refuseExtraction();
    const ack = await jobs.ingestMemory(agentWrite(content, groupId));
    expect(ack.readableNow).toBe(true);
    return ack.versionId!;
  }

  it("dates a late extraction at the write's stated time (C7), not at the retry or the write time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await acknowledgedButUnextracted("Acme's renewal owner is Dana.");
    const [row] = await owed();
    vi.mocked(memory.graphitiStore.ingest).mockReset().mockResolvedValue({ episodeId: "ep-late" });

    // Six hours later: the longest backoff.
    const late = new Date(row.nextAttemptAt.getTime() + 6 * 60 * 60_000);
    await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: late });

    const graphWrite = vi.mocked(memory.graphitiStore.ingest).mock.calls.at(-1)![0];
    expect(graphWrite.referenceTime).toBeDefined();
    // The write stated occurredAt 2026-10-16T08:00Z; that, not the write's createdAt, is the reference time.
    expect(graphWrite.referenceTime).toBe("2026-10-16T08:00:00.000Z");
  });

  it("extracts nothing of an org whose deletion is open, and still attempts another org's rows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deleting = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.", ORG);
    const other = await acknowledgedButUnextracted("Globex churned in September.", OTHER_ORG);
    const now = new Date();
    await db.orgDeletion.create({
      data: {
        orgId: ORG,
        orgName: ORG,
        trigger: "owner",
        requestedAt: now,
        effectiveAt: new Date(now.getTime() + 7 * 86_400_000),
        status: "pending",
      },
    });
    const due = new Date(
      Math.max(...[...(await owed(ORG)), ...(await owed(OTHER_ORG))].map((r) => r.nextAttemptAt.getTime())),
    );
    vi.mocked(memory.graphitiStore.ingest).mockReset().mockResolvedValue({ episodeId: "ep-x" });

    await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: due });

    const written = vi.mocked(memory.graphitiStore.ingest).mock.calls.map((c) => c[0].readableId);
    expect(written).not.toContain(deleting);
    expect(written).toContain(other);
  });

  it("refuses a new owed row for an org whose deletion is open, as every other content table does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    await db.$executeRaw`DELETE FROM graph_extraction_retries WHERE "chunkId" = ${versionId} AND "orgId" = ${ORG}`;
    const now = new Date();
    await db.orgDeletion.create({
      data: {
        orgId: ORG,
        orgName: ORG,
        trigger: "owner",
        requestedAt: now,
        effectiveAt: new Date(now.getTime() + 7 * 86_400_000),
        status: "pending",
      },
    });
    await expect(
      db.$executeRaw`INSERT INTO graph_extraction_retries ("chunkId", "orgId", "job", "lastError", "nextAttemptAt") VALUES (${versionId}, ${ORG}, '{}'::jsonb, 'x', now())`,
    ).rejects.toThrow(/being deleted/);
  });

  it("removes the graph copy of a version erased while its retry was extracting it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Dana Whitfield owns the Acme renewal.");
    const [row] = await owed();
    // The erasure's DELETE (services/memory/person-erasure.ts, removeChunks) commits while the
    // memory service is writing the episode.
    vi.mocked(memory.graphitiStore.ingest)
      .mockReset()
      .mockImplementation(async () => {
        await db.$executeRaw`DELETE FROM memory_chunks WHERE id = ${versionId} AND "orgId" = ${ORG}`;
        return { episodeId: "ep-erased" };
      });

    await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: row.nextAttemptAt });

    expect(memory.graphitiStore.removeChunkFacts).toHaveBeenCalledWith({ groupId: SCOPE, chunkId: versionId });
    expect(await owed()).toEqual([]);
  });
});
