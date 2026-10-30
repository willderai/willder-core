// OPENAI_EXTRACT_EXTRA_BODY reaches the distiller's request, and only when it is set.
//
// On 2026-10-29 a local qwen3:14b behind Ollama thought for about 2.5 minutes before each
// distill reply, so a stdio memory_ingest outlasted its client's 60 s timeout; the same
// request with "reasoning_effort": "none" answered in seconds. The variable lets an operator
// send that (or any sampling field) without changing what every other install sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const create = vi.fn(async (_body: Record<string, unknown>) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          facts: ["Acme renewed its contract for 2027."],
          entities: [],
          attributes: [],
          decisions: [],
        }),
      },
    },
  ],
}));
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-extract",
  createLLMClient: () => ({ chat: { completions: { create } } }),
}));

import { runMemoryIngest } from "./inngest";
import type { IngestInput } from "@/types/memory";

const WRITE: IngestInput = {
  groupId: "org_1",
  content: "Acme renewed its contract for 2027 after the pilot with the platform team went well.",
  name: "Acme",
  actorType: "agent",
  origin: "mcp",
  actorId: "agent_1",
  actorName: "MCP session",
  source: "mcp",
  scopePath: "org_1.sales",
};

/** The body of the one distill request the ingest sent. */
function distillRequest(): Record<string, unknown> {
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the distiller's request and OPENAI_EXTRACT_EXTRA_BODY", () => {
  it("is unchanged when the variable is unset", async () => {
    vi.stubEnv("OPENAI_EXTRACT_EXTRA_BODY", undefined);
    await runMemoryIngest(WRITE);
    const body = distillRequest();
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "response_format", "temperature"]);
    expect(body).toMatchObject({
      model: "test-extract",
      temperature: 0.1,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    });
  });

  it("carries the variable's fields, which win over its own sampling fields", async () => {
    vi.stubEnv("OPENAI_EXTRACT_EXTRA_BODY", '{"reasoning_effort":"none","temperature":0}');
    await runMemoryIngest(WRITE);
    expect(distillRequest()).toMatchObject({
      model: "test-extract",
      reasoning_effort: "none",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("fails the extraction, naming the variable, when the value is not allowed, instead of extracting without it", async () => {
    vi.stubEnv("OPENAI_EXTRACT_EXTRA_BODY", '{"model":"other"}');
    await expect(runMemoryIngest(WRITE)).rejects.toThrow(/OPENAI_EXTRACT_EXTRA_BODY may not set model/);
    expect(create).not.toHaveBeenCalled();
  });
});
