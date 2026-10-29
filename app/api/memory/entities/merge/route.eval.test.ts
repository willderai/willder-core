// Cross-scope WRITE leak — POST /api/memory/entities/merge.
//
// The rule: check() must authorize the same scope the transferEntity call runs
// at. If check() authorized whatever `scope` the REQUEST BODY claimed while the
// write ran at a hardcoded groupId (the bare org id), a caller holding
// memory.write at ANY scope could get a real write applied somewhere check()
// never authorized. The same way app/api/briefs/[id]/correct/route.ts derives a
// brief's scopePath from the target row itself, never the caller, this route
// resolves fromName's REAL, current scope server-side (resolveEntityScope) and
// check()s + writes against exactly that scope. `scope` is not accepted from the
// request body at all.
//
// Seam under test: the real route handler, the real resolveEntityScope, the real
// guardedMemory.transferEntity, and the real check()/ltree containment logic (a
// working `covers()` predicate drives the mocked db.$queryRaw, not a
// permission-always-granted stub — getting that backwards would make the deny
// case below vacuous). Only @/lib/db, the Graphiti HTTP boundary
// (@/services/memory/store), @/lib/access-context, and the alias-registry write
// (unrelated to scope) are mocked.
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
import { recordMergeAlias } from "@/services/memory/entity-aliases";
import { orgRootPath } from "@/services/access";
import { POST } from "./route";
import { holding } from "./graph-holding.testsupport";

const ORG_ID = "org_mergescope_test";
const ROOT = orgRootPath(ORG_ID);
const DEAL_A = `${ROOT}.dealA`;
const DEAL_B = `${ROOT}.dealB`;

/** ltree ancestor-or-self, the same relation Postgres `@>` gives check(). */
const covers = (granted: string, target: string): boolean => target === granted || target.startsWith(`${granted}.`);

// A member with a real grant on dealA ONLY (memory.write) — the ordinary
// "contractor on one deal" case. No grant anywhere else, dealB included.
const rc = {
  org: { id: ORG_ID },
  user: { id: "user_1", name: "Contractor A" },
  ctx: { orgId: ORG_ID, actor: { type: "human" as const, id: "user_1", role: "member" as const } },
};

const post = (body: unknown) =>
  new Request("http://t/api/memory/entities/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  // Every real, registered scope for this org — resolveEntityScope's candidate
  // walk (strictDescendantScopePaths) reads this the same way check.ts's own
  // descendant fan-out does.
  vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A, DEAL_B]);
  // The dealA-only grant, containment implemented for real: only a target scope
  // dealA itself or a descendant of it gets a "write" row back.
  vi.mocked(db.$queryRaw).mockImplementation(((_strings: unknown, ...values: unknown[]) => {
    const targetPath = values[values.length - 1] as string;
    return Promise.resolve(covers(DEAL_A, targetPath) ? [{ permission: "write" }] : []);
  }) as never);
});

describe("POST /api/memory/entities/merge — cross-scope write leak", () => {
  it("denies a merge whose target entity actually lives OUTSIDE the caller's granted scope, and never calls the store", async () => {
    // "Bob" actually lives in dealB — a scope this caller holds no grant on at
    // all. A route that check()ed whatever `scope` the body claimed (trivially
    // dealA, to sail through) and then wrote at a hardcoded groupId would leak
    // here.
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_B && name === "Bob"),
    );

    const res = await POST(post({ fromName: "Bob", toName: "Robert", scope: DEAL_A }));

    // 404, not 403: a denied merge on an entity that
    // genuinely exists elsewhere must look identical to one that doesn't exist
    // anywhere at all, or the status code itself becomes a cross-scope
    // existence oracle. See route.existence-oracle.test.ts for the direct
    // side-by-side assertion.
    expect(res.status).toBe(404);
    expect(memory.transferEntity).not.toHaveBeenCalled();
    expect(recordMergeAlias).not.toHaveBeenCalled();
    // The denial is audited against dealB — the entity's real scope — not
    // dealA, the scope the (ignored) request body claimed.
    expect(db.$queryRaw).toHaveBeenCalled();
    const lastCallValues = vi.mocked(db.$queryRaw).mock.calls.at(-1)!;
    expect(lastCallValues[lastCallValues.length - 1]).toBe(DEAL_B);
  });

  it("a caller-supplied `scope` in the body is ignored outright — the check runs against the entity's real scope either way", async () => {
    // Same as above but the attacker doesn't even bother claiming dealA — any
    // claimed scope is irrelevant since scope is derived, not read from
    // the body.
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_B && name === "Bob"),
    );

    const res = await POST(post({ fromName: "Bob", toName: "Robert", scope: "org_totally_different_org" }));

    expect(res.status).toBe(404);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });

  it("404s when the named entity doesn't exist in any real scope for this org", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockResolvedValue([]);

    const res = await POST(post({ fromName: "Nobody", toName: "Somebody" }));

    expect(res.status).toBe(404);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });

  it("control: a merge fully inside the caller's own granted scope succeeds, and writes at that resolved scope", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_A && name === "Marcus"),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 3 });

    const res = await POST(post({ fromName: "Marcus", toName: "Marcus Chen" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transferred: 3, fromName: "Marcus", toName: "Marcus Chen" });
    // The store call itself runs at the resolved scope (dealA), the same scope
    // that was actually checked.
    expect(memory.transferEntity).toHaveBeenCalledWith({
      groupId: DEAL_A,
      oldName: "Marcus",
      newName: "Marcus Chen",
    });
    expect(recordMergeAlias).toHaveBeenCalledWith(ORG_ID, "Marcus", "Marcus Chen", "user_1");
  });
});
