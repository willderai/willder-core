// A connected source's content is ingested at the extraction tier. Without a
// tier floor, provenance ranking gives every page slot to higher tiers first, so
// a README synced into a scope that already holds ten agent facts never comes
// back from memory_query, however well it matches.
// These tests drive the real GuardedMemoryStore.retrieve(); the store mock only
// returns a relevance-ordered page and does no ranking of its own.
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/services/access", async () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: vi.fn((orgId: string) => `org_${orgId}`),
  resolveExecutedPartition: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .resolveExecutedPartition,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));

import { GuardedMemoryStore, takeWithTierFloor } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { ActorType, MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;

function factOf(uuid: string, actorType: ActorType): MemoryFact {
  return { uuid, fact: `fact-${uuid}`, validAt: null, actorType };
}

function many(prefix: string, actorType: ActorType, count: number): MemoryFact[] {
  return Array.from({ length: count }, (_, i) => factOf(`${prefix}-${i + 1}`, actorType));
}

/** One leg that returns its relevance-ordered page, honouring the overfetch limit. */
function singleLegStore(page: MemoryFact[]): MemoryStore {
  return {
    retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
      facts: input.limit ? page.slice(0, input.limit) : page,
    })),
  } as unknown as MemoryStore;
}

describe("GuardedMemoryStore.retrieve — per-tier floor", () => {
  it("returns a synced source's most relevant facts in a scope crowded with agent facts", async () => {
    // Relevance order as a backend returns it: the README's facts match best,
    // then a long tail of agent-written facts.
    const page = [...many("readme", "extraction", 3), ...many("crew", "agent", 30)];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(facts.map((f) => f.uuid)).toEqual([...many("crew", "agent", 8).map((f) => f.uuid), "readme-1", "readme-2"]);
  });

  it("keeps at least six human facts on a default page when every tier is full", async () => {
    const page = [...many("e", "extraction", 10), ...many("a", "agent", 10), ...many("h", "human", 10)];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(facts.map((f) => f.uuid)).toEqual(["h-1", "h-2", "h-3", "h-4", "h-5", "h-6", "a-1", "a-2", "e-1", "e-2"]);
  });
});

describe("takeWithTierFloor", () => {
  it("gives unused floor slots to the best tier that still has facts", () => {
    const merged = [factOf("e-1", "extraction"), ...many("h", "human", 12)];

    const page = takeWithTierFloor(merged, 10);

    expect(page.map((f) => f.uuid)).toEqual(["e-1", ...many("h", "human", 9).map((f) => f.uuid)]);
  });

  it("reserves nothing below a limit of five, so a small page stays strictly ranked", () => {
    const merged = [
      factOf("e-1", "extraction"),
      factOf("a-1", "agent"),
      factOf("h-1", "human"),
      factOf("h-2", "human"),
    ];

    expect(takeWithTierFloor(merged, 2).map((f) => f.uuid)).toEqual(["h-1", "h-2"]);
    expect(takeWithTierFloor(merged, 4).map((f) => f.uuid)).toEqual(["e-1", "a-1", "h-1", "h-2"]);
  });

  it("keeps each tier's survivors as a prefix of that tier, never skipping a more relevant fact", () => {
    const merged = [...many("a", "agent", 5), ...many("e", "extraction", 5), ...many("h", "human", 5)];

    const page = takeWithTierFloor(merged, 10);

    expect(page.map((f) => f.uuid)).toEqual(["a-1", "a-2", "a-3", "e-1", "e-2", "h-1", "h-2", "h-3", "h-4", "h-5"]);
  });
});
