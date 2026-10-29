// A hybrid read keys a graph passage to the stored row it was extracted from by chunk id,
// not by text and provenance stamps alone.
//
// The graph's copy of a passage names the `memory_chunks` row it came from (`chunkIds`, stamped
// at write time). When a read returns both, they are one piece of information, and the row
// is served: it is the version itself, with its writer's date, its subject and scope, its
// `retired` mark, and the provenance Postgres holds for it. The graph's stamp is derived, and
// can lack a source (the memory service reads it from an episode when the edge carries none).
// Exact-text dedup used to refuse the swap whenever the two stamps differed, so it kept the
// graph's copy and dropped the row; the guarded read then could not fold the row's other
// paraphrases into it (collapseIntoSourceChunks), and they took page slots of their own.
//
// What must not change: the tier a text is served at (the swap needs the same actorType), a
// graph copy that names several rows or a row this read did not return, and the privacy
// rules. A graph copy is never relabelled as a stored row, so a serve-time source check of
// graph answers still sees it; the row never takes a deleted source's item or id from it.
import { describe, expect, it, vi } from "vitest";

// The serve-time source check reads Postgres; these are dedup-output tests, as
// guarded-store.test.ts does, and its own realdb tests cover the check.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));

vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));

vi.mock("@/services/access", async () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: vi.fn((orgId: string) => `org_${orgId}`),
  removingFromGraph: vi.fn(async (_org: string, fn: () => Promise<void>) => fn()),
  resolveExecutedPartition: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .resolveExecutedPartition,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));

import { HybridMemoryStore } from "./hybrid-store";
import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { AccessContext } from "@/services/access";
import type { MemoryFact, SearchInput } from "@/types/memory";

const ctx = { orgId: "org_1" } as AccessContext;
const PASSAGE = "The Q3 pricing review moved to 14 November, after the board pack is final.";
const ROW_DATE = "2026-10-02T09:00:00.000Z";

/** The stored row of a synced Drive passage, as the vector leg returns it. */
function row(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    uuid: "c1",
    fact: PASSAGE,
    validAt: ROW_DATE,
    actorType: "extraction",
    sourceId: "src-drive",
    store: "semantic",
    similarity: 0.62,
    subject: "org_1\u0000pricing review",
    scopePath: null,
    ...overrides,
  };
}

/** The graph's verbatim copy of that passage: extraction found no relation in it. */
function passage(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    uuid: "g1",
    fact: PASSAGE,
    validAt: "2026-10-24T00:00:00.000Z",
    actorType: "extraction",
    chunkIds: ["c1"],
    store: "graph",
    graphGroupId: "org_1",
    ...overrides,
  };
}

/** A paraphrase the graph extracted from the same row. */
function paraphrase(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    uuid: "p1",
    fact: "Pricing review is on 14 November",
    validAt: null,
    actorType: "extraction",
    chunkIds: ["c1"],
    sourceId: "src-drive",
    store: "graph",
    graphGroupId: "org_1",
    ...overrides,
  };
}

function leg(facts: MemoryFact[], store: "graph" | "semantic"): MemoryStore {
  return {
    ingest: vi.fn(),
    retrieve: vi.fn().mockResolvedValue({ facts, storesRead: [{ store }] }),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn().mockResolvedValue({ removed: false }),
    removeEntity: vi.fn().mockResolvedValue({ removed: false }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 0 }),
    findFactById: vi.fn().mockResolvedValue(null),
  } as unknown as MemoryStore;
}

const input: SearchInput = { groupId: "org_1", query: "when is the pricing review", limit: 10 };

async function hybridRead(graphFacts: MemoryFact[], rows: MemoryFact[]): Promise<MemoryFact[]> {
  return (await new HybridMemoryStore(leg(graphFacts, "graph"), leg(rows, "semantic")).retrieve(input)).facts;
}

async function guardedPage(graphFacts: MemoryFact[], rows: MemoryFact[], limit = 10): Promise<MemoryFact[]> {
  const hybrid = new HybridMemoryStore(leg(graphFacts, "graph"), leg(rows, "semantic"));
  return (await new GuardedMemoryStore(hybrid).retrieve(ctx, { ...input, limit })).facts;
}

const servedChars = (facts: MemoryFact[]) => facts.reduce((n, f) => n + f.fact.length, 0);
const withoutChunkIds = (facts: MemoryFact[]) => facts.map(({ chunkIds: _ignored, ...f }) => f);

describe("a graph passage and the row it names are served once, as the row", () => {
  it("serves the row in the graph copy's place when the graph's copy lacks the source stamp", async () => {
    const facts = await hybridRead([passage()], [row()]);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ uuid: "c1", store: "semantic", validAt: ROW_DATE, sourceId: "src-drive" });
  });

  it("no-duplicate page: the row, its verbatim graph copy and its paraphrase take one slot", async () => {
    const page = await guardedPage([passage(), paraphrase()], [row()]);

    expect(page.map((f) => f.uuid)).toEqual(["c1"]);
    expect(page.filter((f) => f.fact === PASSAGE)).toHaveLength(1);
    expect(page[0]).toMatchObject({ store: "semantic", validAt: ROW_DATE, sourceId: "src-drive" });
  });

  it("still keeps the graph copy when it is asserted at a higher tier than the row", async () => {
    const facts = await hybridRead([passage({ actorType: "human" })], [row()]);

    expect(facts.map((f) => [f.uuid, f.actorType])).toEqual([["g1", "human"]]);
  });

  it("does not swap on chunk identity for a graph copy that several rows assert", async () => {
    const facts = await hybridRead([passage({ chunkIds: ["c1", "c9"] })], [row()]);

    expect(facts.map((f) => f.uuid)).toEqual(["g1"]);
  });

  it("keeps the row's retired mark, so the guarded read still replaces a superseded version", async () => {
    const facts = await hybridRead([passage()], [row({ retired: true })]);

    expect(facts[0]).toMatchObject({ uuid: "c1", retired: true });
  });
});

describe("tokens neutral", () => {
  // Pages a read can return. Each holds either a graph copy that names a served row, or none.
  const fixtures: { name: string; graph: MemoryFact[]; rows: MemoryFact[] }[] = [
    { name: "unstamped-source passage + paraphrase", graph: [passage(), paraphrase()], rows: [row()] },
    {
      name: "passage stamped with another source",
      graph: [passage({ sourceId: "src-old", sourceEventIds: ["ep-9"] })],
      rows: [row()],
    },
    {
      name: "same stamps (swapped before chunk-id keying too)",
      graph: [passage({ sourceId: "src-drive" })],
      rows: [row()],
    },
    {
      name: "graph copy names an unreturned row",
      graph: [passage({ chunkIds: ["c-gone"] })],
      rows: [row({ uuid: "c2", fact: "Another passage." })],
    },
    { name: "multi-row graph fact", graph: [passage({ chunkIds: ["c1", "c9"] })], rows: [row()] },
    { name: "higher-tier graph copy", graph: [passage({ actorType: "human" })], rows: [row()] },
    { name: "no graph facts", graph: [], rows: [row(), row({ uuid: "c2", fact: "Another passage." })] },
  ];

  it.each(fixtures)(
    "$name: the served page is never longer than the text-only dedup served",
    async ({ graph, rows }) => {
      // Stripped of chunk ids, the read is exactly the text-only dedup this change extends.
      const before = await guardedPage(withoutChunkIds(graph), rows);
      const after = await guardedPage(graph, rows);

      expect(servedChars(after)).toBeLessThanOrEqual(servedChars(before));
      expect(after.length).toBeLessThanOrEqual(before.length);
    },
  );

  it("the unstamped-source page serves strictly fewer characters: the paraphrase folds into the row", async () => {
    const before = await guardedPage(withoutChunkIds([passage(), paraphrase()]), [row()]);
    const after = await guardedPage([passage(), paraphrase()], [row()]);

    expect(servedChars(before)).toBe(PASSAGE.length + paraphrase().fact.length);
    expect(servedChars(after)).toBe(PASSAGE.length);
  });
});

describe("privacy invariants", () => {
  it("a graph copy whose source was deleted is not resurrected under the row, nor cited on it", async () => {
    // The graph still holds a copy stamped with a source that was deleted and an item of it;
    // its row (c1) is live under another source. The row is served, under its own source only.
    const facts = await hybridRead(
      [passage({ sourceId: "src-deleted", sourceEventIds: ["ep-9"] })],
      [row({ sourceId: "src-live" })],
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ uuid: "c1", store: "semantic", sourceId: "src-live" });
    expect(facts[0].sourceEventIds).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain("src-deleted");
  });

  it("a graph copy whose row was removed or erased stays a graph answer, for the serve-time source check to judge", async () => {
    // The vector leg returns no c1: it was deleted, or an erasure filtered it. Dedup must not
    // relabel the graph copy as a stored row (a vector-store row is not rechecked), nor let a
    // same-text row of another source take its deleted source's item.
    const gone = passage({ chunkIds: ["c1"], sourceId: "src-deleted", sourceEventIds: ["ep-9"] });
    const other = row({ uuid: "c2", sourceId: "src-live" });
    const facts = await hybridRead([gone], [other]);

    const served = facts.find((f) => f.fact === PASSAGE)!;
    // Unchanged from the text-only dedup: different provenance, so the graph copy is kept as is.
    expect(served).toMatchObject({ uuid: "g1", store: "graph", chunkIds: ["c1"], sourceId: "src-deleted" });
    expect(facts.some((f) => f.store === "semantic" && f.sourceEventIds?.includes("ep-9"))).toBe(false);
  });

  it("never brings in a row the read did not return", async () => {
    const facts = await hybridRead([passage({ chunkIds: ["c-erased"] })], []);

    expect(facts.map((f) => [f.uuid, f.store])).toEqual([["g1", "graph"]]);
  });
});
