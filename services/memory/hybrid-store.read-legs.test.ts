// HybridMemoryStore reads the legs the routing policy names (services/memory/routing-policy.ts):
// the text leg alone goes to the chunk store's own text read, never its vector
// search, and a read that asks the graph while the policy is in force says how many rows
// the graph has yet to absorb (`partial`, `pendingRows`).
//
// Fakes: both stores. The policy's legs are set per test, since no tier but enterprise is in
// force yet (`ROUTING_DECISIONS.D6`); the flags-off routing itself is routing-policy.read-legs.test.ts's.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "./memory-store";
import type { ReadLeg } from "./routing-policy";
import type { SearchInput } from "@/types/memory";

const policy = vi.hoisted(() => ({ legs: null as ReadLeg[] | null, inForce: null as boolean | null }));

vi.mock("./routing-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./routing-policy")>();
  return {
    ...actual,
    readLegs: (...args: Parameters<typeof actual.readLegs>) => policy.legs ?? actual.readLegs(...args),
    readPolicyInForce: (...args: Parameters<typeof actual.readPolicyInForce>) =>
      policy.inForce ?? actual.readPolicyInForce(...args),
  };
});

const { HybridMemoryStore } = await import("./hybrid-store");

function stores(pending = 0) {
  const graphiti = {
    retrieve: vi.fn().mockResolvedValue({
      facts: [{ uuid: "g1", fact: "graph fact", validAt: null, store: "graph" }],
      storesRead: [{ store: "graph" }],
    }),
  } as unknown as MemoryStore;
  const pgvector = {
    retrieve: vi.fn().mockResolvedValue({
      facts: [{ uuid: "c1", fact: "vector chunk", validAt: null, store: "semantic" }],
      storesRead: [{ store: "semantic" }],
    }),
    retrieveText: vi.fn().mockResolvedValue({
      facts: [{ uuid: "c2", fact: "quoted chunk", validAt: null, store: "semantic", textMatchRank: 1 }],
      storesRead: [{ store: "semantic", leg: "text" }],
    }),
    pendingAbsorption: vi.fn().mockResolvedValue(pending),
  } as unknown as MemoryStore & Required<Pick<MemoryStore, "retrieveText" | "pendingAbsorption">>;
  return { graphiti, pgvector };
}

const input: SearchInput = { groupId: "org_1", query: '"the deploy freezes every Friday"' };

afterEach(() => {
  policy.legs = null;
  policy.inForce = null;
  vi.unstubAllEnvs();
});

describe("HybridMemoryStore reads the policy's legs", () => {
  it("the text leg alone asks the chunk store's text read, not its vector search, nor the graph", async () => {
    policy.legs = ["text"];
    const { graphiti, pgvector } = stores();
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "starter" });
    expect(pgvector.retrieveText).toHaveBeenCalledTimes(1);
    expect(pgvector.retrieve).not.toHaveBeenCalled();
    expect(graphiti.retrieve).not.toHaveBeenCalled();
    expect(result.facts.map((f) => f.uuid)).toEqual(["c2"]);
    expect(result.storesRead).toEqual([{ store: "semantic", leg: "text" }]);
  });

  it("the text and vector legs together are the chunk store's one fused read, as before the split into legs", async () => {
    policy.legs = ["text", "semantic"];
    const { graphiti, pgvector } = stores();
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "team" });
    expect(pgvector.retrieve).toHaveBeenCalledTimes(1);
    expect(pgvector.retrieveText).not.toHaveBeenCalled();
    expect(graphiti.retrieve).not.toHaveBeenCalled();
    expect(result.storesRead).toEqual([{ store: "semantic" }]);
  });

  it("skipPgvector skips the text leg too, as it skipped the fused read", async () => {
    policy.legs = ["text"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { graphiti, pgvector } = stores();
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      ...input,
      accountTier: "starter",
      skipPgvector: true,
    });
    expect(pgvector.retrieveText).not.toHaveBeenCalled();
    expect(result).toEqual({ facts: [], storesRead: [] });
    warn.mockRestore();
  });
});

describe("a read the graph has not caught up with says so", () => {
  it("with the policy in force, the graph's read carries partial and the rows it has yet to absorb", async () => {
    policy.inForce = true;
    const { graphiti, pgvector } = stores(3);
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "enterprise" });
    expect(result.storesRead).toEqual([{ store: "graph", partial: true, pendingRows: 3 }, { store: "semantic" }]);
    expect(pgvector.pendingAbsorption).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "org_1", accountTier: "enterprise" }),
    );
  });

  it("nothing pending: the graph's read is not partial", async () => {
    policy.inForce = true;
    const { graphiti, pgvector } = stores(0);
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "enterprise" });
    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
  });

  it("flags off: the pending count is never asked, and storesRead is exactly today's", async () => {
    const { graphiti, pgvector } = stores(3);
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "enterprise" });
    expect(pgvector.pendingAbsorption).not.toHaveBeenCalled();
    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
    expect(result.facts.map((f) => f.uuid)).toEqual(["g1", "c1"]);
  });

  it("a tier that does not read the graph never asks the pending count", async () => {
    policy.inForce = true;
    policy.legs = ["text", "semantic"];
    const { graphiti, pgvector } = stores(3);
    await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "team" });
    expect(pgvector.pendingAbsorption).not.toHaveBeenCalled();
  });

  it("a failed pending count costs the read nothing and claims nothing", async () => {
    policy.inForce = true;
    const error = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { graphiti, pgvector } = stores();
    vi.mocked(pgvector.pendingAbsorption).mockRejectedValue(new Error("connection reset"));
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({ ...input, accountTier: "enterprise" });
    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
    expect(result.facts.map((f) => f.uuid)).toEqual(["g1", "c1"]);
    error.mockRestore();
  });

  it("a failed graph read is reported failed, never partial", async () => {
    policy.inForce = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { graphiti, pgvector } = stores(3);
    vi.mocked(graphiti.retrieve).mockRejectedValue(new Error("boom"));
    const result = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      ...input,
      accountTier: "enterprise",
      noRetry: ["graph"],
    });
    expect(result.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
    warn.mockRestore();
  });
});
