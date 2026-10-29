// DELETE /api/sources/:id asks check() about every scope the disconnect destroys content in.
//
// The companion to route.scope-admin-authz-live-sql.test.ts, and the mirror of
// app/api/sources/route.scope-admin-authz.test.ts on the connect side. That
// live-SQL file proves, against real Postgres and real grants, that check()
// admits a scope admin inside their own subtree and refuses them outside it.
// This file proves the half no database can show: that DELETE /api/sources/:id
// asks check() about the scopes this disconnect actually destroys content in,
// and that a denial on any one of them reaches no store.
//
// Together they are the guard-removal differential. Restore the pre-fix call
// (a check() with a "sources:disconnect:<id>" target and no `scope`, which
// defaults to the org root) and every `scope:` assertion below fails; the
// live-SQL file then shows what that costs a real scope admin.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = vi.fn();
  const can = vi.fn();
  // The real record helper, deciding with the stubs above.
  return { ...actual, check, can, authorizeRecord: actual.recordAuthorizer({ check, can }) };
});
// Same seam route.test.ts uses: the concrete store, not the `@/services/memory`
// barrel. `services/memory/source-retirement` stays real, so the scopes this
// route authorizes are derived by the same helper that later purges them —
// which is the whole point of the assertions below.
vi.mock("@/services/memory/store", () => ({
  graphitiStore: { removeGroupFacts: vi.fn() },
}));
vi.mock("@/services/memory/brief-retirement", () => ({ retireBriefsFedBySource: vi.fn(async () => 0) }));
vi.mock("@/lib/db", () => ({
  db: {
    // bumpRemovalEpoch() (services/access/check.ts), after a source's graph facts are retired.
    $executeRaw: vi.fn(async () => 0),
    source: { findFirst: vi.fn(), update: vi.fn() },
    memoryChunk: { deleteMany: vi.fn() },
    changeEvent: { updateMany: vi.fn(async () => ({ count: 0 })) },
    sourceFile: { deleteMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { can, check } from "@/services/access";
import { graphitiStore } from "@/services/memory/store";
import { DELETE } from "./route";

const ORG = "org_1";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;
const SCOPE_B = `${ROOT}.team_b`;

const rc = {
  org: { id: ORG },
  user: { id: "user_a_admin" },
  ctx: { orgId: ORG, actor: { type: "human", id: "user_a_admin", role: "member" } },
};

/** A source living in scope A — the scope its admin must be able to disconnect. */
const SOURCE = { id: "src_1", orgId: ORG, type: "slack", scopePath: SCOPE_A, status: "active" };

function callDelete(id = "src_1") {
  return DELETE(new Request(`http://test/api/sources/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

/** Every scope path the route asked check() about, in the order it asked. */
function checkedScopes(): unknown[] {
  return vi.mocked(check).mock.calls.map((c) => c[1].scope);
}

/** Nothing this route can destroy was touched. */
function expectNothingRetired() {
  expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
  expect(vi.mocked(db.memoryChunk.deleteMany)).not.toHaveBeenCalled();
  expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  // The caller can read the source, so a denial is a 403 rather than its 404.
  vi.mocked(can).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.source.findFirst).mockResolvedValue(SOURCE as never);
  vi.mocked(graphitiStore.removeGroupFacts).mockResolvedValue({ removedCount: 0 } as never);
  vi.mocked(db.memoryChunk.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(db.sourceFile.deleteMany).mockResolvedValue({ count: 0 } as never);
  // The source never moved: its own scopePath is the only scope in play.
  vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
  vi.mocked(db.$transaction).mockResolvedValue([{ count: 0 }, SOURCE] as never);
});

describe("DELETE /api/sources/:id authorizes the scope the source lives in", () => {
  it("checks the source's own scopePath, not the org root", async () => {
    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(checkedScopes()).toEqual([SCOPE_A]);
  });

  it("still names the source in the check target, so the audit trail keeps it", async () => {
    await callDelete();

    expect(vi.mocked(check).mock.calls[0][1]).toMatchObject({
      action: "memory.write",
      target: "sources:disconnect:src_1",
    });
  });

  it("asks before it destroys anything", async () => {
    const order: string[] = [];
    vi.mocked(check).mockImplementation((async () => {
      order.push("check");
      return { allowed: true };
    }) as never);
    vi.mocked(graphitiStore.removeGroupFacts).mockImplementation((async () => {
      order.push("retire");
      return { removedCount: 0 };
    }) as never);

    await callDelete();

    // The second retire is the purge after the disconnect, which the same check covers.
    expect(order).toEqual(["check", "retire", "retire"]);
  });

  it("403s a caller with no grant on that scope and retires nothing", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: `no write grant on ${SCOPE_A}` } as never);

    const res = await callDelete();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `no write grant on ${SCOPE_A}` });
    expectNothingRetired();
  });
});

// A source a reconnect moved still has content under the scope it left, and
// this route destroys that too. Authorizing only where the source points now would let an admin of
// the scope it was moved INTO destroy content in a scope they hold nothing on.
// That is the same asymmetry POST /api/sources' own move guard closes from the
// other direction, and dropping the org-root check is what makes it reachable.
describe("DELETE /api/sources/:id authorizes every scope it purges", () => {
  beforeEach(() => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([{ episodeScopePath: SCOPE_B }] as never);
  });

  it("checks the earlier scope its files record as well as the current one", async () => {
    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(checkedScopes()).toEqual([SCOPE_A, SCOPE_B]);
  });

  it("403s and retires nothing when the caller has no write on the earlier scope", async () => {
    vi.mocked(check).mockImplementation((async (_ctx: unknown, req: { scope?: string }) =>
      req.scope === SCOPE_B ? { allowed: false, reason: `no write grant on ${SCOPE_B}` } : { allowed: true }) as never);

    const res = await callDelete();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `no write grant on ${SCOPE_B}` });
    expectNothingRetired();
  });

  it("does not ask twice when every file records the scope the source still points at", async () => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([
      { episodeScopePath: SCOPE_A },
      { episodeScopePath: SCOPE_A },
    ] as never);

    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(checkedScopes()).toEqual([SCOPE_A]);
  });
});
