// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A memoryIngest job that fails all its Inngest retries keeps its write for the
// graph-extraction retry pass (W12). Before this, the job had no onFailure: a stored write
// whose Inngest run died left nothing naming it, so nothing retried it.
//   1. onFailure leaves a graph_extraction_retries row naming the stored version, holding no text.
//   2. A write with no readableId (nothing stored to name) leaves no row.
//   3. The row is the one the cron picks up: a pass extracts the version from its stored text.
// The memory service is mocked; the stored rows and retry rows are real.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";
import type { VersionTransaction } from "@/services/memory/pgvector-store";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-ingest-onfailure";
const OTHER_ORG = "org-qa-ingest-onfailure-other";
const SCOPE = "org_qa_ingest_onfailure.eng";

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
        const id = `chunk-qa-ingest-onfailure-${++stores.chunks}`;
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
    actorId: "agent-qa-ingest-onfailure",
    actorName: "QA agent",
    source: "mcp",
    scopePath: SCOPE,
    occurredAt: "2026-10-16T08:00:00.000Z",
  };
}

describe.skipIf(!QA_URL)("memoryIngest's onFailure keeps a write that failed all its retries", () => {
  let db: PrismaClient;
  let jobs: typeof import("./inngest");
  let retry: typeof import("@/services/memory/graph-extraction-retry");
  let memory: typeof import("@/services/memory");
  type FailureCtx = { event: { data: { event: { data: unknown } } }; error: Error };
  let onFailure: (ctx: FailureCtx) => Promise<unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    stores.client = db;
    jobs = await import("./inngest");
    retry = await import("@/services/memory/graph-extraction-retry");
    memory = await import("@/services/memory");
    onFailure = (jobs.memoryIngest as unknown as { opts: { onFailure: typeof onFailure } }).opts.onFailure;
  });

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.$executeRaw`DELETE FROM change_events WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
  });

  const owed = () =>
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
      FROM graph_extraction_retries WHERE "orgId" = ${ORG} ORDER BY "chunkId"`;

  /** Store a version the way the request path does, with extraction not yet done. */
  async function storedVersion(content: string): Promise<string> {
    const stored = await memory.pgvectorStore.ingestOnce(agentWrite(content));
    return stored.episodeId;
  }

  const failedRun = (data: unknown, error = new Error("step.run graph-ingest failed after 3 retries")): FailureCtx => ({
    event: { data: { event: { data } } },
    error,
  });

  it("leaves a row naming the stored version, with no text, after three failed retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await storedVersion("Acme renewed at $40k ARR for 2027.");

    await onFailure(failedRun({ ...agentWrite("Acme renewed at $40k ARR for 2027."), readableId: versionId }));

    const [row, ...rest] = await owed();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ chunkId: versionId, orgId: ORG, attempts: 1 });
    expect(row.lastError).toContain("after 3 retries");
    expect(row.job).toMatchObject({ groupId: ORG, name: "Acme renewal", scopePath: SCOPE, readableId: versionId });
    expect(row.job).not.toHaveProperty("content");
    expect(JSON.stringify(row.job)).not.toContain("40k");
  });

  it("leaves no row, and does not throw, for a write with no readableId", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(onFailure(failedRun(agentWrite("Acme is a Company.")))).resolves.not.toThrow();
    expect(await owed()).toEqual([]);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("kept for another attempt"));
  });

  it("leaves a row the retry pass extracts from the stored text, and removes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await storedVersion("Acme renewed at $40k ARR for 2027.");
    await onFailure(failedRun({ ...agentWrite("Acme renewed at $40k ARR for 2027."), readableId: versionId }));
    const [row] = await owed();
    vi.mocked(memory.graphitiStore.ingest).mockReset().mockResolvedValue({ episodeId: "ep-extracted" });

    const pass = await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: row.nextAttemptAt });

    expect(pass).toEqual({ attempted: 1, extracted: 1, failed: 0 });
    expect(await owed()).toEqual([]);
    expect(vi.mocked(memory.graphitiStore.ingest).mock.calls.at(-1)![0]).toMatchObject({
      groupId: ORG,
      content: "Acme renewed at $40k ARR for 2027.",
      readableId: versionId,
    });
  });

  // C7: absorption keeps the write's own time. A late, older row must never read as current.
  const referenceAt = () =>
    db.$queryRaw<{ chunkId: string; referenceAt: Date | null }[]>`
      SELECT "chunkId", "referenceAt" FROM graph_extraction_retries WHERE "orgId" = ${ORG} ORDER BY "chunkId"`;

  it("keeps the write's original occurredAt on the deferred row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await storedVersion("Acme renewed at $40k ARR for 2027.");
    await onFailure(failedRun({ ...agentWrite("Acme renewed at $40k ARR for 2027."), readableId: versionId }));
    expect(await referenceAt()).toEqual([{ chunkId: versionId, referenceAt: new Date("2026-10-16T08:00:00.000Z") }]);
  });

  it("falls back to the version's receivedAt when the write stated no time, and to NULL when it has neither", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const received = new Date("2026-10-15T07:00:00.000Z");
    const a = await storedVersion("Acme has no stated time.");
    const b = await storedVersion("Acme has no time anywhere.");
    await db.$executeRaw`UPDATE memory_chunks SET "receivedAt" = ${received} WHERE id = ${a}`;
    for (const id of [a, b]) {
      const { occurredAt: _omit, ...undated } = agentWrite("x");
      await onFailure(failedRun({ ...undated, readableId: id }));
    }
    const rows = Object.fromEntries((await referenceAt()).map((r) => [r.chunkId, r.referenceAt]));
    expect(rows[a]).toEqual(received);
    expect(rows[b]).toBeNull();
  });

  it("sends the kept time as Graphiti's reference time on the retry, not now", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await storedVersion("Acme renewed at $40k ARR for 2027.");
    await onFailure(failedRun({ ...agentWrite("Acme renewed at $40k ARR for 2027."), readableId: versionId }));
    const [row] = await owed();
    vi.mocked(memory.graphitiStore.ingest).mockReset().mockResolvedValue({ episodeId: "ep" });

    await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, {
      now: new Date(row.nextAttemptAt.getTime() + 6 * 3_600_000),
    });

    expect(vi.mocked(memory.graphitiStore.ingest).mock.calls.at(-1)![0].referenceTime).toBe("2026-10-16T08:00:00.000Z");
  });

  it("a retried older fact keeps an older reference time than a newer fact retried before it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const older = await storedVersion("Acme's owner is Dana.");
    const newer = await storedVersion("Acme's owner is Eli.");
    await onFailure(failedRun({ ...agentWrite("x"), occurredAt: "2026-10-10T08:00:00.000Z", readableId: older }));
    await onFailure(failedRun({ ...agentWrite("x"), occurredAt: "2026-10-12T08:00:00.000Z", readableId: newer }));
    // The newer one is due first, so the older is extracted after it, late.
    await db.$executeRaw`UPDATE graph_extraction_retries SET "nextAttemptAt" = now() - interval '2 hours' WHERE "chunkId" = ${newer}`;
    await db.$executeRaw`UPDATE graph_extraction_retries SET "nextAttemptAt" = now() - interval '1 hour' WHERE "chunkId" = ${older}`;
    vi.mocked(memory.graphitiStore.ingest).mockReset().mockResolvedValue({ episodeId: "ep" });

    await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: new Date() });

    const sent = vi.mocked(memory.graphitiStore.ingest).mock.calls.map(([w]) => [w.readableId, w.referenceTime]);
    expect(sent).toEqual([
      [newer, "2026-10-12T08:00:00.000Z"],
      [older, "2026-10-10T08:00:00.000Z"],
    ]);
  });
});
