// Ask at org root used to come back Graph 15, Chunks 0 at the 15-fact limit
// while the Chunks search found nine vector hits at similarity 0.60-0.54: the
// hybrid store lists graph facts ahead of vector hits, and every slot went to
// graph facts of the same tier. These tests drive the real
// GuardedMemoryStore.retrieve(); the store mock returns the hybrid store's
// page shape (graph first, then vector hits) and does no ranking of its own.
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

import { GuardedMemoryStore, reserveVectorSlots, takeWithTierFloor } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { ActorType, MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;

function graphFacts(prefix: string, actorType: ActorType, count: number): MemoryFact[] {
  return Array.from({ length: count }, (_, i) => ({
    uuid: `${prefix}-${i + 1}`,
    fact: `graph ${prefix} ${i + 1}`,
    validAt: null,
    actorType,
    store: "graph" as const,
  }));
}

function vectorHits(prefix: string, actorType: ActorType, similarities: number[]): MemoryFact[] {
  return similarities.map((similarity, i) => ({
    uuid: `${prefix}-${i + 1}`,
    fact: `chunk ${prefix} ${i + 1}`,
    validAt: null,
    actorType,
    store: "semantic" as const,
    similarity,
  }));
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

describe("GuardedMemoryStore.retrieve — reserved vector slots", () => {
  it("returns vector hits above the floor alongside graph facts at org root (the 15-and-0 case)", async () => {
    const chunks = vectorHits("c", "extraction", [0.6, 0.59, 0.58, 0.57, 0.56, 0.55, 0.55, 0.54, 0.54]);
    const page = [...graphFacts("g", "extraction", 30), ...chunks];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts, breakdown } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 15 });

    expect(facts).toHaveLength(15);
    expect(uuids(facts.filter((f) => f.store === "semantic"))).toEqual(["c-1", "c-2", "c-3", "c-4", "c-5"]);
    // The vector hits take the tail of the graph facts, never the head.
    expect(uuids(facts.filter((f) => f.store === "graph"))).toEqual(uuids(graphFacts("g", "extraction", 10)));
    expect(breakdown?.stores).toEqual([
      { store: "graph", hits: 10 },
      { store: "semantic", hits: 5 },
    ]);
  });

  it("reserves nothing for vector hits below the similarity floor", async () => {
    const page = [...graphFacts("g", "agent", 30), ...vectorHits("c", "agent", [0.49, 0.3, 0.2])];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 15 });

    expect(uuids(facts)).toEqual(uuids(graphFacts("g", "agent", 15)));
  });

  it("takes the slots from lower-tier graph facts before a human-asserted one", async () => {
    const page = [
      ...graphFacts("h", "human", 12),
      ...graphFacts("e", "extraction", 12),
      ...vectorHits("c", "extraction", [0.8, 0.7, 0.6]),
    ];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 15 });

    expect(uuids(facts.filter((f) => f.actorType === "human"))).toEqual(uuids(graphFacts("h", "human", 12)));
    expect(uuids(facts.filter((f) => f.store === "semantic"))).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("still answers from a connected source's content in a scope full of agent facts", async () => {
    // A GitHub source syncs into a busy scope, and the
    // question only its README answers must still come back. Source content is
    // extraction-tier and graph-only, so it is exactly what the vector reserve
    // would otherwise evict first.
    const page = [
      ...graphFacts("g", "agent", 20),
      ...graphFacts("readme", "extraction", 2),
      ...vectorHits("c", "agent", [0.8, 0.7, 0.6]),
    ];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(uuids(facts.filter((f) => f.actorType === "extraction"))).toEqual(["readme-1", "readme-2"]);
    expect(uuids(facts.filter((f) => f.store === "semantic"))).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("serves the closest vector hit when chunks pulled up by their graph facts already fill the reserve", async () => {
    // A fact queried by its own text came back 15th of 20 and not at all in 10: three
    // weaker chunks reached the page in place of graph facts extracted from them
    // (collapseIntoSourceChunks), the reserve counted them as its three slots, and the
    // closest hit, which no graph fact on the page names, never got one.
    const pulledUp = vectorHits("d", "agent", [0.56, 0.55, 0.54]);
    const extractedFrom = pulledUp.map((chunk, i) => ({
      ...graphFacts(`x${i + 1}`, "agent", 1)[0],
      chunkIds: [chunk.uuid],
    }));
    const closest = vectorHits("own", "agent", [0.97]);
    const page = [...extractedFrom, ...graphFacts("g", "agent", 30), ...closest, ...pulledUp];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(facts).toHaveLength(10);
    // The closest hit is served ahead of the less similar chunks that hold graph ranks.
    expect(uuids(facts.filter((f) => f.store === "semantic"))).toEqual(["own-1", "d-1", "d-2", "d-3"]);
    // The closest hit takes the last graph fact's slot; the pulled-up chunks keep theirs.
    expect(uuids(facts.filter((f) => f.store === "graph"))).toEqual(uuids(graphFacts("g", "agent", 6)));
  });

  // A fact written a moment ago is not in the graph yet, while the graph
  // already holds a paraphrase of each earlier version. Every paraphrase pulled its own
  // chunk up (collapseIntoSourceChunks), so the page held only chunks, none of them a
  // graph fact the reserve could evict, and the write was not served to the next query.
  it.each([
    {
      name: "the pulled-up chunk ranked last gives way",
      similarities: [0.93, 0.92, 0.91, 0.9, 0.89, 0.88, 0.87, 0.86, 0.85, 0.84, 0.83, 0.82],
      keeps: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    },
    {
      name: "a pulled-up chunk that is itself a reserved hit keeps its place",
      similarities: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.99],
      keeps: [0, 1, 2, 3, 4, 5, 6, 7, 9],
    },
  ])(
    "serves the closest vector hit when every slot holds a chunk pulled up by its graph fact: $name",
    async ({ similarities, keeps }) => {
      const pulledUp = vectorHits("earlier", "agent", similarities);
      const paraphrases = pulledUp.map((chunk, i) => ({
        ...graphFacts(`p${i + 1}`, "agent", 1)[0],
        chunkIds: [chunk.uuid],
      }));
      const justWritten = vectorHits("own", "agent", [1]);
      const store = new GuardedMemoryStore(singleLegStore([...paraphrases, ...justWritten, ...pulledUp]));

      const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

      expect(facts).toHaveLength(10);
      // Served first, so the token budget, which cuts from the bottom, reaches it last.
      expect(uuids(facts)[0]).toBe("own-1");
      expect(uuids(facts).slice(1)).toEqual(keeps.map((i) => pulledUp[i]!.uuid));
    },
  );

  it("keeps a pulled-up chunk's best place when it gives way, and drops the least similar chunk of its tier", async () => {
    // Without the collapse the page is [g1, c1, c2] and g1 gives way to h, so c1 and c2 stay.
    const [c1, c2, c3] = vectorHits("c", "agent", [0.3, 0.3, 0.3]);
    const g1 = { ...graphFacts("g", "agent", 1)[0], chunkIds: [c1!.uuid] };
    const h = vectorHits("h", "agent", [0.9]);
    const store = new GuardedMemoryStore(singleLegStore([g1, c1!, c2!, c3!, ...h]));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 3 });

    expect(uuids(facts)).toEqual(["h-1", "c-1", "c-2"]);
  });

  it("tries the next closest hit when one finds no slot inside the tier floors", async () => {
    // H could only enter by taking the agent tier below its floor of two; A, of that tier, can.
    const humans = vectorHits("hu", "human", [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const closeHuman = vectorHits("H", "human", [0.9]);
    const agentChunks = vectorHits("a", "agent", [0.4, 0.4]);
    const paraphrases = agentChunks.map((chunk, i) => ({
      ...graphFacts(`p${i + 1}`, "agent", 1)[0],
      chunkIds: [chunk.uuid],
    }));
    const closeAgent = vectorHits("A", "agent", [0.8]);
    const store = new GuardedMemoryStore(
      singleLegStore([...humans, ...closeHuman, ...paraphrases, ...agentChunks, ...closeAgent]),
    );

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(uuids(facts).sort()).toEqual([...uuids(humans), "a-1", "A-1"].sort());
  });

  it("never grows the page when several hits take pulled-up chunks' slots", async () => {
    // Each hit frees a different chunk, so two hits leave six.
    const chunks = vectorHits("p", "agent", [0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
    const paraphrases = chunks.map((chunk, i) => ({
      ...graphFacts(`g${i + 1}`, "agent", 1)[0],
      chunkIds: [chunk.uuid],
    }));
    const hits = vectorHits("own", "agent", [1, 0.99]);
    const store = new GuardedMemoryStore(singleLegStore([...paraphrases, ...hits, ...chunks]));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 6 });

    expect(uuids(facts)).toEqual(["own-1", "own-2", "p-1", "p-2", "p-3", "p-4"]);
  });

  it("takes the slot from the least similar chunk when the hit's own tier is not on the page", async () => {
    // A limit of three keeps no tier floor, so the agent-tier hit
    // asks the human tier, whose page is two chunks pulled up by their paraphrases (0.2) and one
    // vector hit of its own (0.8). The 0.8 chunk is served on main; it must not be the one to go.
    const [p1, p2] = vectorHits("hp", "human", [0.2, 0.2]);
    const paraphrases = [p1!, p2!].map((chunk, i) => ({
      ...graphFacts(`hg${i + 1}`, "human", 1)[0],
      chunkIds: [chunk.uuid],
    }));
    const close = vectorHits("hs", "human", [0.8]);
    const own = vectorHits("own", "agent", [1]);
    const store = new GuardedMemoryStore(singleLegStore([...paraphrases, ...own, ...close, p1!, p2!]));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 3 });

    expect(uuids(facts).sort()).toEqual(["hp-1", "hs-1", "own-1"]);
  });

  it("leaves the page alone when the closest hit could only enter by taking a tier below its floor or a vector hit's slot", async () => {
    // The closest hit is now reserved even when weaker hits already fill the share, so this
    // pins the two limits that still bind it: the only graph facts on the page are a source's
    // README at its tier floor, and every other slot holds a vector hit.
    const readme = graphFacts("readme", "extraction", 2);
    const weak = vectorHits("w", "agent", [0.56, 0.55, 0.55, 0.54, 0.54, 0.53, 0.52, 0.51]);
    const closest = vectorHits("own", "agent", [0.97]);
    const store = new GuardedMemoryStore(singleLegStore([...readme, ...weak, ...closest]));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(uuids(facts).sort()).toEqual(uuids([...readme, ...weak]).sort());
  });
});

describe("reserveVectorSlots", () => {
  it("adds only as many vector hits as the page is short of its reserve", () => {
    // Seven qualifying hits, two already on the page: the page is short by three,
    // so three more arrive, not a full reserve of five on top of the two.
    const candidates = [
      ...graphFacts("g", "agent", 20),
      ...vectorHits("c", "agent", [0.9, 0.8, 0.7, 0.6, 0.58, 0.56, 0.55]),
    ];
    const page = [...graphFacts("g", "agent", 13), candidates[20], candidates[21]];

    const reserved = reserveVectorSlots(page, candidates, 15);

    expect(uuids(reserved.filter((f) => f.store === "semantic"))).toEqual(["c-1", "c-2", "c-3", "c-4", "c-5"]);
    expect(uuids(reserved.filter((f) => f.store === "graph"))).toEqual(uuids(graphFacts("g", "agent", 10)));
    expect(reserved).toHaveLength(15);
  });

  it("picks the most similar missing hits, whatever their position among the candidates", () => {
    const hits = vectorHits("c", "agent", [0.55, 0.9, 0.7]);
    const candidates = [...graphFacts("g", "agent", 15), ...hits];

    const reserved = reserveVectorSlots(graphFacts("g", "agent", 15), candidates, 6);

    expect(uuids(reserved.filter((f) => f.store === "semantic"))).toEqual(["c-2", "c-3"]);
  });

  it("leaves the page alone when nothing on it is a graph fact to give up", () => {
    const hits = vectorHits("c", "agent", [0.9, 0.8]);
    const page = vectorHits("d", "agent", [0.4, 0.3, 0.2]);

    expect(reserveVectorSlots(page, [...page, ...hits], 3)).toEqual(page);
  });

  it("keeps a lower tier's floor slots when the incoming hits belong to another tier", () => {
    // The shape a connected source lands in: a busy scope of agent-tier facts,
    // the source's own content at the extraction tier, and agent-tier chunks
    // competing for the reserve. The reserve must come out of the agent tier's
    // surplus, not out of the two slots the floor holds for the source.
    const sourceFacts = graphFacts("src", "extraction", 2);
    const candidates = [...graphFacts("g", "agent", 20), ...sourceFacts, ...vectorHits("c", "agent", [0.8, 0.7, 0.6])];
    const page = takeWithTierFloor(candidates, 10);
    expect(uuids(page.filter((f) => f.actorType === "extraction"))).toEqual(["src-1", "src-2"]);

    const reserved = reserveVectorSlots(page, candidates, 10);

    expect(uuids(reserved.filter((f) => f.actorType === "extraction"))).toEqual(["src-1", "src-2"]);
    expect(uuids(reserved.filter((f) => f.store === "semantic"))).toEqual(["c-1", "c-2", "c-3"]);
    expect(reserved).toHaveLength(10);
  });

  it("takes a graph fact's slot before a pulled-up chunk's", () => {
    const humanFacts = graphFacts("hg", "human", 5);
    const pulledUpChunk = vectorHits("hc", "human", [0.6]);
    const weak = vectorHits("w", "agent", [0.55, 0.55, 0.55]);
    const close = vectorHits("r", "agent", [0.99, 0.98, 0.97]);
    const candidates = [...humanFacts, ...pulledUpChunk, ...weak, ...close];

    const reserved = reserveVectorSlots(takeWithTierFloor(candidates, 10), candidates, 10, new Set(["hc-1"]));

    expect(reserved).toHaveLength(10);
    expect(uuids(reserved)).toEqual(expect.arrayContaining(["hc-1", "r-1", "r-2", "r-3"]));
  });

  it("reserves nothing below a limit of three", () => {
    const candidates = [...graphFacts("g", "agent", 2), ...vectorHits("c", "agent", [0.9])];
    const page = graphFacts("g", "agent", 2);

    expect(reserveVectorSlots(page, candidates, 2)).toEqual(page);
  });
});
