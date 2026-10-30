// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A graph extraction that fails after the write was acknowledged is kept, not dropped.
//
// On 2026-10-16 the memory service answered every /ingest with an error for a day (its
// model provider's spend limit was reached). memory_ingest stored each write and answered
// "Stored", the request-path job (INNGEST_BYPASS, run in `after()`) logged the graph failure,
// and nothing recorded which versions were never extracted. The claims under test:
//   1. ingestMemory still returns the stored version, and leaves a row naming it in
//      graph_extraction_retries, holding no text.
//   2. A pass extracts a due version from its stored text and removes the row; a failed
//      attempt keeps the row and doubles the wait; a row not yet due is left alone.
//   3. The row goes with its version: deleting the version removes it, and a version gone
//      before the failure is recorded leaves none.
//   4. Two passes at once never attempt one version twice.
// The memory service is mocked (it is not Postgres); the stored rows, the change feed and
// the retry rows are real.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";
import type { VersionTransaction } from "@/services/memory/pgvector-store";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-graph-retry";
const OTHER_ORG = "org-qa-graph-retry-other";
const SCOPE = "org_qa_graph_retry.eng";

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
        const id = `chunk-qa-graph-retry-${++stores.chunks}`;
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

describe.skipIf(!QA_URL)("graph extraction that fails after the write is acknowledged", () => {
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
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("INNGEST_BYPASS", "1");
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

  it("keeps a row naming the stored version, with no text, when extraction fails after the reply", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");

    const [row, ...rest] = await owed();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ chunkId: versionId, orgId: ORG, attempts: 1 });
    expect(row.lastError).toContain("503");
    expect(row.lastError).toContain("quota or spend limit is used up");
    expect(row.job).toMatchObject({ groupId: ORG, name: "Acme renewal", scopePath: SCOPE, readableId: versionId });
    expect(row.job).not.toHaveProperty("content");
    expect(row.job).not.toHaveProperty("occurredAt");
    expect(JSON.stringify(row.job)).not.toContain("40k");
    // The log line the production log check counts still says the ingest failed.
    expect(errors.mock.calls.flat().join(" ")).toContain(
      `[memory] ingest failed: graph extraction of version ${versionId} failed`,
    );
    errors.mockRestore();
  });

  it("keeps no row, and says so, when the failed ingest stored no version", async () => {
    // Extraction-provenance content gets no row (getsVectorRow): nothing names it to retry.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    refuseExtraction();

    const ack = await jobs.ingestMemory({ ...agentWrite("Acme is a Company."), actorType: "extraction" });

    // Outside a request scope the ingest ran before the call returned, and the ack says how it ended.
    expect(ack).toEqual({ readableNow: false, graphExtraction: "failed" });
    expect(await owed()).toEqual([]);
    const logged = errors.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[memory] ingest failed:");
    expect(logged).not.toContain("kept for another attempt");
    errors.mockRestore();
  });

  it("extracts a due version from its stored text on the next pass, and removes its row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const [row] = await owed();
    vi.mocked(memory.graphitiStore.ingest).mockReset().mockResolvedValue({ episodeId: "ep-extracted" });

    const pass = await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: row.nextAttemptAt });

    expect(pass).toEqual({ attempted: 1, extracted: 1, failed: 0 });
    expect(await owed()).toEqual([]);
    const graphWrite = vi.mocked(memory.graphitiStore.ingest).mock.calls.at(-1)![0];
    expect(graphWrite).toMatchObject({
      groupId: ORG,
      content: "Acme renewed at $40k ARR for 2027.",
      readableId: versionId,
      scopePath: SCOPE,
    });
    expect(graphWrite).not.toHaveProperty("occurredAt");
  });

  it("leaves a row that is not due yet, and doubles the wait after a failed attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const [row] = await owed();

    const early = await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, {
      now: new Date(row.nextAttemptAt.getTime() - 1),
    });
    expect(early).toEqual({ attempted: 0, extracted: 0, failed: 0 });

    const now = row.nextAttemptAt;
    const failed = await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now });
    expect(failed).toEqual({ attempted: 1, extracted: 0, failed: 1 });
    const [after] = await owed();
    expect(after.attempts).toBe(2);
    expect(after.nextAttemptAt.getTime()).toBe(now.getTime() + retry.retryDelayMs(2));
    expect(retry.retryDelayMs(2)).toBe(2 * retry.RETRY_BASE_DELAY_MS);
  });

  it("counts a second failure recorded by the request path as one more attempt on the same row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const [first] = await owed();
    const job = { ...agentWrite("Acme renewed at $40k ARR for 2027."), readableId: versionId };
    const now = new Date(first.nextAttemptAt.getTime() + 60_000);

    await retry.deferGraphExtraction(new retry.GraphExtractionError(job, new Error("still refused")), now);

    const [row] = await owed();
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe("still refused");
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + retry.retryDelayMs(2));
  });

  it("counts an attempt when it is claimed, so one the platform kills mid-step still backs off", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const [row] = await owed();
    const now = row.nextAttemptAt;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    // An attempt that never returns: the step was killed while it ran.
    void retry.retryDeferredGraphExtractions(() => (started(), new Promise<void>(() => {})), { now });
    await running;

    const [claimed] = await owed();
    expect(claimed.attempts).toBe(2);
    expect(claimed.nextAttemptAt.getTime()).toBe(now.getTime() + retry.retryDelayMs(2));
    const pastTheLease = new Date(now.getTime() + retry.RETRY_CLAIM_LEASE_MS + 60_000);
    const second = await retry.retryDeferredGraphExtractions(async () => {}, { now: pastTheLease });
    expect(second.attempted).toBe(0);
  });

  it("keeps a long-failing version's wait finite: no overflow at any attempt count", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    await db.$executeRaw`UPDATE graph_extraction_retries SET "attempts" = 1100 WHERE "chunkId" = ${versionId} AND "orgId" = ${ORG}`;
    const [row] = await owed();
    const job = { ...agentWrite("Acme renewed at $40k ARR for 2027."), readableId: versionId };
    await retry.deferGraphExtraction(new retry.GraphExtractionError(job, new Error("refused")), row.nextAttemptAt);
    const [after] = await owed();
    expect(after.attempts).toBe(1101);
    expect(after.nextAttemptAt.getTime()).toBe(row.nextAttemptAt.getTime() + retry.RETRY_MAX_DELAY_MS);

    const pass = await retry.retryDeferredGraphExtractions(async () => {}, { now: after.nextAttemptAt });
    expect(pass).toEqual({ attempted: 1, extracted: 1, failed: 0 });
  });

  it("caps the wait at RETRY_MAX_DELAY_MS", () => {
    expect(retry.retryDelayMs(1)).toBe(retry.RETRY_BASE_DELAY_MS);
    expect(retry.retryDelayMs(30)).toBe(retry.RETRY_MAX_DELAY_MS);
    expect(retry.retryDelayMs(5000)).toBe(retry.RETRY_MAX_DELAY_MS);
  });

  it("removes the row with its version, and records nothing for a version already gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    await db.$executeRaw`DELETE FROM memory_chunks WHERE id = ${versionId} AND "orgId" = ${ORG}`;
    expect(await owed()).toEqual([]);

    const job = { ...agentWrite("gone"), readableId: versionId };
    await retry.deferGraphExtraction(new retry.GraphExtractionError(job, new Error("refused")));
    expect(await owed()).toEqual([]);
  });

  it("never records a version under another org's id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    await db.$executeRaw`DELETE FROM graph_extraction_retries WHERE "chunkId" = ${versionId} AND "orgId" = ${ORG}`;

    const forged = { ...agentWrite("x", OTHER_ORG), readableId: versionId };
    await retry.deferGraphExtraction(new retry.GraphExtractionError(forged, new Error("refused")));

    expect(await owed(OTHER_ORG)).toEqual([]);
    expect(await owed(ORG)).toEqual([]);
  });

  it("settles a version deleted since its row was written without a graph write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versionId = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const [row] = await owed();
    // A delete whose cascade has not reached the retry row yet cannot happen in one
    // statement, so stand the row in for one: the job re-checks the version first.
    vi.mocked(memory.pgvectorStore.isStored).mockResolvedValueOnce(false);
    vi.mocked(memory.graphitiStore.ingest).mockReset();

    const pass = await retry.retryDeferredGraphExtractions(jobs.runMemoryIngest, { now: row.nextAttemptAt });

    expect(pass).toEqual({ attempted: 1, extracted: 1, failed: 0 });
    expect(memory.graphitiStore.ingest).not.toHaveBeenCalled();
    expect(await owed()).toEqual([]);
    expect(versionId).toBeTruthy();
  });

  it("finishes the pass when an org's deletion opens during a failed attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deleting = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const other = await acknowledgedButUnextracted("Globex churned in September.", OTHER_ORG);
    const due = new Date(
      Math.max(...[...(await owed()), ...(await owed(OTHER_ORG))].map((r) => r.nextAttemptAt.getTime())),
    );
    const attempted: string[] = [];
    try {
      const pass = await retry.retryDeferredGraphExtractions(
        async (job) => {
          attempted.push(job.readableId!);
          if (job.readableId !== deleting) return;
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
          throw new Error("refused");
        },
        { now: due },
      );

      expect(pass).toEqual({ attempted: 2, extracted: 1, failed: 1 });
      expect([...attempted].sort()).toEqual([deleting, other].sort());
    } finally {
      await db.$executeRaw`DELETE FROM org_deletions WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    }
  });

  it("passes over a row another pass holds instead of waiting for it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const held = await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027.");
    const free = await acknowledgedButUnextracted("Globex churned in September.");
    const due = new Date(Math.max(...(await owed()).map((r) => r.nextAttemptAt.getTime())));
    const attempted: string[] = [];
    let release!: () => void;
    const releasing = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // Another pass's claim, still open: it holds the lock on `held`'s row.
    const other = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM graph_extraction_retries WHERE "chunkId" = ${held} AND "orgId" = ${ORG} FOR UPDATE`;
        locked();
        await releasing;
      },
      { timeout: 20_000 },
    );
    await holding;

    const pass = await Promise.race([
      retry.retryDeferredGraphExtractions(async (job) => void attempted.push(job.readableId!), { now: due, limit: 1 }),
      // A pass that waited on the held row would hang until release(), so 15 s still tells
      // passing over from waiting, and a loaded machine's slow pass is not read as a wait.
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 15_000)),
    ]);
    release();
    await other;

    expect(pass).toEqual({ attempted: 1, extracted: 1, failed: 0 });
    expect(attempted).toEqual([free]);
  }, 30_000);

  it("never lets two passes at once attempt one version twice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const versions = [
      await acknowledgedButUnextracted("Acme renewed at $40k ARR for 2027."),
      await acknowledgedButUnextracted("Globex churned in September."),
      await acknowledgedButUnextracted("Initech signed a pilot."),
    ];
    const due = new Date(Math.max(...(await owed()).map((r) => r.nextAttemptAt.getTime())));
    const attempted: string[] = [];
    const slowExtract = async (job: IngestInput) => {
      attempted.push(job.readableId!);
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const passes = await Promise.all([
      retry.retryDeferredGraphExtractions(slowExtract, { now: due }),
      retry.retryDeferredGraphExtractions(slowExtract, { now: due }),
    ]);

    expect(passes[0].attempted + passes[1].attempted).toBe(3);
    expect([...attempted].sort()).toEqual([...versions].sort());
    expect(await owed()).toEqual([]);
  });
});
