import { beforeEach, describe, expect, it, vi } from "vitest";

// UC6 pilot: GET /api/briefs/:id/staleness — "did memory change under this
// brief's scope after it was generated?" Deliberately org-scoped like
// GET /api/briefs/:id, not access.manage-gated like /api/audit, since the
// pilot's external grantee reading their own briefing shouldn't need that
// permission just to see the flag.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    brief: { findFirst: vi.fn() },
    // No provenance row: the scope fallback (services/memory/brief-staleness.ts) these tests pin.
    briefProvenance: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(),
    source: { findMany: vi.fn() },
  },
}));
// Real pathCovers (used internally by the route for source in-scope counts);
// check() and readableScopePaths() are mocked, same as every other route-level
// test that exercises the check() gate without a real grant/membership table
// behind it.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
  readableScopePaths: vi.fn(),
  // The cache stamp's own SQL is covered by scan-cache-coherence.realdb.test.ts; here
  // it is set per test, so the db.$queryRaw mock stays the change list alone.
  scopeCacheStamp: vi.fn(),
}));
// Contradiction detection is mocked for the same reason
// fact-governance-routes.test.ts mocks conflicts.ts/disputes.ts for the /correct
// route rather than letting guardedMemory.graph and a real LLM client run in a
// unit test — findScopeContradictions/fileSameTierScopeDisputes get their own
// dedicated coverage; this file only asserts the staleness route calls them
// correctly and gates them on `changed`.
vi.mock("@/services/facts/conflicts", () => ({ findScopeContradictions: vi.fn() }));
vi.mock("@/services/memory/scope-dispute-scan", () => ({ fileSameTierScopeDisputes: vi.fn() }));
vi.mock("@/services/memory/brief-citations", () => ({ checkBriefCitations: vi.fn(async () => []) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { AccessDeniedError, check, readableScopePaths, scopeCacheStamp } from "@/services/access";
import { checkBriefCitations } from "@/services/memory/brief-citations";
import { findScopeContradictions } from "@/services/facts/conflicts";
import { fileSameTierScopeDisputes } from "@/services/memory/scope-dispute-scan";
import { GET } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_1", role: "member" } },
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

// A grant covering the whole org root reads as "this actor can see
// everything" for the tests that aren't specifically about restricted
// visibility (the pre-fix behavior, now opt-in via an explicit fixture
// instead of the route's own unconditional default).
const grantOn = (path: string) => [path];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(db.source.findMany).mockResolvedValue([] as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(readableScopePaths).mockResolvedValue(grantOn("org_1"));
  vi.mocked(scopeCacheStamp).mockResolvedValue(STAMP_V1);
  vi.mocked(findScopeContradictions).mockResolvedValue([]);
  vi.mocked(fileSameTierScopeDisputes).mockResolvedValue([]);
});

const STAMP_V1 = { erasureEpoch: "0", changeCount: "1" };
const STAMP_V2 = { ...STAMP_V1, changeCount: "2" };

describe("GET /api/briefs/:id/staleness", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await GET(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(401);
  });

  it("404s when the brief doesn't exist in this org (tenant-scoped lookup)", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(null as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(404);
    expect(vi.mocked(db.brief.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: "brief_1", orgId: "org_1" },
    });
  });

  it("404s, same as an absent id, when check() denies the reader on the brief's own scope (items revoke-does-not-revoke-brief-access-20260919, brief-404-vs-403-existence-leak-20261001)", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" } as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "brief not found" });
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", scope: "org_1.engineering" });
  });

  it("returns each cited fact's status, checked at the brief's own scope", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    const citations = [
      { sectionIndex: 0, factId: "f1", factText: "Deploys go out on Tuesdays", status: "current" },
      { sectionIndex: 1, factId: "f2", factText: null, status: "gone" },
    ];
    vi.mocked(checkBriefCitations).mockResolvedValueOnce(citations as never);

    const res = await GET(new Request("http://t"), params("brief_1"));

    expect(res.status).toBe(200);
    expect((await res.json()).citations).toEqual(citations);
    expect(checkBriefCitations).toHaveBeenCalledWith(rc.ctx, {
      id: "brief_1",
      orgId: "org_1",
      scopePath: "org_1.engineering",
    });
  });

  it("404s, same as an absent id, when the citation check is denied after the brief check passed", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    vi.mocked(checkBriefCitations).mockRejectedValueOnce(
      new AccessDeniedError({ allowed: false, reason: "grant revoked" } as never),
    );

    const res = await GET(new Request("http://t"), params("brief_1"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "brief not found" });
  });

  it("reports unchanged when no writes/deletes landed under scope since createdAt", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      contradictions: [],
      citations: [],
      sources: { total: 0, inScope: 0, outOfScope: 0 },
    });
    // Gate C.2: unchanged means no scan at all, not a scan that happens to find nothing.
    expect(findScopeContradictions).not.toHaveBeenCalled();
  });

  it("flags changed and returns the diff when a write landed under scope after createdAt", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    const rows = [
      { action: "memory.write", target: "org_1.engineering.backend/fact", at: new Date("2026-09-16T00:00:00Z") },
    ];
    vi.mocked(db.$queryRaw).mockResolvedValue(rows as never);

    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.changed).toBe(true);
    // No provenance row: the brief falls back to its scope, so a write under it reads stale.
    expect([body.stale, body.staleBasis]).toEqual([true, "scope"]);
    expect(body.changes).toEqual(rows.map((r) => ({ ...r, at: r.at.toISOString() })));

    // The route now goes through db.$queryRaw (raw SQL, with real LIKE ...
    // ESCAPE for the two separator legs — see route.ts's own doc comment on
    // why Prisma's own `startsWith` can't express that). Tagged-template
    // mocks receive [strings, ...values]; assert on the bound values rather
    // than re-parsing the SQL text.
    const [, ...values] = vi.mocked(db.$queryRaw).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual([
      "org_1", // orgId
      new Date("2026-09-15T00:00:00Z"), // createdAt
      "org_1.engineering", // exact-scope leg
      "org\\_1.engineering.%", // escaped dot-descendant LIKE prefix (_ escaped)
      "org\\_1.engineering/%", // escaped slash-tagged LIKE prefix (_ escaped)
      "org_1.engineering/brief:brief_1", // self-write exclusion
      20, // MAX_CHANGES
    ]);
    // Gate C.2: changed==true means the scan runs, scoped to this brief.
    expect(findScopeContradictions).toHaveBeenCalledWith(rc.ctx, "org_1", "org_1.engineering");
  });

  it("Gate C.2 — surfaces a detected contradiction and files it, only when changed", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { action: "memory.write", target: "org_1.engineering/fact", at: new Date("2026-09-16T00:00:00Z") },
    ] as never);
    const found = [
      { factA: "deploy target is Vercel", factB: "deploy target is AWS ECS", note: "same decision, incompatible" },
    ];
    vi.mocked(findScopeContradictions).mockResolvedValue(found);
    vi.mocked(fileSameTierScopeDisputes).mockResolvedValue(["dispute_1"]);

    // Own brief id: the cache is real and keyed per brief, and the stamp is fixed per
    // test, so an earlier test's scan of brief_1 would otherwise be served here.
    const res = await GET(new Request("http://t"), params("brief_gate_c2"));
    const body = await res.json();
    expect(body.contradictions).toEqual(found);
    expect(fileSameTierScopeDisputes).toHaveBeenCalledWith(rc.ctx, "org_1", "org_1.engineering", found);
  });

  it("Gate C.2 cost guard — skips the scan when the changed-fact set is unchanged since the last view, re-scans once it moves", async () => {
    // Own brief id, unused by any other test in this file — the cache this
    // guard relies on is real (not mocked) and keyed per brief, so a shared id
    // would let an earlier test's cached result leak into this one.
    const briefId = "brief_cost_guard";
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    const v1 = [{ action: "memory.write", target: "org_1.engineering/fact-v1", at: new Date("2026-09-16T00:00:00Z") }];
    vi.mocked(db.$queryRaw).mockResolvedValue(v1 as never);
    const found = [{ factA: "deploy target is Vercel", factB: "deploy target is AWS ECS", note: "incompatible" }];
    vi.mocked(findScopeContradictions).mockResolvedValue(found);
    vi.mocked(fileSameTierScopeDisputes).mockResolvedValue(["dispute_1"]);

    const first = await GET(new Request("http://t"), params(briefId));
    expect((await first.json()).contradictions).toEqual(found);
    expect(findScopeContradictions).toHaveBeenCalledTimes(1);

    // Same brief, same changed-fact set on a repeat view — the LLM call and the
    // dispute filing must both be skipped, the whole point of the guard.
    const second = await GET(new Request("http://t"), params(briefId));
    expect((await second.json()).contradictions).toEqual(found);
    expect(findScopeContradictions).toHaveBeenCalledTimes(1);
    expect(fileSameTierScopeDisputes).toHaveBeenCalledTimes(1);

    // A genuinely new write under scope changes the fingerprint and must
    // invalidate the cache.
    vi.mocked(db.$queryRaw).mockResolvedValue([
      ...v1,
      { action: "memory.write", target: "org_1.engineering/fact-v2", at: new Date("2026-09-17T00:00:00Z") },
    ] as never);
    vi.mocked(scopeCacheStamp).mockResolvedValue(STAMP_V2);
    const third = await GET(new Request("http://t"), params(briefId));
    expect((await third.json()).contradictions).toEqual(found);
    expect(findScopeContradictions).toHaveBeenCalledTimes(2);
  });

  it("re-scans when only the org's removal epoch moved: an erasure or removal writes no change under the scope", async () => {
    const briefId = "brief_epoch_only";
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { action: "memory.write", target: "org_1.engineering/fact-v1", at: new Date("2026-09-16T00:00:00Z") },
    ] as never);
    vi.mocked(findScopeContradictions).mockResolvedValue([
      { factA: "Mara signs at 160k", factB: "Mara refuses", note: "n" },
    ]);
    await GET(new Request("http://t"), params(briefId));

    vi.mocked(scopeCacheStamp).mockResolvedValue({ ...STAMP_V1, erasureEpoch: "4" });
    vi.mocked(findScopeContradictions).mockResolvedValue([]);
    const after = await GET(new Request("http://t"), params(briefId));
    expect((await after.json()).contradictions).toEqual([]);
    expect(findScopeContradictions).toHaveBeenCalledTimes(2);
  });

  it("a cache hit records the audited memory.read on the scope's graph, and serves nothing when it is denied", async () => {
    const briefId = "brief_hit_audit";
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { action: "memory.write", target: "org_1.engineering/fact-v1", at: new Date("2026-09-16T00:00:00Z") },
    ] as never);
    const found = [{ factA: "deploy target is Vercel", factB: "deploy target is AWS ECS", note: "incompatible" }];
    vi.mocked(findScopeContradictions).mockResolvedValue(found);
    await GET(new Request("http://t"), params(briefId));
    expect(check).not.toHaveBeenCalledWith(rc.ctx, {
      action: "memory.read",
      scope: "org_1.engineering",
      target: "graph",
    });

    const hit = await GET(new Request("http://t"), params(briefId));
    expect((await hit.json()).contradictions).toEqual(found);
    expect(findScopeContradictions).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", scope: "org_1.engineering", target: "graph" });

    vi.mocked(check).mockImplementation(
      async (_ctx, req) => ({ allowed: !("target" in req && req.target === "graph"), reason: "test" }) as never,
    );
    const denied = await GET(new Request("http://t"), params(briefId));
    expect((await denied.json()).contradictions).toEqual([]);
    expect(findScopeContradictions).toHaveBeenCalledTimes(1);
  });
});

// Source visibility: "answered from N of M connected sources; K out of scope".
// A connected Source is in scope exactly
// when its own scopePath sits at or below the brief's granted scopePath, same
// ancestor-or-self relation check()/evaluate() use everywhere else.
describe("GET /api/briefs/:id/staleness — source visibility", () => {
  beforeEach(() => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
  });

  it("counts a source at the brief's exact scope as in scope", async () => {
    vi.mocked(db.source.findMany).mockResolvedValue([{ scopePath: "org_1.engineering" }] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 1, inScope: 1, outOfScope: 0 });
  });

  it("counts a descendant-scoped source as in scope", async () => {
    vi.mocked(db.source.findMany).mockResolvedValue([{ scopePath: "org_1.engineering.backend" }] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 1, inScope: 1, outOfScope: 0 });
  });

  it("counts a sibling scope that merely shares a prefix as out of scope", async () => {
    vi.mocked(db.source.findMany).mockResolvedValue([{ scopePath: "org_1.engineering2" }] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 1, inScope: 0, outOfScope: 1 });
  });

  it("counts an ancestor-scoped source (broader than the brief) as out of scope", async () => {
    vi.mocked(db.source.findMany).mockResolvedValue([{ scopePath: "org_1" }] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 1, inScope: 0, outOfScope: 1 });
  });

  it("mixes in-scope and out-of-scope sources into one count", async () => {
    vi.mocked(db.source.findMany).mockResolvedValue([
      { scopePath: "org_1.engineering" },
      { scopePath: "org_1.engineering.backend" },
      { scopePath: "org_1.sales" },
      { scopePath: "org_1.legal" },
      { scopePath: "org_1.hr" },
    ] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 5, inScope: 2, outOfScope: 3 });
  });

  it("excludes disconnected sources from the connected total", async () => {
    await GET(new Request("http://t"), params("brief_1"));
    const call = vi.mocked(db.source.findMany).mock.calls[0][0] as {
      where: { orgId: string; status: { not: string } };
    };
    expect(call.where.orgId).toBe("org_1");
    expect(call.where.status).toEqual({ not: "disconnected" });
  });
});

// Existence leak: total/
// outOfScope must never reflect a source in a scope this reader holds no
// grant on — same forbidden bare-existence-count class the memory/facts
// staleness-check route already withholds via skippedOutOfScope.
describe("GET /api/briefs/:id/staleness — source counts never leak past the reader's own grants", () => {
  beforeEach(() => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
  });

  it("drops an org-wide count to only the reader's own granted scope, never counting what they can't see", async () => {
    // Reader is granted only org_1.engineering (the brief's own scope), not
    // org root — this is the live repro's exact shape (a grantee narrowed to
    // one scope, denied everywhere else).
    vi.mocked(readableScopePaths).mockResolvedValue(grantOn("org_1.engineering"));
    vi.mocked(db.source.findMany).mockResolvedValue([
      { scopePath: "org_1.engineering" }, // visible, in scope
      { scopePath: "org_1.sales" }, // NOT covered by the reader's grant
      { scopePath: "org_1.hr" }, // NOT covered by the reader's grant
    ] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    // Pre-fix this would have been { total: 3, inScope: 1, outOfScope: 2 },
    // disclosing that org_1.sales/org_1.hr have connected sources at all.
    expect(body.sources).toEqual({ total: 1, inScope: 1, outOfScope: 0 });
  });

  it("still reports a genuinely visible out-of-scope source when the reader's own grant actually covers it", async () => {
    // Reader holds a broader grant (org root) that covers both the brief's
    // scope and a sibling scope — the sibling source is really visible to
    // this reader, so it's correctly counted as out of scope, not withheld.
    vi.mocked(readableScopePaths).mockResolvedValue(grantOn("org_1"));
    vi.mocked(db.source.findMany).mockResolvedValue([
      { scopePath: "org_1.engineering" },
      { scopePath: "org_1.sales" },
    ] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 2, inScope: 1, outOfScope: 1 });
  });

  it("reports all-zero, not an error, for a reader with no covering grant at all", async () => {
    vi.mocked(readableScopePaths).mockResolvedValue([]);
    vi.mocked(db.source.findMany).mockResolvedValue([
      { scopePath: "org_1.engineering" },
      { scopePath: "org_1.sales" },
    ] as never);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.sources).toEqual({ total: 0, inScope: 0, outOfScope: 0 });
  });
});
