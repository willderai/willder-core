// Merge ordering across the scoped and bare-org legs: within a tier the legs
// alternate, so neither leg's position in the concatenation decides who survives
// the page.
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

function factOf(uuid: string, actorType: "human" | "agent" | "extraction") {
  return { uuid, fact: `fact-${uuid}`, validAt: null, actorType };
}

function untieredFactOf(uuid: string) {
  return { uuid, fact: `fact-${uuid}`, validAt: null } as ReturnType<typeof factOf>;
}

/**
 * A store whose two legs answer differently, branching on `skipPgvector` — the
 * real field GuardedMemoryStore.retrieve() sets to tell the bare-org fallback
 * leg apart from the scoped leg. Honours `limit` so the per-leg overfetch is
 * modelled, not ignored.
 */
function twoLegStore(scoped: ReturnType<typeof factOf>[], orgWide: ReturnType<typeof factOf>[]): MemoryStore {
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

describe("GuardedMemoryStore.retrieve — merge ordering across the two legs", () => {
  it("splits a same-tier page fairly between the legs at a realistic page size", async () => {
    // guarded-store.test.ts's same-tier case uses a 2-fact page and a 2-vs-1 leg
    // split, which is small enough that several WRONG merge rules also satisfy
    // it — e.g. "take one scoped fact, then the entire bare-org leg" passes it
    // while handing the bare-org leg 9 of 10 slots at a real page size, the
    // inverse of a scoped-leg-fills-the-page bug. This pins the actual
    // round-robin split instead of merely proving the bare-org leg is not
    // dropped outright.
    const scoped = Array.from({ length: 20 }, (_, i) => factOf(`s${i}`, "extraction"));
    const orgWide = Array.from({ length: 20 }, (_, i) => factOf(`b${i}`, "extraction"));
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 10 }, "org_org_1");

    const ids = result.facts.map((f) => f.uuid);
    expect(ids).toHaveLength(10);
    expect(ids.filter((id) => id.startsWith("s")).length).toBe(5);
    expect(ids.filter((id) => id.startsWith("b")).length).toBe(5);
  });

  it("a bare-org fact wins a share of its OWN tier's slots when the legs' tiers differ by position", async () => {
    // The interleave has to happen WITHIN each provenance tier, not on absolute
    // list index. rankByProvenance is a stable tier-only sort applied AFTER the
    // merge, so the fact that actually competes for a slot is the same-tier one —
    // and two legs rarely carry the same tier at the same index (pgvector's
    // actor_type column defaults to "extraction" while Graphiti facts carry
    // human/agent tiers, so mixed legs are the normal production shape).
    //
    // Here both of the bare-org leg's extraction facts sit BEHIND its two human
    // facts, so an absolute-index interleave lands them after every scoped
    // extraction fact. The two human facts take the first two slots on merit, and
    // the scoped leg then takes BOTH remaining extraction slots — "scoped leg
    // fills the page, bare-org same-tier content silently dropped", inside the
    // extraction tier.
    const scoped = [
      factOf("s-e1", "extraction"),
      factOf("s-e2", "extraction"),
      factOf("s-e3", "extraction"),
      factOf("s-e4", "extraction"),
    ];
    const orgWide = [
      factOf("b-h1", "human"),
      factOf("b-h2", "human"),
      factOf("b-e1", "extraction"),
      factOf("b-e2", "extraction"),
    ];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 4 }, "org_org_1");

    const ids = result.facts.map((f) => f.uuid);
    // Provenance still wins across tiers: both human facts keep their slots
    // ahead of every extraction fact. That part is not in question.
    expect(ids.slice(0, 2)).toEqual(["b-h1", "b-h2"]);
    // The contested part: two extraction-tier slots remain and BOTH legs have
    // extraction facts wanting them. Neither leg may take both.
    const extractionSlots = ids.slice(2);
    expect(extractionSlots.filter((id) => id.startsWith("s-e")).length).toBe(1);
    expect(extractionSlots.filter((id) => id.startsWith("b-e")).length).toBe(1);
  });

  it("splits the contested tier evenly at a realistic page size even when the legs' tiers differ by position", async () => {
    // The two cases above pin one dimension each: fair splitting at scale (but
    // with both legs same-tier at every index), and within-tier fairness on a
    // mixed shape (but at a 4-fact page, where "one each" is the only split
    // there is). This is both at once — the actual production shape: a page-size
    // read where the bare-org leg leads with Graphiti's human-tier facts and the
    // scoped leg is all pgvector extraction-tier. A rule that partitions by tier
    // but then hands one leg the rest of the tier still passes both cases above
    // and fails here.
    const scoped = Array.from({ length: 20 }, (_, i) => factOf(`s-e${i}`, "extraction"));
    const orgWide = [
      factOf("b-h1", "human"),
      factOf("b-h2", "human"),
      ...Array.from({ length: 18 }, (_, i) => factOf(`b-e${i}`, "extraction")),
    ];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 10 }, "org_org_1");

    const ids = result.facts.map((f) => f.uuid);
    expect(ids).toHaveLength(10);
    // Cross-tier priority is untouched: both human facts first.
    expect(ids.slice(0, 2)).toEqual(["b-h1", "b-h2"]);
    // The 8 remaining extraction-tier slots are the contested ones, and each leg
    // takes half — not 7/1 or 1/7, which is what an interleave that collapses
    // once a tier sits at different positions in the two legs produces.
    const extractionSlots = ids.slice(2);
    expect(extractionSlots.filter((id) => id.startsWith("s-e")).length).toBe(4);
    expect(extractionSlots.filter((id) => id.startsWith("b-e")).length).toBe(4);
  });

  it("keeps a fact whose actorType is missing or unrecognised", async () => {
    // Merging per tier means every fact has to land in a tier the merge actually
    // walks. A rank the merge doesn't know about wouldn't be mis-ordered, it
    // would be dropped from the page outright — a worse completeness bug than
    // an unfair split, and a silent one. provenanceRank sends both an
    // absent and an unrecognised actorType to the same extraction tier the
    // ranker uses (memory-service's own ingest default), so this pins that
    // those facts still reach the caller.
    const scoped = [untieredFactOf("s-none"), factOf("s-e1", "extraction")];
    const orgWide = [
      { ...factOf("b-weird", "extraction"), actorType: "moon-phase" } as unknown as ReturnType<typeof factOf>,
      untieredFactOf("b-none"),
    ];
    const guarded = new GuardedMemoryStore(twoLegStore(scoped, orgWide));

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 10 }, "org_org_1");

    expect(result.facts.map((f) => f.uuid).sort()).toEqual(["b-none", "b-weird", "s-e1", "s-none"]);
  });
});
