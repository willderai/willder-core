// The three guarded writers record the partition they actually wrote to.
//
// Two paths are distinct: check() authorizes `scope` (falling back to the org
// root), while the real store mutation runs against `scope ?? input.groupId`.
// When a caller passes no scope, those two are different strings -- the
// authorization row says `org_<orgId>`, the delete executes against the bare,
// untagged `<orgId>` partition -- and only the effect row says so. Without it
// a reviewer reading the trail can see that a destructive write was allowed
// and that it landed, but not where it landed.
//
// The fixtures below use a realistic cuid org id rather than the literal
// string `org_1`. The executed partition and the org-root scope path differ
// only by an `org_` prefix, so an org id that itself starts with `org_` makes
// an unrenderable target look renderable -- and lets every unscoped delete
// show as "Org root" with an unparsed blob and no record id.
//
// Like guarded-store.applied-signal.test.ts, this file deliberately does NOT
// mock the recorder out: the real recordWriteEffect() runs against a mocked
// `db.auditLog.create` and the assertions are on the row that reaches the
// database. Only check() is stubbed, and it returns an auditLogId so the
// effect row has an authorization row to link to.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  // removeFact() writes its applied row and change event in one transaction; the
  // double runs the callback against itself so the row still lands on this mock.
  const db = {
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }) },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1), id: "change_1", seq: BigInt(1) }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return { db };
});

vi.mock("./../access/check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../access/check")>();
  return {
    ...actual,
    check: vi.fn().mockResolvedValue({ allowed: true, reason: "ok", auditLogId: "audit_1" }),
  };
});

import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import { orgRootPath, type AccessContext } from "@/services/access";
import { parseTarget } from "@/components/audit/format";

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

const ORG = "clx7k2m0a0000q1r3s5t7u9v1";
/** A registered scope, the partition a scoped write executes against. */
const SCOPE = `${orgRootPath(ORG)}.engineering`;
/** A partition of neither namespace of this org: assertTenant() and check()
 * keep it unreachable in production, which is why resolving it may throw. */
const FOREIGN = "clx0000000000000000000000.sales";
const ctx = {
  orgId: ORG,
  actor: { type: "human", id: "user_1", role: "member" },
} as AccessContext;

const EFFECT_ACTIONS = ["memory.write.effect", "memory.delete.effect"];

function effectRows() {
  return vi
    .mocked(db.auditLog.create)
    .mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .filter((d) => EFFECT_ACTIONS.includes(d.action as string));
}

beforeEach(() => vi.clearAllMocks());

describe("the executed partition is recorded, not just the authorized scope", () => {
  it("removeFact: records the scope the delete really ran against", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeFact(ctx, { groupId: ORG, factId: "f1" }, SCOPE);

    expect(vi.mocked(store.removeFact).mock.calls[0][0]).toMatchObject({ groupId: SCOPE });
    expect(effectRows()).toEqual([
      {
        orgId: ORG,
        actorType: "human",
        actorId: "user_1",
        action: "memory.delete.effect",
        target: `${SCOPE}/fact:f1`,
        decision: "allow",
        metadata: { auditLogId: "audit_1", executedGroupId: SCOPE },
        runId: undefined,
      },
    ]);
  });

  it("removeEntity: records the same scope the store was called with", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeEntity(ctx, { groupId: ORG, entityId: "e1" }, SCOPE);

    expect(effectRows()).toHaveLength(1);
    expect(effectRows()[0]).toMatchObject({
      action: "memory.delete.effect",
      target: `${SCOPE}/entity:e1`,
      metadata: { auditLogId: "audit_1", executedGroupId: SCOPE },
    });
  });

  it("transferEntity: records the scope the merge really ran against", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.transferEntity(ctx, { groupId: ORG, oldName: "Acme Inc", newName: "Acme" }, SCOPE);

    expect(effectRows()).toHaveLength(1);
    expect(effectRows()[0]).toMatchObject({
      action: "memory.write.effect",
      target: `${SCOPE}/merge:Acme Inc→Acme`,
      metadata: { auditLogId: "audit_1", executedGroupId: SCOPE },
    });
  });

  // The divergence the effect row exists for. check() authorizes `org_<orgId>` (the
  // org-root ltree path); the write lands in the bare, untagged `<orgId>`
  // Graphiti partition. The two strings are different and only the effect row
  // carries the second one.
  it("removeEntity with no scope: authorized at the org root, executed against the bare org partition", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeEntity(ctx, { groupId: ORG, entityId: "e1" });

    expect(vi.mocked(store.removeEntity).mock.calls[0][0]).toMatchObject({ groupId: ORG });
    expect(effectRows()[0]).toMatchObject({
      action: "memory.delete.effect",
      target: `group:${ORG}/entity:e1`,
      metadata: { auditLogId: "audit_1", executedGroupId: ORG },
    });
    // Not the authorized path, which is what every pre-existing row records.
    expect(effectRows()[0].metadata).not.toMatchObject({ executedGroupId: orgRootPath(ORG) });
  });

  it("transferEntity's org-root case: authorized at the org root, executed against the bare partition", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.transferEntity(ctx, { groupId: ORG, oldName: "Acme Inc", newName: "Acme" }, ORG);

    expect(vi.mocked(store.transferEntity).mock.calls[0][0]).toMatchObject({ groupId: ORG });
    expect(effectRows()[0]).toMatchObject({
      action: "memory.write.effect",
      target: `group:${ORG}/merge:Acme Inc→Acme`,
      metadata: { auditLogId: "audit_1", executedGroupId: ORG },
    });
  });
});

// Every row these three writers emit reaches the audit table, so every one of
// them has to survive parseTarget(). See the same guard in
// services/access/check.write-effect.test.ts for what a null target does there.
describe("every effect row the writers emit is renderable", () => {
  const scoped: Array<[string, (g: GuardedMemoryStore) => Promise<unknown>]> = [
    ["removeFact", (g) => g.removeFact(ctx, { groupId: ORG, factId: "f1" }, SCOPE)],
    ["removeEntity", (g) => g.removeEntity(ctx, { groupId: ORG, entityId: "e1" }, SCOPE)],
    ["transferEntity", (g) => g.transferEntity(ctx, { groupId: ORG, oldName: "A", newName: "B" }, SCOPE)],
  ];

  // The default route path: no `?scope=`, so the write executes against the
  // untagged partition. This is the case an `org_`-prefixed fixture id hides.
  // removeFact() is absent: it requires a scope and refuses without one.
  const unscoped: Array<[string, (g: GuardedMemoryStore) => Promise<unknown>]> = [
    ["removeEntity", (g) => g.removeEntity(ctx, { groupId: ORG, entityId: "e1" })],
    ["transferEntity", (g) => g.transferEntity(ctx, { groupId: ORG, oldName: "A", newName: "B" })],
  ];

  it.each(scoped)("%s scoped: the row resolves to the scope it wrote to", async (_name, call) => {
    await call(new GuardedMemoryStore(mockStore()));

    const row = effectRows()[0];
    expect(typeof row.target).toBe("string");
    expect(parseTarget(row.target as string).scope).toBe("Engineering");
  });

  it.each(unscoped)(
    "%s unscoped: the row resolves to the untagged partition, not to the org root",
    async (_name, call) => {
      await call(new GuardedMemoryStore(mockStore()));

      const row = effectRows()[0];
      const parsed = parseTarget(row.target as string);
      expect(parsed.scope).toBe("Untagged");
      // The failure shape: an unparsed target falls through to "Org root",
      // which is also the label of the scope check() authorized -- so the row
      // claims the write landed somewhere it did not.
      expect(parsed.scope).not.toBe("Org root");
      expect(parsed.what).not.toContain(ORG);
    },
  );

  // A delete of a record keeps its id visible so a reviewer can cross-reference
  // the exact memory record. An unparsed target swallows the id into `what`.
  it.each([
    ["removeEntity", (g: GuardedMemoryStore) => g.removeEntity(ctx, { groupId: ORG, entityId: "e1" }), "e1"],
  ] as const)("%s unscoped: the record id survives into the row's chip", async (_name, call, id) => {
    await call(new GuardedMemoryStore(mockStore()));

    const row = effectRows()[0];
    expect(parseTarget(row.target as string).recordId).toBe(id);
  });
});

describe("the effect row only ever describes a write that really happened", () => {
  it.each([
    ["removeFact", (g: GuardedMemoryStore) => g.removeFact(ctx, { groupId: ORG, factId: "f1" }, SCOPE)],
    ["removeEntity", (g: GuardedMemoryStore) => g.removeEntity(ctx, { groupId: ORG, entityId: "e1" }, SCOPE)],
    [
      "transferEntity",
      (g: GuardedMemoryStore) => g.transferEntity(ctx, { groupId: ORG, oldName: "A", newName: "B" }, SCOPE),
    ],
  ])("%s: records nothing when the real store mutation throws", async (_name, call) => {
    const store = mockStore();
    vi.mocked(store.removeFact).mockRejectedValue(new Error("graphiti down"));
    vi.mocked(store.removeEntity).mockRejectedValue(new Error("graphiti down"));
    vi.mocked(store.transferEntity).mockRejectedValue(new Error("graphiti down"));

    await expect(call(new GuardedMemoryStore(store))).rejects.toThrow("graphiti down");
    expect(effectRows()).toEqual([]);
  });

  // resolveExecutedPartition() throws for a partition in neither namespace, and
  // check.ts's doc comment gives the ordering as the reason it is safe to throw
  // at all -- "callers resolve BEFORE the store mutation so this fails while
  // nothing has been written." Moving the resolve below the mutation would keep
  // every other test green while turning a rejected request into a completed
  // delete with no audit row naming where it landed. These pin the ordering
  // for all three writers.
  it.each([
    ["removeFact", (g: GuardedMemoryStore) => g.removeFact(ctx, { groupId: ORG, factId: "f1" }, FOREIGN)],
    ["removeEntity", (g: GuardedMemoryStore) => g.removeEntity(ctx, { groupId: ORG, entityId: "e1" }, FOREIGN)],
    [
      "transferEntity",
      (g: GuardedMemoryStore) => g.transferEntity(ctx, { groupId: ORG, oldName: "A", newName: "B" }, FOREIGN),
    ],
  ])("%s: an unresolvable partition rejects before anything is mutated", async (_name, call) => {
    const store = mockStore();

    await expect(call(new GuardedMemoryStore(store))).rejects.toThrow(/neither a group_id nor a scope path/);

    expect(store.removeFact).not.toHaveBeenCalled();
    expect(store.removeEntity).not.toHaveBeenCalled();
    expect(store.transferEntity).not.toHaveBeenCalled();
    expect(effectRows()).toEqual([]);
  });

  it("removeFact: the effect row is written after the store delete resolves", async () => {
    const store = mockStore();
    const guarded = new GuardedMemoryStore(store);

    await guarded.removeFact(ctx, { groupId: ORG, factId: "f1" }, SCOPE);

    const deleteOrder = vi.mocked(store.removeFact).mock.invocationCallOrder[0];
    const effectCall = vi
      .mocked(db.auditLog.create)
      .mock.calls.findIndex((c) => (c[0] as { data: { action: string } }).data.action === "memory.delete.effect");
    expect(deleteOrder).toBeLessThan(vi.mocked(db.auditLog.create).mock.invocationCallOrder[effectCall]);
  });
});
