// The applied-change audit tag survives the whole ingest pipeline.
//
// The auditTag test in app/api/fact-governance-routes.test.ts stops
// at the call boundary: it asserts `ingestMemory` was handed
// `auditTag: "brief:brief_1"`. That does not establish the thing staleness
// actually depends on — that the tag survives IngestInput -> recordIngestApplied
// -> recordAppliedChange and lands as the EXACT target string
// GET /api/briefs/:id/staleness excludes as a self-write.
//
// That string is built independently in two files. If either drifts, a brief
// silently flags itself stale against its own just-accepted content, which is
// the user-visible bug the exclusion exists to prevent. This file pins both
// halves against each other through the real, unmocked pipeline.
//
// It also covers the distilled branch of runMemoryIngest, whose applied-row
// call site no other test exercises.
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real store's answer to a new row, for the store mock below.
const { storesNewRow } = await vi.hoisted(() => import("@/services/memory/pgvector-store.testsupport"));

vi.mock("@/lib/db", () => ({
  db: {
    // The applied row commits in one transaction with the fact's change event
    // (services/memory/fact-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1), id: "change_1", seq: BigInt(1) }]),
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }), findFirst: vi.fn().mockResolvedValue(null) },
    contactIdempotencyKey: { updateMany: vi.fn() },
    org: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
  },
}));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-1" }) },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
  pgvectorStore: {
    ingestOnce: vi.fn(storesNewRow("chunk-1")),
    isStored: vi.fn().mockResolvedValue(true),
  },
  GraphitiMemoryStore: class {},
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/resolver", () => ({ resolveEntities: vi.fn() }));
vi.mock("@/services/agents", () => ({ runResearchAgent: vi.fn(), runCopyAgent: vi.fn() }));
// Drive distillFacts() deterministically without a real LLM call.
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
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: distillJson } }],
        }),
      },
    },
  }),
}));

import { db } from "@/lib/db";
import { graphitiStore, memory, pgvectorStore } from "@/services/memory";
import { runMemoryIngest } from "./inngest";
import type { IngestInput } from "@/types/memory";

const SCOPE = "org_1.engineering";
const BRIEF_ID = "brief_1";

// EXACTLY how app/api/briefs/[id]/staleness/route.ts builds `selfWriteTarget`.
// Kept as a local literal on purpose: importing the route's private constant
// would let both sides drift together and still read green.
const STALENESS_SELF_WRITE_TARGET = `${SCOPE}/brief:${BRIEF_ID}`;

function briefWriteInput(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    groupId: "org_1",
    content: "Acme renewed at $40k ARR.",
    source: "text",
    name: "Brief: Q3 renewals",
    actorType: "agent",
    origin: "mcp",
    actorId: "agent_1",
    actorName: "Agent",
    scopePath: SCOPE,
    // What POST /api/briefs/:id/persist and /correct both now pass.
    auditTag: `brief:${BRIEF_ID}`,
    ...overrides,
  };
}

function appliedRow() {
  const call = vi
    .mocked(db.auditLog.create)
    .mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((d) => String(d.action).endsWith(".applied"));
  return call;
}

beforeEach(() => vi.clearAllMocks());

describe("auditTag -> applied row -> staleness self-write exclusion", () => {
  it("lands the persist/correct tag as the exact target the staleness route excludes", async () => {
    await runMemoryIngest(briefWriteInput());

    const row = appliedRow();
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      action: "memory.write.applied",
      decision: "allow",
    });
    // The assertion that actually protects the user-visible behavior.
    expect(row!.target).toBe(STALENESS_SELF_WRITE_TARGET);
  });

  it("an untagged write records the bare scope path, so it is NOT excluded and does flag staleness", async () => {
    await runMemoryIngest(briefWriteInput({ auditTag: undefined }));

    const row = appliedRow();
    expect(row!.target).toBe(SCOPE);
    expect(row!.target).not.toBe(STALENESS_SELF_WRITE_TARGET);
  });

  it("distilled branch: records the applied row after the text's row and before any graph write, with the tag intact", async () => {
    const long = "The Acme renewal closed at forty thousand ARR. ".repeat(10);
    const { resolveEntities } = await import("@/services/resolver");
    vi.mocked(resolveEntities).mockResolvedValue({ resolvedText: long } as never);

    await runMemoryIngest(briefWriteInput({ content: long, actorType: "human", actorId: "user_1" }));

    // The distilled branch really ran: the seed through the hybrid store, the raw
    // content's row and episode, and the distilled fact to the graph, not a single write.
    expect(memory.ingest).toHaveBeenCalled();
    expect(pgvectorStore.ingestOnce).toHaveBeenCalled();
    expect(vi.mocked(graphitiStore.ingest).mock.calls.length).toBeGreaterThan(1);
    const row = appliedRow();
    expect(row).toBeDefined();
    expect(row!.target).toBe(STALENESS_SELF_WRITE_TARGET);
    // The text is stored and announced first, so a graph step that fails for good
    // cannot lose it (lib/inngest.store-before-graph.realdb.test.ts).
    const rowWrite = vi.mocked(pgvectorStore.ingestOnce).mock.invocationCallOrder[0];
    const firstGraphWrite = Math.min(
      ...vi.mocked(memory.ingest).mock.invocationCallOrder,
      ...vi.mocked(graphitiStore.ingest).mock.invocationCallOrder,
    );
    const appliedOrder = vi.mocked(db.auditLog.create).mock.invocationCallOrder[0];
    expect(rowWrite).toBeLessThan(appliedOrder);
    expect(appliedOrder).toBeLessThan(firstGraphWrite);
  });

  it("a failed row write records no applied row (the retry-exhaustion analog)", async () => {
    vi.mocked(pgvectorStore.ingestOnce).mockRejectedValueOnce(new Error("postgres down"));

    await expect(runMemoryIngest(briefWriteInput({ actorType: "human", resolve: false }))).rejects.toThrow(
      "postgres down",
    );
    expect(appliedRow()).toBeUndefined();
    expect(graphitiStore.ingest).not.toHaveBeenCalled();
  });

  it("a failed graph write keeps the applied row of the text it already stored", async () => {
    vi.mocked(graphitiStore.ingest).mockRejectedValueOnce(new Error("graphiti down"));

    await expect(runMemoryIngest(briefWriteInput({ actorType: "human", resolve: false }))).rejects.toThrow(
      "graphiti down",
    );
    expect(appliedRow()!.target).toBe(STALENESS_SELF_WRITE_TARGET);
  });

  it("content with no row of its own records its applied row only after its graph episode lands", async () => {
    vi.mocked(graphitiStore.ingest).mockRejectedValueOnce(new Error("graphiti down"));

    await expect(runMemoryIngest(briefWriteInput({ actorType: "extraction" }))).rejects.toThrow("graphiti down");
    expect(appliedRow()).toBeUndefined();
    expect(pgvectorStore.ingestOnce).not.toHaveBeenCalled();
  });
});
