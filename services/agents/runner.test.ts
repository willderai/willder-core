import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeContext } from "./runtime-context";

// Tests for the Mastra agent runner: buildRuntimeContext, buildMastraAgent,
// and runCopyAgent. The Mastra Agent class and AI SDK provider are mocked so we
// test prompt composition, structured-output wiring, and error cases — no real
// LLM calls. (runResearchAgent was removed with Era 1 outbound sales; the
// research role's DEFAULT_RESEARCH_PROMPT default-prompt fallback stays covered
// below since runProspectResearch still uses role="research".)

vi.mock("@mastra/core/agent", () => {
  const generateFn = vi.fn();
  class MockAgent {
    name: string;
    instructions: string;
    generate = generateFn;
    constructor(opts: { name: string; instructions: string }) {
      this.name = opts.name;
      this.instructions = opts.instructions;
    }
  }
  return { Agent: MockAgent, __mockGenerate: generateFn };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => vi.fn((modelId: string) => ({ modelId }))),
}));

vi.mock("@/services/langfuse", () => ({
  tracedGenerateDraft: vi.fn((_ctx: unknown, _trace: unknown, fn: () => Promise<unknown>) => fn()),
  // Pass-through mocks mirroring the real no-trace (Langfuse unconfigured) path —
  // this suite tests runner.ts's own prompt/context wiring, not Langfuse itself
  // (see services/langfuse.test.ts for tests that observe real trace/generation calls).
  startAgentTrace: vi.fn(() => null),
  tracedGeneration: vi.fn((_trace: unknown, _opts: unknown, generate: () => Promise<unknown>) => generate()),
  flushAgentTrace: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  db: {
    capability: { create: vi.fn().mockResolvedValue({ id: "cap_1" }) },
    // agent-scope-full-removal-provenance-gap-20260918: every provision*Capability
    // helper now calls deriveGrantGovernance() at mint, which reads this. No
    // grant on file for any of these agent ids in this suite — the same
    // system-agent, never-grant-governed shape they've always had.
    grant: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

// We don't need the real tool registry — just stub it
vi.mock("./tools", async (orig) => {
  const real = await orig<typeof import("./tools")>();
  return { ...real, buildToolSet: vi.fn(() => ({})) };
});

import { RuntimeContext } from "@mastra/core/runtime-context";
import {
  buildRuntimeContext,
  buildMastraAgent,
  runCopyAgent,
  runHandoffAgent,
  runArchitectureAgent,
  runQaAgent,
  DEFAULT_RESEARCH_PROMPT,
  DEFAULT_COPY_PROMPT,
  DEFAULT_ARCHITECTURE_PROMPT,
  DEFAULT_QA_PROMPT,
} from "./runner";
import { buildToolSet } from "./tools";
// Access the shared mock generate function
import * as mastraModule from "@mastra/core/agent";
const mockGenerate = (mastraModule as unknown as { __mockGenerate: ReturnType<typeof vi.fn> }).__mockGenerate;
// Access the mocked Langfuse tracing helpers to assert each agent role actually
// calls them (see the dedicated "Langfuse tracing wiring" describe block below).
import * as langfuseMock from "@/services/langfuse";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const baseResearchRow = {
  agentKey: "research-agent",
  name: "Research agent",
  role: "research",
  systemPrompt: null,
  tools: ["web_search", "memory_write"],
  model: null,
};

const baseCopyRow = {
  agentKey: "copy-agent",
  name: "Copy agent",
  role: "copy",
  systemPrompt: null,
  tools: ["memory_read"],
  model: "qwen/qwen3-32b",
};

const baseHandoffRow = {
  agentKey: "handoff-agent",
  name: "Handoff agent",
  role: "handoff",
  systemPrompt: null,
  tools: ["memory_read"],
  model: null,
};

const baseArchitectureRow = {
  agentKey: "architecture-agent",
  name: "Architecture agent",
  role: "architecture",
  systemPrompt: null,
  tools: ["memory_read"],
  model: null,
};

const baseQaRow = {
  agentKey: "qa-agent",
  name: "QA agent",
  role: "qa",
  systemPrompt: null,
  tools: ["memory_read"],
  model: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildRuntimeContext
// ---------------------------------------------------------------------------

describe("buildRuntimeContext", () => {
  it("sets orgId and actorId", () => {
    const rc = buildRuntimeContext({ orgId: "org_1", actorId: "agent_research" });
    expect(rc).toBeInstanceOf(RuntimeContext);
    expect(rc.get("orgId")).toBe("org_1");
    expect(rc.get("actorId")).toBe("agent_research");
  });

  it("sets actorName when provided", () => {
    const rc = buildRuntimeContext({ orgId: "o", actorId: "a", actorName: "Research bot" });
    expect(rc.get("actorName")).toBe("Research bot");
  });

  it("does not set actorName when omitted", () => {
    const rc = buildRuntimeContext({ orgId: "o", actorId: "a" });
    expect(rc.get("actorName")).toBeUndefined();
  });

  it("sets capabilityToken when provided", () => {
    const rc = buildRuntimeContext({ orgId: "o", actorId: "a", capabilityToken: "wcap_xyz" });
    expect(rc.get("capabilityToken")).toBe("wcap_xyz");
  });

  it("does not set capabilityToken when omitted", () => {
    const rc = buildRuntimeContext({ orgId: "o", actorId: "a" });
    expect(rc.get("capabilityToken")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildMastraAgent
// ---------------------------------------------------------------------------

describe("buildMastraAgent", () => {
  it("builds an Agent with the db row's agentKey as name", () => {
    const agent = buildMastraAgent(baseResearchRow);
    expect(agent.name).toBe("research-agent");
  });

  it("uses the row's systemPrompt when set", () => {
    const agent = buildMastraAgent({ ...baseResearchRow, systemPrompt: "Custom prompt here." });
    expect(agent.instructions).toBe("Custom prompt here.");
  });

  it("falls back to DEFAULT_RESEARCH_PROMPT for role='research' when systemPrompt is null", () => {
    const agent = buildMastraAgent(baseResearchRow);
    expect(agent.instructions).toBe(DEFAULT_RESEARCH_PROMPT);
  });

  it("falls back to DEFAULT_COPY_PROMPT for role='copy' when systemPrompt is null", () => {
    const agent = buildMastraAgent(baseCopyRow);
    expect(agent.instructions).toBe(DEFAULT_COPY_PROMPT);
  });

  it("falls back to a generic prompt for role='custom'", () => {
    const agent = buildMastraAgent({ ...baseResearchRow, role: "custom", agentKey: "custom-1" });
    expect(agent.instructions).toMatch(/helpful AI assistant/);
  });

  it("calls buildToolSet with the row's tools array", () => {
    buildMastraAgent(baseResearchRow);
    expect(buildToolSet).toHaveBeenCalledWith(["web_search", "memory_write"]);
  });
});

// ---------------------------------------------------------------------------
// runCopyAgent
// ---------------------------------------------------------------------------

const traceCtx = { orgId: "org_1", campaignId: "camp_1", prospectId: "pr_1" };

describe("runCopyAgent", () => {
  it("returns a structured { subject, body } from the agent", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "Quick note", body: "Hi Jane,\n..." } });
    const result = await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane Doe",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: traceCtx as never,
    });
    expect(result).toMatchObject({ subject: "Quick note", body: "Hi Jane,\n..." });
  });

  it("builds a prompt that mentions the contact and campaign", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
    await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Bob Smith",
      campaignName: "Q3 Outbound",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: traceCtx as never,
    });
    const prompt: string = mockGenerate.mock.calls[0][0];
    expect(prompt).toContain("Bob Smith");
    expect(prompt).toContain("Q3 Outbound");
  });

  it("includes tone from orgPreferences when set", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
    await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: traceCtx as never,
      preferences: { toneOverride: "formal and direct" },
    });
    const prompt: string = mockGenerate.mock.calls[0][0];
    expect(prompt).toContain("formal and direct");
  });

  it("omits forbidden topics when not set, includes them when provided", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
    await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: traceCtx as never,
      preferences: { forbiddenTopics: "pricing, competitors" },
    });
    const prompt: string = mockGenerate.mock.calls[0][0];
    expect(prompt).toContain("pricing, competitors");
  });

  it("throws when the agent returns no valid subject/body object", async () => {
    mockGenerate.mockResolvedValue({ object: null });
    await expect(
      runCopyAgent({
        agentRow: baseCopyRow,
        contactName: "Jane",
        orgId: "org_1",
        capabilityToken: "wcap_test",
        traceCtx: traceCtx as never,
      }),
    ).rejects.toThrow(/valid.*subject.*body/i);
  });

  it("throws when the agent returns an object with empty body", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "Hi", body: "" } });
    await expect(
      runCopyAgent({
        agentRow: baseCopyRow,
        contactName: "Jane",
        orgId: "org_1",
        capabilityToken: "wcap_test",
        traceCtx: traceCtx as never,
      }),
    ).rejects.toThrow(/valid/i);
  });

  it("passes the capabilityToken in the RuntimeContext so memory_read can authenticate", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
    await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane",
      orgId: "org_1",
      capabilityToken: "wcap_secret",
      traceCtx: traceCtx as never,
    });
    const [, opts] = mockGenerate.mock.calls[0];
    const rc: RuntimeContext = opts.runtimeContext;
    expect(rc.get("capabilityToken")).toBe("wcap_secret");
    expect(rc.get("orgId")).toBe("org_1");
  });

  it("calls generate with the DRAFT_OUTPUT_SCHEMA so the model returns structured JSON", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
    await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: traceCtx as never,
    });
    const [, opts] = mockGenerate.mock.calls[0];
    expect(opts).toHaveProperty("output"); // structured output schema present
  });

  it("marks the result as grounded: true (agent uses memory_read tool)", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "s", body: "b" } });
    const result = await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane",
      orgId: "org_1",
      capabilityToken: "wcap_test",
      traceCtx: traceCtx as never,
    });
    expect(result.grounded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W1 — consultative-prompt regression guards. The interactive-loop prompt work
// (2026-07-20) added two behaviors that must not silently regress:
// verify-state-don't-trust ("ASSUMPTION" / "back every assertion") and
// reconcile-against-prior-decisions ("relitigate" / "already DECIDED").
// ---------------------------------------------------------------------------

describe("DEFAULT_ARCHITECTURE_PROMPT — verify-state + reconcile guards", () => {
  it("carries the verify-state language (ASSUMPTION + back every assertion)", () => {
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("ASSUMPTION");
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("back every assertion");
    // The "never assert a claim you haven't verified" invariant.
    expect(DEFAULT_ARCHITECTURE_PROMPT).toMatch(/verified against retrieved facts/i);
  });

  it("carries the reconcile-against-prior-decisions language (relitigate + already DECIDED)", () => {
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("relitigate");
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("DECIDED");
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("DEFERRED");
  });

  it("still distinguishes FACT from RECOMMENDATION", () => {
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("FACT");
    expect(DEFAULT_ARCHITECTURE_PROMPT).toContain("RECOMMENDATION");
  });
});

describe("DEFAULT_QA_PROMPT — added consultative lines", () => {
  it("marks tested assumptions distinctly and forbids claiming unobserved results", () => {
    expect(DEFAULT_QA_PROMPT).toContain("ASSUMPTION");
    expect(DEFAULT_QA_PROMPT).toMatch(/never reported as an observed fact/i);
    expect(DEFAULT_QA_PROMPT).toMatch(/Never claim a result you did not actually observe/i);
  });

  it("reconciles against known issues rather than re-filing them", () => {
    expect(DEFAULT_QA_PROMPT).toMatch(/already known/i);
    expect(DEFAULT_QA_PROMPT).toMatch(/don't re-file it as a new bug/i);
  });

  it("gives a GO / NO-GO verdict against scale/SLA targets", () => {
    expect(DEFAULT_QA_PROMPT).toContain("GO / NO-GO");
    expect(DEFAULT_QA_PROMPT).toMatch(/recommended DEFAULT/);
  });
});

// ---------------------------------------------------------------------------
// Langfuse tracing wiring — every agent role (copy, research, handoff,
// architecture, qa) is traced. These tests assert each role actually calls the
// shared tracing helpers (startAgentTrace / tracedGeneration / flushAgentTrace)
// with the right name/tags — observing the trace call itself, not just that the
// LLM call succeeds (a mock that only checks the wrapped function's return value
// would pass even if the tracing wiring were deleted entirely; asserting on the
// mocked langfuse module's own calls closes that gap).
// See services/langfuse.test.ts for tests against the real `langfuse` SDK surface.
// ---------------------------------------------------------------------------

describe("Langfuse tracing wiring", () => {
  it("runHandoffAgent opens a handoff-agent trace and two generations (act + structure), then flushes", async () => {
    mockGenerate
      .mockResolvedValueOnce({ text: "retrieved onboarding context" })
      .mockResolvedValueOnce({ object: { title: "Welcome", summary: "s", sections: [] } });

    await runHandoffAgent({
      agentRow: baseHandoffRow,
      granteeName: "Alex Contractor",
      orgId: "org_1",
      capabilityToken: "wcap_1",
    });

    expect(langfuseMock.startAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "handoff-agent-run", userId: "org_1", tags: ["handoff-agent"] }),
    );
    expect(langfuseMock.tracedGeneration).toHaveBeenCalledTimes(2);
    const calls = (langfuseMock.tracedGeneration as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({ name: "handoff-agent-act" });
    expect(calls[1][1]).toMatchObject({ name: "handoff-agent-structure" });
    expect(langfuseMock.flushAgentTrace).toHaveBeenCalledTimes(1);
  });

  it("runHandoffAgent turns the structured output's fact labels into citations and strips them from sections", async () => {
    mockGenerate
      .mockImplementationOnce(async (_prompt: string, opts: { runtimeContext: AgentRuntimeContext }) => {
        // What memory_read does during the act step (tools.ts).
        opts.runtimeContext.get("retrievedFacts")?.add([
          { uuid: "u1", fact: "Deploys go out on Tuesdays" },
          { uuid: "u2", fact: "Payments are owned by the core team" },
        ]);
        return { text: "retrieved onboarding context" };
      })
      .mockResolvedValueOnce({
        object: {
          title: "Welcome",
          summary: "s",
          sections: [
            { heading: "Ops", content: "Ship on Tuesdays.", citations: ["F1", "F7"] },
            { heading: "Owners", content: "Core owns payments.", citations: ["F2"] },
          ],
        },
      });

    const result = await runHandoffAgent({
      agentRow: baseHandoffRow,
      granteeName: "Alex Contractor",
      orgId: "org_1",
      capabilityToken: "wcap_1",
    });

    expect(result.sections).toEqual([
      { heading: "Ops", content: "Ship on Tuesdays." },
      { heading: "Owners", content: "Core owns payments." },
    ]);
    expect(result.citations).toEqual([
      { sectionIndex: 0, factId: "u1", factText: "Deploys go out on Tuesdays" },
      { sectionIndex: 1, factId: "u2", factText: "Payments are owned by the core team" },
    ]);
    const structurePrompt = mockGenerate.mock.calls[1][0] as string;
    expect(structurePrompt).toContain("[F1] Deploys go out on Tuesdays\n[F2] Payments are owned by the core team");
  });

  it("runHandoffAgent hands both generations the caller's sourcesRead set", async () => {
    mockGenerate
      .mockResolvedValueOnce({ text: "retrieved onboarding context" })
      .mockResolvedValueOnce({ object: { title: "Welcome", summary: "s", sections: [] } });
    const sourcesRead = new Set<string>();

    await runHandoffAgent({
      agentRow: baseHandoffRow,
      granteeName: "Alex Contractor",
      orgId: "org_1",
      capabilityToken: "wcap_1",
      sourcesRead,
    });

    for (const [, options] of mockGenerate.mock.calls) {
      expect((options.runtimeContext as RuntimeContext).get("sourcesRead")).toBe(sourcesRead);
    }
  });

  it("runArchitectureAgent opens an architecture-agent trace and two generations (act + structure), then flushes", async () => {
    mockGenerate
      .mockResolvedValueOnce({ text: "retrieved decisions and constraints" })
      .mockResolvedValueOnce({ object: { title: "Plan", summary: "s", sections: [] } });

    await runArchitectureAgent({
      agentRow: baseArchitectureRow,
      orgId: "org_1",
      capabilityToken: "wcap_1",
    });

    expect(langfuseMock.startAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "architecture-agent-run", userId: "org_1", tags: ["architecture-agent"] }),
    );
    expect(langfuseMock.tracedGeneration).toHaveBeenCalledTimes(2);
    const calls = (langfuseMock.tracedGeneration as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({ name: "architecture-agent-act" });
    expect(calls[1][1]).toMatchObject({ name: "architecture-agent-structure" });
    expect(langfuseMock.flushAgentTrace).toHaveBeenCalledTimes(1);
  });

  it("runQaAgent opens a qa-agent trace and two generations (act + structure), then flushes", async () => {
    mockGenerate.mockResolvedValueOnce({ text: "exercised the API" }).mockResolvedValueOnce({
      object: { title: "QA run", summary: "s", verdict: "healthy", bugs: [], performance: [], suggestions: [] },
    });

    await runQaAgent({
      agentRow: baseQaRow,
      orgId: "org_1",
      target: { baseUrl: "https://api.example.com" },
    });

    expect(langfuseMock.startAgentTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "qa-agent-run", userId: "org_1", tags: ["qa-agent"] }),
    );
    expect(langfuseMock.tracedGeneration).toHaveBeenCalledTimes(2);
    const calls = (langfuseMock.tracedGeneration as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({ name: "qa-agent-act" });
    expect(calls[1][1]).toMatchObject({ name: "qa-agent-structure" });
    expect(langfuseMock.flushAgentTrace).toHaveBeenCalledTimes(1);
  });

  it("runCopyAgent still goes through tracedGenerateDraft (unchanged path) — sanity check no regression", async () => {
    mockGenerate.mockResolvedValue({ object: { subject: "Hi", body: "Body copy" } });
    await runCopyAgent({
      agentRow: baseCopyRow,
      contactName: "Jane",
      orgId: "org_1",
      capabilityToken: "wcap_1",
      traceCtx: { orgId: "org_1" } as never,
    });

    expect(langfuseMock.tracedGenerateDraft).toHaveBeenCalledTimes(1);
    // Copy still uses its own dedicated helper, not the shared research/handoff/etc. one.
    expect(langfuseMock.startAgentTrace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Trace-linkage coverage.
//
// The suite above asserts each role calls startAgentTrace/tracedGeneration with
// the right name+tags, but never WHICH trace handle the generation is hung off.
// Replacing `trace` with `null` at every tracedGeneration call site in runner.ts
// leaves tsc clean (null is a valid AgentTrace) and the suite above green —
// while in production tracedGeneration takes its `if (!trace) return generate()`
// early return, so ZERO generation spans are emitted for any agent. Hence an
// assertion on the trace handle itself, not just on the span's name.
// ---------------------------------------------------------------------------

describe("Langfuse tracing wiring — generations hang off the role's own trace handle", () => {
  const TRACE_HANDLE = { __sentinel: "agent-trace" } as never;

  function tracedGenerationTraceArgs(): unknown[] {
    return (langfuseMock.tracedGeneration as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  }

  it("runHandoffAgent hangs BOTH generations (act + structure) off the one handle", async () => {
    vi.mocked(langfuseMock.startAgentTrace).mockReturnValueOnce(TRACE_HANDLE);
    mockGenerate
      .mockResolvedValueOnce({ text: "retrieved onboarding context" })
      .mockResolvedValueOnce({ object: { title: "Welcome", summary: "s", sections: [] } });

    await runHandoffAgent({
      agentRow: baseHandoffRow,
      granteeName: "Alex Contractor",
      orgId: "org_1",
      capabilityToken: "wcap_1",
    });

    expect(tracedGenerationTraceArgs()).toEqual([TRACE_HANDLE, TRACE_HANDLE]);
  });

  it("runArchitectureAgent hangs BOTH generations (act + structure) off the one handle", async () => {
    vi.mocked(langfuseMock.startAgentTrace).mockReturnValueOnce(TRACE_HANDLE);
    mockGenerate
      .mockResolvedValueOnce({ text: "retrieved decisions and constraints" })
      .mockResolvedValueOnce({ object: { title: "Plan", summary: "s", sections: [] } });

    await runArchitectureAgent({
      agentRow: baseArchitectureRow,
      orgId: "org_1",
      capabilityToken: "wcap_1",
    });

    expect(tracedGenerationTraceArgs()).toEqual([TRACE_HANDLE, TRACE_HANDLE]);
  });

  it("runQaAgent hangs BOTH generations (act + structure) off the one handle", async () => {
    vi.mocked(langfuseMock.startAgentTrace).mockReturnValueOnce(TRACE_HANDLE);
    mockGenerate.mockResolvedValueOnce({ text: "exercised the API" }).mockResolvedValueOnce({
      object: { title: "QA run", summary: "s", verdict: "healthy", bugs: [], performance: [], suggestions: [] },
    });

    await runQaAgent({
      agentRow: baseQaRow,
      orgId: "org_1",
      target: { baseUrl: "https://api.example.com" },
    });

    expect(tracedGenerationTraceArgs()).toEqual([TRACE_HANDLE, TRACE_HANDLE]);
  });
});
