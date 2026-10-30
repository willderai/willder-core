// Fact fidelity for a decision written through memory_ingest.
//
// The sentence "Jordan decided on 2026-09-24 that every crew run reads Willder
// memory ..." must not come back from memory as two facts nobody can use:
// "Jordan is a Decision that specifies operational procedures for crew runs"
// and "Willder memory is a Project that involves data management for crew
// runs". That loses what was decided, when, and by whom, and types a person as
// a Decision. These tests run that exact sentence through the real ingest
// pipeline with the distiller's model mocked, and pin what reaches the store.
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real store's answer to a new row, for the store mock below.
const { storesNewRow } = await vi.hoisted(() => import("@/services/memory/pgvector-store.testsupport"));

vi.mock("@/lib/db", () => ({
  db: {
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

const distillerReply = vi.fn<() => string>();
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-extract",
  createLLMClient: () => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: distillerReply() } }] })),
      },
    },
  }),
}));

import { graphitiStore, memory } from "@/services/memory";
import { memoryIngest, runMemoryIngest } from "./inngest";
import type { IngestInput } from "@/types/memory";

// Exactly what scripts/willder-memory.mjs sent: the sentence plus its suffix.
const WRITTEN =
  "Jordan decided on 2026-09-24 that every crew run reads Willder memory after its control check " +
  "and writes real decisions and handoffs before its run-end row, measuring whether a read " +
  "changed the run action (recorded by claude)";

const DECIDED =
  "every crew run reads Willder memory after its control check and writes real decisions and " +
  "handoffs before its run-end row, measuring whether a read changed the run action";

/** memory_ingest's own input (mcp/tools.ts), for this write. */
function mcpWrite(content = WRITTEN): IngestInput {
  return {
    groupId: "org_1",
    content,
    name: "crew memory protocol",
    actorType: "agent",
    origin: "mcp",
    actorId: "agent_claude",
    actorName: "MCP session",
    source: "mcp",
    scopePath: "org_1.crew.docs",
  };
}

/** The handler `inngest.createFunction` wraps (inngest 4.5.0 keeps it on `fn`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memoryIngestHandler = (memoryIngest as any).fn as (ctx: {
  event: { data: IngestInput };
  step: { run: (id: string, cb: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

/** Runs every step once, in order, recording the id of the step each store write happened in. */
function recordingStep() {
  const writeStep = new Map<IngestInput, string>();
  let current: string | undefined;
  return {
    writeStep,
    run: async (id: string, cb: () => unknown) => {
      current = id;
      const before = new Set(storedWrites());
      const out = await cb();
      for (const write of storedWrites()) if (!before.has(write)) writeStep.set(write, current);
      return out;
    },
  };
}

function reply(body: Record<string, unknown>): string {
  return JSON.stringify({ facts: [], entities: [], attributes: [], decisions: [], ...body });
}

/** Every write that reached a store: through the hybrid store, or to the graph alone. */
function storedWrites(): IngestInput[] {
  return [...vi.mocked(memory.ingest).mock.calls, ...vi.mocked(graphitiStore.ingest).mock.calls].map((call) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a decision written through memory_ingest", () => {
  it("is stored as a Decision fact with its actor, date and content intact", async () => {
    distillerReply.mockReturnValue(reply({ decisions: [{ decision: DECIDED, actor: "Jordan", date: "2026-09-24" }] }));

    await runMemoryIngest(mcpWrite());

    const decisions = storedWrites().filter((w) => w.recordType === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.content).toBe(`Decision by Jordan on 2026-09-24: ${DECIDED}.`);
    // At the writer's own provenance, not demoted to extraction tier.
    expect(decisions[0]).toMatchObject({ actorType: "agent", actorId: "agent_claude", scopePath: "org_1.crew.docs" });
  });

  it("does not store the observed mistyped seeds, and still stores the decision beside them", async () => {
    // The model's raw output for this sentence, in the structured form it is asked for.
    distillerReply.mockReturnValue(
      reply({
        entities: [
          { name: "Jordan", type: "Decision", description: "specifies operational procedures for crew runs" },
          { name: "Willder memory", type: "Project", description: "involves data management for crew runs" },
        ],
        decisions: [{ decision: DECIDED, actor: "Jordan", date: "2026-09-24" }],
      }),
    );

    await runMemoryIngest(mcpWrite());

    const contents = storedWrites().map((w) => w.content);
    expect(contents.some((c) => c.startsWith("Jordan is a"))).toBe(false);
    expect(contents).toContain(`Decision by Jordan on 2026-09-24: ${DECIDED}.`);
  });

  it("drops a decision the model reworded instead of storing its paraphrase", async () => {
    distillerReply.mockReturnValue(
      reply({
        facts: ["Jordan set a memory procedure for crew runs."],
        decisions: [{ decision: "crew runs must use Willder memory operationally", actor: "Jordan" }],
      }),
    );

    await runMemoryIngest(mcpWrite());

    expect(storedWrites().filter((w) => w.recordType === "decision")).toEqual([]);
    // The source itself is still stored whole, as it always was.
    expect(storedWrites().map((w) => w.content)).toContain(WRITTEN);
  });

  it("is distilled even when short, because memory_ingest is a deliberate write", async () => {
    const short = "Jordan decided on 2026-09-24 that crew runs read memory first.";
    distillerReply.mockReturnValue(
      reply({ decisions: [{ decision: "crew runs read memory first", actor: "Jordan", date: "2026-09-24" }] }),
    );

    await runMemoryIngest(mcpWrite(short));

    expect(distillerReply).toHaveBeenCalledTimes(1);
    expect(storedWrites().map((w) => w.content)).toContain(
      "Decision by Jordan on 2026-09-24: crew runs read memory first.",
    );
  });

  it("keeps the length gate for other short agent output", async () => {
    await runMemoryIngest({ ...mcpWrite("Acme renewed at $40k ARR."), source: "text" });

    expect(distillerReply).not.toHaveBeenCalled();
    expect(storedWrites()).toHaveLength(1);
  });
});

// The queued path. runMemoryIngest above is the inline copy of this pipeline; the
// Inngest function repeats the same steps, so its decision write needs its own test.
describe("a decision written through the queued memoryIngest function", () => {
  it("is stored verbatim as a Decision fact in the graphiti-add-decisions step", async () => {
    distillerReply.mockReturnValue(reply({ decisions: [{ decision: DECIDED, actor: "Jordan", date: "2026-09-24" }] }));
    const step = recordingStep();

    const result = await memoryIngestHandler({ event: { data: mcpWrite() }, step });

    const decisions = storedWrites().filter((w) => w.recordType === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      content: `Decision by Jordan on 2026-09-24: ${DECIDED}.`,
      actorType: "agent",
      actorId: "agent_claude",
      scopePath: "org_1.crew.docs",
    });
    expect(step.writeStep.get(decisions[0]!)).toBe("graphiti-add-decisions");
    expect(result).toMatchObject({ decisionCount: 1 });
  });

  it("stores the decision in the graph only, so no pgvector row reads as a version of the fact", async () => {
    // A pgvector row under the fact's name, with the writer's id, is read as one more
    // version of that fact (services/memory/conflict.ts, services/memory/fact-reads.ts).
    distillerReply.mockReturnValue(reply({ decisions: [{ decision: DECIDED }] }));

    await memoryIngestHandler({ event: { data: mcpWrite() }, step: recordingStep() });

    const throughHybrid = vi.mocked(memory.ingest).mock.calls.map(([input]) => input);
    expect(throughHybrid.filter((input) => input.recordType === "decision")).toEqual([]);
    const toGraph = vi.mocked(graphitiStore.ingest).mock.calls.map(([input]) => input);
    expect(toGraph.filter((input) => input.recordType === "decision")).toHaveLength(1);
  });
});
