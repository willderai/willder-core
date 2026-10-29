// The account tier may only narrow an already-authorized read. Asserts a tier
// cannot add a store, a scope or a fact, and that access is decided before the
// tier is resolved, so no tier setting can turn a denial into an answer.
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

// Access is identical on every account tier. A tier may narrow which stores answer
// and how much evidence is kept, never widen what a caller can see, and never run
// before the access decision.
//
// Seam: the real GuardedMemoryStore over the real HybridMemoryStore, with two
// fixture legs shaped like production (a graph leg partitioned by an exact groupId
// match, a vector leg filtered by scopePath containment within one tenant). Only
// check() and its audit writes are mocked, allowing or denying per test.

vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  return {
    check: vi.fn(),
    recordReadFactIds: vi.fn(),
    descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
    pathCovers: actual.pathCovers,
    orgRootPath: actual.orgRootPath,
    resolveExecutedPartition: actual.resolveExecutedPartition,
    AccessDeniedError: actual.AccessDeniedError,
  };
});
vi.mock("./store", () => ({ memory: {} }));

import { AccessDeniedError, check, orgRootPath, type AccessContext } from "@/services/access";
import { GuardedMemoryStore } from "./guarded-store";
import { HybridMemoryStore } from "./hybrid-store";
import { ACCOUNT_TIERS, TIER_LIMITS, type AccountTier } from "./account-tiers";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact, SearchInput } from "@/types/memory";

const ORG = "1";
const OTHER_ORG = "2";
const ROOT = orgRootPath(ORG);
const DEAL_A = `${ROOT}.dealA`;
const DEAL_B = `${ROOT}.dealB`;

type Stored = MemoryFact & { tenant: string; scopePath: string };

const GRAPH: Stored[] = [
  { uuid: "g-dealA", fact: "graph: Deal A renewal is at risk", validAt: null, tenant: ORG, scopePath: DEAL_A },
  { uuid: "g-dealB", fact: "graph: Deal B pricing is confidential", validAt: null, tenant: ORG, scopePath: DEAL_B },
];
const VECTOR: Stored[] = [
  { uuid: "v-dealA", fact: "vector: Deal A call notes", validAt: null, tenant: ORG, scopePath: DEAL_A },
  { uuid: "v-dealB", fact: "vector: Deal B call notes", validAt: null, tenant: ORG, scopePath: DEAL_B },
  { uuid: "v-other", fact: "vector: another tenant's Deal A", validAt: null, tenant: OTHER_ORG, scopePath: DEAL_A },
];

function leg(retrieve: (input: SearchInput) => Stored[]): MemoryStore {
  return {
    retrieve: vi.fn(async (input: SearchInput) => ({
      facts: retrieve(input).map(({ uuid, fact, validAt }) => ({ uuid, fact, validAt })),
    })),
  } as unknown as MemoryStore;
}

/** Graph partitions by exact group id: the store's own `groupId` is the scope path. */
const graphLeg = () => leg((input) => GRAPH.filter((f) => f.scopePath === input.groupId));
/** Vector filters by tenant and scope containment, like pgvector-store.ts's WHERE clause. */
const vectorLeg = () =>
  leg((input) =>
    VECTOR.filter(
      (f) =>
        f.tenant === input.tenantId &&
        input.scopePath !== undefined &&
        (f.scopePath === input.scopePath || f.scopePath.startsWith(`${input.scopePath}.`)),
    ),
  );

const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };

function guardedFor(tier: AccountTier) {
  const tierOf = vi.fn(async () => tier);
  const store = new GuardedMemoryStore(new HybridMemoryStore(graphLeg(), vectorLeg()), tierOf);
  return { store, tierOf };
}

beforeEach(() => {
  vi.mocked(check).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// What a Deal A reader gets on each tier: the stores that tier allows, and nothing else.
const EXPECTED: Record<AccountTier, string[]> = {
  starter: [],
  team: ["v-dealA"],
  enterprise: ["g-dealA", "v-dealA"],
};

describe.each(ACCOUNT_TIERS)("account tier %s", (tier) => {
  it("returns only the Deal A reader's own facts, from the stores the tier allows", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" });
    const { store } = guardedFor(tier);

    const { facts } = await store.retrieve(ctx, { groupId: ORG, query: "deal status" }, DEAL_A);

    expect(facts.map((f) => f.uuid).sort()).toEqual(EXPECTED[tier]);
    const leaked = facts.filter((f) => /Deal B|another tenant/.test(f.fact));
    expect(leaked).toEqual([]);
  });

  it("denies a reader without a grant before the tier is even looked up", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" });
    const { store, tierOf } = guardedFor(tier);

    await expect(store.retrieve(ctx, { groupId: ORG, query: "deal status" }, DEAL_B)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(tierOf).not.toHaveBeenCalled();
  });
});

describe("account tier on a guarded read", () => {
  it("comes from the org, not from the caller's input", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" });
    const { store, tierOf } = guardedFor("team");

    const { facts } = await store.retrieve(
      ctx,
      { groupId: ORG, query: "deal status", accountTier: "enterprise" },
      DEAL_A,
    );

    expect(tierOf).toHaveBeenCalledWith(ORG);
    expect(facts.map((f) => f.uuid)).toEqual(["v-dealA"]);
  });

  it("cuts the ranked page to the tier's token budget", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" });
    // Each fact is exactly half the starter budget, so two fit and the third does not.
    const half = TIER_LIMITS.starter.tokenBudget / 2;
    const facts: MemoryFact[] = ["a", "b", "c"].map((id) => ({ uuid: id, fact: "x".repeat(half * 4), validAt: null }));
    const flat = { retrieve: vi.fn(async () => ({ facts })) } as unknown as MemoryStore;
    const store = new GuardedMemoryStore(flat, async () => "starter");

    const result = await store.retrieve(ctx, { groupId: ORG, query: "deal status" }, DEAL_A);

    expect(result.facts.map((f) => f.uuid)).toEqual(["a", "b"]);
  });
});
