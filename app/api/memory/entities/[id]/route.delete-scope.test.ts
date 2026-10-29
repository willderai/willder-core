// DELETE /api/memory/entities/:id — write partition.
//
// guarded-store's removeEntity()/removeFact() check() the caller's scope and must
// forward it to the store call: without that, the delete executes at group_id =
// the bare org id (org root) instead of the narrow scope that was authorized. Two
// consequences, one destructive and one availability:
//
//   1. a narrow-scope caller's delete lands in the org-root partition, and
//   2. an entity genuinely living in a sub-scope can never be deleted through this
//      route at all — the delete hits the wrong partition, comes back removed:false,
//      and the handler maps that to a 404.
//
// The forwarding rule mirrors entity()/transferEntity(): writeGroupId = scope ??
// input.groupId. services/memory/guarded-store.test.ts asserts it by constructing
// GuardedMemoryStore with an injected mock store.
//
// These tests are a deliberately INDEPENDENT source of truth for the same rule:
// they drive the real route handler and the real `guardedMemory` singleton (only
// the bottom Graphiti store is faked), so they cover the route → guarded store →
// store chain itself.
//
// The fake store below is PARTITION-AWARE rather than a bare vi.fn(): it only
// reports a removal when the delete arrives at the partition the entity really
// lives in. That is what makes case 2 a true regression test — a delete aimed at
// the bare org id returns 404, one aimed at the right partition returns 204,
// without the assertion itself naming the implementation's variable.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    scope: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));
// Fake only the bottom store. `guardedMemory` (services/memory/guarded-store.ts)
// is the REAL singleton over this, so the forwarding under test is real code.
vi.mock("@/services/memory/store", () => ({
  memory: { removeEntity: vi.fn() },
  graphitiStore: { groupsHoldingEntity: vi.fn() },
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn(), recordReadFactIds: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { memory } from "@/services/memory/store";
import { check } from "@/services/access";
import { DELETE } from "./route";

/** The scope the entity genuinely lives in — a real registered ltree path. */
const SCOPE = "org_org_1.marketing";
/** The bare, untagged org partition. */
const BARE_ORG = "org_1";

const rc = {
  org: { id: BARE_ORG },
  user: { id: "user_42", name: "Jane Doe" },
  ctx: { orgId: BARE_ORG, actor: { type: "human", id: "user_42", role: "member" } },
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const del = (url: string) => new Request(url, { method: "DELETE" });

/**
 * Only reports a removal when the delete actually reaches `livesIn`. Mirrors real
 * Graphiti behaviour: group_id is a hard partition, a delete aimed at the wrong one
 * matches nothing and removes nothing.
 */
function entityLivingIn(livesIn: string) {
  return vi.fn(async ({ groupId }: { groupId: string }) => ({ removed: groupId === livesIn }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
});

describe("DELETE /api/memory/entities/:id — write partition", () => {
  it("deletes a sub-scope entity at its own partition, not the bare org id", async () => {
    vi.mocked(memory.removeEntity).mockImplementation(entityLivingIn(SCOPE) as never);

    await DELETE(del(`http://t/api/memory/entities/e1?scope=${SCOPE}`), params("e1"));

    // The destructive half: the delete must execute where it was
    // authorized, never at org root.
    expect(memory.removeEntity).toHaveBeenCalledWith(expect.objectContaining({ groupId: SCOPE, entityId: "e1" }));
    expect(memory.removeEntity).not.toHaveBeenCalledWith(expect.objectContaining({ groupId: BARE_ORG }));
  });

  it("the legitimate sub-scope delete succeeds instead of 404ing on the wrong partition", async () => {
    // The entity really is in SCOPE. A delete aimed at BARE_ORG matches nothing,
    // and the handler turns removed:false into "entity not found".
    vi.mocked(memory.removeEntity).mockImplementation(entityLivingIn(SCOPE) as never);

    const res = await DELETE(del(`http://t/api/memory/entities/e1?scope=${SCOPE}`), params("e1"));

    expect(res.status).toBe(204);
  });

  it("still 404s when the entity genuinely is not in the authorized scope", async () => {
    // Guard against forwarding overcorrecting into a blanket success: an entity that
    // lives somewhere else must still report not-found, not a phantom delete.
    vi.mocked(memory.removeEntity).mockImplementation(entityLivingIn("org_org_1.sales") as never);

    const res = await DELETE(del(`http://t/api/memory/entities/e1?scope=${SCOPE}`), params("e1"));

    expect(res.status).toBe(404);
  });

  it("with no ?scope=, still targets the bare org partition (unscoped default preserved)", async () => {
    vi.mocked(memory.removeEntity).mockImplementation(entityLivingIn(BARE_ORG) as never);

    const res = await DELETE(del("http://t/api/memory/entities/e1"), params("e1"));

    expect(memory.removeEntity).toHaveBeenCalledWith(expect.objectContaining({ groupId: BARE_ORG, entityId: "e1" }));
    expect(res.status).toBe(204);
  });

  it("a denied caller is still refused, and nothing is deleted anywhere", async () => {
    // Forwarding must not move the write ahead of the gate.
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no memory.delete grant" } as never);
    vi.mocked(memory.removeEntity).mockImplementation(entityLivingIn(SCOPE) as never);

    const res = await DELETE(del(`http://t/api/memory/entities/e1?scope=${SCOPE}`), params("e1"));

    expect(res.status).toBe(403);
    expect(memory.removeEntity).not.toHaveBeenCalled();
  });

  it("a cross-tenant group_id never reaches the store (assertTenant still holds)", async () => {
    vi.mocked(memory.removeEntity).mockImplementation(entityLivingIn(SCOPE) as never);
    vi.mocked(requireAccessContext).mockResolvedValue({
      ...rc,
      ctx: { orgId: "org_2", actor: { type: "human", id: "user_42", role: "member" } },
    } as never);

    const res = await DELETE(del(`http://t/api/memory/entities/e1?scope=${SCOPE}`), params("e1"));

    expect(res.status).toBe(403);
    expect(memory.removeEntity).not.toHaveBeenCalled();
  });
});
