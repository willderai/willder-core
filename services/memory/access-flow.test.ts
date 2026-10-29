// GuardedMemoryStore end-to-end, with check() and the backing store mocked: a
// read or write reaches the store only after an allow, and a denial throws
// before the store is touched. Covers retrieve, entity, removeFact and the
// agent-actor path.
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

// Tests for the guarded memory access-control flow: the GuardedMemoryStore wraps
// every memory operation in a check() call. These tests pin the full chain:
// actor → check() → allow/deny → audit row → store call (or block). The DB and
// the upstream memory store are mocked so we isolate the policy layer.

// Mock the DB that check() + audit use.
vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));

// removeFact()'s applied row and change event are asserted in
// fact-removal-change-event.realdb.test.ts; this suite is about the policy layer.
vi.mock("./fact-change-event", () => ({ recordFactRemoved: vi.fn() }));

// Mock the store singleton so GuardedMemoryStore's default constructor arg doesn't
// try to boot GraphitiMemoryStore at import time.
vi.mock("./store", () => ({ memory: {} }));

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { AccessDeniedError, orgRootPath } from "@/services/access";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate check() returning allow/deny by controlling db.$queryRaw */
const allowRows = () => vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "admin" }] as never);
const denyRows = () => vi.mocked(db.$queryRaw).mockResolvedValue([] as never);

/** Build a fresh mock inner store */
function makeInner() {
  return {
    retrieve: vi.fn(),
    entity: vi.fn(),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
  };
}

const adminCtx = {
  orgId: "org_1",
  actor: { type: "human" as const, id: "user_42", role: "admin" as const },
  origin: "app" as const,
};
const memberCtx = {
  orgId: "org_1",
  actor: { type: "human" as const, id: "user_99", role: "member" as const },
  origin: "app" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(strictDescendantScopePaths).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// retrieve (memory.read)
// ---------------------------------------------------------------------------

describe("GuardedMemoryStore.retrieve", () => {
  it("allows the call and returns facts when the grant covers memory.read", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.retrieve.mockResolvedValue({ facts: [{ uuid: "f1", fact: "Jane is CTO", validAt: null }] });

    const result = await guarded.retrieve(adminCtx, { groupId: "org_1", query: "CTO" });
    expect(result.facts).toHaveLength(1);
    // With no scope set, the guard forwards the bare org id for both backends:
    // groupId (Graphiti) = org, tenantId (pgvector) = org, scopePath = undefined.
    // limit is overfetched: the real limit is applied AFTER provenance ranking,
    // not per-leg, so no limit given means the default 10 overfetches to 40
    // (see guarded-store.ts's overfetchLimit).
    expect(inner.retrieve).toHaveBeenCalledWith({
      accountTier: "enterprise",
      groupId: "org_1",
      query: "CTO",
      tenantId: "org_1",
      scopePath: undefined,
      // No scope override means check()'s own targetPath defaults to
      // orgRootPath(ctx.orgId), which trivially covers itself, so untagged/bare-org
      // content stays visible on an unscoped (org-root) read.
      includeUntagged: true,
      // Retired rows come back marked so their places go to their successors.
      withRetired: true,
      limit: 40,
    });
  });

  it("throws AccessDeniedError and records an audit deny when the grant is absent", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    denyRows();

    await expect(guarded.retrieve(memberCtx, { groupId: "org_1", query: "budget" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(inner.retrieve).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: "deny" }) }),
    );
  });

  it("records an allow audit row on a successful read", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.retrieve.mockResolvedValue({ facts: [] });
    await guarded.retrieve(adminCtx, { groupId: "org_1", query: "x" });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: "allow", action: "memory.read" }) }),
    );
  });

  it("the audit row includes the actor type and id", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.retrieve.mockResolvedValue({ facts: [] });
    await guarded.retrieve(adminCtx, { groupId: "org_1", query: "test" });
    const auditData = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(auditData.actorType).toBe("human");
    expect(auditData.actorId).toBe("user_42");
  });

  it("throws immediately on tenant mismatch — inner store never called", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    // ctx.orgId is org_1 but groupId is org_OTHER
    await expect(guarded.retrieve(adminCtx, { groupId: "org_OTHER", query: "x" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(inner.retrieve).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled(); // denied before check() is even called
  });
});

// ---------------------------------------------------------------------------
// entity (memory.entity)
// ---------------------------------------------------------------------------

describe("GuardedMemoryStore.entity", () => {
  it("allows an admin to fetch an entity", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.entity.mockResolvedValue({ uuid: "e1", name: "Acme", type: "Company", facts: [] });

    const result = await guarded.entity(adminCtx, { groupId: "org_1", entityId: "e1" });
    expect(result?.uuid).toBe("e1");
    expect(inner.entity).toHaveBeenCalledWith({ groupId: "org_1", entityId: "e1" });
  });

  // Scope-completeness: the test above never passes a `scope` argument, so it
  // only exercises `target = scope ?? groupId`'s bare-groupId default and does
  // not prove the exact-match relationship (caller's granted scope equals the
  // entity's own tag). This case passes an explicit scope distinct from the
  // bare groupId and asserts it, not the groupId, is the query key.
  it("an explicit scope matching the entity's own tag is used as the real query key (exact-match), not just the caller's bare groupId", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.entity.mockResolvedValue({ uuid: "e1", name: "Acme", type: "Company", facts: [] });

    const result = await guarded.entity(adminCtx, { groupId: "org_1", entityId: "e1" }, "org_1.dealA");
    expect(result?.uuid).toBe("e1");
    expect(inner.entity).toHaveBeenCalledWith({ groupId: "org_1.dealA", entityId: "e1" });
  });

  // Scope-completeness for entity(): it is a single exact-groupId Graphiti
  // lookup with no containment of its own and no pgvector leg to fall back on
  // (pgvector-store.ts's entity() is a hard `return null`). Without a
  // descendant walk, an ancestor-scoped grant that is fully authorized for a
  // descendant-scoped entity gets nothing back, no denial, silently. A miss at
  // the exact target must try every registered descendant scope under it
  // before giving up.
  it("an entity missing at the exact target is found under a real registered descendant scope, since the Graphiti leg has no containment of its own", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    vi.mocked(strictDescendantScopePaths).mockResolvedValue(["org_1.dealA.notes"]);
    inner.entity.mockImplementation(async (input: { groupId: string; entityId: string; groupIds?: string[] }) =>
      input.groupIds?.includes("org_1.dealA.notes")
        ? { uuid: "e1", name: "Acme", type: "Company", facts: [], graphGroupId: "org_1-dealA-notes" }
        : null,
    );

    // Read scoped to org_1.dealA (the ancestor) — the entity actually lives
    // one level down, at org_1.dealA.notes, a real registered scope.
    const result = await guarded.entity(adminCtx, { groupId: "org_1", entityId: "e1" }, "org_1.dealA");

    expect(result?.uuid).toBe("e1");
    expect(strictDescendantScopePaths).toHaveBeenCalledWith("org_1", "org_1.dealA");
    // Tried the exact target first (existing behavior), not the descendant
    // alone — proves this is a genuine fallback, not a lucky short-circuit.
    expect(inner.entity).toHaveBeenNthCalledWith(1, { groupId: "org_1.dealA", entityId: "e1" });
    // The descendant scope this fix adds is tried somewhere after that, and
    // is what actually produces the hit.
    expect(inner.entity).toHaveBeenCalledWith({
      groupId: "org_1.dealA",
      entityId: "e1",
      groupIds: ["org_1.dealA.notes"],
    });
  });

  it("still returns null when no exact, bare-org, or descendant scope has the entity — the fix doesn't fabricate a hit", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    vi.mocked(strictDescendantScopePaths).mockResolvedValue(["org_1.dealA.notes"]);
    inner.entity.mockResolvedValue(null);

    const result = await guarded.entity(adminCtx, { groupId: "org_1", entityId: "missing" }, "org_1.dealA");

    expect(result).toBeNull();
  });

  it("throws when access is denied", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    denyRows();
    await expect(guarded.entity(memberCtx, { groupId: "org_1", entityId: "e1" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(inner.entity).not.toHaveBeenCalled();
  });

  it("returns null when the entity doesn't exist (propagates null from the store)", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.entity.mockResolvedValue(null);
    const result = await guarded.entity(adminCtx, { groupId: "org_1", entityId: "missing" });
    expect(result).toBeNull();
  });

  it("uses action=memory.entity in the audit trail", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.entity.mockResolvedValue(null);
    await guarded.entity(adminCtx, { groupId: "org_1", entityId: "e1" });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "memory.entity" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// removeFact (memory.delete — needs write+)
// ---------------------------------------------------------------------------

describe("GuardedMemoryStore.removeFact", () => {
  it("allows removal with write+ (admin) permission", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    allowRows();
    inner.removeFact.mockResolvedValue({ removed: true });

    const result = await guarded.removeFact(adminCtx, { groupId: "org_1", factId: "f1" }, orgRootPath("org_1"));
    expect(result.removed).toBe(true);
    // tenantId is the bare org id, forwarded alongside groupId so pgvector's
    // tenant-isolated DELETE has it even when groupId carries a scope path
    // instead.
    expect(inner.removeFact).toHaveBeenCalledWith({ groupId: "org_org_1", factId: "f1", tenantId: "org_1" });
  });

  it("throws when the actor has only read permission (read-only member can't delete)", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    // read grant only — insufficient for memory.delete (needs write+)
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read" }] as never);
    await expect(
      guarded.removeFact(memberCtx, { groupId: "org_1", factId: "f1" }, orgRootPath("org_1")),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(inner.removeFact).not.toHaveBeenCalled();
  });

  it("records a deny audit row when blocked", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    denyRows();
    await guarded.removeFact(memberCtx, { groupId: "org_1", factId: "f1" }, orgRootPath("org_1")).catch(() => {});
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: "deny", action: "memory.delete" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Agent actor (capability token path)
// ---------------------------------------------------------------------------

describe("GuardedMemoryStore — agent actor", () => {
  const agentCtx = {
    orgId: "org_1",
    actor: { type: "agent" as const, id: "copy-agent", capabilityToken: "wcap_valid" },
    origin: "mcp" as const,
  };

  it("allows a read when the capability covers memory.read", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", agentId: "copy-agent" }] as never);
    inner.retrieve.mockResolvedValue({ facts: [{ uuid: "f1", fact: "Jane is CTO", validAt: null }] });

    const result = await guarded.retrieve(agentCtx, { groupId: "org_1", query: "CTO" });
    expect(result.facts).toHaveLength(1);
  });

  it("denies a read when the capability is expired/revoked (empty DB result)", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    denyRows();
    await expect(guarded.retrieve(agentCtx, { groupId: "org_1", query: "budget" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(inner.retrieve).not.toHaveBeenCalled();
  });

  it("audit row records actorType='agent' and the agent's id", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    denyRows();
    await guarded.retrieve(agentCtx, { groupId: "org_1", query: "x" }).catch(() => {});
    const auditData = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(auditData.actorType).toBe("agent");
    expect(auditData.actorId).toBe("copy-agent");
  });

  it("an agent with write permission can call removeFact", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", agentId: "copy-agent" }] as never);
    inner.removeFact.mockResolvedValue({ removed: true });
    const result = await guarded.removeFact(agentCtx, { groupId: "org_1", factId: "f1" }, orgRootPath("org_1"));
    expect(result.removed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------

describe("GuardedMemoryStore — tenant isolation", () => {
  it("throws immediately when groupId doesn't match ctx.orgId", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    await expect(guarded.retrieve(adminCtx, { groupId: "org_2", query: "secret" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(db.$queryRaw).not.toHaveBeenCalled(); // blocked before check()
    expect(inner.retrieve).not.toHaveBeenCalled();
  });

  it("a cross-tenant mismatch reason mentions both org ids", async () => {
    const inner = makeInner();
    const guarded = new GuardedMemoryStore(inner as never);
    const err = await guarded.retrieve(adminCtx, { groupId: "org_2", query: "x" }).catch((e) => e);
    expect(err.decision.reason).toContain("org_1");
    expect(err.decision.reason).toContain("org_2");
  });
});
