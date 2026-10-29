// HybridMemoryStore unit tests: which stores a query is routed to, which stores
// an ingest writes to, and how the account tier's allowed-store list and latency
// ceiling narrow both.
import { describe, expect, it, vi } from "vitest";
import { HybridMemoryStore } from "./hybrid-store";
import { rankByProvenance } from "./guarded-store";
import { StoreRefusedError, type MemoryStore } from "./memory-store";
import { MemoryServiceError } from "./graphiti-store";
import type { MemoryFact, SearchInput } from "@/types/memory";

function mockStore(facts: string[] = []): MemoryStore {
  return {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-1" }),
    retrieve: vi.fn().mockResolvedValue({ facts: facts.map((f) => ({ uuid: "u1", fact: f, validAt: null })) }),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn().mockResolvedValue({ removed: true }),
    removeEntity: vi.fn().mockResolvedValue({ removed: false }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 0 }),
  } as unknown as MemoryStore;
}

const input: SearchInput = { groupId: "org_1", query: "" };

describe("HybridMemoryStore — query routing", () => {
  it("entity lookup (what is X) asks pgvector too, so a chunk not yet extracted still answers", async () => {
    // The pilot's ckpt_06 shape: the graph holds the extracted fact from before the
    // change; the new chunk is in pgvector, and extraction has not caught up with it.
    const graphiti = {
      ...mockStore(),
      retrieve: vi.fn().mockResolvedValue({
        facts: [{ uuid: "g1", fact: "The launch date is October 20", validAt: null, actorType: "extraction" }],
      }),
    } as unknown as MemoryStore;
    const pgvector = {
      ...mockStore(),
      retrieve: vi.fn().mockResolvedValue({
        facts: [
          { uuid: "p1", fact: "The launch date is now October 27", validAt: null, actorType: "agent", similarity: 0.7 },
        ],
      }),
    } as unknown as MemoryStore;

    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      ...input,
      query: "what is the launch date",
    });

    expect(pgvector.retrieve).toHaveBeenCalled();
    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
    // The graph's fact stays first in the merge; the guarded store's provenance
    // ranking then puts the writer's own chunk ahead of the extracted one.
    expect(result.facts.map((f) => f.uuid)).toEqual(["g1", "p1"]);
    expect(rankByProvenance(result.facts).map((f) => f.fact)).toEqual([
      "The launch date is now October 27",
      "The launch date is October 20",
    ]);
  });

  it("entity lookup whose vector store fails still answers from the graph, and says the vector store failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = mockStore(["The launch date is October 20"]);
      const pgvector = {
        ...mockStore(),
        retrieve: vi.fn().mockRejectedValue(new Error("memory service /search failed: 502")),
      } as unknown as MemoryStore;

      const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
        ...input,
        query: "what is the launch date",
      });

      expect(result.facts.map((f) => f.fact)).toEqual(["The launch date is October 20"]);
      expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic", failed: true }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("semantic query runs both stores", async () => {
    const graphiti = mockStore(["pricing discussed last week"]);
    const pgvector = mockStore(["pricing doc chunk"]);
    const store = new HybridMemoryStore(graphiti, pgvector);

    await store.retrieve({ ...input, query: "what have we discussed about pricing" });

    expect(graphiti.retrieve).toHaveBeenCalled();
    expect(pgvector.retrieve).toHaveBeenCalled();
  });

  it("deduplicates facts that appear in both stores", async () => {
    const sharedFact = "Elon Musk is a prospect";
    const graphiti = mockStore([sharedFact]);
    const pgvector = mockStore([sharedFact, "extra pgvector fact"]);
    const store = new HybridMemoryStore(graphiti, pgvector);

    const result = await store.retrieve({ ...input, query: "tell me about prospects" });

    const matching = result.facts.filter((f) => f.fact === sharedFact);
    expect(matching).toHaveLength(1);
  });

  it("dedup keeps whichever copy carries a real actorType, not just whichever arrived first", async () => {
    // A [...graphitiFacts, ...pgFacts] first-wins dedup lets an unstamped
    // Graphiti copy always beat a pgvector copy that actually knows the tier.
    // Same claim in both legs, Graphiti's actorType absent, pgvector's
    // actorType real.
    const sharedFact = "the board approved the raise";
    const graphiti: MemoryStore = {
      ...mockStore(),
      retrieve: vi.fn().mockResolvedValue({
        facts: [{ uuid: "g1", fact: sharedFact, validAt: null }], // no actorType
      }),
    } as unknown as MemoryStore;
    const pgvector: MemoryStore = {
      ...mockStore(),
      retrieve: vi.fn().mockResolvedValue({
        facts: [{ uuid: "p1", fact: sharedFact, validAt: null, actorType: "human" }],
      }),
    } as unknown as MemoryStore;
    const store = new HybridMemoryStore(graphiti, pgvector);

    const result = await store.retrieve({ ...input, query: "raise" });

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].actorType).toBe("human");
  });

  describe("dedup between a stored chunk and the graph's verbatim copy of it", () => {
    // The memory service stores a write in its own words when extraction finds no relation
    // in it (memory-service `ensure_graph_visible`), so the graph can return the exact text
    // of a stored chunk. Serving the graph copy hides the chunk: the read then cannot
    // collapse the chunk's paraphrases into it, and the line carries the graph's clock
    // instead of the date the chunk was written with.
    const text = "[t035 2026-03-03T09:42] Mina Park (patient): I think I'm here for the 11 o'clock follow-up.";
    const legs = (graph: Record<string, unknown>, chunk: Record<string, unknown>) =>
      new HybridMemoryStore(
        {
          ...mockStore(),
          retrieve: vi.fn().mockResolvedValue({
            facts: [graph, { uuid: "g-other", fact: "another fact", validAt: null, store: "graph" }],
          }),
        } as unknown as MemoryStore,
        { ...mockStore(), retrieve: vi.fn().mockResolvedValue({ facts: [chunk] }) } as unknown as MemoryStore,
      );
    const graphCopy = {
      uuid: "g-verbatim",
      fact: text,
      validAt: "2026-10-12T06:59:29+00:00",
      actorType: "agent",
      store: "graph",
      chunkIds: ["c1"],
    };
    const chunk = {
      uuid: "c1",
      fact: text,
      validAt: "2026-03-03T09:42:00.000Z",
      actorType: "agent",
      store: "semantic",
    };

    it("serves the stored chunk, in the graph copy's place, when both carry the same provenance", async () => {
      const result = await legs(graphCopy, chunk).retrieve({ ...input, query: "follow-up" });

      expect(result.facts.map((f) => f.uuid)).toEqual(["c1", "g-other"]);
      expect(result.facts[0].validAt).toBe("2026-03-03T09:42:00.000Z");
    });

    it("keeps the graph copy when it carries a different provenance than the chunk", async () => {
      // Which tier wins is the ranker's call, not dedup's: swapping copies of different
      // provenance could serve the text at a lower tier than it was asserted at.
      const result = await legs({ ...graphCopy, actorType: "human" }, chunk).retrieve({ ...input, query: "follow-up" });

      expect(result.facts.map((f) => f.uuid)).toEqual(["g-verbatim", "g-other"]);
    });

    it("keeps the synced item the graph copy names on the chunk that replaces it", async () => {
      const result = await legs(
        { ...graphCopy, sourceId: "src1", sourceEventIds: ["ep-item"] },
        { ...chunk, sourceId: "src1" },
      ).retrieve({
        ...input,
        query: "follow-up",
      });

      expect(result.facts[0]).toMatchObject({ uuid: "c1", store: "semantic", sourceEventIds: ["ep-item"] });
    });

    it("keeps the item the chunk names itself over the graph copy's", async () => {
      // The chunk is the stored version, so the item it was written under is the one to cite.
      const result = await legs(
        { ...graphCopy, sourceId: "src1", sourceEventIds: ["ep-graph"] },
        { ...chunk, sourceId: "src1", sourceEventIds: ["ep-chunk"] },
      ).retrieve({ ...input, query: "follow-up" });

      expect(result.facts[0]).toMatchObject({ uuid: "c1", sourceEventIds: ["ep-chunk"] });
    });

    it("keeps the graph copy when the chunk with the same text came from another source", async () => {
      // Every connector passage carries actorType "extraction", so the tier alone cannot tell
      // two sources apart. Swapping here would carry one source's item onto the other's line.
      // The graph copy names its own row: one that names the chunk is the chunk's copy.
      const result = await legs(
        {
          ...graphCopy,
          actorType: "extraction",
          chunkIds: ["c-drive"],
          sourceId: "src-drive",
          sourceEventIds: ["ep-drive-item"],
        },
        { ...chunk, actorType: "extraction", sourceId: "src-site" },
      ).retrieve({ ...input, query: "follow-up" });

      expect(result.facts[0]).toMatchObject({
        uuid: "g-verbatim",
        sourceId: "src-drive",
        sourceEventIds: ["ep-drive-item"],
      });
    });

    it("never carries a synced item onto a stamped copy from another source", async () => {
      // An unstamped graph copy still gives way to a stamped copy of any source, as before
      // this dedup kept items; the item it names belongs to its own source, not the other one.
      const result = await legs(
        { ...graphCopy, actorType: undefined, sourceId: "src-drive", sourceEventIds: ["ep-drive-item"] },
        { ...chunk, actorType: "extraction", sourceId: "src-site" },
      ).retrieve({ ...input, query: "follow-up" });

      expect(result.facts[0]).toMatchObject({ uuid: "c1", sourceId: "src-site" });
      expect(result.facts[0].sourceEventIds).toBeUndefined();
    });

    it("keeps the graph copy when only the chunk names a source, and the copy names another row", async () => {
      // A copy naming the chunk itself gives way to it (hybrid-store.chunk-dedup.test.ts).
      const result = await legs(
        { ...graphCopy, chunkIds: ["c-other"], sourceEventIds: ["ep-item"] },
        { ...chunk, sourceId: "src1" },
      ).retrieve({ ...input, query: "follow-up" });

      expect(result.facts[0].uuid).toBe("g-verbatim");
    });

    it("keeps the first of two stored copies of the same text, the one ranked higher", async () => {
      const store = new HybridMemoryStore(
        { ...mockStore(), retrieve: vi.fn().mockResolvedValue({ facts: [] }) } as unknown as MemoryStore,
        {
          ...mockStore(),
          retrieve: vi
            .fn()
            .mockResolvedValue({ facts: [chunk, { ...chunk, uuid: "c2", validAt: "2026-01-01T00:00:00.000Z" }] }),
        } as unknown as MemoryStore,
      );
      const result = await store.retrieve({ ...input, query: "follow-up" });

      expect(result.facts.map((f) => f.uuid)).toEqual(["c1"]);
    });
  });

  it("returns graphiti facts even when pgvector fails", async () => {
    const graphiti = mockStore(["graphiti fact"]);
    const pgvector = {
      ...mockStore(),
      retrieve: vi.fn().mockRejectedValue(new Error("db down")),
    } as unknown as MemoryStore;
    const store = new HybridMemoryStore(graphiti, pgvector);

    const result = await store.retrieve({ ...input, query: "what do we know" });

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].fact).toBe("graphiti fact");
  });

  it("returns pgvector facts (within budget, never hangs) when graphiti is slow/timed-out", async () => {
    // Simulate the real cold path: the graphiti store's own HTTP timeout has fired,
    // so its retrieve REJECTS after a delay. pgvector answers immediately. The hybrid
    // retrieve must still resolve with the pgvector results and must not hang.
    const graphiti = {
      ...mockStore(),
      retrieve: vi.fn(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("memory service /search timed out after 8000ms")), 30),
          ),
      ),
    } as unknown as MemoryStore;
    const pgvector = mockStore(["pgvector chunk"]);
    const store = new HybridMemoryStore(graphiti, pgvector);

    const start = Date.now();
    const result = await store.retrieve({ ...input, query: "what do we know" });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // resolved on the fast leg, not a 30s wall
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].fact).toBe("pgvector chunk");
  });
});

describe("HybridMemoryStore — ingest routing", () => {
  it("short human content ALSO goes to pgvector (retrievable even if Graphiti extracts nothing)", async () => {
    const graphiti = mockStore();
    const pgvector = mockStore();
    const store = new HybridMemoryStore(graphiti, pgvector);

    await store.ingest({
      groupId: "org_1",
      content: "the outbound job queue uses SQS",
      source: "text",
      actorType: "human",
      origin: "app",
      actorId: "u1",
    });

    expect(graphiti.ingest).toHaveBeenCalled();
    expect(pgvector.ingest).toHaveBeenCalled();
  });

  it("short extraction content goes to graphiti only (seeds/distilled facts don't double-store)", async () => {
    const graphiti = mockStore();
    const pgvector = mockStore();
    const store = new HybridMemoryStore(graphiti, pgvector);

    await store.ingest({
      groupId: "org_1",
      content: "SQS is a Technology.",
      source: "text",
      actorType: "extraction",
      origin: "connector-sync",
      actorId: "sys",
    });

    expect(graphiti.ingest).toHaveBeenCalled();
    expect(pgvector.ingest).not.toHaveBeenCalled();
  });

  it("long human content goes to both stores", async () => {
    const graphiti = mockStore();
    const pgvector = mockStore();
    const store = new HybridMemoryStore(graphiti, pgvector);
    const longContent = "x".repeat(301);

    await store.ingest({
      groupId: "org_1",
      content: longContent,
      source: "text",
      actorType: "human",
      origin: "app",
      actorId: "u1",
    });

    expect(graphiti.ingest).toHaveBeenCalled();
    expect(pgvector.ingest).toHaveBeenCalled();
  });

  it("long extraction content goes to graphiti only", async () => {
    const graphiti = mockStore();
    const pgvector = mockStore();
    const store = new HybridMemoryStore(graphiti, pgvector);
    const longContent = "x".repeat(301);

    await store.ingest({
      groupId: "org_1",
      content: longContent,
      source: "text",
      actorType: "extraction",
      origin: "connector-sync",
      actorId: "sys",
    });

    expect(graphiti.ingest).toHaveBeenCalled();
    expect(pgvector.ingest).not.toHaveBeenCalled();
  });
});

describe("HybridMemoryStore — account tier limits", () => {
  it("with no tier on the input, queries both stores", async () => {
    const graphiti = mockStore(["graph fact"]);
    const pgvector = mockStore(["vector chunk"]);

    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, query: "pricing" });

    expect(result.facts.map((f) => f.fact)).toEqual(["graph fact", "vector chunk"]);
  });

  it("team never asks the graph, only vector", async () => {
    const graphiti = mockStore(["graph fact"]);
    const pgvector = mockStore(["vector chunk"]);

    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      ...input,
      query: "pricing",
      accountTier: "team",
    });

    expect(graphiti.retrieve).not.toHaveBeenCalled();
    expect(result.facts.map((f) => f.fact)).toEqual(["vector chunk"]);
  });

  it("team's entity lookup falls to vector instead of answering from the graph", async () => {
    const graphiti = mockStore(["Elon is a prospect"]);
    const pgvector = mockStore(["Elon chunk"]);

    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      ...input,
      query: "who is Elon",
      accountTier: "team",
    });

    expect(graphiti.retrieve).not.toHaveBeenCalled();
    expect(result.facts.map((f) => f.fact)).toEqual(["Elon chunk"]);
  });

  it("starter asks neither store, since both need a tier above it", async () => {
    const graphiti = mockStore(["graph fact"]);
    const pgvector = mockStore(["vector chunk"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      ...input,
      query: "pricing",
      accountTier: "starter",
    });

    expect(graphiti.retrieve).not.toHaveBeenCalled();
    expect(pgvector.retrieve).not.toHaveBeenCalled();
    expect(result.facts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('account tier "starter"'));
    warn.mockRestore();
  });

  it("abandons a store that has not answered by the tier's latency ceiling and returns the other", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = { ...mockStore(), retrieve: vi.fn(() => new Promise(() => {})) } as unknown as MemoryStore;
      const pgvector = mockStore(["vector chunk"]);

      const pending = new HybridMemoryStore(graphiti, pgvector).retrieve({
        ...input,
        query: "pricing",
        accountTier: "enterprise",
      });
      // Enterprise's ceiling is 10s: nothing settles a millisecond before it.
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect((await pending).facts.map((f) => f.fact)).toEqual(["vector chunk"]);
      expect(warn).toHaveBeenCalledWith(
        "[hybrid] graphiti retrieve failed, returning the other leg only:",
        "exceeded the account tier's 10000ms latency ceiling",
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("HybridMemoryStore — a failed store is asked once more, then reported", () => {
  const failing = (...outcomes: ("throw" | "report" | string[])[]) =>
    ({
      ...mockStore(),
      retrieve: outcomes.reduce(
        (mock, outcome) =>
          outcome === "throw"
            ? mock.mockRejectedValueOnce(new Error("memory service /search failed: 502"))
            : outcome === "report"
              ? mock.mockResolvedValueOnce({ facts: [], storesRead: [{ store: "semantic", failed: true }] })
              : mock.mockResolvedValueOnce({ facts: outcome.map((f) => ({ uuid: f, fact: f, validAt: null })) }),
        vi.fn(),
      ),
    }) as unknown as MemoryStore;

  it("answers from both stores when the vector store fails once and then answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = mockStore(["graph fact"]);
      const pgvector = failing("throw", ["vector chunk"]);

      const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, query: "pricing" });

      expect(pgvector.retrieve).toHaveBeenCalledTimes(2);
      expect(result.facts.map((f) => f.fact)).toEqual(["graph fact", "vector chunk"]);
      expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks a vector store that reports its own failure once more, and marks it failed when it fails again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = mockStore(["graph fact"]);
      const pgvector = failing("report", "report");

      const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, query: "pricing" });

      expect(pgvector.retrieve).toHaveBeenCalledTimes(2);
      expect(result.facts.map((f) => f.fact)).toEqual(["graph fact"]);
      expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic", failed: true }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks a graph store that throws once more, and marks it failed when it throws again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = failing("throw", "throw");
      const pgvector = mockStore(["vector chunk"]);

      const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, query: "pricing" });

      expect(graphiti.retrieve).toHaveBeenCalledTimes(2);
      expect(result.facts.map((f) => f.fact)).toEqual(["vector chunk"]);
      expect(result.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks each healthy store exactly once", async () => {
    const graphiti = mockStore(["graph fact"]);
    const pgvector = mockStore(["vector chunk"]);

    await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, query: "pricing" });

    expect(graphiti.retrieve).toHaveBeenCalledTimes(1);
    expect(pgvector.retrieve).toHaveBeenCalledTimes(1);
  });

  it("spends one latency ceiling on both attempts, so a retry never doubles the wait", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The first attempt fails after 6s; the retry never answers. Enterprise's ceiling
      // is 10s, so the store is dropped at 10s, not at 6s + 10s.
      const graphiti = {
        ...mockStore(),
        retrieve: vi
          .fn()
          .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error("502")), 6_000)))
          .mockImplementationOnce(() => new Promise(() => {})),
      } as unknown as MemoryStore;
      const pgvector = mockStore(["vector chunk"]);

      const pending = new HybridMemoryStore(graphiti, pgvector).retrieve({
        ...input,
        query: "pricing",
        accountTier: "enterprise",
      });
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(graphiti.retrieve).toHaveBeenCalledTimes(2);
      expect((await pending).storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not ask again once the latency ceiling has passed, even when the first attempt fails after it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Enterprise's ceiling is 10s; the graph call fails at 12s, after the read returned.
      const graphiti = {
        ...mockStore(),
        retrieve: vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(new Error("502")), 12_000))),
      } as unknown as MemoryStore;
      const pgvector = mockStore(["vector chunk"]);

      const result = new HybridMemoryStore(graphiti, pgvector).retrieve({
        ...input,
        query: "pricing",
        accountTier: "enterprise",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await result).storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(graphiti.retrieve).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not ask again a store that reports a failed read after the ceiling has passed", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The vector store's own embedding deadline is the ceiling, so its reported
      // failure can land just after the read gave up on it.
      const pgvector = {
        ...mockStore(),
        retrieve: vi.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ facts: [], storesRead: [{ store: "semantic", failed: true }] }), 12_000),
            ),
        ),
      } as unknown as MemoryStore;
      const graphiti = mockStore(["graph fact"]);

      const result = new HybridMemoryStore(graphiti, pgvector).retrieve({
        ...input,
        query: "pricing",
        accountTier: "enterprise",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await result).storesRead).toEqual([{ store: "graph" }, { store: "semantic", failed: true }]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(pgvector.retrieve).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ["the memory service refused the key", new MemoryServiceError("memory service /search failed: unauthorized", 401)],
    ["the memory service URL is not set", new MemoryServiceError("GRAPHITI_SERVICE_URL is not set")],
    ["the store lacks the schema it needs", new StoreRefusedError("memory_chunks.embedding does not exist")],
  ])("does not ask again when %s, and marks the store failed", async (_, error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = { ...mockStore(), retrieve: vi.fn().mockRejectedValue(error) } as unknown as MemoryStore;
      const pgvector = mockStore(["vector chunk"]);

      const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, query: "pricing" });

      expect(graphiti.retrieve).toHaveBeenCalledTimes(1);
      expect(result.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks a store that already failed earlier in the same read only once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graphiti = failing("throw", "throw");
      const pgvector = mockStore(["vector chunk"]);

      const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
        ...input,
        query: "pricing",
        noRetry: ["graph"],
      });

      expect(graphiti.retrieve).toHaveBeenCalledTimes(1);
      expect(result.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("HybridMemoryStore: the text leg's rank across copies of one text", () => {
  const QUOTED = "Findings T-4c378528: Cause is components/settings/sources-panel.tsx, which drops the row";
  const answering = (facts: MemoryFact[]) =>
    ({ retrieve: vi.fn().mockResolvedValue({ facts }) }) as unknown as MemoryStore;
  const graphWithCopyAt = (place: number): MemoryFact[] =>
    Array.from({ length: 20 }, (_, i) =>
      i === place
        ? { uuid: "graph-copy", fact: QUOTED, validAt: null, actorType: "agent", store: "graph" }
        : {
            uuid: `graph-${i + 1}`,
            fact: `the nightly job ran task ${i + 1}`,
            validAt: null,
            actorType: "agent",
            store: "graph",
          },
    );

  // The graph's copy is kept when the copies' sources differ,
  // and the vector copy that carried the text rank was dropped with it.
  it.each([
    { name: "the graph's copy is kept (another source)", chunkSource: "src-1", served: "graph-copy" },
    { name: "the chunk replaces the graph's copy (same provenance)", chunkSource: undefined, served: "asked" },
  ])("$name: the quoted text is served first", async ({ chunkSource, served }) => {
    const chunk: MemoryFact = {
      uuid: "asked",
      fact: QUOTED,
      validAt: null,
      actorType: "agent",
      store: "semantic",
      similarity: 0.4,
      textMatchRank: 1,
      sourceId: chunkSource,
    };
    const hybrid = new HybridMemoryStore(answering(graphWithCopyAt(14)), answering([chunk]));

    const facts = (await hybrid.retrieve({ groupId: "org_x", query: QUOTED, accountTier: "enterprise" })).facts;

    expect(facts[0]).toMatchObject({ uuid: served, textMatchRank: 1 });
  });
});
