// resolveExecutedPartition as the store layer's tenant boundary: a partition
// outside the context org is refused before the backend is touched, and every
// partition that IS in the tenant (bare org id or a scope path) still reaches it.
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

// GuardedMemoryStore's tenant guard on the partition a request actually reads
// or writes (resolveExecutedPartition() in services/access/check.ts, which
// every GuardedMemoryStore method calls on `scope ?? input.groupId`).
//
// The defect these cases pin: assertTenant() validated `input.groupId`, the
// bare tenant marker, while every method partitioned on `scope ??
// input.groupId`. `scope` is caller-influenced on real routes (`?scope=` on
// /api/memory/entities/[id], `body.scope` on /api/memory/query), and a scope
// path lives in the `org_<orgId>` namespace the marker's rule never matches,
// so the identifier that was checked was not the identifier that was used.
//
// Every case here runs with check() ALLOWING the request — db.$queryRaw
// returns a covering admin grant for whatever path is asked about. That is the
// point: in production check()'s org-filtered grant query is what denies a
// foreign scope, so a test that let check() deny would prove nothing about the
// store layer. Allowing it isolates the second guard.
//
// Guard-removal check: make resolveExecutedPartition() return instead of throw,
// or drop its call from any method below, and that method's denial case fails — the call reaches the inner store
// with the foreign partition.

vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));

vi.mock("./store", () => ({ memory: {} }));
// removeFact()'s applied row and change event are asserted in
// fact-removal-change-event.realdb.test.ts; these are partition-forwarding tests.
vi.mock("./fact-change-event", () => ({ recordFactRemoved: vi.fn() }));

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { AccessDeniedError, orgRootPath } from "@/services/access";
import type { AccessContext } from "@/services/access";

const ORG_ID = "org_1";
const ORG_ROOT = orgRootPath(ORG_ID); // "org_org_1"

const ctx: AccessContext = {
  orgId: ORG_ID,
  actor: { type: "human", id: "user_42", role: "admin" },
  origin: "app",
};

/** Every store method this guard protects, as (name, call) pairs, so a method
 *  added to GuardedMemoryStore without a tenant guard shows up as a gap here
 *  rather than as an untested path. */
type Inner = ReturnType<typeof makeInner>;
const CALLS: Array<{
  name: string;
  run: (guarded: GuardedMemoryStore, scope?: string) => Promise<unknown>;
  method: keyof Inner;
}> = [
  {
    name: "retrieve",
    method: "retrieve",
    run: (g, scope) => g.retrieve(ctx, { groupId: ORG_ID, query: "secrets" }, scope),
  },
  {
    name: "entity",
    method: "entity",
    run: (g, scope) => g.entity(ctx, { groupId: ORG_ID, entityId: "e1" }, scope),
  },
  {
    name: "graph",
    method: "graph",
    run: (g, scope) => g.graph(ctx, { groupId: ORG_ID, limit: 10 }, scope),
  },
  {
    name: "findFact",
    method: "findFactById",
    run: (g, scope) => g.findFact(ctx, { groupId: ORG_ID, factId: "f1" }, scope),
  },
  {
    name: "removeEntity",
    method: "removeEntity",
    run: (g, scope) => g.removeEntity(ctx, { groupId: ORG_ID, entityId: "e1" }, scope),
  },
  {
    name: "removeFact",
    method: "removeFact",
    // removeFact() has no default scope; an absent one reaches its own refusal
    // (guarded-store.test.ts), which is why the no-scope case skips it below.
    run: (g, scope) => g.removeFact(ctx, { groupId: ORG_ID, factId: "f1" }, scope ?? ""),
  },
  {
    name: "transferEntity",
    method: "transferEntity",
    run: (g, scope) => g.transferEntity(ctx, { groupId: ORG_ID, oldName: "a", newName: "b" }, scope),
  },
];

function makeInner() {
  return {
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    findFactById: vi.fn().mockResolvedValue(null),
    removeEntity: vi.fn().mockResolvedValue({ removed: true }),
    removeFact: vi.fn().mockResolvedValue({ removed: true }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 1 }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // check() allows everything: a covering admin grant for any target path.
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "admin" }] as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_1" } as never);
  vi.mocked(strictDescendantScopePaths).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Denials: a partition outside the context org never reaches the store
// ---------------------------------------------------------------------------

describe("a scope outside the context org is refused at the store layer", () => {
  // Three shapes of foreign path, all syntactically valid ltree so nothing
  // upstream rejects them first:
  //   • another tenant's scope tree
  //   • another tenant's bare group id
  //   • a sibling whose id merely STARTS WITH this org's id — the prefix trap
  //     a `startsWith(orgId)` comparison without the dot would let through
  const FOREIGN = ["org_org_2.deals", "org_2", "org_org_11.deals", "org_11.deals"];

  for (const { name, run, method } of CALLS) {
    for (const scope of FOREIGN) {
      it(`${name}() denies scope "${scope}"`, async () => {
        const inner = makeInner();
        const guarded = new GuardedMemoryStore(inner as never);

        await expect(run(guarded, scope)).rejects.toBeInstanceOf(AccessDeniedError);
        expect(inner[method]).not.toHaveBeenCalled();
      });
    }
  }

  it("the denial names the context org and the refused partition", async () => {
    const guarded = new GuardedMemoryStore(makeInner() as never);
    const err = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "x" }, "org_org_2.deals").catch((e) => e);
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect(err.decision.reason).toContain(ORG_ID);
    expect(err.decision.reason).toContain("org_org_2.deals");
  });

  it("denies even though check() allowed the read — the guard is independent of the grant query", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);

    await expect(guarded.retrieve(ctx, { groupId: ORG_ID, query: "x" }, "org_org_2.deals")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );

    // check() really did run and really did say allow: it wrote its allow audit
    // row and queried the grants table. Nothing about the denial came from it.
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.decision).toBe("allow");
    expect(inner.retrieve).not.toHaveBeenCalled();
  });

  it("a foreign scope cannot smuggle group_ids into graph()", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);

    await expect(
      guarded.graph(ctx, { groupId: ORG_ID, groupIds: ["org_org_2.deals", `${ORG_ROOT}.deals`] }, "org_org_2.deals"),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(inner.graph).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Positive control: the guard does not narrow what a tenant may reach
// ---------------------------------------------------------------------------

describe("every in-tenant partition still reaches the store", () => {
  // The two legitimate roots, plus a descendant of each. The bare org id is the
  // untagged Graphiti partition the pre-scope ingest paths write to and
  // resolveEntityScope's first candidate, so it is as real as the scope tree.
  const ALLOWED: Array<[string, string | undefined]> = [
    ["no scope at all", undefined],
    ["the org root", ORG_ROOT],
    ["a scope under the org root", `${ORG_ROOT}.dealA.notes`],
    ["the bare org id", ORG_ID],
    ["a descendant of the bare org id", `${ORG_ID}.dealA`],
  ];

  for (const { name, run, method } of CALLS) {
    for (const [label, scope] of ALLOWED) {
      if (method === "removeFact" && scope === undefined) continue;
      it(`${name}() allows ${label}`, async () => {
        const inner = makeInner();
        const guarded = new GuardedMemoryStore(inner as never);

        await run(guarded, scope);
        expect(inner[method]).toHaveBeenCalled();
      });
    }
  }

  it("partitions the read on the scope, not on the bare group id", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);

    await guarded.retrieve(ctx, { groupId: ORG_ID, query: "x" }, `${ORG_ROOT}.dealA`);
    expect(inner.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: `${ORG_ROOT}.dealA`, tenantId: ORG_ID }),
    );
  });
});
