// Mocked end to end: needs no database; runs in every environment.

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

// The org's account tier governs every leg of a guarded read, not only the first.
//
// GuardedMemoryStore.retrieve can call the store up to three ways for one read: the
// checked partition, the bare-org leg for an org-root reader, and one leg per
// descendant scope. A caller-set `accountTier` must be overwritten on all of them;
// if any leg forwarded the caller's input unchanged, a team org could ask for
// "enterprise" and have the graph answer that leg. account-tier-access.eval.test.ts
// covers the first leg with a Deal A reader, where the other two never run.

vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  return {
    check: vi.fn(),
    recordReadFactIds: vi.fn(),
    descendantScopePaths: vi.fn(),
    pathCovers: actual.pathCovers,
    orgRootPath: actual.orgRootPath,
    resolveExecutedPartition: actual.resolveExecutedPartition,
    AccessDeniedError: actual.AccessDeniedError,
  };
});
vi.mock("./store", () => ({ memory: {} }));

import { check, descendantScopePaths, orgRootPath, type AccessContext } from "@/services/access";
import { GuardedMemoryStore } from "./guarded-store";
import { HybridMemoryStore } from "./hybrid-store";
import type { MemoryStore } from "./memory-store";
import type { SearchInput } from "@/types/memory";

const ORG = "1";
const ROOT = orgRootPath(ORG);
const DEAL_A = `${ROOT}.dealA`;
const DEAL_B = `${ROOT}.dealB`;

const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "user_1", role: "owner" }, origin: "app" };

function store(name: string) {
  return {
    retrieve: vi.fn(async (input: SearchInput) => ({
      facts: [{ uuid: `${name}:${input.groupId}`, fact: `${name} fact for ${input.groupId}`, validAt: null }],
    })),
  };
}

beforeEach(() => {
  vi.mocked(check).mockReset().mockResolvedValue({ allowed: true, reason: "grant" });
  vi.mocked(descendantScopePaths)
    .mockReset()
    .mockResolvedValue({ paths: [DEAL_A, DEAL_B], unsearched: [], partial: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("an org-root read on a team org that asks for enterprise", () => {
  it("runs every leg under the org's tier, not the caller's", async () => {
    const inner = store("inner");
    const guarded = new GuardedMemoryStore(inner as unknown as MemoryStore, async () => "team");

    await guarded.retrieve(ctx, { groupId: ORG, query: "deal status", accountTier: "enterprise" }, ROOT);

    // Checked partition, bare-org leg, and one leg asking every descendant scope.
    const legs = inner.retrieve.mock.calls.map(([input]) => [input.groupId, input.groupIds, input.accountTier]);
    expect(legs).toEqual([
      [ROOT, undefined, "team"],
      [ORG, undefined, "team"],
      [DEAL_A, [DEAL_B], "team"],
    ]);
  });

  it("never lets the graph answer any leg", async () => {
    const graph = store("graph");
    const vector = store("vector");
    const guarded = new GuardedMemoryStore(
      new HybridMemoryStore(graph as unknown as MemoryStore, vector as unknown as MemoryStore),
      async () => "team",
    );

    const { facts } = await guarded.retrieve(
      ctx,
      { groupId: ORG, query: "deal status", accountTier: "enterprise" },
      ROOT,
    );

    expect(graph.retrieve).not.toHaveBeenCalled();
    // The bare-org and descendant legs skip pgvector by design (the checked leg's
    // pgvector query already covers them by scope containment), so vector answers once.
    expect(vector.retrieve).toHaveBeenCalledTimes(1);
    expect(facts.every((f) => f.uuid.startsWith("vector:"))).toBe(true);
  });
});
