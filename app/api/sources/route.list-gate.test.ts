// GET /api/sources refuses an unauthorized caller.
//
// Why this file exists: deleting the whole authorization gate
// on `GET /api/sources` (the check() call and its 403) left the entire suite
// green. The gate is present in shipped code — this is a coverage gap, not a
// live defect — but nothing asserted that an unauthorized caller cannot list an
// org's connected sources, so a future edit could drop it silently.
//
// This is the half that runs everywhere, including CI, where no database is
// provisioned. It pins the wiring: that GET asks check() at all, that it asks
// with the permission the route intends, and that a denial reaches no query.
// route.list-gate-live-sql.test.ts is the companion that proves, against real
// grants and real ltree, who that check() actually admits and refuses.
//
// Together they are the guard-removal differential: delete the gate and the
// denial cases below fail here without needing a database, while the live-SQL
// file shows what the missing gate would expose to a real unauthorized caller.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: { source: { findMany: vi.fn() } } }));
vi.mock("@/services/memory/source-page", () => ({
  pageSourceIds: vi.fn(async () => ({ ids: ["src_1"], total: 1, count: 1 })),
  pageOfSource: vi.fn(),
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/services/memory/source-retirement", () => ({ retireSourceContent: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { pageSourceIds } from "@/services/memory/source-page";
import { GET } from "./route";

/** The first page, as the panels ask for it. */
const LIST = new Request("http://localhost/api/sources?page=1");

const ORG = "org_1";

const rc = {
  org: { id: ORG },
  user: { id: "user_lister" },
  ctx: { orgId: ORG, actor: { type: "human", id: "user_lister", role: "member" } },
};

/** One row in the shape GET's own `select` returns. */
const row = {
  id: "src_1",
  type: "slack",
  externalId: "C123",
  name: "#eng",
  scopePath: `org_${ORG}.team_a`,
  status: "active",
  meta: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  _count: { files: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(db.source.findMany).mockResolvedValue([row] as never);
});

describe("GET /api/sources is gated", () => {
  it("asks check() for memory.write on the source list before returning anything", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);

    await GET(LIST);

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.write", target: "sources:list" });
  });

  it("403s when check() denies, surfacing the decision's own reason", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no write grant" } as never);

    const res = await GET(LIST);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "no write grant" });
  });

  // The leak this gate exists to prevent. A 403 that still ran the query would
  // be a 403 in name only: the row set is what the caller was refused, so it
  // must never be read, and the response must not carry it or its shape.
  it("never queries the sources table when check() denies", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no write grant" } as never);

    const res = await GET(LIST);

    expect(db.source.findMany).not.toHaveBeenCalled();
    expect(pageSourceIds).not.toHaveBeenCalled();
    await expect(res.json()).resolves.not.toHaveProperty("sources");
  });

  it("returns the org's sources when check() allows", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);

    const res = await GET(LIST);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { id: string }[] };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].id).toBe("src_1");
  });

  // The tenant half of the predicate, separate from the grant half: even an
  // allowed caller only ever sees rows filtered to their own org.
  it("scopes the query to the caller's org when check() allows", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);

    await GET(LIST);

    expect(db.source.findMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.source.findMany).mock.calls[0][0]).toMatchObject({
      where: { orgId: ORG },
    });
  });

  it("401s an unauthenticated caller without consulting check() or the database", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);

    const res = await GET(LIST);

    expect(res.status).toBe(401);
    expect(check).not.toHaveBeenCalled();
    expect(db.source.findMany).not.toHaveBeenCalled();
    expect(pageSourceIds).not.toHaveBeenCalled();
  });
});
