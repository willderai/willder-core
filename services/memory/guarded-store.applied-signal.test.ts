// Every guarded-store mutation writes a confirmed-applied audit row, and this
// file observes that row at the seam a brief's staleness read queries.
//
// guarded-store.test.ts mocks `recordAppliedChange` out of `@/services/access`
// wholesale, so nothing there observes the `memory.delete.applied` row
// removeFact() writes — deleting that call site leaves that suite green. This
// file does NOT mock it: it lets the real function run against a mocked
// `db.auditLog.create` and asserts on the row that reaches the database.
//
// removeEntity() and transferEntity() are covered the same way. Each writes an
// authorization-time `memory.delete`/`memory.write` row via check(), but
// auditChangesUnderScope() matches only `.applied` rows, so without an applied
// counterpart a brief never goes stale when an entity under its scope is
// deleted or merged away. guarded-store.ts records the confirmed-applied row
// for both after the real store mutation resolves; the tests below assert that
// row, real and unmocked, the same way as removeFact().
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  // removeFact() writes its applied row and change event in one transaction; the
  // double runs the callback against itself so the row still lands on this mock.
  const db = {
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }) },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1) }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return { db };
});

// Only check() is stubbed (always allow, and recording nothing) — the real
// recordAppliedChange/orgRootPath/pathCovers from services/access run.
vi.mock("./../access/check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../access/check")>();
  return { ...actual, check: vi.fn().mockResolvedValue({ allowed: true }) };
});

import { db } from "@/lib/db";
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
    removeEntity: vi.fn().mockResolvedValue({ removed: true }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 3 }),
  } as unknown as MemoryStore;
}

const SCOPE = "org_org_1.engineering";
const ctx = {
  orgId: "org_1",
  actor: { type: "human", id: "user_1", role: "member" },
} as AccessContext;

// The exact action literals auditChangesUnderScope()'s SQL filters on.
const STALENESS_ACTIONS = ["memory.write.applied", "memory.delete.applied"];

function appliedRows() {
  return vi
    .mocked(db.auditLog.create)
    .mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .filter((d) => STALENESS_ACTIONS.includes(d.action as string));
}

beforeEach(() => vi.clearAllMocks());

describe("removeFact — the confirmed-applied delete signal (unmocked)", () => {
  it("writes a memory.delete.applied row AFTER the real store delete resolves", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }, SCOPE);

    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: "org_1",
      action: "memory.delete.applied",
      target: `${SCOPE}/fact:f1`,
      decision: "allow",
    });
    // Ordering is the whole point: the store delete must land first.
    const deleteOrder = vi.mocked(store.removeFact).mock.invocationCallOrder[0];
    const appliedOrder = vi.mocked(db.auditLog.create).mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(appliedOrder);
  });

  it("records nothing when the real store delete throws", async () => {
    const store = mockStore();
    vi.mocked(store.removeFact).mockRejectedValue(new Error("graphiti down"));
    const guarded = new GuardedMemoryStore(store);

    await expect(guarded.removeFact(ctx, { groupId: "org_1", factId: "f1" }, SCOPE)).rejects.toThrow("graphiti down");
    expect(appliedRows()).toHaveLength(0);
  });
});

describe("removeEntity/transferEntity feed the staleness signal (unmocked)", () => {
  it("removeEntity: a real entity delete under the brief's scope writes a memory.delete.applied row AFTER the real store delete resolves", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeEntity(ctx, { groupId: "org_1", entityId: "e1" }, SCOPE);

    expect(store.removeEntity).toHaveBeenCalledTimes(1);
    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: "org_1",
      action: "memory.delete.applied",
      target: `${SCOPE}/entity:e1`,
      decision: "allow",
    });
    const deleteOrder = vi.mocked(store.removeEntity).mock.invocationCallOrder[0];
    const appliedOrder = vi.mocked(db.auditLog.create).mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(appliedOrder);
  });

  it("removeEntity: records nothing when the real store delete throws", async () => {
    const store = mockStore();
    vi.mocked(store.removeEntity).mockRejectedValue(new Error("graphiti down"));
    const guarded = new GuardedMemoryStore(store);

    await expect(guarded.removeEntity(ctx, { groupId: "org_1", entityId: "e1" }, SCOPE)).rejects.toThrow(
      "graphiti down",
    );
    expect(appliedRows()).toHaveLength(0);
  });

  it("transferEntity: a real entity merge under the brief's scope writes a memory.write.applied row AFTER the real store merge resolves", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.transferEntity(ctx, { groupId: "org_1", oldName: "Acme Inc", newName: "Acme" }, SCOPE);

    expect(store.transferEntity).toHaveBeenCalledTimes(1);
    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: "org_1",
      action: "memory.write.applied",
      target: `${SCOPE}/merge:Acme Inc→Acme`,
      decision: "allow",
    });
    const mergeOrder = vi.mocked(store.transferEntity).mock.invocationCallOrder[0];
    const appliedOrder = vi.mocked(db.auditLog.create).mock.invocationCallOrder[0];
    expect(mergeOrder).toBeLessThan(appliedOrder);
  });

  it("transferEntity: records nothing when the real store merge throws", async () => {
    const store = mockStore();
    vi.mocked(store.transferEntity).mockRejectedValue(new Error("graphiti down"));
    const guarded = new GuardedMemoryStore(store);

    await expect(
      guarded.transferEntity(ctx, { groupId: "org_1", oldName: "Acme Inc", newName: "Acme" }, SCOPE),
    ).rejects.toThrow("graphiti down");
    expect(appliedRows()).toHaveLength(0);
  });

  it("transferEntity: the org-root special case (scope === input.groupId) records the applied row at orgRootPath, matching what check() authorized", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.transferEntity(ctx, { groupId: "org_1", oldName: "Acme Inc", newName: "Acme" }, "org_1");

    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "memory.write.applied",
      target: "org_org_1/merge:Acme Inc→Acme",
    });
  });
});
