// Leakage evals for the node-graph read: caller-supplied groupIds are validated
// against the scope check() authorized, a sibling scope never appears, and a
// denial returns no data at all rather than an empty-looking graph.
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

// Leak-scenario eval for the GRAPH READ path.
//
// access-leakage-eval.test.ts covers retrieve() and not this path: its fixture
// store stubs `graph` to `{ nodes: [], edges: [] }` (see its
// fixtureScopedStore), and app/api/memory/memory-routes.test.ts mocks
// `guardedMemory.graph` wholesale to test route plumbing. So the graph read —
// the one payload the graph explorer actually renders — gets its leak-scenario
// coverage here, on both sides of the gate.
//
// This is load-bearing because hover/zoom/select reveal any node NAME on
// demand. Degree-based label thinning is not an access-control boundary (the
// whole payload is already in client state either way), so the safety premise
// is that the payload reaching the browser is genuinely scope-filtered. This
// file pins that premise.
//
// Seam under test: the real (unmocked) GuardedMemoryStore.graph() —
// services/memory/guarded-store.ts:288 — wired to a fixture store whose
// graph() models memory-service/app/graphiti_client.py's real
// `graph_for_group` Cypher (L232-249): a node is returned when
// `n.group_id IN $gids`, and an edge only when `r.group_id IN $gids AND
// m.group_id IN $gids`. Both ends and the edge are filtered; there is no
// multi-hop traversal to widen the set. Only check()'s DB lookup is mocked
// (same pattern as access-leakage-eval.test.ts).

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    scope: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_test_id" }),
      update: vi.fn(),
    },
  },
}));

// For the route-level cases at the bottom: the real GET handler needs a request
// context and a guarded store. The store here is a REAL GuardedMemoryStore over
// the same fixture, not a mock of it — mocking `guardedMemory` (as
// app/api/memory/memory-routes.test.ts does) is exactly what left route assembly
// untested.
vi.mock("@/lib/access-context", () => ({
  requireAccessContext: vi.fn(),
}));
// The route is imported dynamically inside its test, so this factory runs after
// module init; `routeStoreRef.current` is populated by then. A getter keeps the
// lookup lazy either way.
const routeStoreRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore: G } = await import("./guarded-store");
  const { MemoryServiceError: E } = await import("./graphiti-store");
  return {
    get guardedMemory() {
      return new G(routeStoreRef.current as never);
    },
    MemoryServiceError: E,
  };
});

import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { AccessDeniedError, orgRootPath, type AccessContext, type Permission } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { GraphInput, MemoryGraph } from "@/types/memory";

// The bare org id, NOT the org's root scope path. Those are two different
// strings in production and the difference is load-bearing for groupIds
// validation: a real org id is a cuid and `orgRootPath()` prepends `org_` to
// it, so every real `scopes` row is rooted at `org_<orgId>` while the bare org
// id itself — what app/api/memory/graph/route.ts passes as `groupId`, and the
// partition untagged content lands in — is not under that root at all.
//
// A fixture that sets ORG_ID to "org_1" and writes its scope paths as
// "org_1.dealA" quietly conflates the two: `orgRootPath("org_1")` is
// "org_org_1", so those paths are NOT rooted under the fixture's own org root,
// and the org-root aggregate case stops covering its own descendant scopes once
// containment is checked against `orgRootPath(ctx.orgId)`. Keeping ORG_ID as
// the bare id ("1") makes `orgRootPath(ORG_ID)` exactly "org_1", so every
// scope path below is genuinely rooted under it — the production shape.
const ORG_ID = "1";

// Fixture graph: one org, two sibling deals, each with a descendant "notes"
// scope. Every node name carries its own scope so a leak is obvious in the
// failure message — a leaked *name* is precisely what hover puts on screen.
interface FixtureEntity {
  uuid: string;
  name: string;
  type: string;
  groupId: string;
}
interface FixtureRel {
  uuid: string;
  source: string;
  target: string;
  fact: string;
  groupId: string;
}

const ENTITIES: FixtureEntity[] = [
  { uuid: "e-dealA-alice", name: "Alice Kim", type: "Person", groupId: "org_1.dealA" },
  { uuid: "e-dealA-acct", name: "Northwind Traders", type: "Account", groupId: "org_1.dealA" },
  { uuid: "e-dealA-note", name: "Section 4 redline", type: "Document", groupId: "org_1.dealA.notes" },
  { uuid: "e-dealB-priya", name: "Priya Rao", type: "Person", groupId: "org_1.dealB" },
  { uuid: "e-dealB-comp", name: "Acme Corporation", type: "Account", groupId: "org_1.dealB" },
  { uuid: "e-dealB-note", name: "Churn risk memo", type: "Document", groupId: "org_1.dealB.notes" },
  // Untagged/bare-org content (no scopePath at ingest), the same class the
  // bare-org fallback serves — reachable only by the org-root aggregate view,
  // and only for a caller whose checked scope genuinely covers org root.
  { uuid: "e-org-root-doc", name: "Org onboarding checklist", type: "Document", groupId: ORG_ID },
];

const RELS: FixtureRel[] = [
  {
    uuid: "r-dealA-1",
    source: "e-dealA-alice",
    target: "e-dealA-acct",
    fact: "Alice Kim is the champion at Northwind Traders",
    groupId: "org_1.dealA",
  },
  {
    uuid: "r-dealA-2",
    source: "e-dealA-acct",
    target: "e-dealA-note",
    fact: "Northwind Traders' MSA has a section 4 redline",
    groupId: "org_1.dealA.notes",
  },
  {
    uuid: "r-dealB-1",
    source: "e-dealB-priya",
    target: "e-dealB-comp",
    fact: "Priya Rao is evaluating Acme Corporation",
    groupId: "org_1.dealB",
  },
  {
    uuid: "r-dealB-2",
    source: "e-dealB-comp",
    target: "e-dealB-note",
    fact: "Acme Corporation deal has churn risk",
    groupId: "org_1.dealB.notes",
  },
];

/**
 * Fixture store whose graph() mirrors graphiti_client.py's graph_for_group
 * (L232-249) rather than inventing a filter of its own:
 *   MATCH (n:Entity) WHERE n.group_id IN $gids            -> node filter
 *   OPTIONAL MATCH (n)-[r]->(m) WHERE r.group_id IN $gids
 *                              AND m.group_id IN $gids    -> edge + far-node filter
 * One hop, both ends filtered. Deliberately NOT a pass-through: if
 * GuardedMemoryStore forwards the wrong partition keys, this store will
 * happily return the sibling deal, which is the leak the test asserts against.
 */
function fixtureGraphStore(): MemoryStore {
  const graph = vi.fn(async (input: GraphInput): Promise<MemoryGraph> => {
    const gids = input.groupIds ?? [input.groupId];
    const inScope = (gid: string) => gids.includes(gid);
    const nodes = ENTITIES.filter((e) => inScope(e.groupId));
    const nodeIds = new Set(nodes.map((n) => n.uuid));
    const edges = RELS.filter((r) => inScope(r.groupId) && nodeIds.has(r.source) && nodeIds.has(r.target));
    return {
      nodes: nodes.map((n) => ({ uuid: n.uuid, name: n.name, type: n.type })),
      edges: edges.map((r) => ({ uuid: r.uuid, source: r.source, target: r.target, fact: r.fact })),
    };
  });
  return {
    ingest: vi.fn(),
    retrieve: vi.fn(),
    entity: vi.fn().mockResolvedValue(null),
    graph,
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

/** Stub check()'s DB lookup: a covering grant row, or none (default deny). */
const allow = (permission: "read" | "write" | "admin" = "read", agentId?: string) =>
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission, agentId }] as never);
const deny = () => vi.mocked(db.$queryRaw).mockResolvedValue([] as never);

const humanCtx: AccessContext = {
  orgId: ORG_ID,
  actor: { type: "human", id: "user_1", role: "member" },
  origin: "app",
};

/**
 * Assert none of `leaked` appears in the graph — by node uuid, by node NAME,
 * and by edge fact text. The name check is the one hover makes matter: a
 * revealed label draws `n.name`, so a leak that kept the uuid out but shipped
 * the name would still put the string on a user's screen.
 */
function assertNoLeak(graph: MemoryGraph, leaked: FixtureEntity[], leakedRels: FixtureRel[]) {
  const ids = new Set(graph.nodes.map((n) => n.uuid));
  const names = graph.nodes.map((n) => n.name).join(" | ");
  const facts = graph.edges.map((e) => e.fact).join(" | ");
  for (const l of leaked) {
    expect(ids.has(l.uuid), `leaked node id ${l.uuid} present`).toBe(false);
    expect(names, `leaked node NAME "${l.name}" present (the graph view draws names on hover)`).not.toContain(l.name);
  }
  for (const r of leakedRels) {
    expect(
      graph.edges.some((e) => e.uuid === r.uuid),
      `leaked edge ${r.uuid} present`,
    ).toBe(false);
    expect(facts, `leaked edge fact "${r.fact}" present`).not.toContain(r.fact);
  }
}

const dealBEntities = ENTITIES.filter((e) => e.groupId.startsWith("org_1.dealB"));
const dealBRels = RELS.filter((r) => r.groupId.startsWith("org_1.dealB"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
});

describe("graph read — sibling-scope leakage", () => {
  it("a Deal A-scoped read never returns Deal B nodes, names, or edges", async () => {
    const guarded = new GuardedMemoryStore(fixtureGraphStore());
    allow("read");

    // Exactly what app/api/memory/graph/route.ts builds for ?scope=org_1.dealA:
    // the scope itself plus its descendants, never a sibling.
    const graph = await guarded.graph(
      humanCtx,
      { groupId: ORG_ID, groupIds: ["org_1.dealA", "org_1.dealA.notes"], limit: 300 },
      "org_1.dealA",
    );

    // Scope-completeness: the in-scope content really is returned, so a leak
    // assertion below can't pass by returning nothing.
    expect(graph.nodes.map((n) => n.uuid).sort()).toEqual(["e-dealA-acct", "e-dealA-alice", "e-dealA-note"]);
    expect(graph.edges.map((e) => e.uuid).sort()).toEqual(["r-dealA-1", "r-dealA-2"]);

    assertNoLeak(graph, dealBEntities, dealBRels);
  });

  it("defaults the partition key to the CHECKED scope, not the bare org id", async () => {
    // guarded-store.ts:301-302 — `const groupId = scope ?? input.groupId` and
    // `groupIds: input.groupIds ?? [groupId]`. This is the line the safety
    // premise rests on: if the default fell back to the bare org id, a
    // narrow-scope caller would receive the whole org's graph, and every one
    // of those names is revealable by hover.
    const store = fixtureGraphStore();
    const guarded = new GuardedMemoryStore(store);
    allow("read");

    const graph = await guarded.graph(humanCtx, { groupId: ORG_ID, limit: 300 }, "org_1.dealA");

    expect(vi.mocked(store.graph).mock.calls[0][0]).toMatchObject({
      groupId: "org_1.dealA",
      groupIds: ["org_1.dealA"],
    });
    expect(graph.nodes.map((n) => n.uuid).sort()).toEqual(["e-dealA-acct", "e-dealA-alice"]);
    assertNoLeak(graph, dealBEntities, dealBRels);
  });

  it("an agent capability token scoped to Deal A never surfaces Deal B", async () => {
    const guarded = new GuardedMemoryStore(fixtureGraphStore());
    const agentCtx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const graph = await guarded.graph(
      agentCtx,
      { groupId: ORG_ID, groupIds: ["org_1.dealA", "org_1.dealA.notes"], limit: 300 },
      "org_1.dealA",
    );

    expect(graph.nodes.map((n) => n.uuid)).toContain("e-dealA-alice");
    assertNoLeak(graph, dealBEntities, dealBRels);
  });
});

// ---------------------------------------------------------------------------
// Caller-supplied groupIds are validated against the checked scope. Every case
// above hands guarded.graph() a `groupIds` array that already agrees with the
// checked `scope` — production's one real caller
// (app/api/memory/graph/route.ts) builds it that way. These pin what happens
// when it DOESN'T agree: if guarded-store.ts forwarded `input.groupIds` to the
// store unvalidated, a caller (or a future route/MCP tool that builds groupIds
// from request input) could tack a sibling scope's real groupId onto the list
// and receive its content back under an audit row that only ever named the
// narrow `scope` check() actually authorized. These cases drive the real
// GuardedMemoryStore.graph() (not a mock of it) and assert the sibling
// content never reaches the store call, not just that it's absent from the
// response.
// ---------------------------------------------------------------------------

describe("graph read — caller-supplied groupIds validated against the checked scope", () => {
  it("drops a caller-supplied sibling-scope groupId instead of silently honoring it", async () => {
    const store = fixtureGraphStore();
    const guarded = new GuardedMemoryStore(store);
    allow("read");

    // A caller checked (and only checked) for Deal A also lists Deal B's real
    // groupIds on the same call. check() only ever sees `scope`, so the guard
    // is the only thing that stops groupIds from carrying more than what was
    // actually authorized.
    const graph = await guarded.graph(
      humanCtx,
      {
        groupId: ORG_ID,
        groupIds: ["org_1.dealA", "org_1.dealA.notes", "org_1.dealB", "org_1.dealB.notes"],
        limit: 300,
      },
      "org_1.dealA",
    );

    // The invalid entries never even reach the store's own query — the
    // guarantee lives in the guard itself, which is stronger than only
    // checking what came back.
    expect(vi.mocked(store.graph).mock.calls[0][0].groupIds).toEqual(["org_1.dealA", "org_1.dealA.notes"]);

    // Scope-completeness: the real, legitimately-requested descendant scope is
    // untouched, so the leak assertion below can't be passing because nothing
    // came back at all.
    expect(graph.nodes.map((n) => n.uuid).sort()).toEqual(["e-dealA-acct", "e-dealA-alice", "e-dealA-note"]);
    expect(graph.edges.map((e) => e.uuid).sort()).toEqual(["r-dealA-1", "r-dealA-2"]);
    assertNoLeak(graph, dealBEntities, dealBRels);
  });

  it("falls back to the checked scope alone when every caller-supplied groupId is invalid", async () => {
    const store = fixtureGraphStore();
    const guarded = new GuardedMemoryStore(store);
    allow("read");

    // Not one entry in this list is the checked scope or a real descendant of
    // it (a sibling deal, and a different org entirely) — degrade to exactly
    // what an omitted `groupIds` would have produced, the same read-direction
    // fallback convention a malformed ?scope= uses, rather than querying an
    // empty partition set or forwarding any of it.
    const graph = await guarded.graph(
      humanCtx,
      { groupId: ORG_ID, groupIds: ["org_1.dealB", "org_2.other"], limit: 300 },
      "org_1.dealA",
    );

    expect(vi.mocked(store.graph).mock.calls[0][0].groupIds).toEqual(["org_1.dealA"]);
    expect(graph.nodes.map((n) => n.uuid).sort()).toEqual(["e-dealA-acct", "e-dealA-alice"]);
    assertNoLeak(graph, dealBEntities, dealBRels);
  });
});

describe("graph read — denial returns no data at all", () => {
  it("denies (and returns nothing) when no grant covers the requested scope", async () => {
    const store = fixtureGraphStore();
    const guarded = new GuardedMemoryStore(store);
    deny();

    await expect(
      guarded.graph(
        humanCtx,
        { groupId: ORG_ID, groupIds: ["org_1.dealB", "org_1.dealB.notes"], limit: 300 },
        "org_1.dealB",
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // The store is never reached, so no payload exists to be revealed.
    expect(store.graph).not.toHaveBeenCalled();
  });

  it("denies a cross-tenant group id before the gate (tenant safety net)", async () => {
    const store = fixtureGraphStore();
    const guarded = new GuardedMemoryStore(store);
    allow("read"); // even WITH a grant row, the tenant net must refuse

    await expect(guarded.graph(humanCtx, { groupId: "org_2", limit: 300 }, "org_2.dealX")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(store.graph).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route assembly — the seam the cases above deliberately do NOT cover.
//
// Everything above hands GuardedMemoryStore.graph() a checked scope and a
// groupIds list that already agree with each other. Production doesn't: the
// route derives BOTH from the same request parameter, and these cases pin that
// they stay the same value. app/api/memory/graph/route.ts reads `?scope=` and
// makes it `groupIds[0]` verbatim, while the same string is what gets gated by
// check(). If a later edit gated one scope and partitioned on another, every
// case above stays green and sibling data reaches the store. These cases drive
// the real GET handler over a real GuardedMemoryStore so that divergence fails
// loudly.
// ---------------------------------------------------------------------------

describe("graph route — checked scope and partition key cannot diverge", () => {
  async function callRoute(url: string, storeImpl: MemoryStore) {
    routeStoreRef.current = storeImpl;
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG_ID } as never,
      user: { id: "user_1" } as never,
      ctx: humanCtx,
    });
    const { GET } = await import("@/app/api/memory/graph/route");
    return GET(new Request(url));
  }

  /** The route's own descendant lookup is the first `$queryRaw`; check()'s
   * grant lookup comes after it. */
  const descendantsThen = (paths: string[], grants: () => void) => {
    grants();
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(paths.map((path) => ({ path })) as never);
  };

  it("answers 503, not the selected scope alone, when the scopes below it cannot be listed", async () => {
    const store = fixtureGraphStore();
    allow("read");
    vi.mocked(db.$queryRaw).mockRejectedValueOnce(new Error("connection reset"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await callRoute("http://t/api/memory/graph?scope=org_1.dealA&limit=300", store);

    expect(res.status).toBe(503);
    expect(store.graph).not.toHaveBeenCalled();
  });

  it("a scoped request gates and partitions on the SAME value, and leaks nothing", async () => {
    const store = fixtureGraphStore();
    // The descendant lookup the route makes for `?scope=org_1.dealA`.
    descendantsThen(["org_1.dealA.notes"], () => allow("read"));

    const res = await callRoute("http://t/api/memory/graph?scope=org_1.dealA&limit=300", store);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemoryGraph;

    // The invariant: whatever check() gated is exactly what partitions the read.
    // guarded-store.ts sets `groupId = scope ?? input.groupId`, i.e. the CHECKED
    // scope, so comparing it to groupIds[0] compares gate against partition.
    const forwarded = vi.mocked(store.graph).mock.calls[0][0];
    expect(forwarded.groupIds?.[0]).toBe("org_1.dealA");
    expect(forwarded.groupId).toBe(forwarded.groupIds?.[0]);
    expect(forwarded.groupIds).toEqual(["org_1.dealA", "org_1.dealA.notes"]);

    // And end to end, through the real route, no sibling content comes back.
    expect(body.nodes.map((n) => n.uuid).sort()).toEqual(["e-dealA-acct", "e-dealA-alice", "e-dealA-note"]);
    assertNoLeak(body, dealBEntities, dealBRels);
  });

  it("returns 403 and reaches no store when the gate denies the requested scope", async () => {
    const store = fixtureGraphStore();
    descendantsThen(["org_1.dealB.notes"], deny);

    const res = await callRoute("http://t/api/memory/graph?scope=org_1.dealB&limit=300", store);

    expect(res.status).toBe(403);
    expect(store.graph).not.toHaveBeenCalled();
  });

  // This route applies normalizeScopePath()/isValidLtreePath() like every other
  // scope-accepting route (qa/run-interactive/run-manager). Without it, a
  // malformed ?scope= reaches check()'s `::ltree` cast raw, throwing before
  // recordAudit() runs (an unaudited failed access), and is ALSO the raw value
  // route.ts forwards verbatim as groupIds[0], with only check()'s own gate
  // constraining it.
  it("a malformed ?scope= is discarded before check() and the read still gates + audits, at the org root", async () => {
    const store = fixtureGraphStore();
    allow("read");
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([{ path: "org_1.dealA" }, { path: "org_1.dealB" }] as never);

    // A space is genuinely invalid ltree syntax (42601) — the same MALFORMED
    // exemplar the write-direction guard tests use. URLSearchParams decodes
    // %20 to a literal space.
    const res = await callRoute("http://t/api/memory/graph?scope=org_1.deal%20A&limit=300", store);

    // Unguarded, this reaches check()'s `::ltree` cast raw and the route
    // surfaces a raw 500 with zero audit row. The read direction discards it
    // back to undefined, so the request falls back to the org-root aggregate
    // view instead of throwing.
    expect(res.status).toBe(200);

    // The malformed string never reaches the store as a partition key, and the
    // partition key stays the checked (org-root) value, not the raw input.
    const forwarded = vi.mocked(store.graph).mock.calls[0][0];
    expect(forwarded.groupIds).not.toContain("org_1.deal A");
    expect(forwarded.groupId).toBe(ORG_ID);

    // And the read is still audited normally — recordAudit() actually ran,
    // proving the raw-throw-before-audit half of the defect is closed, not
    // just silenced by returning early.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: ORG_ID,
          action: "memory.read",
          decision: "allow",
          target: expect.stringContaining("graph"),
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Two gaps the case above cannot close on its own, visible by mutating the
// guard away and watching WHICH assertion moves.
//
// 1. It cannot prove the headline claim. Delete `if (scope &&
//    !isValidLtreePath(scope)) scope = undefined;` from route.ts and that case
//    goes red — but on `groupIds`, never on `expect(res.status).toBe(200)`.
//    The status assertion holds either way, because `db.$queryRaw` is a plain
//    `mockResolvedValue` there: the `${targetPath}::ltree` cast inside
//    evaluate() is mocked out, so the malformed value can reach check()
//    without anything throwing. The partition-key half is pinned; the
//    "unaudited raw 500" half needs the cast modelled.
//
// 2. Nothing pins what the org-root fallback does for a caller who is NOT
//    authorized at the org root. "Bad scope filters show all scopes" is a
//    behavior concern rather than a leak for exactly one reason, and that
//    reason should ride on an assertion, not on reading check() and agreeing.
//
// The oracle below is deliberately NOT isValidLtreePath(): testing the guard
// with the guard's own predicate is a tautology. It is Postgres's ltree
// grammar — `SELECT 'org_1.deal A'::ltree` raises 42601 "ltree syntax error at
// character 11" (ltree_io.c, parse_ltree), and the same error comes back from
// the `'org_1'::ltree @> 'org_1.deal A'::ltree` shape evaluate() itself
// builds, while `'org_1.dealA'::ltree` casts fine.
// ---------------------------------------------------------------------------

/** Postgres's own ltree label grammar, written from the 42601 behaviour
 * above rather than imported from the code under test. */
const PG_LTREE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * Stub check()'s DB lookup the way the real database behaves: both queries in
 * evaluate() interpolate `targetPath` LAST and cast it with `::ltree`, so a
 * malformed target raises before any row comes back — and, critically, before
 * check() ever reaches recordAudit(). `grants` = the rows to return when the
 * cast succeeds ([] for default deny).
 */
const stubDbWithRealLtreeCast = (grants: { permission: Permission }[]) =>
  vi.mocked(db.$queryRaw).mockImplementation((async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const targetPath = values[values.length - 1];
    if (typeof targetPath !== "string" || !PG_LTREE.test(targetPath)) {
      throw Object.assign(new Error(`ltree syntax error at character 11`), { code: "42601" });
    }
    return grants;
  }) as never);

describe("graph route — a malformed ?scope= is audited, not thrown past", () => {
  async function callRoute(url: string, storeImpl: MemoryStore) {
    routeStoreRef.current = storeImpl;
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG_ID } as never,
      user: { id: "user_1" } as never,
      ctx: humanCtx,
    });
    const { GET } = await import("@/app/api/memory/graph/route");
    return GET(new Request(url));
  }

  it("never reaches the ::ltree cast with the malformed value, so recordAudit() runs and the row exists", async () => {
    const store = fixtureGraphStore();
    stubDbWithRealLtreeCast([{ permission: "read" }]);
    // Real scope rows are rooted under orgRootPath(orgId) (app/api/access/
    // scopes/route.ts, app/api/sources/route.ts), not the bare org id — the
    // groupIds containment check (guarded-store.ts's graph()) validates
    // against that real shape, so this mock has to match it or the org-root
    // aggregate's own real descendant scopes would be (wrongly) treated as
    // outside containment.
    const rootedDealA = `${orgRootPath(ORG_ID)}.dealA`;
    const rootedDealB = `${orgRootPath(ORG_ID)}.dealB`;
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([{ path: rootedDealA }, { path: rootedDealB }] as never);

    const res = await callRoute("http://t/api/memory/graph?scope=org_1.deal%20A&limit=300", store);

    // Unguarded, this is where the defect showed: evaluate()'s cast throws,
    // the route's catch handles only AccessDeniedError/MemoryServiceError, and
    // the request dies as a raw 500 with NO audit row for the attempt.
    expect(res.status).toBe(200);

    // The audit row is the actual deliverable — an attempted access that
    // leaves no trace is the gap, whether or not data moved.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: ORG_ID,
          actorId: "user_1",
          action: "memory.read",
          decision: "allow",
        }),
      }),
    );

    // Scope-completeness: the fallback really did serve the org-root
    // aggregate, so the assertions above can't be passing on an empty response
    // that never reached the store. Also proves the groupIds containment check
    // doesn't over-reject: both real (rooted) descendant scopes AND the bare
    // org id (untagged content, gated on the caller's checked scope genuinely
    // covering org root, which it does here — no ?scope= means check()
    // authorized orgRootPath(ORG_ID) itself) survive.
    const forwarded = vi.mocked(store.graph).mock.calls[0][0];
    expect(forwarded.groupId).toBe(ORG_ID);
    // The root scope itself is asked too: its content is its own partition.
    expect(forwarded.groupIds).toEqual([ORG_ID, orgRootPath(ORG_ID), rootedDealA, rootedDealB]);

    // Assert the aggregate's real CONTENT, not just that something came back.
    // `nodes.length > 0` is satisfied by the bare-org doc alone, so it stays
    // green even when the containment check silently drops BOTH descendant
    // scopes and the aggregate collapses to one untagged node — the exact
    // over-rejection this test is the only content-level guard against.
    // Naming the uuids makes the completeness claim above falsifiable: a
    // containment predicate that over-rejects real rooted descendants fails
    // here instead of passing on a technicality.
    const body = (await res.json()) as MemoryGraph;
    expect(body.nodes.map((n) => n.uuid).sort()).toEqual([
      "e-dealA-acct",
      "e-dealA-alice",
      "e-dealB-comp",
      "e-dealB-priya",
      "e-org-root-doc",
    ]);
  });

  it("the org-root fallback still defaults to DENY: an ungranted caller gets 403, not the aggregate", async () => {
    // "Bad scope filters show all scopes" is a real description of the
    // fallback, and it is a BEHAVIOR concern, not a leak, for exactly one
    // reason: the widened target is still gated. A caller who
    // could not have read the org root by omitting ?scope= cannot reach it by
    // sending a malformed one either. That reason is pinned here rather than
    // inferred from check().
    const store = fixtureGraphStore();
    stubDbWithRealLtreeCast([]); // no covering grant
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([{ path: "org_1.dealA" }, { path: "org_1.dealB" }] as never);

    const res = await callRoute("http://t/api/memory/graph?scope=org_1.deal%20A&limit=300", store);

    expect(res.status).toBe(403);
    expect(store.graph).not.toHaveBeenCalled();

    // And the denial is itself audited, at the target actually evaluated.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decision: "deny", orgId: ORG_ID }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// What the route forwards besides the scope: the search text and the page size.
// The memory service narrows its node window to ?query= and caps it at `limit`;
// with no limit it falls back to its own 50, which in a crowded scope hides the
// fact a user is looking for, so the route always names one.
// ---------------------------------------------------------------------------

describe("graph route — forwards ?query= and a bounded node limit", () => {
  async function forwarded(url: string) {
    const store = fixtureGraphStore();
    routeStoreRef.current = store;
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG_ID } as never,
      user: { id: "user_1" } as never,
      ctx: humanCtx,
    });
    allow("read");
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([] as never);
    const { GET } = await import("@/app/api/memory/graph/route");
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    return vi.mocked(store.graph).mock.calls[0][0];
  }

  it("passes the trimmed query through to the store", async () => {
    const input = await forwarded("http://t/api/memory/graph?query=%20Acme%20renewal%20");
    expect(input.query).toBe("Acme renewal");
  });

  it("asks for 300 nodes when no limit is given, not the service's 50", async () => {
    expect((await forwarded("http://t/api/memory/graph")).limit).toBe(300);
    expect((await forwarded("http://t/api/memory/graph?limit=abc")).limit).toBe(300);
    expect((await forwarded("http://t/api/memory/graph?limit=0.5")).limit).toBe(300);
  });

  it("caps the limit at 500 and sends a whole number", async () => {
    expect((await forwarded("http://t/api/memory/graph?limit=10000")).limit).toBe(500);
    expect((await forwarded("http://t/api/memory/graph?limit=120.7")).limit).toBe(120);
  });
});
