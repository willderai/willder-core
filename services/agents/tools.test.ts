import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for the four Mastra agent tools:
// web_search (Exa), scrape (Firecrawl), memory_read (guarded), memory_write (direct).
// Each tool's `execute` function is tested: correct passthrough, RuntimeContext extraction,
// graceful error return (never throw), and edge cases (missing context, empty results).

vi.mock("@/services/enrichment/exa", () => ({ researchCompany: vi.fn() }));
vi.mock("@/services/enrichment/firecrawl", () => ({ scrapeSite: vi.fn() }));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn() },
  guardedMemory: { retrieve: vi.fn() },
}));
vi.mock("@/lib/copy-agent", () => ({
  copyAgentContext: vi.fn((orgId: string, token: string) => ({
    orgId,
    actor: { type: "agent", id: "copy_agent", capabilityToken: token },
  })),
}));
vi.mock("@/services/access", () => ({ check: vi.fn() }));
// Mocked rather than left to load for real: the real module pulls in
// services/agents/runner.ts, which circularly imports back into this file's
// own module ("./tools") — safe when something else loads the barrel first,
// but a crash when this test file is the very first thing to import "./tools".
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
import { RuntimeContext } from "@mastra/core/runtime-context";
import { RetrievedFacts } from "./retrieved-facts";
import { researchCompany } from "@/services/enrichment/exa";
import { scrapeSite } from "@/services/enrichment/firecrawl";
import { guardedMemory } from "@/services/memory";
import { check } from "@/services/access";
import { ingestMemory } from "@/lib/inngest";
import { webSearchTool, scrapeTool, memoryReadTool, memoryWriteTool, buildToolSet, TOOL_REGISTRY } from "./tools";

function makeRc(vals: Record<string, string | undefined> = {}): RuntimeContext {
  const rc = new RuntimeContext();
  for (const [k, v] of Object.entries(vals)) {
    if (v !== undefined) rc.set(k, v);
  }
  return rc;
}

// Mastra's Tool type declares `execute` optional (a tool can be schema-only);
// ours are always defined, so this narrows once instead of asserting at
// every call site.
function run(tool: { execute?: (args: never) => Promise<any> }, args: never) {
  if (!tool.execute) throw new Error("tool has no execute");
  return tool.execute(args);
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// web_search tool
// ---------------------------------------------------------------------------

describe("webSearchTool", () => {
  it("calls researchCompany with query and optional domain, returns results", async () => {
    vi.mocked(researchCompany).mockResolvedValue("Acme raised $10M");
    const res = await run(webSearchTool, {
      context: { query: "Acme Corp", domain: "acme.com" },
      runtimeContext: makeRc(),
    } as never);
    expect(res).toMatchObject({ results: "Acme raised $10M" });
    expect(researchCompany).toHaveBeenCalledWith("Acme Corp", "acme.com");
  });

  it("calls researchCompany without domain when omitted", async () => {
    vi.mocked(researchCompany).mockResolvedValue("some results");
    await run(webSearchTool, { context: { query: "Jane Doe" }, runtimeContext: makeRc() } as never);
    expect(researchCompany).toHaveBeenCalledWith("Jane Doe", undefined);
  });

  it("returns empty results and an error field when the API throws — never propagates", async () => {
    vi.mocked(researchCompany).mockRejectedValue(new Error("quota exceeded"));
    const res = await run(webSearchTool, {
      context: { query: "Acme" },
      runtimeContext: makeRc(),
    } as never);
    expect(res).toMatchObject({ results: "", error: expect.stringContaining("quota exceeded") });
  });

  it("returns empty results on network error", async () => {
    vi.mocked(researchCompany).mockRejectedValue(new TypeError("network"));
    const res = await run(webSearchTool, { context: { query: "x" }, runtimeContext: makeRc() } as never);
    expect(res.results).toBe("");
  });
});

// ---------------------------------------------------------------------------
// scrape tool
// ---------------------------------------------------------------------------

describe("scrapeTool", () => {
  it("calls scrapeSite with the URL and returns markdown content", async () => {
    vi.mocked(scrapeSite).mockResolvedValue("# About us\nWe build software.");
    const res = await run(scrapeTool, {
      context: { url: "https://acme.com/about" },
      runtimeContext: makeRc(),
    } as never);
    expect(res).toMatchObject({ content: "# About us\nWe build software." });
    expect(scrapeSite).toHaveBeenCalledWith("https://acme.com/about");
  });

  it("returns empty content and error field on scrape failure — never throws", async () => {
    vi.mocked(scrapeSite).mockRejectedValue(new Error("403 Forbidden"));
    const res = await run(scrapeTool, {
      context: { url: "https://acme.com" },
      runtimeContext: makeRc(),
    } as never);
    expect(res).toMatchObject({ content: "", error: expect.stringContaining("403") });
  });

  it("handles very long content without throwing", async () => {
    vi.mocked(scrapeSite).mockResolvedValue("x".repeat(100_000));
    const res = await run(scrapeTool, { context: { url: "https://big.com" }, runtimeContext: makeRc() } as never);
    expect(res.content.length).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// memory_read tool
// ---------------------------------------------------------------------------

describe("memoryReadTool", () => {
  it("says when the read is not the whole answer, so an empty one does not read as nothing stored", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [],
      partialScopeCoverage: true,
      degraded: ["graph"],
    } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });

    const res = await run(memoryReadTool, { context: { query: "who owns the renewal?" }, runtimeContext: rc } as never);

    expect(res.facts).toEqual([]);
    expect(res.notes).toEqual([
      expect.stringMatching(/^Note: not every scope under yours was searched/),
      expect.stringMatching(/^Note: search was incomplete: the graph store did not answer/),
    ]);
  });

  it("carries no notes on a complete read", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: [] } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });

    const res = await run(memoryReadTool, { context: { query: "who owns the renewal?" }, runtimeContext: rc } as never);

    expect(res).not.toHaveProperty("notes");
  });

  it("retrieves facts through the guarded store using capability token from runtime context", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [{ uuid: "f1", fact: "Jane is CTO", validAt: null, confidence: 0.9, actorType: "human" }],
    } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    const res = await run(memoryReadTool, {
      context: { query: "who is the CTO?", limit: 5 },
      runtimeContext: rc,
    } as never);
    expect(res.facts).toHaveLength(1);
    expect(res.facts[0]).toMatchObject({ fact: "Jane is CTO", uuid: "f1" });
    expect(guardedMemory.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1" }),
      expect.objectContaining({ groupId: "org_1", query: "who is the CTO?", limit: 5 }),
      undefined, // no memoryScope set in this test's runtime context
    );
  });

  it("marks a fact served as an excerpt, in its output and on the run's RetrievedFacts", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [
        { uuid: "f1", fact: "Jane is CTO", validAt: null },
        { uuid: "f2", fact: "… Jane joined in May. …", validAt: null, excerptOfChars: 67716 },
      ],
    } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    const retrieved = new RetrievedFacts();
    rc.set("retrievedFacts", retrieved);

    const res = await run(memoryReadTool, { context: { query: "when did Jane join?" }, runtimeContext: rc } as never);

    expect(res.facts.map((f: { fact: string }) => f.fact)).toEqual([
      "Jane is CTO",
      "… Jane joined in May. … [excerpt of 67716 chars]",
    ]);
    expect(retrieved.promptBlock()).toBe("[F1] Jane is CTO\n[F2] … Jane joined in May. … [excerpt of 67716 chars]");
  });

  it("records what it returned on the run's RetrievedFacts, when the run keeps one", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [{ uuid: "f1", fact: "Jane is CTO", validAt: null }],
    } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    const retrieved = new RetrievedFacts();
    rc.set("retrievedFacts", retrieved);

    await run(memoryReadTool, { context: { query: "who is the CTO?" }, runtimeContext: rc } as never);

    expect(retrieved.promptBlock()).toBe("[F1] Jane is CTO");
  });

  it("adds the source of every returned fact to the run's sourcesRead set, across calls", async () => {
    const sourcesRead = new Set<string>();
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    rc.set("sourcesRead", sourcesRead);
    vi.mocked(guardedMemory.retrieve)
      .mockResolvedValueOnce({
        facts: [
          { uuid: "f1", fact: "from slack", validAt: null, sourceId: "src_slack" },
          { uuid: "f2", fact: "typed by a person", validAt: null },
        ],
      } as never)
      .mockResolvedValueOnce({
        facts: [{ uuid: "f3", fact: "from drive", validAt: null, sourceId: "src_drive" }],
      } as never);

    await run(memoryReadTool, { context: { query: "a" }, runtimeContext: rc } as never);
    await run(memoryReadTool, { context: { query: "b" }, runtimeContext: rc } as never);

    expect([...sourcesRead].sort()).toEqual(["src_drive", "src_slack"]);
  });

  it("never attributes a missing actorId to the fallback name 'agent'", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: [] } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" }); // no actorId
    await run(memoryReadTool, { context: { query: "x" }, runtimeContext: rc } as never);
    const ctxPassed = vi.mocked(guardedMemory.retrieve).mock.calls[0][0] as { actor: { id: string } };
    expect(ctxPassed.actor.id).not.toBe("agent");
  });

  it("returns empty facts with error when orgId is missing from the runtime context", async () => {
    const rc = makeRc({ capabilityToken: "wcap_test" }); // no orgId
    const res = await run(memoryReadTool, { context: { query: "x" }, runtimeContext: rc } as never);
    expect(res.facts).toEqual([]);
    expect(res.error).toMatch(/requires orgId/);
    expect(guardedMemory.retrieve).not.toHaveBeenCalled();
  });

  it("returns empty facts with error when capabilityToken is missing", async () => {
    const rc = makeRc({ orgId: "org_1" }); // no token
    const res = await run(memoryReadTool, { context: { query: "x" }, runtimeContext: rc } as never);
    expect(res.facts).toEqual([]);
    expect(res.error).toMatch(/capabilityToken/);
  });

  it("returns empty facts and error when the guarded store throws — never propagates", async () => {
    vi.mocked(guardedMemory.retrieve).mockRejectedValue(new Error("access denied"));
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    const res = await run(memoryReadTool, { context: { query: "x" }, runtimeContext: rc } as never);
    expect(res.facts).toEqual([]);
    expect(res.error).toMatch(/access denied/);
  });

  it("defaults limit to 10 when not provided", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: [] } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    await run(memoryReadTool, { context: { query: "budget" }, runtimeContext: rc } as never);
    expect(guardedMemory.retrieve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 10 }),
      undefined,
    );
  });

  it("maps confidence and actorType fields from the memory service response", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [{ uuid: "f2", fact: "Revenue is $5M", validAt: null, confidence: 0.8, actorType: "agent" }],
    } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" });
    const res = await run(memoryReadTool, { context: { query: "revenue" }, runtimeContext: rc } as never);
    expect(res.facts[0]).toMatchObject({ confidence: 0.8, actorType: "agent" });
  });
});

// ---------------------------------------------------------------------------
// memory_write tool
// ---------------------------------------------------------------------------

describe("memoryWriteTool", () => {
  it("gates via check(), then queues the write through ingestMemory using the actor's identity from runtime context", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true } as never);
    vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
    const rc = makeRc({
      orgId: "org_1",
      capabilityToken: "wcap_test",
      actorId: "agent_research",
      actorName: "Research agent",
    });
    const res = await run(memoryWriteTool, {
      context: { content: "Acme raised $10M Series A in March", name: "Acme Corp" },
      runtimeContext: rc,
    } as never);
    expect(res).toMatchObject({ episodeId: "queued" });
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1" }),
      expect.objectContaining({ action: "memory.write", target: "content:Acme Corp" }),
    );
    expect(ingestMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "org_1",
        content: "Acme raised $10M Series A in March",
        name: "Acme Corp",
        actorType: "agent",
        actorId: "agent_research",
        actorName: "Research agent",
      }),
    );
  });

  // ingestMemory refuses a NUL, but the name reached check()'s audit target first, where
  // Postgres rejects it too; either way the agent got an error naming nothing it could fix.
  it.each([
    ["content", { content: "Acme raised\u0000 $10M", name: "Acme Corp" }],
    ["name", { content: "Acme raised $10M", name: "Acme\u0000 Corp" }],
  ])("refuses a NUL in %s as invalid_input, before check() or ingest", async (field, context) => {
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test", actorId: "agent_1" });
    const res = await run(memoryWriteTool, { context, runtimeContext: rc } as never);
    expect(res).toEqual({
      episodeId: null,
      error: `invalid_input: ${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
    });
    expect(check).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("returns error when orgId is missing — never throws", async () => {
    const rc = makeRc({ capabilityToken: "wcap_test", actorId: "agent_1" }); // no orgId
    const res = await run(memoryWriteTool, {
      context: { content: "x", name: "y" },
      runtimeContext: rc,
    } as never);
    expect(res.episodeId).toBeNull();
    expect(res.error).toMatch(/requires orgId/);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("returns error when actorId is missing — never throws", async () => {
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" }); // no actorId
    const res = await run(memoryWriteTool, {
      context: { content: "x", name: "y" },
      runtimeContext: rc,
    } as never);
    expect(res.episodeId).toBeNull();
    expect(res.error).toMatch(/requires orgId, capabilityToken, and actorId/);
  });

  it("returns access-denied error without writing when check() disallows", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no scope" } as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test", actorId: "agent_1" });
    const res = await run(memoryWriteTool, {
      context: { content: "x", name: "y" },
      runtimeContext: rc,
    } as never);
    expect(res.episodeId).toBeNull();
    expect(res.error).toMatch(/access denied: no scope/);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("returns null episodeId and error string when ingestMemory throws — never propagates", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true } as never);
    vi.mocked(ingestMemory).mockRejectedValue(new Error("service unavailable"));
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test", actorId: "agent_1" });
    const res = await run(memoryWriteTool, {
      context: { content: "some findings", name: "Acme" },
      runtimeContext: rc,
    } as never);
    expect(res.episodeId).toBeNull();
    expect(res.error).toMatch(/service unavailable/);
  });

  it("defaults actorName to 'Agent' when not in runtime context", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true } as never);
    vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test", actorId: "agent_1" }); // no actorName
    await run(memoryWriteTool, { context: { content: "x", name: "y" }, runtimeContext: rc } as never);
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ actorName: "Agent" }));
  });

  it("passes memoryScope through to both check() and ingestMemory as scopePath", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true } as never);
    vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
    const rc = makeRc({
      orgId: "org_1",
      capabilityToken: "wcap_test",
      actorId: "agent_1",
      memoryScope: "org_1.deals",
    });
    await run(memoryWriteTool, { context: { content: "x", name: "y" }, runtimeContext: rc } as never);
    expect(check).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: "org_1.deals" }));
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ scopePath: "org_1.deals" }));
  });
});

// ---------------------------------------------------------------------------
// buildToolSet
// ---------------------------------------------------------------------------

describe("buildToolSet", () => {
  it("returns exactly the requested tools from the registry", () => {
    const ts = buildToolSet(["web_search", "memory_read"]);
    expect(Object.keys(ts)).toEqual(expect.arrayContaining(["web_search", "memory_read"]));
    expect(ts).not.toHaveProperty("scrape");
    expect(ts).not.toHaveProperty("memory_write");
  });

  it("silently ignores unknown tool keys", () => {
    const ts = buildToolSet(["web_search", "nonexistent_tool", "also_fake"]);
    expect(Object.keys(ts)).toEqual(["web_search"]);
  });

  it("returns an empty object for an empty array", () => {
    expect(buildToolSet([])).toEqual({});
  });

  it("returns all four tools when all keys are requested", () => {
    const ts = buildToolSet(Object.keys(TOOL_REGISTRY));
    expect(Object.keys(ts)).toHaveLength(4);
  });
});
