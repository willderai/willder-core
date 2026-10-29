// How retrieve() and entity() use the descendant-scope list from
// descendantScopePaths(). retrieve() reports when that list was partial and names
// the scopes it did not search; entity() asks every descendant scope in one call.
// check() and the containment helpers are the real functions' shapes; only
// the scope lookup and the raw store are stubbed.
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
  descendantScopePaths: vi.fn(),
  orgRootPath: (orgId: string) => `org_${orgId}`,
  resolveExecutedPartition: (orgId: string, groupId: string) =>
    groupId === orgId || groupId.startsWith(`${orgId}.`)
      ? { groupId, targetPath: `group:${groupId}` }
      : { groupId, targetPath: groupId },
  AccessDeniedError: class AccessDeniedError extends Error {},
}));

import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import { descendantScopePaths, type AccessContext } from "@/services/access";
import type { EntityLookup, MemoryEntity } from "@/types/memory";

const ctx = { orgId: "org_1", actor: { type: "human", id: "user_1", role: "member" } } as AccessContext;
const ROOT = "org_org_1";
const D1 = `${ROOT}.d1`;
const D2 = `${ROOT}.d2`;
const D3 = `${ROOT}.d3`;

function entityNamed(name: string): MemoryEntity {
  return { uuid: "e1", name, type: "person", summary: "", facts: [] };
}

function storeWithEntityLookup(lookup: (input: EntityLookup) => Promise<MemoryEntity | null>): MemoryStore {
  return {
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn(lookup),
  } as unknown as MemoryStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retrieve() reports partial descendant-scope coverage", () => {
  it("sets partialScopeCoverage when the descendant list was partial", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1], unsearched: [], partial: true });
    const guarded = new GuardedMemoryStore(storeWithEntityLookup(async () => null));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "q" }, ROOT);

    expect(result.partialScopeCoverage).toBe(true);
  });

  it("leaves partialScopeCoverage unset when every descendant scope was searched", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1], unsearched: [], partial: false });
    const guarded = new GuardedMemoryStore(storeWithEntityLookup(async () => null));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "q" }, ROOT);

    expect(result).not.toHaveProperty("partialScopeCoverage");
  });
});

describe("retrieve() names the descendant scopes it did not search", () => {
  it("passes the unsearched list on, with partialScopeCoverage", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1], unsearched: [D2, D3], partial: true });
    const guarded = new GuardedMemoryStore(storeWithEntityLookup(async () => null));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "q" }, ROOT);

    expect(result.partialScopeCoverage).toBe(true);
    expect(result.unsearchedScopes).toEqual([D2, D3]);
  });
});

describe("retrieve() keeps the partitions it asks its own", () => {
  it("never passes on partitions a caller put on the read", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [], unsearched: [], partial: false });
    const store = storeWithEntityLookup(async () => null);

    await new GuardedMemoryStore(store).retrieve(
      ctx,
      { groupId: "org_1", query: "q", groupIds: ["org_OTHER-secret"] },
      D1,
    );

    expect(vi.mocked(store.retrieve).mock.calls.map(([input]) => input.groupIds)).toEqual([undefined]);
  });

  it("refuses a descendant answer from a partition it did not ask", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1, D2], unsearched: [], partial: false });
    const store = {
      retrieve: vi.fn(async (input: { groupIds?: string[] }) => ({
        facts: input.groupIds
          ? [{ uuid: "f", fact: "x", validAt: null, store: "graph", graphGroupId: "org_OTHER-secret" }]
          : [],
      })),
      entity: vi.fn(),
    } as unknown as MemoryStore;

    await expect(new GuardedMemoryStore(store).retrieve(ctx, { groupId: "org_1", query: "q" }, ROOT)).rejects.toThrow(
      "not asked",
    );
  });
});

describe("entity() looks up every descendant scope in one call", () => {
  it("asks all of them at once and answers with the partition the hit was in", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1, D2, D3], unsearched: [], partial: false });
    const store = storeWithEntityLookup(async (input) =>
      input.groupIds ? { ...entityNamed("from d3"), graphGroupId: "org_org_1-d3" } : null,
    );
    const guarded = new GuardedMemoryStore(store);

    const hit = await guarded.entity(ctx, { groupId: "org_1", entityId: "e1" }, ROOT);

    expect(hit).toEqual(entityNamed("from d3"));
    expect(vi.mocked(store.entity).mock.calls.map(([input]) => input.groupIds)).toEqual([
      undefined,
      undefined,
      [D1, D2, D3],
    ]);
  });

  it("refuses a hit from a partition it did not ask", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1], unsearched: [], partial: false });
    const store = storeWithEntityLookup(async (input) =>
      input.groupIds ? { ...entityNamed("elsewhere"), graphGroupId: "org_org_1-d9" } : null,
    );

    await expect(new GuardedMemoryStore(store).entity(ctx, { groupId: "org_1", entityId: "e1" }, ROOT)).rejects.toThrow(
      "not asked",
    );
  });

  it.each([
    { name: "every scope listed", unsearched: [] as string[], partial: false, outcome: null },
    // A lookup by id is one indexed match, so it asks past the search bound too.
    { name: "scopes past the per-read search bound", unsearched: [D2, D3], partial: true, outcome: null },
    { name: "the scope list could not be read", unsearched: [] as string[], partial: true, outcome: "could not list" },
  ])(
    "with no hit and $name, answers not found only when it looked everywhere",
    async ({ unsearched, partial, outcome }) => {
      vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1], unsearched, partial });
      const store = storeWithEntityLookup(async () => null);
      const lookup = new GuardedMemoryStore(store).entity(ctx, { groupId: "org_1", entityId: "e1" }, ROOT);

      if (outcome === null) await expect(lookup).resolves.toBeNull();
      else await expect(lookup).rejects.toThrow(outcome);
      if (outcome === null)
        expect(vi.mocked(store.entity).mock.calls.at(-1)?.[0].groupIds).toEqual([D1, ...unsearched]);
    },
  );

  it("never passes on partitions a caller put on the lookup", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1], unsearched: [], partial: false });
    const store = storeWithEntityLookup(async () => null);

    await new GuardedMemoryStore(store).entity(
      ctx,
      { groupId: "org_1", entityId: "e1", groupIds: ["org_OTHER-secret"] },
      ROOT,
    );

    expect(vi.mocked(store.entity).mock.calls.map(([input]) => input.groupIds)).toEqual([undefined, undefined, [D1]]);
  });

  it("a failed lookup is an error, not 'not found'", async () => {
    vi.mocked(descendantScopePaths).mockResolvedValue({ paths: [D1, D2], unsearched: [], partial: false });
    const store = storeWithEntityLookup(async (input) => {
      if (input.groupIds) throw new Error("memory service timed out");
      return null;
    });

    await expect(new GuardedMemoryStore(store).entity(ctx, { groupId: "org_1", entityId: "e1" }, ROOT)).rejects.toThrow(
      "memory service timed out",
    );
  });
});
