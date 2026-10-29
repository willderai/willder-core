// POST /api/memory/entities/merge — the resolution rules route.eval.test.ts
// (cross-scope WRITE leak), route.bare-org-scope.test.ts and
// route.existence-oracle.test.ts do not cover: duplicate names across scopes, a
// memory-service outage during scope resolution must reach the existing 502
// mapping, and a scope-registry outage during resolution must not silently
// become 404.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/store", () => ({
  memory: { transferEntity: vi.fn() },
  graphitiStore: { groupsHoldingEntity: vi.fn() },
}));
vi.mock("@/services/memory/entity-aliases", async (importActual) => ({
  ...(await importActual<typeof import("@/services/memory/entity-aliases")>()),
  recordMergeAlias: vi.fn().mockResolvedValue(undefined),
}));

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { memory, graphitiStore } from "@/services/memory/store";
import { orgRootPath } from "@/services/access";
import { MemoryServiceError } from "@/services/memory";
import { POST } from "./route";
import { holding } from "./graph-holding.testsupport";

const ORG_ID = "org_scope_round3";
const ROOT = orgRootPath(ORG_ID);
const DEAL_A = `${ROOT}.dealA`;
const DEAL_B = `${ROOT}.dealB`;

const covers = (granted: string, target: string): boolean => target === granted || target.startsWith(`${granted}.`);

const post = (body: unknown) =>
  new Request("http://t/api/memory/entities/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/memory/entities/merge — duplicate names across scopes", () => {
  // An org-root admin: write covers everything under ROOT, dealA and dealB
  // both included. resolveEntityScope must not stop at whichever of dealA/dealB
  // happens to sort first and silently merge that one.
  const admin = {
    org: { id: ORG_ID },
    user: { id: "user_admin", name: "Org Admin" },
    ctx: { orgId: ORG_ID, actor: { type: "human" as const, id: "user_admin", role: "admin" as const } },
  };

  beforeEach(() => {
    vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A, DEAL_B]);
    vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
      const targetPath = values[values.length - 1] as string;
      return Promise.resolve(covers(ROOT, targetPath) ? [{ permission: "admin" }] : []);
    }) as never);
  });

  it("refuses rather than guessing when a name resolves to two scopes the caller can both write to", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => name === "Bob" && (groupId === DEAL_A || groupId === DEAL_B)),
    );

    const res = await POST(post({ fromName: "Bob", toName: "Robert" }));

    expect(res.status).toBe(409);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });

  it("control: a name that exists in only one scope still resolves normally for the same admin", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_A && name === "Marcus"),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 1 });

    const res = await POST(post({ fromName: "Marcus", toName: "Marcus Chen" }));

    expect(res.status).toBe(200);
    expect(memory.transferEntity).toHaveBeenCalledWith({
      groupId: DEAL_A,
      oldName: "Marcus",
      newName: "Marcus Chen",
    });
  });

  it("resolves a name that lives only in the 60th scope below the root, with no cap on the scopes asked", async () => {
    const deals = Array.from({ length: 60 }, (_, i) => `${ROOT}.deal${String(i).padStart(2, "0")}`);
    vi.mocked(strictDescendantScopePaths).mockResolvedValue(deals);
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === deals[59] && name === "Marcus"),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 1 });

    const res = await POST(post({ fromName: "Marcus", toName: "Marcus Chen" }));

    expect(res.status).toBe(200);
    expect(memory.transferEntity).toHaveBeenCalledWith({
      groupId: deals[59],
      oldName: "Marcus",
      newName: "Marcus Chen",
    });
  });

  it("a duplicate name hidden in a scope this caller can't write to is not ambiguous — it resolves to the one scope they hold", async () => {
    // dealA-only member (no org-root grant). "Carol" exists in both dealA
    // (this caller's own scope) and dealB (a scope they can't write to). Only
    // one authorized hit exists, so this must resolve normally to dealA, not
    // 409 — ambiguity is about the caller's OWN authorized candidates, not
    // raw name collisions the caller can't even see.
    const contractor = {
      org: { id: ORG_ID },
      user: { id: "user_1", name: "Contractor A" },
      ctx: { orgId: ORG_ID, actor: { type: "human" as const, id: "user_1", role: "member" as const } },
    };
    vi.mocked(requireAccessContext).mockResolvedValue(contractor as never);
    vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
      const targetPath = values[values.length - 1] as string;
      return Promise.resolve(covers(DEAL_A, targetPath) ? [{ permission: "write" }] : []);
    }) as never);
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => name === "Carol" && (groupId === DEAL_A || groupId === DEAL_B)),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 1 });

    const res = await POST(post({ fromName: "Carol", toName: "Carol Chen" }));

    expect(res.status).toBe(200);
    expect(memory.transferEntity).toHaveBeenCalledWith({
      groupId: DEAL_A,
      oldName: "Carol",
      newName: "Carol Chen",
    });
  });
});

describe("POST /api/memory/entities/merge — resolution failures don't misreport", () => {
  const rc = {
    org: { id: ORG_ID },
    user: { id: "user_1", name: "Contractor A" },
    ctx: { orgId: ORG_ID, actor: { type: "human" as const, id: "user_1", role: "member" as const } },
  };

  beforeEach(() => {
    vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([]);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write" }] as never);
  });

  it("a memory-service outage during scope resolution maps to 502, not an unhandled error", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockRejectedValue(
      new MemoryServiceError("memory service entity find-by-name failed: 503"),
    );

    const res = await POST(post({ fromName: "Bob", toName: "Robert" }));

    expect(res.status).toBe(502);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });

  it("a scope-registry outage during resolution propagates instead of silently becoming 404", async () => {
    vi.mocked(strictDescendantScopePaths).mockRejectedValue(new Error("connection terminated"));
    vi.mocked(graphitiStore.groupsHoldingEntity).mockResolvedValue([]);

    await expect(POST(post({ fromName: "Bob", toName: "Robert" }))).rejects.toThrow("connection terminated");
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });
});
