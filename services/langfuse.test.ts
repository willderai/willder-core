import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for services/langfuse.ts's own trace/generation wiring — NOT a pass-through
// mock of this module (that's what runner.test.ts uses to test runner.ts's own
// logic). Here we mock the underlying `langfuse` SDK itself and assert that
// trace()/generation()/generation.end() are actually invoked, so a bug that makes
// tracedGenerateDraft/tracedGeneration/flushAgentTrace silently no-op (a
// zero-trace failure) would show up as a failing assertion here, not just a
// passing LLM-call return value.

const { generationEnd, generation, trace, shutdownAsync, flushAsync } = vi.hoisted(() => {
  const generationEnd = vi.fn().mockResolvedValue(undefined);
  const generation = vi.fn<(opts: unknown) => { end: typeof generationEnd }>(() => ({ end: generationEnd }));
  const trace = vi.fn<(opts: unknown) => { generation: typeof generation }>(() => ({ generation }));
  const shutdownAsync = vi.fn().mockResolvedValue(undefined);
  const flushAsync = vi.fn().mockResolvedValue(undefined);
  return { generationEnd, generation, trace, shutdownAsync, flushAsync };
});

vi.mock("langfuse", () => ({
  default: class MockLangfuse {
    trace = trace;
    shutdownAsync = shutdownAsync;
    flushAsync = flushAsync;
  },
}));

describe("services/langfuse.ts", () => {
  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";
    process.env.LANGFUSE_SECRET_KEY = "sk_test";
    trace.mockClear();
    generation.mockClear();
    generationEnd.mockClear();
    shutdownAsync.mockClear();
    flushAsync.mockClear();
  });

  describe("tracedGenerateDraft (copy agent)", () => {
    it("opens a real trace + generation and ends it with the draft output", async () => {
      const { tracedGenerateDraft } = await import("./langfuse");
      const draft = { subject: "Hi", body: "Body text", model: "gpt-4o-mini", grounded: true };
      const result = await tracedGenerateDraft(
        {
          contactName: "Jane",
          facts: [{ fact: "raised $10M" } as never],
        } as never,
        { orgId: "org_1", campaignId: "camp_1" },
        async () => draft,
      );

      expect(result).toBe(draft);
      expect(trace).toHaveBeenCalledWith(
        expect.objectContaining({ name: "draft-generation", userId: "org_1", tags: ["copy-agent", "outreach-draft"] }),
      );
      expect(generation).toHaveBeenCalledWith(expect.objectContaining({ name: "copy-agent-draft" }));
      expect(generationEnd).toHaveBeenCalledWith(
        expect.objectContaining({ output: { subject: "Hi", body: "Body text" }, level: "DEFAULT" }),
      );
    });

    it("ends the generation at ERROR level and rethrows when generate() throws", async () => {
      const { tracedGenerateDraft } = await import("./langfuse");
      const boom = new Error("model call failed");
      await expect(
        tracedGenerateDraft({ contactName: "Jane", facts: [] } as never, { orgId: "org_1" }, async () => {
          throw boom;
        }),
      ).rejects.toThrow(boom);

      expect(generationEnd).toHaveBeenCalledWith(expect.objectContaining({ level: "ERROR" }));
    });

    it("flushes via shutdownAsync, not flushAsync, so no trace is lost on exit", async () => {
      // With flushAt:1 (this file's Langfuse config), every event triggers its own
      // background flush tracked only in the SDK's internal pendingIngestionPromises
      // map, which flushAsync() does NOT await before resolving. A bare
      // `await lf.flushAsync()` can resolve while ingestion requests are still in flight,
      // so on a Vercel function whose execution is frozen right after the response is
      // sent, the trace is silently dropped even though flushAsync() reported success.
      // shutdownAsync() explicitly awaits pendingIngestionPromises before resolving.
      const { tracedGenerateDraft } = await import("./langfuse");
      await tracedGenerateDraft({ contactName: "Jane", facts: [] } as never, { orgId: "org_1" }, async () => ({
        subject: "s",
        body: "b",
        model: "m",
        grounded: true,
      }));

      expect(shutdownAsync).toHaveBeenCalledTimes(1);
      expect(flushAsync).not.toHaveBeenCalled();
    });
  });

  describe("shared helpers (research/handoff/architecture/qa agents)", () => {
    it("startAgentTrace opens a real trace with the given name/tags", async () => {
      const { startAgentTrace } = await import("./langfuse");
      startAgentTrace({ name: "research-agent-run", userId: "org_1", tags: ["research-agent"] });
      expect(trace).toHaveBeenCalledWith(
        expect.objectContaining({ name: "research-agent-run", userId: "org_1", tags: ["research-agent"] }),
      );
    });

    it("tracedGeneration records a real generation span per call and ends it with the mapped output", async () => {
      const { startAgentTrace, tracedGeneration } = await import("./langfuse");
      const t = startAgentTrace({ name: "handoff-agent-run", userId: "org_1", tags: ["handoff-agent"] });
      const result = await tracedGeneration(
        t,
        { name: "handoff-agent-act", model: "gpt-4o-mini", input: { prompt: "brief them" } },
        async () => ({ text: "retrieved facts" }),
        (r) => r,
      );

      expect(result).toEqual({ text: "retrieved facts" });
      expect(generation).toHaveBeenCalledWith(
        expect.objectContaining({ name: "handoff-agent-act", model: "gpt-4o-mini" }),
      );
      expect(generationEnd).toHaveBeenCalledWith(
        expect.objectContaining({ output: { text: "retrieved facts" }, level: "DEFAULT" }),
      );
    });

    it("two tracedGeneration calls under one trace record two separate spans (act + structure, e.g. QA/architecture/handoff)", async () => {
      const { startAgentTrace, tracedGeneration } = await import("./langfuse");
      const t = startAgentTrace({ name: "qa-agent-run", userId: "org_1", tags: ["qa-agent"] });
      await tracedGeneration(
        t,
        { name: "qa-agent-act", model: "m", input: {} },
        async () => "acted",
        (r) => r,
      );
      await tracedGeneration(
        t,
        { name: "qa-agent-structure", model: "m", input: {} },
        async () => "structured",
        (r) => r,
      );

      expect(generation).toHaveBeenCalledTimes(2);
      expect(generation.mock.calls[0][0]).toMatchObject({ name: "qa-agent-act" });
      expect(generation.mock.calls[1][0]).toMatchObject({ name: "qa-agent-structure" });
      expect(generationEnd).toHaveBeenCalledTimes(2);
    });

    it("tracedGeneration is a real passthrough (no trace/generation call) when Langfuse isn't configured", async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      vi.resetModules();
      const { startAgentTrace, tracedGeneration } = await import("./langfuse");
      const t = startAgentTrace({ name: "research-agent-run", userId: "org_1" });
      expect(t).toBeNull();

      const result = await tracedGeneration(
        t,
        { name: "x", model: "m", input: {} },
        async () => "raw result",
        (r) => r,
      );
      expect(result).toBe("raw result");
      expect(trace).not.toHaveBeenCalled();
      expect(generation).not.toHaveBeenCalled();
    });

    it("flushAgentTrace calls shutdownAsync on the configured client", async () => {
      const { flushAgentTrace } = await import("./langfuse");
      await flushAgentTrace();
      expect(shutdownAsync).toHaveBeenCalledTimes(1);
    });
  });
});
