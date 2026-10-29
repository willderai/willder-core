// Every fact must land in a tier the merge actually walks: a fact with an
// unknown or absent actorType is ranked as extraction rather than dropped out of
// the interleave entirely.
import { describe, expect, it, vi, beforeEach } from "vitest";
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

// Mock the access gate so we exercise the merge/ranking logic, not check().
vi.mock("@/services/access", async () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  // guarded-store.ts calls descendantScopePaths in retrieve()/entity() to fan
  // out to real registered descendant scopes. Not what these tests are about,
  // so it defaults to none.
  // guarded-store.ts's retrieve() calls this pure containment check directly
  // (no DB round trip) to decide whether untagged/bare-org content should be
  // visible for this read — mirrors services/access/check.ts's real pathCovers
  // exactly (ancestor-or-self on dot-separated ltree labels), not a test-only
  // stub, since a wrong mock here would hide a real regression rather than
  // isolate one.
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: (orgId: string) => `org_${orgId}`,
  // The real partition resolver, not a copy: it is the store's tenant guard,
  // and every partition these tests read from sits inside the test org.
  resolveExecutedPartition: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .resolveExecutedPartition,
  AccessDeniedError: class AccessDeniedError extends Error {
    constructor(public decision: unknown) {
      super("denied");
    }
  },
}));

import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;
beforeEach(() => vi.clearAllMocks());

type Fact = { uuid: string; fact: string; validAt: null; actorType?: string };

function factOf(uuid: string, actorType: string): Fact {
  return { uuid, fact: `fact-${uuid}`, validAt: null, actorType };
}

function twoLegStore(scoped: Fact[], orgWide: Fact[]): MemoryStore {
  return {
    ingest: vi.fn(),
    retrieve: vi.fn().mockImplementation(async (input: { skipPgvector?: boolean; limit?: number }) => {
      const facts = input.skipPgvector ? orgWide : scoped;
      return { facts: input.limit ? facts.slice(0, input.limit) : facts };
    }),
    entity: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

/**
 * The merge walks a fixed set of provenance tiers (`TIER_RANKS`) and emits only
 * the facts bucketed under one of them, so a fact whose rank is not a walked
 * tier would vanish from the page silently: no error, and the caller cannot
 * tell "that fact does not exist" from "the merge dropped it".
 *
 * `actorType` is not enum-constrained at runtime: `memory_chunks."actorType"`
 * is a free-text `String` column (`prisma/schema.prisma`) and both read paths
 * launder whatever they get through an unchecked cast — `pgvector-store.ts`'s
 * `r.actor_type as MemoryFact["actorType"]` and `graphiti-store.ts`'s
 * `(f.actor_type ?? undefined) as MemoryFact["actorType"]`, the latter over an
 * HTTP response from a service outside this repo. The `ActorType` union is a
 * compile-time claim about that data, not a runtime guarantee. The dangerous
 * values are the names of Object.prototype properties: looked up on a plain
 * object they resolve to inherited functions rather than a missing key, which
 * is why `provenanceRank` reads its table from a Map.
 */
describe("GuardedMemoryStore.retrieve — every fact lands in a tier the merge walks", () => {
  // Object.prototype keys: each would resolve to an inherited property if the
  // tier table were a plain object, skipping the `?? UNRANKED` fallback.
  //
  // Derived from Object.prototype rather than hand-listed. A hand list of a
  // few names lets a fix that merely special-cases that list pass the whole
  // file. The defect class is "every key an empty object inherits", all 12 of
  // them, and only the runtime knows that list: __defineGetter__,
  // __lookupSetter__, isPrototypeOf and toLocaleString are in it and appear in
  // no list anyone writes from memory. Deriving it means a narrow special-case
  // fix cannot pass, and a future engine adding a prototype method is covered
  // the day it ships.
  for (const inherited of Object.getOwnPropertyNames(Object.prototype)) {
    it(`returns a bare-org fact whose actorType is "${inherited}"`, async () => {
      const scoped = [factOf("s-e1", "extraction")];
      const orgWide = [factOf("b-weird", inherited), factOf("b-e1", "extraction")];
      const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

      const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 10 }, "org_org_1");

      const ids = result.facts.map((f) => f.uuid);
      // The page is nowhere near `limit`, so nothing here is a truncation
      // decision — a missing fact was dropped by the merge, not ranked out.
      expect(ids).toContain("b-weird");
      expect(ids.sort()).toEqual(["b-e1", "b-weird", "s-e1"]);
    });
  }

  it("returns a scoped fact with an inherited-key actorType too, not just a bare-org one", async () => {
    // Same defect from the other leg: the drop is in the shared bucketing step,
    // so it is not specific to the fallback leg.
    const scoped = [factOf("s-weird", "toString"), factOf("s-e1", "extraction")];
    const orgWide = [factOf("b-e1", "extraction")];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 10 }, "org_org_1");

    expect(result.facts.map((f) => f.uuid).sort()).toEqual(["b-e1", "s-e1", "s-weird"]);
  });

  it("never returns fewer facts than the two legs hold when the page is not full", async () => {
    // The general invariant behind the cases above, stated without naming any
    // particular bad actorType: under a limit larger than both legs combined,
    // the merge is a pure union — no fact may vanish for any reason.
    //
    // The bad actorTypes here are deliberately ones no hand-written allow/deny
    // list is likely to contain: `isPrototypeOf` and
    // `__lookupGetter__` are inherited exactly like `constructor` and fail in
    // exactly the same way, but neither appears in any list of "the weird keys"
    // anyone writes from memory. A fix that enumerates known-bad names instead
    // of validating the resulting rank fails here, which is the point.
    const scoped = [factOf("s-1", "human"), factOf("s-2", "extraction"), factOf("s-3", "isPrototypeOf")];
    const orgWide = [
      factOf("b-1", "agent"),
      factOf("b-2", "__lookupGetter__"),
      factOf("b-3", "toLocaleString"),
      factOf("b-4", "moon-phase"),
    ];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 50 }, "org_org_1");

    expect(result.facts).toHaveLength(scoped.length + orgWide.length);
    expect(result.facts.map((f) => f.uuid).sort()).toEqual(["b-1", "b-2", "b-3", "b-4", "s-1", "s-2", "s-3"]);
  });

  it("keeps cross-tier priority for the facts that DO rank, with an unrankable one present", async () => {
    // Guards the likely over-correction: a fix that rescues the dropped fact by
    // flattening every rank into one bucket would pass the cases above while
    // destroying the cross-tier provenance guarantee. The human fact must still
    // come first, and the unrankable fact must sit with the extraction tier
    // (PROVENANCE_RANK's documented default for an unstamped/unrecognised fact),
    // not ahead of a human-asserted one.
    const scoped = [factOf("s-weird", "constructor"), factOf("s-e1", "extraction")];
    const orgWide = [factOf("b-h1", "human")];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 2 }, "org_org_1");

    const ids = result.facts.map((f) => f.uuid);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("b-h1");
    expect(ids[1]).toBe("s-weird");
  });

  it("walks every tier PROVENANCE_RANK defines, so adding a tier cannot silently drop it", async () => {
    // Each distinct rank PROVENANCE_RANK can produce must survive a page with
    // room for all of them, with cross-tier order intact.
    //
    // Honest limit of this case: it does not pin TIER_RANKS being *derived*
    // from PROVENANCE_RANK rather than written as a literal `[0, 1, 2]`. The
    // derivation evaluates to exactly `[0, 1, 2]`, so the two are behaviourally
    // indistinguishable from outside the module and no black-box test can
    // separate them. The derivation still earns its place (a fourth tier added
    // to the table is interleaved with no second edit), it is just a
    // readability property, not one this suite enforces. The guard that
    // matters is the union case above: whatever TIER_RANKS holds, no fact may
    // vanish.
    const scoped = [factOf("s-h", "human"), factOf("s-a", "agent"), factOf("s-e", "extraction")];
    const orgWide = [factOf("b-h", "human"), factOf("b-a", "agent"), factOf("b-e", "extraction")];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 20 }, "org_org_1");

    const ids = result.facts.map((f) => f.uuid);
    expect(ids).toHaveLength(6);
    // Tier order still holds across all three tiers, both legs represented in each.
    expect(ids.slice(0, 2).sort()).toEqual(["b-h", "s-h"]);
    expect(ids.slice(2, 4).sort()).toEqual(["b-a", "s-a"]);
    expect(ids.slice(4, 6).sort()).toEqual(["b-e", "s-e"]);
  });
});
