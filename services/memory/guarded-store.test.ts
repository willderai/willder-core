// GuardedMemoryStore unit tests: what each method forwards to the backing store
// (scope-encoded groupId plus bare tenantId), how the page is chosen by
// provenance tier, and that removeFact refuses without an explicit scope.
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

// removeFact()'s applied row and change event are asserted in
// fact-removal-change-event.realdb.test.ts; these are scope-forwarding tests.
vi.mock("./fact-change-event", () => ({ recordFactRemoved: vi.fn() }));

// Mock the access gate so we exercise the store-forwarding logic, not check().
vi.mock("@/services/access", () => ({
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
  // removeFact() records the confirmed-applied signal after a real delete
  // succeeds — not what these forwarding tests are about, so stub it out same
  // as recordReadFactIds.
  recordAppliedChange: vi.fn(),
  // The destructive methods also record which partition the write actually
  // executed against. Stubbed here for the same reason as the two recorders
  // above — these are scope-forwarding tests, and the effect row itself is
  // asserted unmocked in guarded-store.write-effect.test.ts.
  recordWriteEffect: vi.fn(),
  // The executed partition is resolved before the store call and supplies the
  // group_id the mutation runs against, so these forwarding tests assert on
  // its output. Mirrors services/access/check.ts's real implementation rather
  // than stubbing it, for the same reason pathCovers above is real: a wrong
  // mock here would hide the very forwarding regression these tests exist to
  // catch.
  resolveExecutedPartition: (orgId: string, groupId: string) =>
    groupId === orgId || groupId.startsWith(`${orgId}.`)
      ? { groupId, targetPath: `group:${groupId}` }
      : { groupId, targetPath: groupId },
  AccessDeniedError: class AccessDeniedError extends Error {
    constructor(public decision: unknown) {
      super("denied");
    }
  },
}));

import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { AccessContext } from "@/services/access";

function mockStore(): MemoryStore {
  return {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-1" }),
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn().mockResolvedValue({ removed: true }),
    removeEntity: vi.fn().mockResolvedValue({ removed: false }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 0 }),
  } as unknown as MemoryStore;
}

// removeFact() reads ctx.actor to stamp the confirmed-applied audit row, so
// this shared fixture needs a real actor.
const ctx = { orgId: "org_1", actor: { type: "human", id: "user_1", role: "member" } } as AccessContext;

beforeEach(() => vi.clearAllMocks());

describe("GuardedMemoryStore.retrieve — scoped forwarding", () => {
  it("scoped read: groupId → scope (Graphiti), tenantId → bare org, scopePath → scope (pgvector)", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing" }, "org_org_1");

    // pgvector isolates tenants by the bare org id, not the scope string. If
    // groupId is overwritten with the scope and pgvector filters orgId against
    // it, scoped reads silently return zero chunks.
    expect(store.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "org_org_1", // Graphiti group_id (scope-encoded)
        tenantId: "org_1", // pgvector tenant isolation (bare org id)
        scopePath: "org_org_1", // pgvector scope prefix filter
        query: "pricing",
      }),
    );
  });

  it("unscoped read: tenantId is the org id and scopePath is undefined", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing" });

    expect(store.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "org_1",
        tenantId: "org_1",
        scopePath: undefined,
        query: "pricing",
      }),
    );
  });
});

describe("GuardedMemoryStore.retrieve — provenance re-ranking", () => {
  // Real leak/behavior scenario: a scoped read merges its own scoped-leg facts
  // with the bare-org fallback leg (guarded-store.ts's `orgWide` merge, needed
  // since several ingest paths write with no scopePath at all).
  // The scoped leg here returns two facts that would otherwise fill the page
  // (extraction-tier, then agent-tier); the org-wide leg returns a human-tier
  // fact that arrives last in merge order and would be the one truncated by a
  // plain `slice(0, limit)`. The store mock below carries and returns a real
  // `actorType` per fact — GuardedMemoryStore's own production ranking code is
  // what sorts them, this test never recomputes the ordering itself.
  function factOf(uuid: string, actorType: "human" | "agent" | "extraction") {
    return { uuid, fact: `fact-${uuid}`, validAt: null, actorType };
  }

  it("a human fact outranks agent and agent outranks extraction when they compete for a limited slot", async () => {
    const scopedLegFacts = [factOf("e1", "extraction"), factOf("a1", "agent")];
    const orgWideLegFacts = [factOf("h1", "human")];

    const store: MemoryStore = {
      ingest: vi.fn(),
      retrieve: vi
        .fn()
        .mockImplementation(async (input: { skipPgvector?: boolean }) =>
          input.skipPgvector ? { facts: orgWideLegFacts } : { facts: scopedLegFacts },
        ),
      entity: vi.fn(),
      graph: vi.fn(),
      removeFact: vi.fn(),
      removeEntity: vi.fn(),
      transferEntity: vi.fn(),
    } as unknown as MemoryStore;
    const guarded = new GuardedMemoryStore(store);

    // scope ("org_org_1") differs from groupId ("org_1") so the
    // bare-org fallback leg actually fires and the two legs actually merge.
    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 2 }, "org_org_1");

    // Merge order alone (scoped leg first) would have kept e1+a1 and dropped
    // h1 — the exact bug provenance ranking exists to close. With ranking,
    // the human fact wins a slot over both lower tiers, and agent still beats
    // extraction for the second slot.
    expect(result.facts.map((f) => f.uuid)).toEqual(["h1", "a1"]);
    expect(result.facts).toHaveLength(2);
  });

  it("keeps each backend's own relevance order for facts of the same tier", async () => {
    const scopedLegFacts = [factOf("agent-2nd", "agent"), factOf("agent-1st", "agent")];

    const store: MemoryStore = {
      ingest: vi.fn(),
      retrieve: vi.fn().mockResolvedValue({ facts: scopedLegFacts }),
      entity: vi.fn(),
      graph: vi.fn(),
      removeFact: vi.fn(),
      removeEntity: vi.fn(),
      transferEntity: vi.fn(),
    } as unknown as MemoryStore;
    const guarded = new GuardedMemoryStore(store);

    // No scope passed → single leg, no org-wide merge — isolates that the
    // sort is stable rather than accidentally reversing/reordering same-tier
    // facts when there's nothing to rank against.
    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing" });

    expect(result.facts.map((f) => f.uuid)).toEqual(["agent-2nd", "agent-1st"]);
  });

  it("a human fact below the leg's own relevance cutoff still reaches the ranker", async () => {
    // The trap: each backend leg truncates its OWN query at whatever
    // `limit` it's given (pgvector's SQL LIMIT, graphiti's search limit) before
    // guarded-store.ts ever sees the results. A plain `retrieve({ ...input })`
    // forward — no overfetch — means a human fact ranked 3rd by relevance in a
    // leg that was only asked for its top 2 never comes back from the leg at
    // all, so provenance ranking has nothing to promote. The store mock below
    // is faithful to that (it actually truncates on `input.limit`, unlike the
    // two tests above which return every fact regardless of the limit asked
    // for and so cannot catch this class of bug).
    const relevanceOrder = [factOf("agent-1st", "agent"), factOf("agent-2nd", "agent"), factOf("human-3rd", "human")];
    const store: MemoryStore = {
      ingest: vi.fn(),
      retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
        facts: input.limit ? relevanceOrder.slice(0, input.limit) : relevanceOrder,
      })),
      entity: vi.fn(),
      graph: vi.fn(),
      removeFact: vi.fn(),
      removeEntity: vi.fn(),
      transferEntity: vi.fn(),
    } as unknown as MemoryStore;
    const guarded = new GuardedMemoryStore(store);

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 2 });

    // Without overfetch, the leg only ever returns agent-1st/agent-2nd and
    // human-3rd is truncated away before ranking runs — this would assert
    // ["agent-1st", "agent-2nd"] instead. With the leg overfetched and the real
    // limit applied AFTER ranking, the human fact wins its slot.
    expect(result.facts.map((f) => f.uuid)).toEqual(["human-3rd", "agent-1st"]);
    expect(result.facts).toHaveLength(2);
  });

  it("a same-tier bare-org fact survives a page fill by the scoped leg", async () => {
    // Both legs return facts of the SAME tier, so provenance ranking can't be
    // what decides who keeps a slot — this isolates the merge-order tie-break
    // rankByProvenance's stable sort falls back to. The scoped leg alone
    // already has enough extraction-tier facts to fill `limit`; the bare-org
    // leg's single extraction-tier fact (the account/contact-seed content a
    // root-scoped read routes there) is the one this test proves does NOT get
    // silently dropped by a scoped-leg-always-first merge order.
    const scopedLegFacts = [factOf("scoped-1", "extraction"), factOf("scoped-2", "extraction")];
    const orgWideLegFacts = [factOf("bareorg-1", "extraction")];

    const store: MemoryStore = {
      ingest: vi.fn(),
      retrieve: vi.fn().mockImplementation(async (input: { skipPgvector?: boolean; limit?: number }) => {
        const facts = input.skipPgvector ? orgWideLegFacts : scopedLegFacts;
        return { facts: input.limit ? facts.slice(0, input.limit) : facts };
      }),
      entity: vi.fn(),
      graph: vi.fn(),
      removeFact: vi.fn(),
      removeEntity: vi.fn(),
      transferEntity: vi.fn(),
    } as unknown as MemoryStore;
    const guarded = new GuardedMemoryStore(store);

    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 2 }, "org_org_1");

    // A plain concatenation-then-slice (mergeFacts(scoped, orgWide).slice(0,2))
    // would keep scoped-1 + scoped-2 and drop bareorg-1 entirely, even though
    // all three facts are the same provenance tier. The round-robin interleave
    // gives the bare-org leg's fact a slot instead of always losing the tie to
    // the scoped leg.
    expect(result.facts.map((f) => f.uuid)).toEqual(["scoped-1", "bareorg-1"]);
    expect(result.facts).toHaveLength(2);
  });
});

describe("GuardedMemoryStore — write-partition forwarding", () => {
  // check() only ever authorizes `scope`; the real write must land there too,
  // not at the bare org id `input.groupId` stays as (assertTenant's tenant
  // marker). If `removeEntity()`/`removeFact()` drop the scope before calling
  // into the store, a narrow-scope caller's delete executes at org root
  // instead of their own scope, and a legitimately sub-scoped entity/fact can
  // never be deleted at all (wrong partition → 404). `entity()` and
  // `transferEntity()` are run here too as passing controls: if all four
  // failed this would be a harness bug, not a real regression.
  const scope = "org_org_1.marketing";

  it("CONTROL: entity() forwards the scope, not the bare org id", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.entity(ctx, { groupId: "org_1", entityId: "e1" }, scope);

    expect(store.entity).toHaveBeenCalledWith(expect.objectContaining({ groupId: scope }));
  });

  it("CONTROL: transferEntity() forwards the scope, not the bare org id", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.transferEntity(ctx, { groupId: "org_1", oldName: "Acme", newName: "Acme Inc" }, scope);

    expect(store.transferEntity).toHaveBeenCalledWith(expect.objectContaining({ groupId: scope }));
  });

  it("removeEntity() forwards the scope, not the bare org id", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeEntity(ctx, { groupId: "org_1", entityId: "e1" }, scope);

    // The failure shape: called with { groupId: "org_1", entityId: "e1" } — the
    // raw input, forwarded to Graphiti as group_id=org_1 (org root), not the
    // authorized org_org_1.marketing partition.
    expect(store.removeEntity).toHaveBeenCalledWith(expect.objectContaining({ groupId: scope, entityId: "e1" }));
  });

  it("removeFact() forwards the scope, not the bare org id", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }, scope);

    expect(store.removeFact).toHaveBeenCalledWith(expect.objectContaining({ groupId: scope, factId: "f1" }));
  });

  it("removeEntity() still defaults to the bare org id when no scope is given", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeEntity(ctx, { groupId: "org_1", entityId: "e1" });

    expect(store.removeEntity).toHaveBeenCalledWith(expect.objectContaining({ groupId: "org_1" }));
  });

  // The scope forwarding above overwrites `groupId` with the scope path for
  // Graphiti, but pgvector isolates on the bare org id in a separate `orgId`
  // column — it has no scope concept at all. Forwarding only `groupId` leaves
  // pgvector's removeFact() with nothing but the scope path to filter on, so a
  // scoped delete matches zero pgvector rows while still reporting
  // removed:true. `tenantId` carries the bare org id through unconditionally,
  // the same split retrieve() uses.
  it("removeFact() ALSO forwards tenantId as the bare org id, alongside the scoped groupId", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }, scope);

    expect(store.removeFact).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: scope, tenantId: "org_1", factId: "f1" }),
    );
  });

  it("removeFact() at org root forwards the org root path, the one scope pgvector lets reach untagged rows", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }, "org_org_1");

    // pgvector-store.test.ts pins the other half: groupId === orgRootPath(tenantId)
    // is what turns on includeUntagged in its DELETE.
    expect(store.removeFact).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "org_org_1", tenantId: "org_1", factId: "f1" }),
    );
  });
});

describe("GuardedMemoryStore.removeFact — scope is required", () => {
  // With no scope, check() authorized org root while the delete ran against the
  // bare org id. No pgvector row is stored under that partition, tagged or not,
  // so the caller got removed:false for a fact that stayed stored.
  async function expectRefusedBeforeAnything(remove: (guarded: GuardedMemoryStore) => Promise<unknown>) {
    const { check } = await import("@/services/access");
    vi.mocked(check).mockClear();
    const store = mockStore();

    await expect(remove(new GuardedMemoryStore(store))).rejects.toThrow(
      /removeFact\(fact:f1\) needs a scope; pass orgRootPath\(orgId\)/,
    );

    expect(check).not.toHaveBeenCalled();
    expect(store.removeFact).not.toHaveBeenCalled();
  }

  it("refuses an omitted scope before authorizing or deleting anything", async () => {
    await expectRefusedBeforeAnything((guarded) =>
      // @ts-expect-error scope is required; this is the untyped caller the runtime guard is for
      guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }),
    );
  });

  it("refuses an empty scope before authorizing or deleting anything", async () => {
    await expectRefusedBeforeAnything((guarded) => guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }, ""));
  });
});
