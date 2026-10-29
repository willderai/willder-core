// The Inngest job `memoryIngest` records the applied-change row after the real
// store write.
//
// `recordIngestApplied`'s two `runMemoryIngest` call sites have their own
// tests; the two inside the job are covered here, and the job is the path that
// runs in production: `ingestMemory()` only takes `runMemoryIngest` under
// `INNGEST_BYPASS=1` (dev/scripts), everything else goes through
// `inngest.send()` -> this job. A regression that dropped or reordered the
// `record-applied-change` step on that async fire-and-forget path would
// otherwise ship silently.
//
// No other test invokes the job handler, so
// `inngest` itself is mocked to hand back the raw handler, and `step.run` is
// a pass-through shim that records call order. That order is the assertion:
// the applied row lands AFTER the write that makes the content readable, never
// beside it: the content's own row when it has one (before any graph write, so
// a graph outage cannot lose it), otherwise its graph episode.
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real store's answer to a new row, for the store mock below.
const { storesNewRow } = await vi.hoisted(() => import("@/services/memory/pgvector-store.testsupport"));

const calls: string[] = [];

vi.mock("inngest", () => ({
  Inngest: class {
    createFunction(_opts: unknown, handler: unknown) {
      return { handler };
    }
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    // The applied row commits in one transaction with the fact's change event
    // (services/memory/fact-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1) }]),
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }) },
    contactIdempotencyKey: { updateMany: vi.fn() },
    org: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: {
      create: vi.fn().mockImplementation((args: { data: { action: string } }) => {
        calls.push(`audit:${args.data.action}`);
        return Promise.resolve({ id: "audit_1" });
      }),
    },
  },
}));
// The fact's `create` event is inserted once by the database (ON CONFLICT against a
// partial unique index), which a mocked client cannot run; the insert is observed here.
vi.mock("@/services/memory/change-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/change-events")>()),
  recordFactCreateOnce: vi.fn().mockResolvedValue({ id: "change_1", seq: BigInt(1) }),
}));
vi.mock("@/services/memory", () => ({
  memory: {
    ingest: vi.fn().mockImplementation(() => {
      calls.push("store:ingest");
      return Promise.resolve({ episodeId: "ep-1" });
    }),
  },
  graphitiStore: {
    ingest: vi.fn().mockImplementation(() => {
      calls.push("store:ingest");
      return Promise.resolve({ episodeId: "ep-1" });
    }),
    ingestBulk: vi.fn(),
  },
  pgvectorStore: {
    ingestOnce: vi.fn(async (...args: Parameters<ReturnType<typeof storesNewRow>>) => {
      calls.push("store:row");
      return storesNewRow("chunk-1")(...args);
    }),
    isStored: vi.fn().mockResolvedValue(true),
  },
  GraphitiMemoryStore: class {},
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/resolver", () => ({ resolveEntities: vi.fn() }));
vi.mock("@/services/agents", () => ({ runResearchAgent: vi.fn(), runCopyAgent: vi.fn() }));

const distillJson = JSON.stringify({
  facts: ["Acme renewed its contract with Willder."],
  entities: [],
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
import { recordFactCreateOnce } from "@/services/memory/change-events";
import { pgvectorStore } from "@/services/memory";
import { memoryIngest } from "./inngest";
import type { IngestInput } from "@/types/memory";

const SCOPE = "org_1.engineering";
const BRIEF_ID = "brief_1";
// Built the same way app/api/briefs/[id]/staleness/route.ts builds its
// self-write exclusion target, as a local literal so the two can't drift
// together and still read green.
const STALENESS_SELF_WRITE_TARGET = `${SCOPE}/brief:${BRIEF_ID}`;

// Pass-through `step.run`: runs the real work, keeps the real ordering.
const step = { run: (_name: string, fn: () => unknown) => Promise.resolve(fn()) };

type Handler = (arg: { event: { data: IngestInput }; step: typeof step }) => Promise<unknown>;
const handler = (memoryIngest as unknown as { handler: Handler }).handler;

function input(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    groupId: "org_1",
    actorType: "extraction",
    actorId: "agent_1",
    content: "Acme renewed.",
    scopePath: SCOPE,
    ...overrides,
  } as IngestInput;
}

async function run(data: IngestInput) {
  return handler({ event: { data }, step });
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("memoryIngest for a write that skips graph extraction", () => {
  it("stores the row and records the applied change, and makes no graph write", async () => {
    await run(input({ actorType: "agent", content: "Session state: tests pass.", skipGraphExtraction: true }));

    expect(calls).toEqual(["store:row", "audit:memory.write.applied"]);
    expect(pgvectorStore.ingestOnce).toHaveBeenCalledTimes(1);
  });
});

describe("memoryIngest (the Inngest job — the production ingest path)", () => {
  it("standard path: writes memory.write.applied AFTER the real store write, not before", async () => {
    await run(input());

    expect(calls).toContain("audit:memory.write.applied");
    expect(calls.indexOf("store:ingest")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("audit:memory.write.applied")).toBeGreaterThan(calls.lastIndexOf("store:ingest"));
  });

  it("standard path: records the applied row at the input's own scopePath", async () => {
    await run(input());

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "memory.write.applied",
          decision: "allow",
          target: SCOPE,
        }),
      }),
    );
  });

  it("standard path: an auditTag lands as the EXACT target the staleness read excludes", async () => {
    await run(input({ auditTag: `brief:${BRIEF_ID}` } as Partial<IngestInput>));

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "memory.write.applied",
          target: STALENESS_SELF_WRITE_TARGET,
        }),
      }),
    );
  });

  it("standard path: falls back to the org root when the input carries no scopePath", async () => {
    await run(input({ scopePath: undefined }));

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "memory.write.applied",
          target: "org_org_1",
        }),
      }),
    );
  });

  it("distilled path: writes memory.write.applied after the content's row and before any graph write", async () => {
    // Long human content is what trips shouldDistillContent() into the
    // distill branch.
    await run(input({ actorType: "human", resolve: false, content: "x".repeat(4000) }));

    expect(calls.slice(0, 2)).toEqual(["store:row", "audit:memory.write.applied"]);
    expect(calls.slice(2)).toContain("store:ingest");
  });

  it("announces the fact on the change feed as the episode the store returned", async () => {
    await run(input({ content: "Acme renewed.\nsecond line" }));

    expect(recordFactCreateOnce).toHaveBeenCalledTimes(1);
    expect(recordFactCreateOnce).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org_1",
        scopePath: SCOPE,
        recordId: "ep-1",
        actorId: "agent_1",
        title: "Acme renewed.\nsecond line",
      }),
    );
  });

  it("distilled path: announces the fact once, not once per distilled sentence, as the row that holds it", async () => {
    await run(input({ actorType: "human", resolve: false, content: "x".repeat(4000) }));

    expect(recordFactCreateOnce).toHaveBeenCalledTimes(1);
    expect(recordFactCreateOnce).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordId: "chunk-1" }),
    );
  });

  it("no applied row is written when the real store write throws", async () => {
    const { graphitiStore } = await import("@/services/memory");
    vi.mocked(graphitiStore.ingest).mockRejectedValueOnce(new Error("graphiti down"));

    await expect(run(input())).rejects.toThrow("graphiti down");
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(recordFactCreateOnce).not.toHaveBeenCalled();
  });
});
