// Write-through visibility.
//
// The claim: an ingest is readable and on the change feed when `ingestMemory`
// returns, before the queued graph extraction runs, and the queued job then
// writes only the graph: no second pgvector row, no second feed event. Every
// store and the queue are mocked; what is pinned is the order and the count of
// the writes, which is the whole fix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The real store's answer to a new row, for the store mock below.
const { storesNewRow } = await vi.hoisted(() => import("@/services/memory/pgvector-store.testsupport"));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1) }]),
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }) },
    contactIdempotencyKey: { updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
  },
}));
// The fact's `create` event is inserted once by the database (ON CONFLICT against a
// partial unique index), which a mocked client cannot run; the insert is observed here.
vi.mock("@/services/memory/change-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/change-events")>()),
  recordFactCreateOnce: vi.fn().mockResolvedValue({ id: "change_1", seq: BigInt(1) }),
}));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }),
    ingestBulk: vi.fn().mockResolvedValue([]),
  },
  pgvectorStore: {
    ingestOnce: vi.fn(storesNewRow("chunk_1")),
    // The row the request path stored is still there when the job runs.
    isStored: vi.fn().mockResolvedValue(true),
  },
  GraphitiMemoryStore: class {},
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn().mockResolvedValue(undefined),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/resolver", () => ({
  resolveEntities: vi.fn().mockResolvedValue({ resolvedText: "resolved" }),
}));
vi.mock("@/services/agents", () => ({ runResearchAgent: vi.fn(), runCopyAgent: vi.fn() }));
// The distiller is an LLM call; this is what it returns for the MCP-sized fact below.
const distillJson = JSON.stringify({
  facts: ["Acme renewed its contract with Willder."],
  entities: [{ name: "Acme", type: "Deal", description: "renewed in Q3" }],
  attributes: [],
});
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-extract",
  createLLMClient: () => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: distillJson } }] }),
      },
    },
  }),
}));

import { db } from "@/lib/db";
import { recordEpisode } from "@/services/guardrails";
import { recordFactCreateOnce } from "@/services/memory/change-events";
import { graphitiStore, memory, pgvectorStore } from "@/services/memory";
import type { IngestInput } from "@/types/memory";
import { WRITE_THROUGH_TIMEOUT_MS, ingestMemory, inngest, runMemoryIngest } from "./inngest";

function mcpWrite(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    groupId: "org_1",
    content: "Acme renewed its contract with Willder at $40k ARR.",
    name: "Acme",
    source: "mcp",
    actorType: "agent",
    origin: "mcp",
    actorId: "agent_ada",
    actorName: "MCP session",
    scopePath: "org_1.sales",
    ...overrides,
  };
}

/** The `data` of the one event `ingestMemory` queued. */
function queuedInput(): IngestInput {
  const calls = vi.mocked(inngest.send).mock.calls;
  expect(calls).toHaveLength(1);
  const sent = calls[0]![0] as { name: string; data: IngestInput };
  return sent.data;
}

// Every default is re-set here, not only cleared: a test that makes a store fail
// must not leak that failure into the next one.
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
  vi.mocked(pgvectorStore.ingestOnce).mockImplementation(storesNewRow("chunk_1"));
  vi.mocked(graphitiStore.ingest).mockResolvedValue({ episodeId: "ep-graph" });
  vi.mocked(memory.ingest).mockResolvedValue({ episodeId: "ep-hybrid" });
  vi.mocked(db.$queryRaw).mockResolvedValue([{ next: BigInt(1) }]);
  vi.mocked(recordFactCreateOnce).mockResolvedValue({ id: "change_1", seq: BigInt(1) });
  delete process.env.INNGEST_BYPASS;
});

describe("ingestMemory: an agent's write is readable before the job runs", () => {
  it("stores the pgvector row and announces it before queueing, and says so", async () => {
    const order: string[] = [];
    vi.mocked(pgvectorStore.ingestOnce).mockImplementation(async (...args) => {
      order.push("pgvector");
      return storesNewRow("chunk_1")(...args);
    });
    vi.mocked(recordFactCreateOnce).mockImplementation(async () => {
      order.push("announce");
      return { id: "change_1", seq: BigInt(1) };
    });
    vi.mocked(inngest.send).mockImplementation(async () => {
      order.push("queue");
      return { ids: [] };
    });

    const ack = await ingestMemory(mcpWrite());

    expect(ack).toEqual({ readableNow: true, versionId: "chunk_1" });
    expect(order).toEqual(["pgvector", "announce", "queue"]);
    expect(recordFactCreateOnce).toHaveBeenCalledTimes(1);
    expect(recordFactCreateOnce).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: "org_1", scopePath: "org_1.sales", recordId: "chunk_1", actorId: "agent_ada" }),
    );
    expect(queuedInput().readableId).toBe("chunk_1");
    // Nothing touched the graph on the request path: that is the slow part.
    expect(graphitiStore.ingest).not.toHaveBeenCalled();
    expect(memory.ingest).not.toHaveBeenCalled();
  });

  it("a replay of a stored fact writes no event, queues no job, counts no episode, and confirms delivery", async () => {
    vi.mocked(pgvectorStore.ingestOnce).mockResolvedValue({ episodeId: "chunk_1", inserted: false });
    const confirmDelivery = { kind: "contact-idempotency-key" as const, orgId: "org_1", key: "idem_1" };

    const ack = await ingestMemory(mcpWrite({ confirmDelivery }));

    expect(ack).toEqual({ readableNow: true, versionId: "chunk_1" });
    expect(recordFactCreateOnce).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
    expect(recordEpisode).not.toHaveBeenCalled();
    expect(db.contactIdempotencyKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org_1", key: "idem_1", ingestedAt: null } }),
    );
  });

  it("falls back to the queued announcement when the pgvector write fails", async () => {
    vi.mocked(pgvectorStore.ingestOnce).mockRejectedValue(new Error("insert failed"));

    const ack = await ingestMemory(mcpWrite());

    expect(ack).toEqual({ readableNow: false });
    expect(recordFactCreateOnce).not.toHaveBeenCalled();
    expect(queuedInput().readableId).toBeUndefined();
  });

  // 2026-10-14: the memory service stopped answering, and every memory_ingest through
  // /api/mcp waited on its embedding until the function was killed at maxDuration.
  it("stops waiting on an embedding that never comes back, and leaves the write to the job", async () => {
    vi.useFakeTimers();
    try {
      // A memory service that accepts the request and never answers: only an abort ends it.
      vi.mocked(pgvectorStore.ingestOnce).mockImplementation(
        (_input, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal!.reason));
          }),
      );

      const pending = ingestMemory(mcpWrite());
      await vi.advanceTimersByTimeAsync(WRITE_THROUGH_TIMEOUT_MS);
      const ack = await pending;

      expect(WRITE_THROUGH_TIMEOUT_MS).toBeLessThan(30_000);
      expect(ack).toEqual({ readableNow: false });
      expect(recordFactCreateOnce).not.toHaveBeenCalled();
      expect(queuedInput().readableId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not announce when the feed write fails, and leaves the job to announce", async () => {
    vi.mocked(recordFactCreateOnce).mockRejectedValue(new Error("feed down"));

    const ack = await ingestMemory(mcpWrite());

    expect(ack).toEqual({ readableNow: false });
    expect(queuedInput().readableId).toBeUndefined();
  });

  it("leaves human content that the resolver rewrites to the job, as before", async () => {
    const ack = await ingestMemory(mcpWrite({ actorType: "human", source: "text" }));

    expect(ack).toEqual({ readableNow: false });
    expect(pgvectorStore.ingestOnce).not.toHaveBeenCalled();
    expect(recordFactCreateOnce).not.toHaveBeenCalled();
    expect(queuedInput().readableId).toBeUndefined();
  });

  it("stores human content that skips the resolver", async () => {
    const ack = await ingestMemory(mcpWrite({ actorType: "human", source: "text", resolve: false }));

    expect(ack).toEqual({ readableNow: true, versionId: "chunk_1" });
    expect(pgvectorStore.ingestOnce).toHaveBeenCalledTimes(1);
  });

  it("never stores extraction content in pgvector, matching the hybrid store", async () => {
    const ack = await ingestMemory(mcpWrite({ actorType: "extraction", source: "text" }));

    expect(ack).toEqual({ readableNow: false });
    expect(pgvectorStore.ingestOnce).not.toHaveBeenCalled();
  });
});

describe("the queued job after a write-through: graph only, announced once", () => {
  it("distilled branch (an MCP fact): writes the raw episode to the graph store, not the hybrid store", async () => {
    const raw = mcpWrite().content;
    await runMemoryIngest(mcpWrite({ readableId: "chunk_1" }));

    // The entity seed takes its own store write; the distilled fact is a derived record,
    // which goes to the graph only.
    const hybridWrites = vi.mocked(memory.ingest).mock.calls.map(([input]) => input.content);
    expect(hybridWrites).toHaveLength(1);
    expect(hybridWrites).not.toContain(raw);
    const graphWrites = vi.mocked(graphitiStore.ingest).mock.calls.map(([input]) => input);
    expect(graphWrites.map((input) => input.content)).toContain("Acme renewed its contract with Willder.");
    // The raw content's own episode is written to the graph only, once.
    expect(graphWrites.filter((input) => input.content === raw)).toEqual([
      expect.objectContaining({ readableId: "chunk_1" }),
    ]);
    expect(pgvectorStore.ingestOnce).not.toHaveBeenCalled();
    expect(recordFactCreateOnce).not.toHaveBeenCalled();
  });

  it("standard branch (short agent output): same rule", async () => {
    await runMemoryIngest(mcpWrite({ source: "agent", content: "Acme renewed.", readableId: "chunk_1" }));

    expect(graphitiStore.ingest).toHaveBeenCalledTimes(1);
    expect(memory.ingest).not.toHaveBeenCalled();
    expect(recordFactCreateOnce).not.toHaveBeenCalled();
  });

  it("never hands a writer's occurredAt to the graph, while the queued vector row keeps it", async () => {
    const dated = { occurredAt: "2020-01-01T00:00:00.000Z" };
    await runMemoryIngest(mcpWrite({ ...dated, readableId: "chunk_1" }));
    await runMemoryIngest(mcpWrite({ ...dated, source: "agent", content: "Acme renewed." }));

    const graphWrites = [
      ...vi.mocked(graphitiStore.ingest).mock.calls.map(([input]) => input),
      ...vi.mocked(graphitiStore.ingestBulk).mock.calls.flatMap(([inputs]) => inputs),
      ...vi.mocked(memory.ingest).mock.calls.map(([input]) => input),
    ];
    expect(graphWrites.length).toBeGreaterThan(0);
    for (const input of graphWrites) expect(input).not.toHaveProperty("occurredAt");
    expect(vi.mocked(pgvectorStore.ingestOnce).mock.calls.map(([input]) => input.occurredAt)).toEqual([
      dated.occurredAt,
    ]);
  });

  it("without a readableId the job stores the row by its content key and the episode, and announces the row", async () => {
    await runMemoryIngest(mcpWrite({ source: "agent", content: "Acme renewed." }));

    expect(pgvectorStore.ingestOnce).toHaveBeenCalledTimes(1);
    expect(graphitiStore.ingest).toHaveBeenCalledTimes(1);
    expect(memory.ingest).not.toHaveBeenCalled();
    expect(recordFactCreateOnce).toHaveBeenCalledTimes(1);
    expect(recordFactCreateOnce).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordId: "chunk_1" }),
    );
  });
});

describe("a write that skips graph extraction (a session-state capture, mcp/session-capture.ts)", () => {
  it("is stored and announced on the request path, and queues no graph job", async () => {
    const ack = await ingestMemory(mcpWrite({ skipGraphExtraction: true }));

    expect(ack).toEqual({ readableNow: true, versionId: "chunk_1" });
    expect(recordFactCreateOnce).toHaveBeenCalledTimes(1);
    expect(recordFactCreateOnce).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordId: "chunk_1" }),
    );
    expect(inngest.send).not.toHaveBeenCalled();
    // Still counted against the org's episode cap: skipping extraction is not a way around it.
    expect(recordEpisode).toHaveBeenCalledTimes(1);
  });

  it("when the request path could not store it, the queued job stores and announces it, and writes nothing to the graph", async () => {
    vi.mocked(pgvectorStore.ingestOnce).mockRejectedValueOnce(new Error("insert failed"));

    await ingestMemory(mcpWrite({ skipGraphExtraction: true }));
    await runMemoryIngest(queuedInput());

    expect(pgvectorStore.ingestOnce).toHaveBeenCalledTimes(2);
    expect(recordFactCreateOnce).toHaveBeenCalledTimes(1);
    expect(recordFactCreateOnce).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordId: "chunk_1" }),
    );
    expect(graphitiStore.ingest).not.toHaveBeenCalled();
    expect(graphitiStore.ingestBulk).not.toHaveBeenCalled();
    expect(memory.ingest).not.toHaveBeenCalled();
  });
});

describe("ingestMemory: a queue nobody is listening on names its fix", () => {
  afterEach(() => vi.unstubAllEnvs());

  function refused(): Error {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
  }

  it("says to start the Inngest dev server when the local one is not running", async () => {
    vi.stubEnv("INNGEST_DEV", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.mocked(inngest.send).mockRejectedValue(refused());

    await expect(ingestMemory(mcpWrite())).rejects.toThrow(
      "Could not queue the write: no Inngest dev server is answering. Start one with: npx inngest-cli@latest dev (docs/development.md, Full path, step 6).",
    );
  });

  it("leaves any other queue failure as it was", async () => {
    vi.stubEnv("INNGEST_DEV", "");
    vi.mocked(inngest.send).mockRejectedValue(refused());

    await expect(ingestMemory(mcpWrite())).rejects.toThrow(/^fetch failed$/);
  });
});
