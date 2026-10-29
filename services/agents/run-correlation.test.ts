import { beforeEach, describe, expect, it, vi } from "vitest";

// The RUNTIME WIRING for AuditLog.runId, which nothing else covers.
//
// services/access/check.test.ts proves check()/recordReadFactIds() copy a
// ctx.runId they are handed straight onto the audit row, and
// services/memory/access-leakage-eval.test.ts proves two hand-built contexts
// carrying different runIds stay attributable. Both start from an
// AccessContext that ALREADY has runId set — neither exercises how a real run
// gets one.
//
// That path is: POST /api/agents/[id]/run passes agentRunId: agentRun.id into
// runCopyAgent -> buildRuntimeContext() writes it into the Mastra
// RuntimeContext under a string key -> agentContextFromRuntime() (tools.ts)
// reads it back out under that same string key -> AccessContext.runId. It is a
// contract between two modules agreeing on an untyped string key, with no
// compiler check on either side: RuntimeContext.get() returns unknown, and the
// read is cast (`as string | undefined`), so a rename or typo on ONE side
// compiles clean, passes every existing test, and silently produces
// runId: null on every audit row in production.
//
// Replacing the read in agentContextFromRuntime with `undefined` outright
// leaves every other test green. This file is what bites instead.
//
// It matters because the audit route filters on an exact `runId: run.id`.
// Against silently-null runIds that filter matches nothing, so the panel would
// show an empty trail for every run and look like a clean scoped result rather
// than a broken one — a false-EMPTY failure.

vi.mock("@mastra/core/agent", () => {
  // Shared across instances so a test can read back the exact options —
  // RuntimeContext included — that runCopyAgent/runResearchAgent handed the
  // model. That call is where the real run's context is observable.
  const generateFn = vi.fn();
  class MockAgent {
    generate = generateFn;
    constructor(public opts: unknown) {}
  }
  return { Agent: MockAgent, __mockGenerate: generateFn };
});
vi.mock("@ai-sdk/openai-v5", () => ({ createOpenAI: vi.fn(() => vi.fn((m: string) => ({ modelId: m }))) }));
vi.mock("@ai-sdk/anthropic-v5", () => ({ createAnthropic: vi.fn(() => vi.fn((m: string) => ({ modelId: m }))) }));
vi.mock("@/services/langfuse", () => ({
  tracedGenerateDraft: vi.fn((_c: unknown, _t: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/db", () => ({
  db: { capability: { create: vi.fn().mockResolvedValue({ id: "cap_1" }) } },
}));
vi.mock("@/services/enrichment/exa", () => ({ researchCompany: vi.fn() }));
vi.mock("@/services/enrichment/firecrawl", () => ({ scrapeSite: vi.fn() }));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn() },
  guardedMemory: { retrieve: vi.fn() },
}));
vi.mock("@/services/access", () => ({ check: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { RuntimeContext } from "@mastra/core/runtime-context";
import { guardedMemory } from "@/services/memory";
import { check } from "@/services/access";
import { ingestMemory } from "@/lib/inngest";
// The two ends of the contract, both real — importing either one alone would
// miss the mismatch this file exists to catch.
import { buildRuntimeContext, runCopyAgent } from "./runner";
import { memoryReadTool, memoryWriteTool } from "./tools";
import * as mastraModule from "@mastra/core/agent";

const mockGenerate = (mastraModule as unknown as { __mockGenerate: ReturnType<typeof vi.fn> }).__mockGenerate;

function run(tool: { execute?: (args: never) => Promise<unknown> }, args: never) {
  if (!tool.execute) throw new Error("tool has no execute");
  return tool.execute(args);
}

/** The AccessContext a tool actually handed to the guarded store. */
function ctxPassedToRetrieve() {
  return vi.mocked(guardedMemory.retrieve).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: [] } as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
  mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
});

/** The RuntimeContext runCopyAgent actually handed the model for this run. */
function rcFromRealCopyRun() {
  const [, opts] = mockGenerate.mock.calls[0] as [unknown, { runtimeContext: RuntimeContext }];
  return opts.runtimeContext;
}

const AGENT_ROW = {
  id: "agent_1",
  agentKey: "outreach",
  name: "Outreach",
  role: "copy",
  model: null,
  systemPrompt: null,
  tools: [],
  settings: {},
};

const BASE = {
  orgId: "org_1",
  actorId: "copy-agent",
  actorName: "Outreach agent",
  capabilityToken: "wcap_test",
};

describe("agentRunId survives the RuntimeContext round trip into AccessContext.runId", () => {
  it("memory_read: a run id set by buildRuntimeContext reaches the guarded store as ctx.runId", async () => {
    const rc = buildRuntimeContext({ ...BASE, agentRunId: "run_A" });
    await run(memoryReadTool, { context: { query: "deal status" }, runtimeContext: rc } as never);

    expect(guardedMemory.retrieve).toHaveBeenCalledTimes(1);
    expect(ctxPassedToRetrieve()).toMatchObject({
      orgId: "org_1",
      runId: "run_A",
      actor: { type: "agent", id: "copy-agent" },
    });
  });

  it("memory_write: the same run id reaches check() as ctx.runId, so write-side audit rows are attributable too", async () => {
    const rc = buildRuntimeContext({ ...BASE, agentRunId: "run_A" });
    await run(memoryWriteTool, {
      context: { content: "Acme is opening an Austin office", name: "Acme Corp" },
      runtimeContext: rc,
    } as never);

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", runId: "run_A" }),
      expect.objectContaining({ action: "memory.write" }),
    );
  });

  it("two runs sharing one static actorId stay distinguishable end to end, which actorId alone never was", async () => {
    // The exact shape runCopyAgent produces: identical actor identity on both
    // runs (COPY_AGENT_ID is static), so runId is the ONLY thing that can tell
    // these two apart once their audit rows are written.
    for (const runId of ["run_A", "run_B"]) {
      const rc = buildRuntimeContext({ ...BASE, agentRunId: runId });
      await run(memoryReadTool, { context: { query: "deal status" }, runtimeContext: rc } as never);
    }

    const seen = vi.mocked(guardedMemory.retrieve).mock.calls.map((c) => c[0]);
    expect(seen).toHaveLength(2);
    // Precondition, asserted rather than assumed: if these ever stop sharing an
    // actorId this test has stopped reproducing the ambiguity it claims to, and
    // should fail loudly instead of passing for a weaker reason.
    expect(new Set(seen.map((c) => c.actor.id)).size).toBe(1);
    expect(seen.map((c) => c.runId)).toEqual(["run_A", "run_B"]);
  });

  // -------------------------------------------------------------------------
  // The hop ABOVE buildRuntimeContext: runCopyAgent forwarding opts.agentRunId.
  //
  // The four cases above call buildRuntimeContext themselves, so deleting
  // `agentRunId: opts.agentRunId` from runCopyAgent leaves all of them green —
  // the same gap this file exists to close, one hop up the chain. Closed the
  // same way: drive the real runCopyAgent and read the context it actually
  // built.
  // -------------------------------------------------------------------------
  it("runCopyAgent forwards its agentRunId into the RuntimeContext it builds for the model", async () => {
    await runCopyAgent({
      agentRow: AGENT_ROW,
      contactName: "Jane Doe",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: { orgId: "org_1", contactId: "contact_1" },
      agentRunId: "run_from_route",
    } as never);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(rcFromRealCopyRun().get("agentRunId")).toBe("run_from_route");
  });

  it("a real runCopyAgent invocation carries its run id all the way to the guarded store", async () => {
    // The whole chain below the route, in one assertion: runCopyAgent ->
    // buildRuntimeContext -> RuntimeContext -> agentContextFromRuntime ->
    // AccessContext.runId. The context is NOT rebuilt here — it is the exact
    // object the real run handed the model, so every hop is the production one.
    await runCopyAgent({
      agentRow: AGENT_ROW,
      contactName: "Jane Doe",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: { orgId: "org_1", contactId: "contact_1" },
      agentRunId: "run_from_route",
    } as never);

    await run(memoryReadTool, {
      context: { query: "deal status" },
      runtimeContext: rcFromRealCopyRun(),
    } as never);

    expect(ctxPassedToRetrieve()).toMatchObject({ orgId: "org_1", runId: "run_from_route" });
  });

  it("leaves runId undefined when the caller has no run, so untracked activity is not attributed to one", async () => {
    // buildRuntimeContext omits the key entirely for an absent agentRunId
    // (`if (values.agentRunId)`), so this also pins that a missing key reads
    // back as undefined rather than as some sentinel a filter could match.
    const rc = buildRuntimeContext(BASE);
    await run(memoryReadTool, { context: { query: "deal status" }, runtimeContext: rc } as never);

    expect(ctxPassedToRetrieve().runId).toBeUndefined();
  });
});
