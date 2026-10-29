// POST /api/sources asks check() about the scope the source lands in.
//
// The companion to route.scope-admin-authz-live-sql.test.ts. That file proves,
// against real Postgres and real grants, that check() admits a scope admin
// inside their own subtree and refuses them outside it. This file proves the
// other half, which no database can show: that POST /api/sources asks check()
// about the scope the source actually lands in, for each of the three ways
// that scope gets resolved, and that a denial still reaches no write.
//
// Together they are the guard-removal differential. Restore the pre-fix call
// (`check(rc.ctx, { action: "memory.write", target: "sources:connect" })`, no
// `scope`) and every `scope:` assertion below fails; the live-SQL file then
// shows what that costs a real scope admin.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The connect's widening gate has its own tests (app/api/sources/route.widening.realdb.test.ts). Here the
// source reports no one beyond the scope, so these tests stay on what they cover.
vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
vi.mock("@/services/access/source-widening", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access/source-widening")>()),
  scopeAudience: vi.fn(async () => ({ people: [], agents: [] })),
}));

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    source: { findUnique: vi.fn(), upsert: vi.fn() },
    scope: { findUnique: vi.fn() },
    sourceFile: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
// The change-feed event is covered by its own tests; here it only has to not throw.
vi.mock("@/services/memory/source-change-event", () => ({ recordSourceChange: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/services/memory/source-retirement", () => ({ retireSourceContent: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { retireSourceContent } from "@/services/memory/source-retirement";
import { POST } from "./route";

const ORG = "org_1";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;

const rc = {
  org: { id: ORG },
  user: { id: "user_a_admin" },
  ctx: { orgId: ORG, actor: { type: "human", id: "user_a_admin", role: "member" } },
};

/** A slack connect, the cheapest branch that needs no token or encryption key. */
function connect(extra: Record<string, unknown> = {}) {
  return new Request("http://test/api/sources", {
    method: "POST",
    body: JSON.stringify({ type: "slack", channelId: "C123", channelName: "#eng", ...extra }),
  });
}

/** The single scope path the route asked check() about. */
function checkedScope(): unknown {
  expect(vi.mocked(check)).toHaveBeenCalledTimes(1);
  return vi.mocked(check).mock.calls[0][1].scope;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.source.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.source.upsert).mockResolvedValue({
    id: "src_1",
    type: "slack",
    name: "#eng",
    scopePath: SCOPE_A,
    status: "active",
  } as never);
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({
      source: db.source,
      $executeRaw: vi.fn(),
      scope: { create: vi.fn().mockResolvedValue({ id: "scope_1" }) },
      grant: { create: vi.fn().mockResolvedValue({ id: "grant_1" }) },
    })) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/sources authorizes the scope the source lands in", () => {
  it("checks the requested scopePath, not the org root", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue({ id: "sc_a" } as never);

    const res = await POST(connect({ scopePath: SCOPE_A }));
    expect(res.status).toBe(201);
    expect(checkedScope()).toBe(SCOPE_A);
  });

  it("checks the scope a reconnected source already uses", async () => {
    vi.mocked(db.source.findUnique).mockResolvedValue({
      id: "src_1",
      orgId: ORG,
      scopePath: SCOPE_A,
    } as never);

    const res = await POST(connect());
    expect(res.status).toBe(201);
    expect(checkedScope()).toBe(SCOPE_A);
  });

  it("checks the new child of the org root a first connect mints", async () => {
    const res = await POST(connect());
    expect(res.status).toBe(201);
    // The label carries a random suffix, so pin the parent, which is what
    // decides the answer: only an org-root grant is an ancestor of this.
    expect(checkedScope()).toMatch(new RegExp(`^${ROOT}\\.eng_[0-9a-f]{6}$`));
  });

  it("creates the minted scope only after the check allows it", async () => {
    const order: string[] = [];
    vi.mocked(check).mockImplementation((async () => {
      order.push("check");
      return { allowed: true };
    }) as never);
    vi.mocked(db.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => {
      return fn({
        source: db.source,
        $executeRaw: vi.fn(),
        scope: {
          create: vi.fn(async () => {
            order.push("create-scope");
            return { id: "scope_1" };
          }),
        },
        grant: { create: vi.fn().mockResolvedValue({ id: "grant_1" }) },
      });
    }) as never);

    await POST(connect());
    expect(order).toEqual(["check", "create-scope"]);
  });
});

// Naming the destination scope is what makes a cross-scope move reachable for
// someone who is not an org-wide writer, so the scope a source LEAVES has to be
// authorized in the same change. Its content there is retired by the move.
describe("POST /api/sources authorizes the scope a moved source leaves", () => {
  const SCOPE_B = `${ROOT}.team_b`;

  beforeEach(() => {
    vi.mocked(db.scope.findUnique).mockResolvedValue({ id: "sc_a" } as never);
    vi.mocked(db.source.findUnique).mockResolvedValue({
      id: "src_1",
      orgId: ORG,
      scopePath: SCOPE_B,
    } as never);
  });

  it("checks both ends of the move", async () => {
    const res = await POST(connect({ scopePath: SCOPE_A }));
    expect(res.status).toBe(201);

    expect(vi.mocked(check).mock.calls.map((c) => c[1].scope)).toEqual([SCOPE_A, SCOPE_B]);
  });

  it("403s and retires nothing when the caller has no write on the old scope", async () => {
    vi.mocked(check).mockImplementation((async (_ctx: unknown, req: { scope?: string }) =>
      req.scope === SCOPE_B ? { allowed: false, reason: `no write grant on ${SCOPE_B}` } : { allowed: true }) as never);

    const res = await POST(connect({ scopePath: SCOPE_A }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `no write grant on ${SCOPE_B}` });
    expect(vi.mocked(retireSourceContent)).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.deleteMany)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
  });

  it("does not ask twice when the reconnect is not a move", async () => {
    vi.mocked(db.source.findUnique).mockResolvedValue({
      id: "src_1",
      orgId: ORG,
      scopePath: SCOPE_A,
    } as never);

    const res = await POST(connect({ scopePath: SCOPE_A }));
    expect(res.status).toBe(201);

    expect(vi.mocked(check).mock.calls.map((c) => c[1].scope)).toEqual([SCOPE_A]);
    expect(vi.mocked(retireSourceContent)).not.toHaveBeenCalled();
  });
});

describe("POST /api/sources still refuses a denied caller", () => {
  beforeEach(() => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant on scope" } as never);
  });

  it.each([
    ["a named scope", { scopePath: `${ROOT}.team_b` }],
    ["no scope at all", {}],
  ])("403s a connect into %s and writes nothing", async (_label, extra) => {
    const res = await POST(connect(extra));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no grant on scope" });
    expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
    expect(vi.mocked(retireSourceContent)).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.deleteMany)).not.toHaveBeenCalled();
  });

  it("does not reveal whether the requested scope exists", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(null as never);

    const res = await POST(connect({ scopePath: `${ROOT}.does_not_exist` }));

    // A 404 here would tell an unauthorized caller which scopes their org has.
    expect(res.status).toBe(403);
    expect(vi.mocked(db.scope.findUnique)).not.toHaveBeenCalled();
  });
});

describe("POST /api/sources rejects a scopePath it cannot safely check", () => {
  // check() casts its target to ::ltree. Before this route named a scope, the
  // caller's path only ever reached an equality lookup, so an unparseable one
  // was a harmless 404; now it has to be refused before the cast raises a 500.
  // Same defect class as items 05/22/27/34.
  it.each([
    ["a path with spaces", "org_1.team a"],
    ["a path with quotes", "org_1.team'a"],
    ["a label over the 1000-byte ltree limit", `org_1.${"a".repeat(1001)}`],
  ])("400s %s without calling check()", async (_label, scopePath) => {
    const res = await POST(connect({ scopePath }));

    expect(res.status).toBe(400);
    expect(vi.mocked(check)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
  });

  it("canonicalizes a padded scopePath so the checked and stored paths match", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue({ id: "sc_a" } as never);

    const res = await POST(connect({ scopePath: `  ${SCOPE_A}  ` }));
    expect(res.status).toBe(201);

    expect(checkedScope()).toBe(SCOPE_A);
    expect(vi.mocked(db.scope.findUnique)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_path: { orgId: ORG, path: SCOPE_A } } }),
    );
    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ scopePath: SCOPE_A }) }),
    );
  });
});
