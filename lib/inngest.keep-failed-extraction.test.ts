// What the request-path ingest (INNGEST_BYPASS, run in `after()`) does when the ingest it ran
// after replying fails: a stored version whose graph extraction failed is handed to
// deferGraphExtraction, which keeps it for another attempt; any other failure, and a failure
// to keep it, is logged and never reaches the caller, which was already answered. Every log
// line starts "[memory] ingest failed", which the production log check counts. The real
// retry table is covered in lib/inngest.graph-extraction-retry.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real store's answer to a new row, for the store mock below.
const { storesNewRow } = await vi.hoisted(() => import("@/services/memory/pgvector-store.testsupport"));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1) }]),
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }), findFirst: vi.fn().mockResolvedValue(null) },
    contactIdempotencyKey: { updateMany: vi.fn() },
    org: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
  },
}));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: { ingest: vi.fn(), ingestBulk: vi.fn() },
  pgvectorStore: {
    ingestOnce: vi.fn(storesNewRow("chunk-1")),
    isStored: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock("@/services/memory/graph-extraction-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-extraction-retry")>()),
  deferGraphExtraction: vi.fn(),
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));
vi.mock("@/services/resolver", () => ({ resolveEntities: vi.fn() }));
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-extract",
  createLLMClient: () => ({ chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no model")) } } }),
}));

import { graphitiStore, pgvectorStore } from "@/services/memory";
import { GraphExtractionError, deferGraphExtraction } from "@/services/memory/graph-extraction-retry";
import { ingestMemory } from "./inngest";
import type { IngestInput } from "@/types/memory";

const write = (overrides: Partial<IngestInput> = {}): IngestInput => ({
  groupId: "org_1",
  content: "Acme renewed at $40k ARR.",
  source: "text",
  name: "Acme renewal",
  actorType: "agent",
  origin: "mcp",
  actorId: "agent_1",
  scopePath: "org_1.eng",
  ...overrides,
});

describe("the request-path ingest after a failure", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  const logged = () => errors.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INNGEST_BYPASS", "1");
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("hands a stored version whose extraction failed to deferGraphExtraction, and still acknowledges the write", async () => {
    const refusal = new Error("memory service /ingest failed: graph extraction unavailable");
    vi.mocked(graphitiStore.ingest).mockRejectedValueOnce(refusal);

    const ack = await ingestMemory(write());

    expect(ack).toEqual({ readableNow: true, versionId: "chunk-1" });
    expect(deferGraphExtraction).toHaveBeenCalledTimes(1);
    const kept = vi.mocked(deferGraphExtraction).mock.calls[0][0];
    expect(kept).toBeInstanceOf(GraphExtractionError);
    expect(kept.job).toMatchObject({ readableId: "chunk-1", groupId: "org_1", name: "Acme renewal" });
    expect(kept.cause).toBe(refusal);
    expect(logged()).toContain(
      "[memory] ingest failed: graph extraction of version chunk-1 failed: memory service /ingest failed",
    );
    expect(logged()).toContain("kept for another attempt");
  });

  it("logs, and still acknowledges, when the version cannot be kept for another attempt", async () => {
    vi.mocked(graphitiStore.ingest).mockRejectedValueOnce(new Error("refused"));
    vi.mocked(deferGraphExtraction).mockRejectedValueOnce(new Error("postgres down"));

    await expect(ingestMemory(write())).resolves.toMatchObject({ readableNow: true });

    expect(logged()).toContain(
      "[memory] ingest failed: graph extraction of version chunk-1 failed: refused; could not keep it for another attempt",
    );
    expect(logged()).toContain("postgres down");
  });

  it("keeps nothing for a failure before any graph step", async () => {
    vi.mocked(pgvectorStore.isStored).mockRejectedValueOnce(new Error("lookup failed"));

    await ingestMemory(write());

    expect(deferGraphExtraction).not.toHaveBeenCalled();
    expect(logged()).toContain("[memory] ingest failed: Error: lookup failed");
  });

  it("keeps nothing for content that got no stored row", async () => {
    vi.mocked(graphitiStore.ingest).mockRejectedValueOnce(new Error("refused"));

    await expect(ingestMemory(write({ actorType: "extraction" }))).resolves.toEqual({ readableNow: false });

    expect(deferGraphExtraction).not.toHaveBeenCalled();
    expect(logged()).toContain("[memory] ingest failed: Error: refused");
  });
});
