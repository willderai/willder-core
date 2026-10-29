// A guarded read serves a stored chunk once, in place of the graph facts extracted
// from it. These tests drive the real GuardedMemoryStore.retrieve(); the store mock
// returns the hybrid store's page shape (graph facts first, then vector hits) and does
// no ranking of its own. Access and erasure on a real database are covered in
// guarded-store.source-collapse.realdb.test.ts.
import { describe, expect, it, vi } from "vitest";
// These tests assert on collapse and ranking, not on conflict resolution, so the
// supersession record a guarded read consults is empty here.
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

import { collapseIntoSourceChunks, GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { ActorType, MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;

function graphFact(uuid: string, chunkIds: string[] = [], actorType: ActorType = "agent"): MemoryFact {
  return { uuid, fact: `graph ${uuid}`, validAt: null, actorType, store: "graph", chunkIds };
}

function chunk(uuid: string, actorType: ActorType = "agent", similarity = 0.4): MemoryFact {
  return { uuid, fact: `chunk ${uuid}`, validAt: "2026-03-11T15:10:00.000Z", actorType, store: "semantic", similarity };
}

/** One leg that returns its page, honouring the overfetch limit. */
function singleLegStore(page: MemoryFact[]): MemoryStore {
  return {
    retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
      facts: input.limit ? page.slice(0, input.limit) : page,
      storesRead: [{ store: "graph" }, { store: "semantic" }],
    })),
  } as unknown as MemoryStore;
}

const uuids = (facts: MemoryFact[]) => facts.map((f) => f.uuid);

describe("collapseIntoSourceChunks", () => {
  it("drops a graph fact whose source chunk is a candidate, and keeps the chunk once", () => {
    const out = collapseIntoSourceChunks([graphFact("g1", ["c1"]), graphFact("g2"), chunk("c1")]);
    expect(uuids(out.facts)).toEqual(["c1", "g2"]);
    expect([...out.pulledUp]).toEqual(["c1"]);
  });

  it("moves the chunk up to the place of its best-ranked extracted fact", () => {
    const out = collapseIntoSourceChunks([
      graphFact("g0"),
      graphFact("g1", ["c1"]),
      graphFact("g2", ["c1"]),
      chunk("c2"),
      chunk("c1"),
    ]);
    expect(uuids(out.facts)).toEqual(["g0", "c1", "c2"]);
    // c1 took g1's place; c2 kept its own.
    expect([...out.pulledUp]).toEqual(["c1"]);
  });

  it("keeps a graph fact whose source chunk is not a candidate, and never adds that chunk", () => {
    const out = collapseIntoSourceChunks([graphFact("g1", ["hidden"]), chunk("c1")]);
    expect(uuids(out.facts)).toEqual(["g1", "c1"]);
  });

  it("keeps a fact several stored chunks assert, since it can say what no one of them says alone", () => {
    const out = collapseIntoSourceChunks([graphFact("g1", ["c2", "c1"]), chunk("c1"), chunk("c2")]);
    expect(uuids(out.facts)).toEqual(["g1", "c1", "c2"]);
  });

  it("keeps a graph fact that outranks its chunk's tier, so collapsing never lowers a tier", () => {
    const out = collapseIntoSourceChunks([graphFact("g1", ["c1"], "human"), chunk("c1", "agent")]);
    expect(uuids(out.facts)).toEqual(["g1", "c1"]);
  });

  it("drops a lower-tier graph fact and leaves its chunk in the chunk's own tier", () => {
    const out = collapseIntoSourceChunks([
      chunk("c0", "agent"),
      chunk("c1", "agent"),
      graphFact("g1", ["c1"], "extraction"),
    ]);
    expect(uuids(out.facts)).toEqual(["c0", "c1"]);
    // c1 ranked above its fact already, so it holds its own place, not the fact's.
    expect(out.pulledUp.size).toBe(0);
  });

  it("never collapses into another graph fact, only into a stored chunk", () => {
    const out = collapseIntoSourceChunks([graphFact("g1", ["g2"]), graphFact("g2")]);
    expect(uuids(out.facts)).toEqual(["g1", "g2"]);
  });

  it("returns the candidates unchanged when no chunk is among them", () => {
    const candidates = [graphFact("g1", ["c1"]), graphFact("g2", ["c2"])];
    expect(collapseIntoSourceChunks(candidates).facts).toEqual(candidates);
  });
});

describe("GuardedMemoryStore.retrieve: extracted facts collapse into their source chunk", () => {
  it("frees the slots a chunk's paraphrases held, for the next distinct fact", async () => {
    // Two paraphrases of c1 and c1 itself used to fill three of four slots.
    const page = [graphFact("g1", ["c1"]), graphFact("g2", ["c1"]), graphFact("g3"), graphFact("g4"), chunk("c1")];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "portal access", limit: 3 });

    expect(uuids(facts).sort()).toEqual(["c1", "g3", "g4"]);
  });

  it("serves the dated chunk where its undated paraphrase would have ranked", async () => {
    // Twelve graph facts ahead of the chunk; the first is a paraphrase of it. Without the
    // collapse the chunk falls past the page and only the undated paraphrase is served.
    const page = [graphFact("g1", ["c1"]), ...Array.from({ length: 11 }, (_, i) => graphFact(`n${i}`)), chunk("c1")];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "follow-up plan", limit: 5 });

    expect(uuids(facts)).toContain("c1");
    expect(uuids(facts)).not.toContain("g1");
    expect(facts.find((f) => f.uuid === "c1")?.validAt).toBe("2026-03-11T15:10:00.000Z");
  });

  it("records only the facts it served as read, never a collapsed paraphrase", async () => {
    const { recordReadFactIds } = await import("@/services/access");
    const page = [graphFact("g1", ["c1"]), chunk("c1")];
    const store = new GuardedMemoryStore(singleLegStore(page));

    await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 5 });

    expect(vi.mocked(recordReadFactIds).mock.calls.at(-1)?.[2]).toEqual(["c1"]);
  });
});
