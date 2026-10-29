// Which store answered a read, and what the answer cost in context.
//
// Each backend stamps the facts it returns with its store and reports the
// stores it asked (`storesRead`); the hybrid store keeps both through its merge;
// the access-checked read turns them into the breakdown the Ask page shows. The
// pgvector similarity score itself is asserted against real Postgres in
// pgvector-similarity.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));
// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) serves them as they are; it is proven against
// real rows in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));

vi.mock("@/services/access", () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: (orgId: string) => `org_${orgId}`,
  resolveExecutedPartition: (_orgId: string, groupId: string) => ({ groupId, targetPath: groupId }),
  AccessDeniedError: class AccessDeniedError extends Error {},
}));

import { descendantScopePaths } from "@/services/access";
import type { AccessContext } from "@/services/access";
import type { MemoryFact, SearchInput, SearchResult } from "@/types/memory";
import { GraphitiMemoryStore } from "./graphiti-store";
import { GuardedMemoryStore } from "./guarded-store";
import { HybridMemoryStore } from "./hybrid-store";
import type { MemoryStore } from "./memory-store";

const ctx = { orgId: "1", actor: { type: "human", id: "user_1", role: "member" } } as AccessContext;
const semanticQuery: SearchInput = { groupId: "1", query: "what have we discussed about pricing" };

const fact = (uuid: string, text: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({
  uuid,
  fact: text,
  validAt: null,
  actorType: "human",
  ...extra,
});

function storeReturning(...results: (SearchResult | Error)[]): MemoryStore {
  const retrieve = vi.fn();
  for (const result of results) {
    if (result instanceof Error) retrieve.mockRejectedValueOnce(result);
    else retrieve.mockResolvedValueOnce(result);
  }
  retrieve.mockResolvedValue({ facts: [] });
  return { retrieve } as unknown as MemoryStore;
}

beforeEach(() => vi.clearAllMocks());

describe("GraphitiMemoryStore.retrieve", () => {
  it("stamps each fact as a graph fact and reports the graph as read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ facts: [{ uuid: "e1", fact: "Amy owns pricing", valid_at: null }] }),
      }),
    );
    try {
      const result = await new GraphitiMemoryStore("http://svc", "key").retrieve(semanticQuery);
      expect(result.facts[0].store).toBe("graph");
      expect(result.storesRead).toEqual([{ store: "graph" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("HybridMemoryStore.retrieve: stores read", () => {
  it("reports both stores for a semantic question, and keeps each fact's store through the merge", async () => {
    const graph = storeReturning({
      facts: [fact("e1", "Amy owns pricing", { store: "graph" })],
      storesRead: [{ store: "graph" }],
    });
    const vector = storeReturning({
      facts: [fact("c1", "Pricing doc: tiers are 29 and 99", { store: "semantic", similarity: 0.81 })],
      storesRead: [{ store: "semantic" }],
    });

    const result = await new HybridMemoryStore(graph, vector).retrieve(semanticQuery);

    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
    expect(result.facts.map((f) => [f.uuid, f.store, f.similarity])).toEqual([
      ["e1", "graph", undefined],
      ["c1", "semantic", 0.81],
    ]);
  });

  it("reports both stores for an entity lookup, since vector search is asked too", async () => {
    const graph = storeReturning({ facts: [], storesRead: [{ store: "graph" }] });
    const vector = storeReturning({ facts: [], storesRead: [{ store: "semantic" }] });

    const result = await new HybridMemoryStore(graph, vector).retrieve({ ...semanticQuery, query: "who is Amy" });

    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
  });

  it("marks a store whose call failed, so no hits reads as a failure rather than an empty store", async () => {
    // Failing twice: a store is asked once more before it is reported failed.
    const graph = storeReturning(new Error("AuraDB reconnect"), new Error("AuraDB reconnect"));
    const vector = storeReturning({
      facts: [fact("c1", "chunk", { store: "semantic" })],
      storesRead: [{ store: "semantic" }],
    });

    const result = await new HybridMemoryStore(graph, vector).retrieve(semanticQuery);

    expect(result.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
  });

  it("does not report vector search on a leg that skips it", async () => {
    const graph = storeReturning({ facts: [], storesRead: [{ store: "graph" }] });
    const vector = storeReturning({ facts: [], storesRead: [{ store: "semantic" }] });

    const result = await new HybridMemoryStore(graph, vector).retrieve({ ...semanticQuery, skipPgvector: true });

    expect(result.storesRead).toEqual([{ store: "graph" }]);
  });
});

describe("GuardedMemoryStore.retrieve: breakdown", () => {
  it("counts the returned facts per store and estimates their context tokens", async () => {
    const store = storeReturning({
      facts: [
        fact("e1", "Amy owns pricing", { store: "graph" }), // 16 chars: 4 tokens
        fact("c1", "Pricing tiers are 29 and 99 a month", { store: "semantic" }), // 35 chars: 9 tokens
        fact("c2", "Annual plans get two months free", { store: "semantic" }), // 32 chars: 8 tokens
      ],
      storesRead: [{ store: "graph" }, { store: "semantic" }],
    });

    const result = await new GuardedMemoryStore(store).retrieve(ctx, semanticQuery);

    expect(result.breakdown).toEqual({
      stores: [
        { store: "graph", hits: 1 },
        { store: "semantic", hits: 2 },
      ],
      contextTokens: 21,
    });
    expect(result.storesRead).toBeUndefined();
  });

  it("lists a store that was asked and returned nothing with zero hits", async () => {
    const store = storeReturning({
      facts: [fact("c1", "chunk", { store: "semantic" })],
      storesRead: [{ store: "graph" }, { store: "semantic" }],
    });

    const result = await new GuardedMemoryStore(store).retrieve(ctx, semanticQuery);

    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 0 },
      { store: "semantic", hits: 1 },
    ]);
  });

  it("counts a fact the limit cut as no hit: the breakdown describes what the caller received", async () => {
    const store = storeReturning({
      facts: [fact("e1", "graph fact", { store: "graph" }), fact("c1", "vector fact", { store: "semantic" })],
      storesRead: [{ store: "graph" }, { store: "semantic" }],
    });

    const result = await new GuardedMemoryStore(store).retrieve(ctx, { ...semanticQuery, limit: 1 });

    expect(result.facts).toHaveLength(1);
    const hits = result.breakdown!.stores.reduce((sum, s) => sum + s.hits, 0);
    expect(hits).toBe(1);
  });

  it("marks a store failed only when every leg that asked it failed", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValueOnce({ paths: ["org_1.sales"], unsearched: [], partial: false });
    const store = storeReturning(
      // the scoped leg: graph failed, vector answered
      {
        facts: [fact("c1", "chunk", { store: "semantic" })],
        storesRead: [{ store: "graph", failed: true }, { store: "semantic" }],
      },
      // the descendant leg (graph only): answered
      { facts: [fact("e1", "graph fact", { store: "graph" })], storesRead: [{ store: "graph" }] },
    );

    const result = await new GuardedMemoryStore(store).retrieve(ctx, semanticQuery);

    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 1 },
      { store: "semantic", hits: 1 },
    ]);
  });

  it("keeps a failure visible when no leg reached the store", async () => {
    const store = storeReturning({ facts: [], storesRead: [{ store: "graph", failed: true }, { store: "semantic" }] });

    const result = await new GuardedMemoryStore(store).retrieve(ctx, semanticQuery);

    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 0, failed: true },
      { store: "semantic", hits: 0 },
    ]);
  });
});

describe("a store the graph has not caught up with", () => {
  it("the breakdown keeps partial and the most rows any call of the read said were pending", async () => {
    const { retrievalBreakdown } = await import("./retrieval-breakdown");
    const facts: MemoryFact[] = [{ uuid: "g1", fact: "graph fact", validAt: null, store: "graph" }];
    const legs: SearchResult[] = [
      { facts, storesRead: [{ store: "graph", partial: true, pendingRows: 2 }, { store: "semantic" }] },
      { facts: [], storesRead: [{ store: "graph", partial: true, pendingRows: 5 }] },
      { facts: [], storesRead: [{ store: "graph" }] },
    ];
    expect(retrievalBreakdown(facts, legs).stores).toEqual([
      { store: "graph", hits: 1, partial: true, pendingRows: 5 },
      { store: "semantic", hits: 0 },
    ]);
  });

  it("no call partial: the breakdown is exactly as before", async () => {
    const { retrievalBreakdown } = await import("./retrieval-breakdown");
    const legs: SearchResult[] = [{ facts: [], storesRead: [{ store: "graph" }, { store: "semantic", leg: "text" }] }];
    expect(retrievalBreakdown([], legs).stores).toEqual([
      { store: "graph", hits: 0 },
      { store: "semantic", hits: 0 },
    ]);
  });
});
