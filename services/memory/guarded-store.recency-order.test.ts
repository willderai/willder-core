// A guarded read serves its page in relevance order, and uses recency only to break the
// tie between versions of one fact (stored chunks with the same scope and entity name). Which facts make the page is
// decided by tier and relevance alone, and the token budget still drops the least
// relevant fact first. These tests drive the real GuardedMemoryStore.retrieve().
import { describe, expect, it, vi } from "vitest";
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

import { breakTiesByRecency, GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { ActorType, MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;

interface ChunkShape {
  similarity?: number;
  subject?: string;
  actorType?: ActorType;
  text?: string;
}

/** A stored chunk, dated by `validAt`: its stated event time or its store time, never later than when it was stored. */
function chunk(
  uuid: string,
  validAt: string | null,
  { similarity, subject, actorType = "agent", text }: ChunkShape = {},
): MemoryFact {
  return {
    uuid,
    fact: text ?? `chunk ${uuid}`,
    validAt,
    actorType,
    store: "semantic",
    ...(similarity === undefined ? {} : { similarity }),
    ...(subject === undefined ? {} : { subject }),
  };
}

/** A graph fact: its `validAt` is whatever date the extractor read out of the text. */
function graphFact(uuid: string, validAt: string | null): MemoryFact {
  return { uuid, fact: `graph ${uuid}`, validAt, actorType: "agent", store: "graph" };
}

function singleLegStore(page: MemoryFact[]): MemoryStore {
  return {
    retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
      facts: input.limit ? page.slice(0, input.limit) : page,
      storesRead: [{ store: "semantic" }],
    })),
  } as unknown as MemoryStore;
}

const uuids = (facts: MemoryFact[]) => facts.map((f) => f.uuid);
const day = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString();

describe("breakTiesByRecency: relevance first", () => {
  it("keeps relevance order when nothing is tied, however the dates fall", () => {
    const page = [
      chunk("best-oldest", day(1), { similarity: 0.9 }),
      chunk("mid", day(2), { similarity: 0.8 }),
      chunk("worst-newest", day(3), { similarity: 0.7 }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["best-oldest", "mid", "worst-newest"]);
  });

  it("never moves a graph fact, whatever date its text claims", () => {
    const page = [
      chunk("stored-today", day(10), { similarity: 0.8 }),
      graphFact("as-of-2099-price-5", "2099-01-01T00:00:00Z"),
      chunk("stored-yesterday", day(9), { similarity: 0.79 }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["stored-today", "as-of-2099-price-5", "stored-yesterday"]);
  });

  it("never dates a graph fact as a version, even one that names the same subject", () => {
    // Only a stored chunk's date is bounded by its write time; a graph fact's is what the
    // extractor read out of the text.
    const claimed = { ...graphFact("graph-as-of-2099", "2099-01-01T00:00:00Z"), subject: "price" };
    const page = [chunk("price-stored-today", day(10), { similarity: 0.8, subject: "price" }), claimed];
    expect(uuids(breakTiesByRecency(page))).toEqual(["price-stored-today", "graph-as-of-2099"]);
  });

  it("never lets a newer vector hit jump a graph fact it would tie with", () => {
    const page = [
      graphFact("graph-old-claim", "2001-01-01T00:00:00Z"),
      chunk("stored-today", day(10), { similarity: 0.8 }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["graph-old-claim", "stored-today"]);
  });
});

describe("breakTiesByRecency: versions of one fact", () => {
  it("gives the newest version the best place any version of it holds", () => {
    const page = [
      chunk("miles-20-old", day(3), { similarity: 0.71, subject: "weekly mileage" }),
      chunk("unrelated", day(30), { similarity: 0.65 }),
      chunk("miles-35-new", day(21), { similarity: 0.58, subject: "weekly mileage" }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["miles-35-new", "unrelated", "miles-20-old"]);
  });

  it("leaves chunks with different subjects where relevance put them", () => {
    const page = [
      chunk("a-old", day(1), { similarity: 0.9, subject: "a" }),
      chunk("b-new", day(5), { similarity: 0.7, subject: "b" }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["a-old", "b-new"]);
  });

  it("orders versions by instant, not by the text of the date", () => {
    const page = [
      chunk("offset-earlier", "2026-03-11T11:00:00+02:00", { similarity: 0.9, subject: "s" }), // 09:00Z
      chunk("utc-later", "2026-03-11T10:00:00Z", { similarity: 0.5, subject: "s" }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["utc-later", "offset-earlier"]);
  });

  it("puts an undated version after the dated ones", () => {
    const page = [
      chunk("undated", null, { similarity: 0.9, subject: "s" }),
      chunk("dated", day(2), { similarity: 0.5, subject: "s" }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["dated", "undated"]);
  });

  it("never moves a version across tiers", () => {
    const page = [
      chunk("old-human", day(1), { similarity: 0.6, subject: "s", actorType: "human" }),
      chunk("new-agent", day(9), { similarity: 0.9, subject: "s", actorType: "agent" }),
    ];
    expect(uuids(breakTiesByRecency(page))).toEqual(["old-human", "new-agent"]);
  });
});

describe("breakTiesByRecency: different facts", () => {
  it("never reorders two different facts by date, however close their match", () => {
    const page = [chunk("old", day(1), { similarity: 0.801 }), chunk("new", day(2), { similarity: 0.8 })];
    expect(uuids(breakTiesByRecency(page))).toEqual(["old", "new"]);
  });
});

describe("GuardedMemoryStore.retrieve: relevance first, recency to break ties", () => {
  it("serves the newer of two versions of a fact first", async () => {
    const page = [
      chunk("weekly-miles-20", day(5), { similarity: 0.7, subject: "Weekly mileage" }),
      chunk("weekly-miles-35", day(90), { similarity: 0.6, subject: "Weekly mileage" }),
    ];
    const { facts } = await new GuardedMemoryStore(singleLegStore(page)).retrieve(ctx, {
      groupId: "org_1",
      query: "miles",
      limit: 10,
    });

    expect(uuids(facts)).toEqual(["weekly-miles-35", "weekly-miles-20"]);
  });

  it("chooses and orders the page by relevance: newer, less relevant facts stay behind", async () => {
    const page = Array.from({ length: 8 }, (_, i) => chunk(`r${i}`, day(i + 1), { similarity: 0.9 - i * 0.05 }));
    const { facts } = await new GuardedMemoryStore(singleLegStore(page)).retrieve(ctx, {
      groupId: "org_1",
      query: "what is the current plan",
      limit: 4,
    });

    expect(uuids(facts)).toEqual(["r0", "r1", "r2", "r3"]);
  });

  it("cuts to the token budget by relevance before breaking ties, so the budget drops the least relevant fact", async () => {
    // The team tier's 6,000-token budget holds three of these four 2,000-token versions of one
    // fact. The least relevant is the newest; breaking ties before the cut would keep it and
    // drop the most relevant.
    const long = (label: string) => `${label} ${"x".repeat(7_990)}`.slice(0, 8_000);
    const page = Array.from({ length: 4 }, (_, i) =>
      chunk(`r${i}`, day(i + 1), { similarity: 0.9 - i * 0.1, subject: "s", text: long(`r${i}`) }),
    );
    const { facts } = await new GuardedMemoryStore(singleLegStore(page), async () => "team").retrieve(ctx, {
      groupId: "org_1",
      query: "q",
      limit: 10,
    });

    expect(uuids(facts)).toEqual(["r2", "r1", "r0"]);
  });
});
