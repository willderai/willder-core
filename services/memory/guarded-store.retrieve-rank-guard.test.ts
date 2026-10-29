// The same malformed-provenance guard as rank-guard, but through a full
// retrieve(): a fact whose actorType is not a known tier must not disturb the
// order of the page the caller gets back.
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

// Mock the access gate so we exercise the ranking/truncation path, not check().
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
  orgRootPath: vi.fn((orgId: string) => `org_${orgId}`),
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
import type { MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;
beforeEach(() => vi.clearAllMocks());

function factOf(uuid: string, actorType: string): MemoryFact {
  // Cast past ActorType's compile-time union on purpose: `actorType` reaches
  // this code as unchecked runtime data off a free-text column (same note as
  // guarded-store.merge-tier-coverage.test.ts).
  return { uuid, fact: `fact-${uuid}`, validAt: null, actorType: actorType as MemoryFact["actorType"] };
}

/** A single-leg store that hands back exactly the page it is given, honouring
 *  `limit` so the per-leg overfetch is modelled rather than ignored. It does no
 *  tiering of its own — ranking is entirely the code under test's job. */
function singleLegStore(page: MemoryFact[]): MemoryStore {
  return {
    ingest: vi.fn(),
    retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
      facts: input.limit ? page.slice(0, input.limit) : page,
    })),
    entity: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

/**
 * The production seam for the rank guard. guarded-store.rank-guard.test.ts
 * calls `rankByProvenance` directly; the defect is also reachable through an
 * ordinary `retrieve()`, and these tests pin that path.
 *
 * `retrieve(ctx, input)` takes `scope` as an OPTIONAL third argument, and
 * `target = scope ?? input.groupId`, so an ordinary unscoped read leaves
 * `target === input.groupId`, which makes `orgWide` null. `mergeFacts` is
 * variadic and always called (`legs` always has at least `result.facts` in
 * it), so it runs even here. That does not change what these tests pin:
 * `groupByProvenance` uses the validated rank only as a Map key and pushes the
 * ORIGINAL fact, so `rankByProvenance` recomputes the same lookup off the same
 * untouched `actorType` afterward — the guard these tests are about lives in
 * `rankByProvenance`, not in whether `mergeFacts` ran first. A
 * malformed-provenance fact reaches `rankByProvenance` unsanitised either way;
 * it merely happens to have already been placed last by `groupByProvenance`'s
 * own safe fallback when the merge runs, which a NaN comparator then leaves
 * alone — correct by luck, not by protection, on either path.
 *
 * These tests go through the real `GuardedMemoryStore.retrieve()`. The store
 * mock only decides which facts come back; it does no ranking, so a pass can
 * only come from the guard inside `rankByProvenance`.
 */
describe("GuardedMemoryStore.retrieve — malformed provenance on the unscoped path", () => {
  it("does not let a malformed-provenance fact outrank a human fact when no scope is passed", async () => {
    // Store order puts the malformed fact first, as a relevance-ranked backend
    // legitimately can. Without the guard, `provenanceRank` returns
    // Object.prototype's `toString` here, every comparison against it is NaN,
    // V8 treats that as "equal" and leaves the fact exactly where the store
    // put it — first.
    const page = [factOf("weird", "toString"), factOf("human-1", "human"), factOf("agent-1", "agent")];
    const store = new GuardedMemoryStore(singleLegStore(page));

    // No third argument: this is the default, unscoped read.
    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 10 });

    expect(facts.map((f) => f.uuid)).toEqual(["human-1", "agent-1", "weird"]);
  });

  it("does not let a malformed-provenance fact take a limited slot away from a human fact", async () => {
    // The real damage isn't the ordering, it's what ordering decides: facts are
    // truncated to `limit` AFTER ranking, so a malformed fact holding the top
    // slot doesn't just sort oddly, it evicts a human-asserted fact from the
    // page that reaches the model.
    const page = [factOf("weird", "constructor"), factOf("human-1", "human")];
    const store = new GuardedMemoryStore(singleLegStore(page));

    const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: "q", limit: 1 });

    expect(facts.map((f) => f.uuid)).toEqual(["human-1"]);
  });
});
