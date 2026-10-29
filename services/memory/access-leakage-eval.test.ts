// Leakage evals for GuardedMemoryStore reads: a caller scoped to one branch of
// the scope tree must never see a sibling's facts, and the audit row must name
// exactly the fact ids that were returned. Fixtures mirror the real two-backend
// call shape (tenantId + scopePath, not groupId alone) so a pass means the real
// predicate held, not the fixture's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
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

// Access-control leakage eval — the highest-value eval case: an agent must
// never surface a fact outside its capability token's granted scope.
//
// check()'s own ltree containment logic (grant/capability → allow/deny) is
// already unit-tested in services/access/check.test.ts and live-verified against
// real Postgres ltree in scripts/check-access.ts. Neither of those asks the next
// question: once check() ALLOWS a narrow-scoped read, does the DATA that comes
// back actually stay inside that scope? A correct allow/deny decision on the
// *gate* says nothing about whether the *facts* returned past that gate leak
// content from a sibling or ancestor scope — that's a distinct failure mode and
// the one this file targets.
//
// Seam under test: the real (unmocked) GuardedMemoryStore.retrieve() — services/
// memory/guarded-store.ts — wired, in most cases, to a fixture "memory graph"
// whose fake retrieve() models the real TWO-LEG hybrid shape (hybrid-store.ts):
// a Graphiti leg keyed on an EXACT `groupId` match (graphiti-store.ts's
// `retrieve()`, no containment of its own) plus a pgvector leg keyed on
// `scopePath` containment (services/memory/pgvector-store.ts, the
// `scopePath = X OR scopePath LIKE 'X.%' OR scopePath IS NULL` clause). Both
// axes matter: `groupId` is the actual Graphiti partition key GuardedMemoryStore
// forwards (its own bare-org fallback retry depends on it), and a fixture that
// only modeled `scopePath` couldn't tell a correct read from one whose Graphiti
// partition key had silently moved — see visibleFacts() below. That fixture
// proves GuardedMemoryStore forwards both correctly to whatever store it's
// given, but it does NOT exercise pgvector-store.ts's actual SQL — a
// dedicated case below (`production SQL filter (pgvector)`) wires the real
// PgvectorMemoryStore in and pins the exact WHERE clause + bound parameters it
// sends, so a regression in the real filter can't sail through this file green.
// Only the DB layer behind check() (and, for that dedicated case, the pgvector
// query itself + the embedding fetch) is mocked (same pattern as
// services/memory/access-flow.test.ts).
//
// Each case: a narrow-scope caller, a fixture memory graph with facts both inside
// and outside that scope, and an assertion that the caller's output contains zero
// facts (by id AND by content substring) from outside its granted scope.

vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    // retrieve() sends its SELECT in one transaction with the index's probe count.
    $executeRawUnsafe: vi.fn(),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_test_id" }),
      update: vi.fn(),
    },
  },
}));
// The descendant lookup. Defaults to no registered descendant scopes; Case 6
// below overrides it per-test.
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));

// mcp/tools.ts (used by the MCP-gap case below) pulls in guardedMemory's default
// store singleton and the Inngest ingest pipeline. Mock both at the module
// boundary, same reasoning as access-flow.test.ts's "./store" mock: neither
// should try to boot a real backend or the LLM/resolver chain at import time.
vi.mock("./store", () => ({
  memory: {
    retrieve: vi.fn(),
    entity: vi.fn(),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  },
}));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { toGid } from "./graphiti-store";
import { PgvectorMemoryStore } from "./pgvector-store";
import { memory } from "./store";
import { registerWillderTools } from "@/mcp/tools";
import { AccessDeniedError, orgRootPath, type AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact, SearchInput } from "@/types/memory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The BARE org id — what `ctx.orgId`/`input.groupId` carry — NOT a scope path.
 * In production a real org id is a cuid and `orgRootPath()` prepends `org_` to
 * it, so every real `scopes` row is rooted at `org_<orgId>`. Keeping the bare
 * id un-path-shaped here is load-bearing, not cosmetic: a fixture that sets
 * `ORG_ID = "org_1"` while writing its scope paths as `org_1.*` silently makes
 * the bare org id read as an ancestor of its own deals and makes
 * `orgRootPath(ORG_ID)` ("org_org_1") a namespace that covers nothing in the
 * fixture at all. That conflation leaves `pathCovers`'s ARGUMENT DIRECTION
 * unexercised — the untagged-visibility gate is
 * `pathCovers(scope ?? orgRootPath(orgId), orgRootPath(orgId))`, and with a
 * narrow scope that isn't under its own org root, reversing those two arguments
 * returns false either way, so every case here would pass on a reversal that in
 * production reopens the bare-org leak. With the bare id kept bare,
 * `orgRootPath(ORG_ID)` is `org_1` and every scope below is a genuine
 * descendant of it, the real production shape — so a reversed gate fails red.
 */
const ORG_ID = "1";
/** A second tenant, same shape — used only by the cross-tenant case. */
const OTHER_ORG_ID = "2";
/** The org's real root scope path, the shape a root capability token actually
 * carries (`resolveCallerScopePath`'s own `?? orgRootPath(orgId)` fallback). */
const ORG_ROOT = orgRootPath(ORG_ID);
/** Scope paths DERIVED from the org root rather than hardcoded, so they are
 * structurally descendants of it and cannot drift back into the bare-id
 * conflation above. */
const DEAL_A = `${ORG_ROOT}.dealA`;
const DEAL_A_NOTES = `${DEAL_A}.notes`;
const DEAL_B = `${ORG_ROOT}.dealB`;
const DEAL_B_NOTES = `${DEAL_B}.notes`;

// ---------------------------------------------------------------------------
// Fixture memory graph — one org, two sibling deals, each with a descendant
// "notes" scope, plus an org-wide (null-scope) fact and an explicit root-scoped
// fact. Every fact's content names its own scope so a leak is easy to spot in
// a failure message (e.g. "Deal B" text showing up in a Deal A read).
// ---------------------------------------------------------------------------

interface FixtureFact extends MemoryFact {
  scopePath: string | null;
}

const MEMORY_GRAPH: FixtureFact[] = [
  { uuid: "f-dealA-1", fact: "Deal A: budget is $50k, champion is Alice Kim", validAt: null, scopePath: DEAL_A },
  { uuid: "f-dealA-2", fact: "Deal A: legal flagged a redline in section 4", validAt: null, scopePath: DEAL_A_NOTES },
  {
    uuid: "f-dealB-1",
    fact: "Deal B: budget is $200k, champion is Priya Rao, competitor is Acme",
    validAt: null,
    scopePath: DEAL_B,
  },
  { uuid: "f-dealB-2", fact: "Deal B: churn risk flagged, renewal at risk", validAt: null, scopePath: DEAL_B_NOTES },
  { uuid: "f-org-wide", fact: "Willder's list price starts at $99/mo", validAt: null, scopePath: null },
  // Explicit org-root scope (`ORG_ROOT` = `orgRootPath(ORG_ID)` = "org_1", a
  // distinct string from the bare tenant id "1") — NOT the same partition as an
  // untagged/null-scope fact. Using the bare org id here instead would make this
  // fact collide with the Graphiti bare-org fallback leg below (guarded-store.ts's
  // own bare-org retry) and start leaking, which would be a bug in the fixture,
  // not a faithful model of production (root-scoped ingest that tags anything at
  // all tags `orgRootPath()`, never the bare tenant id — see check.ts's own
  // convention, mirrored in mcp-read-scope-partition.test.ts; the separate claim
  // that root-scoped ingest ALWAYS tags is false, which is the whole subject of
  // Case 7 below).
  //
  // This fact sits at the deals' real ANCESTOR (`org_1` vs `org_1.dealA`).
  // Downward containment is what retrieval filters on, so it cannot reach a
  // narrower deal-scoped read (Case 2) — but a read at org root exact-matches
  // it, which Cases 5 and 6 assert directly.
  {
    uuid: "f-org-root",
    fact: "Company-wide layoffs planned for Q4, still confidential",
    validAt: null,
    scopePath: orgRootPath(ORG_ID),
  },
  // Drive-sourced (services/connectors/gdrive.ts → lib/inngest.ts's fileIngest,
  // fired by sourceSync for a synced Drive folder): actorType "extraction",
  // tagged with the Source row's own scopePath at ingest.
  {
    uuid: "f-dealA-drive",
    fact: "Deal A: MSA extracted from Drive contract PDF, term is 24 months",
    validAt: null,
    actorType: "extraction",
    scopePath: DEAL_A,
  },
  {
    uuid: "f-dealB-drive",
    fact: "Deal B: MSA extracted from Drive contract PDF, term is 12 months",
    validAt: null,
    actorType: "extraction",
    scopePath: DEAL_B,
  },
];

/** Real Graphiti partition key a fact would land under at ingest — mirrors
 * graphiti-store.ts's `group_id: toGid(input.scopePath ?? input.groupId)`
 * (ingest, L163): a scoped fact partitions under its own scopePath; an
 * untagged (null-scope) fact falls back to the bare tenant/org id. */
function graphitiGroupOf(f: FixtureFact): string {
  return f.scopePath ?? ORG_ID;
}

/**
 * The real two-leg retrieval shape (hybrid-store.ts's `retrieve()`, what
 * actually sits behind `memory`/`guardedMemory`) — NOT scopePath alone.
 *
 *   • Query routing: hybrid-store.ts's `retrieve()` sends an entity-lookup-
 *     shaped query ("who/what is/are/was/were …", under 80 chars) to
 *     Graphiti ONLY, skipping pgvector entirely (`isEntityLookup`, L94) —
 *     same as `input.skipPgvector`.
 *   • Graphiti leg: an EXACT match on `input.groupId` (graphiti-store.ts's
 *     `retrieve()` sends `group_id: toGid(input.groupId)` verbatim — no
 *     ancestor/descendant containment, no org-wide fallback of its own).
 *   • pgvector leg: tenant-isolated on `input.tenantId ?? input.groupId`
 *     (pgvector-store.ts's real SELECT, `tenantId`), then `input.scopePath`
 *     containment (exact, descendant, or NULL = org-wide) as before — and
 *     never holds `actorType: "extraction"` content, which hybrid-store.ts's
 *     ingest split (L67-69) routes to Graphiti only. This fixture models a
 *     single tenant (`ORG_ID`) — every call in this file resolves to it
 *     (GuardedMemoryStore.retrieve() always sends `tenantId: input.groupId`,
 *     and every caller here uses `ORG_ID`) — so an unexpected tenant throws
 *     rather than silently answering a query no real cross-tenant caller
 *     could reach; the actual cross-tenant leak is asserted at
 *     `GuardedMemoryStore.assertTenant()` (the "cross-tenant" case below),
 *     before any store is ever called.
 *
 * Modeling every field production actually branches on — not just scopePath —
 * is what keeps this mock from being vacuous: a fixture that ignores a field
 * production keys on can return realistic-looking results for a case where
 * production wouldn't. See services/memory/mcp-read-scope-partition.test.ts
 * for the worked example the groupId/scopePath split mirrors.
 */
function visibleFacts(
  graph: FixtureFact[],
  input: {
    groupId: string;
    scopePath?: string;
    groupIds?: string[];
    skipPgvector?: boolean;
    tenantId?: string;
    query: string;
    /** Mirrors pgvector-store.ts's real `input.includeUntagged` gate on its
     * `scopePath IS NULL` clause (GuardedMemoryStore sets this from a pure
     * containment check against the caller's own checked scope — see
     * guarded-store.ts's retrieve() and pgvector-store.ts's retrieve() for the
     * real behavior this fixture must stay faithful to). Absent/false means a
     * scoped query does not treat untagged content as always-visible. */
    includeUntagged?: boolean;
  },
  opts: { graphitiDown?: boolean } = {},
): FixtureFact[] {
  const isEntityLookup = /^(who|what) (is|are|was|were)\b/.test(input.query.toLowerCase()) && input.query.length < 80;

  // `graphitiDown` models hybrid-store.ts's documented degraded path: a rejected
  // Graphiti leg (timeout, cold service, AuraDB reconnect) is explicitly NOT
  // fatal — `graphitiFacts` becomes `[]` and pgvector alone answers (L94-L112).
  // Defaults off, so every case that doesn't ask for it is unchanged.
  const graphitiHits = opts.graphitiDown
    ? []
    : graph.filter((f) => [input.groupId, ...(input.groupIds ?? [])].includes(graphitiGroupOf(f)));
  if (input.skipPgvector || isEntityLookup) return graphitiHits;

  const tenant = input.tenantId ?? input.groupId;
  if (tenant !== ORG_ID) {
    throw new Error(
      `fixtureScopedStore: unexpected tenantId/groupId "${tenant}" — this fixture only models tenant "${ORG_ID}"; a real cross-tenant call must be rejected by GuardedMemoryStore.assertTenant() before reaching the store at all`,
    );
  }

  const scope = input.scopePath;
  const pgHits = graph.filter((f) => {
    if (f.actorType === "extraction") return false;
    if (!scope) return true;
    // Mirrors pgvector-store.ts's real input.includeUntagged gate (set by
    // GuardedMemoryStore from a pure org-root containment check) — untagged
    // content is only visible when this leg's checked scope genuinely covers
    // org root, not for every scoped caller.
    if (f.scopePath === null) return !!input.includeUntagged;
    if (f.scopePath === scope) return true;
    return f.scopePath.startsWith(scope + ".");
  });

  const seen = new Set<string>();
  const merged: FixtureFact[] = [];
  for (const f of [...graphitiHits, ...pgHits]) {
    if (!seen.has(f.uuid)) {
      seen.add(f.uuid);
      merged.push(f);
    }
  }
  return merged;
}

/** visibleFacts(), shaped as the MemoryStore#retrieve() result both the fixture
 * store below and the mocked `memory` singleton return. */
function retrieveVisibleFacts(
  graph: FixtureFact[],
  input: {
    groupId: string;
    scopePath?: string;
    skipPgvector?: boolean;
    tenantId?: string;
    query: string;
    includeUntagged?: boolean;
  },
  opts: { graphitiDown?: boolean } = {},
): { facts: MemoryFact[] } {
  return {
    facts: visibleFacts(graph, input, opts).map((f) => ({
      uuid: f.uuid,
      fact: f.fact,
      validAt: f.validAt,
      actorType: f.actorType,
    })),
  };
}

/**
 * A fake MemoryStore whose retrieve() mirrors the real two-leg hybrid shape
 * (see visibleFacts() above) instead of just pgvector's scope filter. This is
 * a fixture, kept deliberately faithful to both backends' production
 * partitioning so it stays a meaningful proxy for either — see
 * hybrid-store.ts's `retrieve()` and graphiti-store.ts / pgvector-store.ts's
 * own `retrieve()` if either filter changes.
 */
function fixtureScopedStore(graph: FixtureFact[], opts: { graphitiDown?: boolean } = {}): MemoryStore {
  const retrieve = vi.fn(async (input: SearchInput) => retrieveVisibleFacts(graph, input, opts));
  return {
    ingest: vi.fn(),
    retrieve,
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

/** Stub check()'s DB lookup: grant/capability rows covering (or not) the target.
 * `agentId`, when given, must match the calling ctx's own `actor.id` — the
 * capability-owner check denies otherwise. Irrelevant (and omitted) for a human
 * actor, which never reads it. */
const allow = (permission: "read" | "write" | "admin" = "read", agentId?: string) =>
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission, agentId }] as never);
const deny = () => vi.mocked(db.$queryRaw).mockResolvedValue([] as never);

/** Assert `facts` contains none of `leaked` — by id and by raw content substring,
 * so a leak that changed shape (re-worded, re-uuid'd) still fails loudly. */
function assertNoLeak(facts: MemoryFact[], leaked: FixtureFact[]) {
  const ids = new Set(facts.map((f) => f.uuid));
  const text = facts.map((f) => f.fact).join(" | ");
  for (const l of leaked) {
    expect(ids.has(l.uuid), `leaked fact id ${l.uuid} present in output`).toBe(false);
    expect(text, `leaked content "${l.fact}" present in output`).not.toContain(l.fact);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  // descendantScopePaths() default: no registered descendant scopes, so every
  // case that doesn't explicitly override this (i.e. everything except Case 6
  // below) reads without a descendant fan-out.
  vi.mocked(strictDescendantScopePaths).mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

/** Minimal McpServer test double: captures each registered tool's handler by
 * name so a test can call it directly, exactly as the real MCP transport would. */
function fakeMcpServer() {
  const tools = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>
  >();
  return {
    registerTool: vi.fn(
      (
        name: string,
        _config: unknown,
        handler: (
          args: Record<string, unknown>,
        ) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
      ) => {
        tools.set(name, handler);
      },
    ),
    tools,
  };
}

// ---------------------------------------------------------------------------
// Case 1 — sibling-scope leak (the core scenario)
// ---------------------------------------------------------------------------

describe("access-control leakage — sibling scope", () => {
  it("a Deal A-scoped human grant never surfaces Deal B facts", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read"); // grant covers org_1.dealA (the requested target)

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, DEAL_A);

    // In-scope: the deal's own fact and its descendant "notes" scope.
    expect(facts.map((f) => f.uuid)).toEqual(expect.arrayContaining(["f-dealA-1", "f-dealA-2"]));
    // Out-of-scope: the sibling deal (and its descendant) never appears — the
    // literal "zero leaks" assertion the eval exists to make.
    assertNoLeak(
      facts,
      MEMORY_GRAPH.filter((f) => f.uuid.startsWith("f-dealB")),
    );
    // f-org-wide (untagged, scopePath null) is not visible to this dealA-only
    // grant either. "Untagged" and "genuinely org-wide/public" are the same
    // partition by construction — closing the real leak (confidential untagged
    // content reaching a narrow-scoped reader, see the "bare-org fallback leg"
    // cases below) necessarily also removes the harmless case, since the data
    // layer can't tell them apart. Accepted cost, not a bug in this assertion.
    assertNoLeak(facts, [MEMORY_GRAPH.find((f) => f.uuid === "f-org-wide")!]);
  });

  it("an agent capability token scoped to Deal A never surfaces Deal B facts", async () => {
    // Mirrors the real product surface: a Handoff-agent capability token minted
    // for one deal (willder_v2_wedge.md's "grant → scoped brief" flow).
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const { facts } = await guarded.retrieve(
      ctx,
      { groupId: ORG_ID, query: "what should the contractor know" },
      DEAL_A,
    );

    expect(facts.map((f) => f.uuid)).toContain("f-dealA-1");
    assertNoLeak(
      facts,
      MEMORY_GRAPH.filter((f) => f.uuid.startsWith("f-dealB")),
    );
  });
});

// ---------------------------------------------------------------------------
// Case 1', fixture fidelity: visibleFacts() must model `tenantId` and
// query-dependent hybrid routing, not just groupId/scopePath, or it can return
// realistic-looking results for an input shape production would answer
// differently (or reject outright).
// ---------------------------------------------------------------------------

describe("access-control leakage — fixture fidelity (tenantId + query-routing, not just groupId/scopePath)", () => {
  it("an entity-lookup-shaped query routes Graphiti-only, same as hybrid-store.ts's real isEntityLookup — pgvector-only descendant content disappears", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "what is Deal A" }, DEAL_A);

    // f-dealA-1 is ingested exactly at DEAL_A — reachable via Graphiti's
    // exact groupId match, so it survives the entity-lookup route.
    expect(facts.map((f) => f.uuid)).toContain("f-dealA-1");
    // f-dealA-2 is a DESCENDANT (DEAL_A_NOTES) — only pgvector's
    // containment leg finds it (Graphiti has no containment of its own). A
    // fixture that doesn't model query-routing would return it here too — a
    // realistic-looking result production would not return.
    expect(facts.map((f) => f.uuid)).not.toContain("f-dealA-2");
  });

  it("the fixture store throws on an unexpected tenantId/groupId rather than silently answering — it models exactly one tenant", async () => {
    // Direct call to the fixture store, bypassing GuardedMemoryStore (which
    // never forwards a mismatched tenant in the first place — every real
    // caller here resolves to ORG_ID, and a genuine cross-tenant read is
    // rejected earlier, at assertTenant(), the "cross-tenant" case below).
    // This proves the guard itself is real and reachable, not dead code.
    const store = fixtureScopedStore(MEMORY_GRAPH);
    await expect(
      store.retrieve({ groupId: OTHER_ORG_ID, tenantId: OTHER_ORG_ID, query: "deal status" }),
    ).rejects.toThrow(/unexpected tenantId\/groupId/);
  });
});

// ---------------------------------------------------------------------------
// Case 1a — the per-fact audit id records exactly what was returned, never
// more (memory.read audit targets are query-based, not per-record, so without
// the linked row the audit log shows that a query ran but not which exact
// facts came back). This is the mirror image of the "zero leaks in the response"
// assertion above: the same over-exposure failure mode, but checked against
// what gets WRITTEN TO THE AUDIT TRAIL, not just what the caller receives.
// A correct response with an over-broad audit annotation would still be a
// real leak — it would tell a reviewer facts were read that never actually
// left the scope boundary.
// ---------------------------------------------------------------------------

describe("access-control leakage — per-fact audit id matches exactly what was returned", () => {
  it("a Deal A-scoped read writes a NEW linked audit row (audit_log stays append-only) with exactly the Deal A fact ids, never Deal B's", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, DEAL_A);

    // Never mutated: the original decision row (written by check()) is untouched.
    expect(db.auditLog.update).not.toHaveBeenCalled();
    // check() writes the first row (the gated decision); this writes a second,
    // separate row linked to it by auditLogId — never an update of the first.
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
    const factIdsCall = vi.mocked(db.auditLog.create).mock.calls[1][0];
    expect(factIdsCall.data).toMatchObject({
      orgId: ORG_ID,
      actorType: "human",
      actorId: "user_1",
      action: "memory.read.factIds",
      decision: "allow",
    });
    // Linked back to the original decision row, so the two are joinable.
    expect((factIdsCall.data.metadata as { auditLogId: string }).auditLogId).toBe("audit_test_id");
    const recordedIds = (factIdsCall.data.metadata as { factIds: string[] }).factIds;

    // Exactly the ids the caller actually got back — no more, no fewer.
    expect(new Set(recordedIds)).toEqual(new Set(facts.map((f) => f.uuid)));
    // The literal "no over-exposure" assertion: Deal B's facts exist in the
    // fixture graph (proving this isn't just an empty-graph false negative)
    // but must never appear in what the audit trail records as read, even
    // though check() only gated the QUERY, not the individual records.
    for (const dealB of MEMORY_GRAPH.filter((f) => f.uuid.startsWith("f-dealB"))) {
      expect(recordedIds, `leaked fact id ${dealB.uuid} present in audit annotation`).not.toContain(dealB.uuid);
    }
  });

  it("a denied read never writes a linked fact-ids audit row — nothing was actually returned", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    deny();

    await expect(guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, DEAL_A)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );

    expect(db.auditLog.update).not.toHaveBeenCalled();
    // Only check()'s own deny-decision row — no second row for fact ids.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case 1b — run-correlation id disambiguates two overlapping runs sharing one
// agent identity.
//
// runCopyAgent (lib/copy-agent.ts, services/agents/runner.ts) stamps every
// non-research test-run under the one static COPY_AGENT_ID actorId — real
// agent identity plays no part in it. Two runs of that same shared identity,
// started close enough together to overlap in time, are indistinguishable in
// audit_log without runId: filtering by actorId + a time window necessarily
// returns BOTH runs' rows, so a reviewer asking "what did THIS run touch"
// could be handed another run's memory access and never know it — a real
// leak-class defect in the audit trail, not cosmetic. This is the same failure
// class as Case 1 above (sibling-scope leak), one level up: the content
// returned to each caller stays correctly scoped, but WHICH RUN gets credited
// for having read it must too.
// ---------------------------------------------------------------------------

describe("access-control leakage — run-correlation id disambiguates overlapping runs of the shared copy-agent identity", () => {
  it("two concurrent runs of the same shared actorId produce audit rows exactly attributable by runId, where actorId alone would conflate them", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    // Mirrors runCopyAgent: every non-research test-run shares this one actorId,
    // real disambiguation can only come from runId.
    const sharedActorId = "copy-agent";
    const runA: AccessContext = {
      orgId: ORG_ID,
      runId: "run_A",
      actor: { type: "agent", id: sharedActorId, capabilityToken: "wcap_A" },
      origin: "mcp",
    };
    const runB: AccessContext = {
      orgId: ORG_ID,
      runId: "run_B",
      actor: { type: "agent", id: sharedActorId, capabilityToken: "wcap_B" },
      origin: "mcp",
    };
    allow("read", sharedActorId);

    // Overlapping in time (no window narrowing here at all — runId is exact,
    // unlike an actorId + startedAt/finishedAt heuristic), each run reads its
    // own deal's scope so a misattributed row would also be a content leak.
    await guarded.retrieve(runA, { groupId: ORG_ID, query: "deal status" }, DEAL_A);
    await guarded.retrieve(runB, { groupId: ORG_ID, query: "deal status" }, DEAL_B);

    // Each retrieve() writes TWO rows: check()'s own gated decision
    // (action "memory.read") plus recordReadFactIds()'s linked per-fact row
    // (action "memory.read.factIds", both facts in scope for a non-empty
    // fixture read) — same as Case "per-fact audit id" above. Both must carry
    // the run's id, not just the first.
    const rows = vi.mocked(db.auditLog.create).mock.calls.map((c) => c[0].data);
    expect(rows).toHaveLength(4);
    // Every row shares the run-agnostic actorId — confirms this scenario really
    // does reproduce the shared-identity ambiguity, not two distinguishable actors.
    for (const r of rows) expect(r.actorId).toBe(sharedActorId);

    // An exact runId filter (what the run-trail route uses) recovers precisely
    // one run's own rows (its gate decision AND its linked fact-ids row), never
    // the other run's.
    const byRunA = rows.filter((r) => r.runId === "run_A");
    const byRunB = rows.filter((r) => r.runId === "run_B");
    expect(byRunA).toHaveLength(2);
    expect(byRunB).toHaveLength(2);
    expect(byRunA.map((r) => r.action)).toEqual(["memory.read", "memory.read.factIds"]);
    expect(byRunB.map((r) => r.action)).toEqual(["memory.read", "memory.read.factIds"]);
    expect(byRunA[0].target).toContain("dealA");
    expect(byRunB[0].target).toContain("dealB");

    // The regression this guards: filtering by actorId alone (with no
    // time-window narrowing — the exact ambiguity a real overlapping window
    // reproduces) still returns BOTH runs merged into one "trail". If a future
    // change stopped writing runId, byRunA/byRunB above would silently match
    // nothing (undefined !== "run_A"), not match the wrong thing — so this
    // second assertion is what pins the failure mode as reproducible in
    // principle, proving the runId filter is doing real disambiguation work,
    // not just filtering on a value nothing else could produce.
    const byActorIdAlone = rows.filter((r) => r.actorId === sharedActorId);
    expect(byActorIdAlone).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Case 1b — the real pgvector SQL filter, not a JS reimplementation of it
// ---------------------------------------------------------------------------
//
// Every other case in this file mocks the MemoryStore interface itself
// (fixtureScopedStore), so a regression in PgvectorMemoryStore's actual SQL
// WHERE clause (pgvector-store.ts, the scopePath predicate around lines
// 109-118) would never be caught here. This case wires in the REAL
// PgvectorMemoryStore, stubbing only the DB client's $queryRaw and the
// embedding fetch, and pins the exact predicate + bound parameters production
// code sends to Postgres for tenant/scope isolation — simulating Postgres's
// own WHERE evaluation in JS would just be another reimplementation of the
// same rule, so this asserts on the query shape and its arguments instead.

describe("access-control leakage — production SQL filter (pgvector)", () => {
  it("a narrow (non-root) scope's read sends PgvectorMemoryStore's real scope-isolation WHERE clause to Postgres WITHOUT the untagged (`scopePath IS NULL`) branch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: [0, 0, 0] }) }));
    const queryRaw = vi.fn().mockResolvedValue([{ id: "f-dealA-1", content: MEMORY_GRAPH[0].fact, created_at: null }]);
    // db.$queryRaw backs both check()'s grant lookup (called first, by
    // GuardedMemoryStore.retrieve()) and PgvectorMemoryStore's own SELECT (called
    // second, by the store) — `allow()`'s standing mockResolvedValue would
    // clobber whichever runs second, so queue the grant response as a one-off
    // ahead of the standing pgvector implementation instead. The descendant
    // lookup is the separately mocked scope-registry module, so it doesn't
    // touch this query count.
    vi.mocked(db.$queryRaw)
      .mockResolvedValueOnce([{ permission: "read" }] as never)
      .mockImplementation(queryRaw as never);

    const guarded = new GuardedMemoryStore(new PgvectorMemoryStore());
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };

    // DEAL_A ("org_1.dealA") is a real DESCENDANT of ORG_ROOT ("org_1"), i.e.
    // strictly narrower — the caller's own checked scope does NOT cover org root,
    // so pgvector-store.ts's includeUntagged gate must be false and the IS NULL
    // branch must be absent. Descendant-but-narrower is the whole point: two
    // merely UNRELATED strings ("org_1.dealA" vs "org_org_1") are also "doesn't
    // cover org root" — but unrelated strings fail the gate in BOTH argument
    // orders, so that shape could not tell a correct `pathCovers(scope,
    // orgRoot)` from a reversed one.
    await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, DEAL_A);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("");

    // Tenant isolation: filters on the bare org id (never the scope-encoded path).
    expect(sql).toContain('"orgId" = ');
    expect(values).toContain(ORG_ID);
    // …and specifically NOT the org root path, the near-miss a path-shaped
    // ORG_ID would let this bound value silently accept.
    expect(values).not.toContain(ORG_ROOT);

    // Scope isolation: exact match or descendant (LIKE prefix) only — the
    // untagged/NULL branch is dropped entirely for a caller whose checked scope
    // doesn't cover org root, rather than left in on the hope that nothing
    // confidential ever lands there untagged.
    expect(sql).not.toContain("IS NULL");
    expect(sql).toContain('"scopePath" = ');
    expect(sql).toContain('OR "scopePath" LIKE');
    expect(sql).toContain("ESCAPE");
    expect(values).toContain(DEAL_A);
    // The bound LIKE prefix is escaped: `org_1` itself carries an underscore,
    // which Postgres LIKE would otherwise read as a single-character wildcard.
    // See pgvector-store.ts's escapeLikePrefix().
    expect(values).toContain("org\\_1.dealA.%");
    expect(values).not.toContain("org_1.dealA.%");
  });

  it("a read whose checked scope genuinely IS orgRootPath(orgId) keeps the untagged (`scopePath IS NULL`) branch — org-root coverage is what justifies it, not just holding some grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: [0, 0, 0] }) }));
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { id: "f-org-root", content: "Company-wide layoffs planned for Q4, still confidential", created_at: null },
      ]);
    vi.mocked(db.$queryRaw)
      .mockResolvedValueOnce([{ permission: "read" }] as never)
      .mockImplementation(queryRaw as never);

    const guarded = new GuardedMemoryStore(new PgvectorMemoryStore());
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "admin" }, origin: "app" };

    await guarded.retrieve(ctx, { groupId: ORG_ID, query: "company news" }, orgRootPath(ORG_ID));

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("");

    expect(sql).toContain('"scopePath" IS NULL OR "scopePath" = ');
    expect(values).toContain(orgRootPath(ORG_ID));
  });
});

// ---------------------------------------------------------------------------
// Case 2 — ancestor scope is NOT inherited downward
// ---------------------------------------------------------------------------

describe("access-control leakage — ancestor scope", () => {
  it("an explicit org-root fact does not leak into a narrower deal scope (only null-scope facts are org-wide)", async () => {
    // check()'s ltree rule runs the other way (a root GRANT covers descendant
    // scopes); the data filter must NOT mirror that for retrieval, or a root-only
    // sensitive fact (explicitly scoped to org_1, e.g. "layoffs planned") would
    // leak into every narrower read across the org. Only untagged (null-scope)
    // facts are meant to be org-wide-visible — this pins that distinction.
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "company news" }, DEAL_A);

    assertNoLeak(facts, [MEMORY_GRAPH.find((f) => f.uuid === "f-org-root")!]);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — cross-tenant isolation holds even inside this same eval harness
// ---------------------------------------------------------------------------

describe("access-control leakage — cross-tenant", () => {
  it("a second org's context can never read this org's memory graph, scope string collisions included", async () => {
    const store = fixtureScopedStore(MEMORY_GRAPH);
    const guarded = new GuardedMemoryStore(store);
    const ctx: AccessContext = {
      orgId: OTHER_ORG_ID,
      actor: { type: "human", id: "user_9", role: "admin" },
      origin: "app",
    };

    await expect(guarded.retrieve(ctx, { groupId: ORG_ID, query: "anything" }, DEAL_A)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(store.retrieve).not.toHaveBeenCalled(); // blocked before the store is ever touched
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Drive read-side scope enforcement, through the real MCP tools
// ---------------------------------------------------------------------------
//
// An MCP handler that calls guardedMemory.retrieve()/entity() with no third
// `scope` argument lets check()'s target default to the ORG ROOT instead of
// the caller's own capability — a narrow capability (scoped below root,
// exactly the "grant → scoped brief" contractor-token shape) can never cover
// that target and is denied every time, Drive-sourced content included. That
// is an over-restriction, not a leak.
//
// mcp/tools.ts's memory_query/memory_entity default their scope to the
// token's own cap.scopePath (mirroring memory_ingest's `scopePath ??
// cap.scopePath ?? orgRootPath(...)` default). That closes the
// over-restriction — a Deal A-scoped capability can use memory_query — but it
// also has to hold on the OTHER side: a Deal A token must still surface zero
// facts from Deal B, Drive-sourced facts included. This block proves both
// halves through the real MCP handler (registerWillderTools → the actual
// memory_query closure), not a hand-rolled call to guarded.retrieve(), so it
// stays honest if the handler's call shape ever drifts.
// ---------------------------------------------------------------------------

describe("access-control leakage — Drive read-side scope enforcement (MCP memory_query)", () => {
  beforeEach(() => {
    // The mocked `memory` singleton (vi.mock("./store") above) backs
    // guardedMemory's default store — wire its retrieve() to the same
    // scope-containment rule pgvector's real SQL implements (visibleFacts,
    // shared with fixtureScopedStore above), so this test observes real
    // scope forwarding through the actual handler instead of a vacuous mock
    // that would pass whether or not the handler actually threads the scope
    // through.
    vi.mocked(memory.retrieve).mockImplementation(async (input: SearchInput) =>
      retrieveVisibleFacts(MEMORY_GRAPH, input),
    );
  });

  it("a Deal A-scoped MCP capability token can use memory_query (no over-restriction) but never sees Deal B's Drive-sourced content (the leak-scenario check)", async () => {
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent"); // capability scoped to org_1.dealA, its own scope

    const server = fakeMcpServer();
    registerWillderTools(server as unknown as McpServer, ctx, {
      orgId: ORG_ID,
      agentId: "handoff-agent",
      scopePath: DEAL_A,
    });
    const memoryQuery = server.tools.get("memory_query");
    expect(memoryQuery, "mcp/tools.ts must register a memory_query tool").toBeDefined();

    const result = await memoryQuery!({ query: "what should the contractor know about the MSA" });

    // Not denied outright — the completeness half.
    expect(result.isError).not.toBe(true);
    const text = result.content.map((c) => c.text).join(" | ");
    // In-scope, Drive-sourced content DOES come through.
    expect(text).toContain("Deal A: MSA extracted from Drive contract PDF, term is 24 months");
    // The actual leak-scenario assertion: a token scoped to org_1.dealA can
    // never retrieve Drive-sourced content tagged org_1.dealB.
    expect(text).not.toContain("Deal B");
    expect(text).not.toContain("12 months");
  });

  it("an unscoped memory_query call still defaults to the caller's own capability, not the org root — sibling scopes stay invisible either way", async () => {
    // Even with no scopePath argument supplied by the caller, the handler must
    // fall back to cap.scopePath (its own granted scope), never silently widen
    // to org root.
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const server = fakeMcpServer();
    registerWillderTools(server as unknown as McpServer, ctx, {
      orgId: ORG_ID,
      agentId: "handoff-agent",
      scopePath: DEAL_A,
    });
    const memoryQuery = server.tools.get("memory_query")!;

    const result = await memoryQuery({ query: "deal status", limit: 10 });

    const text = result.content.map((c) => c.text).join(" | ");
    expect(text).toContain("Deal A");
    expect(text).not.toContain("Deal B");
  });
});

// ---------------------------------------------------------------------------
// Case 5 — scope-completeness: an ancestor/root-level grant sees every
// descendant scope's content, not just the one it happens to be tagged with
// (services/access/SCOPE_COMPLETENESS.md's "ancestor grant, descendant
// content" relationship). Every case above proves a NARROW scope never sees a
// SIBLING's content. None of them prove a BROAD grant actually sees everything
// nested below it — a narrowing-direction failure mode (a root token that can
// approve a descendant draft while the list says "No pending drafts" for that
// same token). This pairs the same relationship for memory_query/retrieve().
// ---------------------------------------------------------------------------

describe("access-control leakage — scope-completeness: an org-root-scoped read sees every deal's content, not just its own", () => {
  it("a read scoped to the org root (ORG_ROOT, the broadest containing scope — a real ANCESTOR of both deals, not a disjoint string) surfaces BOTH deals' facts at the descendant relationship AND the fact tagged at the root exactly, not just whichever deal happens to match first", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "admin" }, origin: "app" };
    allow("read");

    // ORG_ROOT is the broadest grant this fixture's pgvector containment can
    // express (`scopePath = 'org_1' OR LIKE 'org_1.%' OR NULL`) — everything
    // below it must come back, across BOTH sibling deals, not just the one
    // nearer the top of the merge order.
    //
    // The scope under test is the real root, not the bare tenant/org id. A
    // path-shaped fixture org id (`ORG_ID = "org_1"`) makes the bare id look
    // like an ancestor of `org_1.dealA` and makes the real root ("org_org_1")
    // cover nothing. Neither shape exists in production: a real org id is a
    // cuid, every real `scopes` row is rooted at `org_<orgId>`, and no
    // capability ever carries the bare org id as a scope path.
    //
    // Note scope !== groupId (ORG_ROOT vs ORG_ID), which is also the real
    // shape: Graphiti keys on the scope-encoded path, pgvector isolates on the
    // bare org id. See guarded-store.ts's retrieve() for that split.
    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, ORG_ROOT);

    const ids = facts.map((f) => f.uuid);
    // Both relationships in one read: DESCENDANT content (the four deal facts)
    // and content tagged at the grant's own scope EXACTLY (f-org-root). A broad
    // grant must not stop at its own exact tag — and must not skip it either.
    expect(ids).toEqual(
      expect.arrayContaining(["f-dealA-1", "f-dealA-2", "f-dealB-1", "f-dealB-2", "f-org-wide", "f-org-root"]),
    );
    // f-org-wide (untagged) is legitimately visible here: this caller's own
    // checked scope genuinely IS org root, so `hasOrgRootGrant` holds and
    // pgvector's includeUntagged gate opens. That is the positive half of the
    // untagged-visibility rule — it narrows untagged visibility to
    // org-root-covering callers, it does not remove it. Case 7's narrow-scope
    // cases below pin the negative half on the same fixture.
    //
    // f-org-root is a real exact match at ORG_ROOT. Case 2 pins the boundary
    // that actually matters (this same root fact must NOT reach a narrower
    // deal-scoped read), from the narrow side.
    //
    // Deliberately NOT asserted here: the Drive-sourced (actorType
    // "extraction") facts. They stay absent from this broad-grant read too,
    // and correctly so — see SCOPE_COMPLETENESS.md's Drive-sourced-reads row.
    // hybrid-store.ts routes extraction content to Graphiti ONLY (never
    // pgvector, visibleFacts()'s pgHits filter mirrors that), and Graphiti has
    // no containment: its groupId here is ORG_ROOT (this read's own scope),
    // not DEAL_A (where the Drive facts are actually tagged), so
    // neither leg reaches them. A broader grant reaching Drive-sourced
    // content requires querying that content's own exact scope, same as any
    // other Graphiti-only read — not a gap this case is meant to close.
    expect(ids).not.toContain("f-dealA-drive");
    expect(ids).not.toContain("f-dealB-drive");
  });
});

// ---------------------------------------------------------------------------
// Case 5b — scope-completeness, the REAL org-root shape, through the real
// registered memory_query handler. Case 5 above proves the
// ancestor/descendant relationship by calling GuardedMemoryStore.retrieve()
// directly; it does NOT prove that a CAPABILITY whose own scopePath is the org
// root resolves to that scope end to end the way resolveCallerScopePath
// resolves one in production. This case closes that, driving the real
// memory_query handler rather than the store.
//
// Case 5 reads at the same ORG_ROOT string this case uses, so the two differ
// not in the scope under test but in the PATH TO IT (direct store call vs.
// capability → resolveCallerScopePath → registered handler), which is the
// load-bearing distinction.
// ---------------------------------------------------------------------------

describe("access-control leakage — scope-completeness: a REAL org-root capability retrieves descendant content through memory_query", () => {
  const ORG_ROOT_PATH = ORG_ROOT; // "org_1" — distinct from the bare tenant id "1"
  const ORG_ROOT_DESCENDANT_GRAPH: FixtureFact[] = [
    ...MEMORY_GRAPH,
    // Nested BELOW the real org-root scope, not at it — the relationship this
    // case exists to prove (a root capability sees descendant content, not
    // just its own exact tag).
    {
      uuid: "f-orgroot-dealC",
      fact: "Org-root scoped deal: Project Nova renewal is at risk",
      validAt: null,
      scopePath: `${ORG_ROOT_PATH}.dealC`,
    },
  ];

  beforeEach(() => {
    // Same reasoning as the "Drive read-side scope enforcement" block above:
    // wire the mocked `memory` singleton to the real two-leg fixture model so
    // this exercises real scope forwarding through the actual handler, not a
    // vacuous mock.
    vi.mocked(memory.retrieve).mockImplementation(async (input: SearchInput) =>
      retrieveVisibleFacts(ORG_ROOT_DESCENDANT_GRAPH, input),
    );
  });

  it("a capability whose own scopePath IS orgRootPath(ORG_ID) — the real root-capability shape resolveCallerScopePath produces, not the bare tenant id — retrieves content nested below it via the real registered memory_query handler", async () => {
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "root-agent", capabilityToken: "wcap_test_orgroot" },
      origin: "mcp",
    };
    allow("read", "root-agent"); // grant covers the capability's own root scope

    const server = fakeMcpServer();
    registerWillderTools(server as unknown as McpServer, ctx, {
      orgId: ORG_ID,
      agentId: "root-agent",
      scopePath: ORG_ROOT_PATH, // orgRootPath(ORG_ID), the real root shape — not the bare org id
    });
    const memoryQuery = server.tools.get("memory_query");
    expect(memoryQuery, "mcp/tools.ts must register a memory_query tool").toBeDefined();

    // No caller-supplied scopePath — resolveCallerScopePath must fall back to
    // cap.scopePath, i.e. exactly ORG_ROOT_PATH, proving the fallback resolves
    // to the real org-root shape end to end, not just a relabeled test.
    const result = await memoryQuery!({ query: "deal status" });

    expect(result.isError).not.toBe(true);
    const text = result.content.map((c) => c.text).join(" | ");
    // The actual coverage gap: a real root capability must retrieve content
    // nested below orgRootPath(ORG_ID), not just whatever is tagged exactly at it.
    expect(text).toContain("Org-root scoped deal: Project Nova renewal is at risk");
  });
});

// ---------------------------------------------------------------------------
// Case 6 — the descendant walk: a broad/ancestor-scoped read's Graphiti leg
// surfaces a real descendant scope's Drive-extracted (extraction-tier)
// content, closing the silent "wrong data, not denied" gap Case 5 above and
// SCOPE_COMPLETENESS.md's Drive-sourced-reads/memory_entity rows describe.
// Same fixture, same org-root scope as Case 5 — the only new variable is
// descendantScopePaths() resolving real registered descendant scopes (DEAL_A,
// DEAL_B), which this file's default scope-registry stub (top of file)
// otherwise reports as none.
// ---------------------------------------------------------------------------

describe("access-control leakage — scope-completeness: an org-root-scoped read surfaces descendant Drive-extracted content via Graphiti's authorized-descendant-query", () => {
  it("an org-root-scoped read retrieves BOTH deals' Drive-sourced facts once their scopes are real, registered descendants — the exact gap Case 5 pins as absent on this identical fixture/scope/query", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "admin" }, origin: "app" };
    allow("read");
    // The one thing that changes vs. Case 5: dealA and dealB are real,
    // registered scopes under the org — exactly what app/api/sources/route.ts
    // creates for every Drive-connected folder in production.
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A, DEAL_A_NOTES, DEAL_B, DEAL_B_NOTES]);

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, ORG_ROOT);

    const ids = facts.map((f) => f.uuid);
    // Both deals' Drive-sourced (extraction-tier) content comes back — absent
    // without the walk, per Case 5's own deliberate negative assertion on this
    // exact fixture, scope, and query.
    expect(ids).toEqual(expect.arrayContaining(["f-dealA-drive", "f-dealB-drive"]));
    // Case 5's own assertions still hold: everything that already worked keeps
    // working, the org-root-tagged fact included (a real exact match at this
    // scope, see Case 5's own note).
    expect(ids).toEqual(
      expect.arrayContaining(["f-dealA-1", "f-dealA-2", "f-dealB-1", "f-dealB-2", "f-org-wide", "f-org-root"]),
    );
  });

  it("only real, registered descendants of the read's OWN target are queried — a Deal A-scoped capability's descendant lookup never asks the DB for Deal B's subtree, so the walk can't leak sideways", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A_NOTES]);

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, DEAL_A);

    expect(strictDescendantScopePaths).toHaveBeenCalledWith(ORG_ID, DEAL_A);
    assertNoLeak(
      facts,
      MEMORY_GRAPH.filter((f) => f.uuid.startsWith("f-dealB")),
    );
  });
});

// ---------------------------------------------------------------------------
// Case 7 — the BARE-ORG fallback leg
//
// Every case above this point takes the fixture's one bare-org-partitioned
// fact (`f-org-wide`, "Willder's list price starts at $99/mo") as *deliberately*
// org-wide content that every scoped reader is supposed to see, and the one
// genuinely confidential root fact (`f-org-root`) is deliberately tagged
// `orgRootPath(ORG_ID)` — a DISJOINT partition from the bare org id, which is
// exactly why it never reaches the bare-org fallback leg. MEMORY_GRAPH's own
// comment on `f-org-root` defends that routing on a stated premise: "real
// root-scoped ingest always tags orgRootPath(), never the bare tenant id."
//
// That premise is false. guarded-store.ts's own comment on the fallback leg
// names six production ingest paths — memory/upload, onboarding,
// accounts/[id], contacts/[id], contacts/from-research, outbound/send — that
// write with NO scopePath at all, so their episodes land under the BARE org
// id. Nothing about those paths is "deliberately public": onboarding notes,
// account records and contact research are ordinary org content that happens
// to have been ingested untagged. So the bare-org partition is not a public
// bucket, it is the default dumping ground for every untagged write, and an
// ungated fallback leg merges ALL of it into every narrow-scoped read.
//
// The cases above cannot see this class at all: the only fact the fixture
// puts in the bare-org partition is harmless. These cases put a genuinely
// confidential fact there instead, in the exact shape those six call sites
// produce (ingest with scopePath undefined → graphiti-store.ts's
// `toGid(input.scopePath ?? input.groupId)` → the bare org id), and ask: does
// a caller holding ONLY a single-deal capability, who never held an org-root
// grant, get it back?
//
// Two mechanisms are gated to answer no: guarded-store.ts's bare-org fallback
// leg runs only when the caller's checked scope actually covers org root, and
// pgvector-store.ts's `scopePath IS NULL` clause is gated the same way. Each
// case here asserts `assertNoLeak(facts, [BARE_ORG_CONFIDENTIAL])` while still
// pinning an in-scope fact, so it can never pass on an empty/errored result
// (an `it.fails` would pass on any thrown error and demonstrate nothing).
// ---------------------------------------------------------------------------

/** A confidential fact ingested by one of the six untagged production call
 * sites (onboarding, in this shape). No scopePath, so Graphiti partitions it
 * under the BARE org id and pgvector stores it with `scopePath IS NULL` —
 * identical storage shape to `f-org-wide`, opposite sensitivity. */
const BARE_ORG_CONFIDENTIAL: FixtureFact = {
  uuid: "f-bare-org-confidential",
  fact: "Onboarding call: we are in acquisition talks with Acme, board-only, do not share",
  validAt: null,
  scopePath: null,
};

const BARE_ORG_GRAPH: FixtureFact[] = [...MEMORY_GRAPH, BARE_ORG_CONFIDENTIAL];

describe("access-control leakage — bare-org fallback leg", () => {
  // Isolates the Graphiti fallback leg from pgvector's own `scopePath IS NULL`
  // clause. An entity-lookup-shaped query (hybrid-store.ts's isEntityLookup:
  // /^(who|what) (is|are|was|were)/, under 80 chars) routes Graphiti-only, so
  // pgvector never runs on either leg. If the confidential fact comes back,
  // the ONLY path it can have travelled is guarded-store.ts's own bare-org
  // retry — with pgvector's NULL-is-org-wide behaviour taken off the table.
  // guarded-store.ts only invokes the bare-org retry when the caller's own
  // checked scope genuinely covers org root (pathCovers), so a Deal A-only
  // capability never issues this query at all.
  it("a Deal A-only capability does NOT surface a bare-org-ingested confidential fact — Graphiti-only routing, so the bare-org fallback leg is the only possible source", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(BARE_ORG_GRAPH));
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent"); // grant covers org_1.dealA ONLY — never org root

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "who is the champion" }, DEAL_A);

    // The read genuinely succeeds and returns this capability's own in-scope
    // content first — so the no-leak assertion below is about a real, working
    // read staying correctly bounded, not about an empty or errored result.
    expect(facts.map((f) => f.uuid)).toContain("f-dealA-1");
    assertNoLeak(facts, [BARE_ORG_CONFIDENTIAL]);
  });

  // The same question on the ordinary (hybrid) read path a real product surface
  // takes. Kept separate from the case above because a failure here is
  // ambiguous on its own — pgvector's `scopePath IS NULL` clause would return
  // this fact even with the fallback leg deleted — so this case measures
  // reachability in production, while the Graphiti-only case above attributes
  // it to the leg. pgvector-store.ts's own `scopePath IS NULL` branch (cause 2)
  // is gated the same way (input.includeUntagged), so this holds independently
  // of the Graphiti leg above (either mechanism alone would satisfy this case,
  // so on its own it cannot tell the two causes apart).
  it("a Deal A-only capability does NOT surface a bare-org-ingested confidential fact on the ordinary hybrid read path", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(BARE_ORG_GRAPH));
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const { facts } = await guarded.retrieve(
      ctx,
      { groupId: ORG_ID, query: "what should the contractor know" },
      DEAL_A,
    );

    // Same non-vacuity guard as the case above: a real, working, in-scope read…
    expect(facts.map((f) => f.uuid)).toContain("f-dealA-1");
    // …that correctly stays bounded.
    assertNoLeak(facts, [BARE_ORG_CONFIDENTIAL]);
    // And the sibling deal still does NOT leak — the containment that already
    // worked is unaffected.
    assertNoLeak(
      facts,
      MEMORY_GRAPH.filter((f) => f.uuid.startsWith("f-dealB")),
    );
  });

  // The mirror image of the Graphiti-only case, and the reason BOTH causes
  // have their own case. The case above cannot isolate pgvector: with the
  // fallback leg live, either mechanism alone satisfies it, so gating
  // pgvector's NULL rule on its own would leave it green and the second cause
  // would go unnoticed (disabling only the leg leaves that case passing).
  //
  // Isolating pgvector needs the Graphiti side to contribute nothing, which is
  // a real production state rather than a fixture contrivance: hybrid-store.ts
  // explicitly treats a rejected Graphiti leg — timeout, cold service, AuraDB
  // reconnect — as NON-fatal and answers from pgvector alone. In that degraded
  // state the fallback leg returns nothing at all (it is Graphiti-only by
  // construction, `skipPgvector: true`), so anything that leaks is pgvector's
  // `scopePath IS NULL` clause and nothing else. pgvector-store.ts's
  // includeUntagged gate closes this on its own, independent of the Graphiti
  // leg's gate.
  it("with Graphiti degraded, a Deal A-only capability still does NOT surface the bare-org fact — pgvector's own gate holds even when the fallback leg can't contribute", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(BARE_ORG_GRAPH, { graphitiDown: true }));
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const { facts } = await guarded.retrieve(
      ctx,
      { groupId: ORG_ID, query: "what should the contractor know" },
      DEAL_A,
    );

    // Non-vacuity: pgvector really is answering (its own in-scope content is
    // here), so this is a working degraded read, not an empty one.
    expect(facts.map((f) => f.uuid)).toContain("f-dealA-1");
    assertNoLeak(facts, [BARE_ORG_CONFIDENTIAL]);
    // Scope containment otherwise intact even while degraded.
    assertNoLeak(
      facts,
      MEMORY_GRAPH.filter((f) => f.uuid.startsWith("f-dealB")),
    );
  });

  // Control, and the reason the no-leak cases above are a real gate and not a
  // fixture artefact: the confidential fact IS legitimately reachable by a
  // caller reading at the bare org id (no narrow scope), where the fallback
  // leg never fires at all (`target !== input.groupId` is false). If this went
  // red, the fixture would simply not be storing the fact, and the cases above
  // would prove nothing either way.
  it("the same fact IS returned to a bare-org read, where the fallback leg never fires — so the cases above are a real gate, not a missing fixture", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(BARE_ORG_GRAPH));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "who is the champion" });

    expect(facts.map((f) => f.uuid)).toContain("f-bare-org-confidential");
  });

  // Attribution, at the store boundary rather than the result. An ungated
  // fallback leg's second retrieve() call is aimed at the bare org id while the
  // caller's own checked scope is Deal A, a question strictly wider than the
  // scope check() approved, and `scopePath: DEAL_A` is inert on it
  // (graphiti-store.ts's retrieve() sends only `group_id`, `query` and `limit`,
  // never `scope_path`, even though its own ingest() does send it; Graphiti has
  // no scope_path concept to filter on in the first place, see the
  // `includeUntagged` doc comment in guarded-store.ts's retrieve()).
  //
  // The leg's invocation is gated on the same org-root-grant check
  // (pathCovers) as pgvector's `scopePath IS NULL` clause — a narrow-scoped
  // caller's read never issues the widening call at all.
  it("a Deal A-only scope's read never issues the bare-org widening call at all — only the leg the scope check() actually approved runs", async () => {
    const store = fixtureScopedStore(BARE_ORG_GRAPH);
    const guarded = new GuardedMemoryStore(store);
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");

    await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, DEAL_A);

    const calls = vi.mocked(store.retrieve).mock.calls.map(([i]) => i);
    // Leg 1 only: the scope check() actually approved.
    expect(calls).toEqual([expect.objectContaining({ groupId: DEAL_A, scopePath: DEAL_A, includeUntagged: false })]);
    // In particular, no call ever asks for the bare org id's own group — the
    // widened, unfiltered query a leak would come from.
    expect(calls.some((c) => c.groupId === ORG_ID)).toBe(false);
  });

  // The widening leg isn't deleted — it's gated. A caller whose checked scope
  // genuinely covers org root (here: no scope override at all, so check()
  // itself defaults to orgRootPath(ctx.orgId)) still gets the completeness the
  // leg exists for once a *narrower* target is requested downstream of that
  // grant (e.g. a UI-selected scope under an admin's own root capability).
  it("a caller whose checked scope covers org root DOES still get the bare-org widening leg for a narrower target — the leg is gated, not removed", async () => {
    const store = fixtureScopedStore(BARE_ORG_GRAPH);
    const guarded = new GuardedMemoryStore(store);
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "admin" }, origin: "app" };
    allow("read");

    // check() validates this exact scope, and pathCovers(orgRootPath(ORG_ID),
    // orgRootPath(ORG_ID)) is true by definition (self), so hasOrgRootGrant holds.
    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, orgRootPath(ORG_ID));

    const calls = vi.mocked(store.retrieve).mock.calls.map(([i]) => i);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: orgRootPath(ORG_ID), scopePath: orgRootPath(ORG_ID) }),
        expect.objectContaining({ groupId: ORG_ID, scopePath: orgRootPath(ORG_ID), skipPgvector: true }),
      ]),
    );
    // And the untagged content is legitimately visible here — this caller's
    // checked scope really does cover org root.
    expect(facts.map((f) => f.uuid)).toContain("f-bare-org-confidential");
  });
});

// ---------------------------------------------------------------------------
// Case 8 — the BARE-ORG fallback leg on entity()
//
// entity() has the exact same bare-org Graphiti fallback shape as retrieve()
// (guarded-store.ts's own comment on the leg: "Same bare-org Graphiti
// fallback as retrieve() above"), and it must be gated the same way. Ungated,
// a Deal-A-only capability, given the id of a confidential entity seeded ONLY
// under the bare org id (no scopePath at ingest — the same untagged-production
// shape Case 7 names), gets it back via guardedMemory.entity(). Reachable in
// production through both the memory_entity MCP tool (mcp/tools.ts) and the
// REST route (app/api/memory/entities/[id]/route.ts) — both call
// guardedMemory.entity() directly with no branching logic of their own (see
// app/api/memory/memory-routes.test.ts's coverage that the route forwards
// verbatim), so the one shared method covers both. Narrower than Case 7
// above: the caller must already know the entity id (targeted disclosure),
// not free-text trawling, but still a real out-of-scope read of the same
// class.
// ---------------------------------------------------------------------------

interface FixtureEntity {
  uuid: string;
  name: string;
  type: string;
  scopePath: string | null;
}

/** A confidential entity seeded by one of the untagged production ingest
 * paths (Case 7's six call sites) — no scopePath, so it lands under the BARE
 * org id, identical partitioning to BARE_ORG_CONFIDENTIAL above. */
const BARE_ORG_CONFIDENTIAL_ENTITY: FixtureEntity = {
  uuid: "e-bare-org-confidential",
  name: "Acme Holdings (acquisition target, board-only)",
  type: "Company",
  scopePath: null,
};

/** Mirrors graphiti-store.ts's real entity() partitioning: exact `groupId`
 * match only, no containment and no fallback of its own (same rule
 * `graphitiGroupOf` above already models for retrieve()'s fixture). */
function entityFixtureStore(entities: FixtureEntity[]) {
  return vi.fn(async (input: { groupId: string; entityId: string; groupIds?: string[] }) => {
    const asked = input.groupIds ?? [input.groupId];
    const hit = entities.find((e) => e.uuid === input.entityId && asked.includes(e.scopePath ?? ORG_ID));
    return hit
      ? { uuid: hit.uuid, name: hit.name, type: hit.type, facts: [], graphGroupId: toGid(hit.scopePath ?? ORG_ID) }
      : null;
  });
}

function fixtureEntityInnerStore(entities: FixtureEntity[]): MemoryStore {
  return {
    ingest: vi.fn(),
    retrieve: vi.fn(),
    entity: entityFixtureStore(entities),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

describe("access-control leakage — bare-org fallback leg on entity()", () => {
  it("a Deal A-only capability does NOT retrieve a bare-org-seeded confidential entity by id — guardedMemory.entity() directly", async () => {
    const guarded = new GuardedMemoryStore(fixtureEntityInnerStore([BARE_ORG_CONFIDENTIAL_ENTITY]));
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent"); // grant covers org_1.dealA ONLY — never org root

    const result = await guarded.entity(ctx, { groupId: ORG_ID, entityId: "e-bare-org-confidential" }, DEAL_A);

    expect(result).toBeNull();
  });

  // Control: the same entity IS legitimately reachable at the bare org id
  // itself, where the fallback leg never fires (`target !== input.groupId` is
  // false) — proves the case above is a real gate, not a fixture that simply
  // never stores the entity.
  it("the same entity IS returned to a bare-org read, where the fallback leg never fires", async () => {
    const guarded = new GuardedMemoryStore(fixtureEntityInnerStore([BARE_ORG_CONFIDENTIAL_ENTITY]));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "member" }, origin: "app" };
    allow("read");

    const result = await guarded.entity(ctx, { groupId: ORG_ID, entityId: "e-bare-org-confidential" });

    expect(result?.uuid).toBe("e-bare-org-confidential");
  });

  // The leg isn't deleted, only gated: a caller whose checked scope genuinely
  // covers org root still gets the fallback for a narrower target — same
  // relationship Case 7 pins for retrieve() (last case above).
  it("a caller whose checked scope covers org root DOES still get the bare-org fallback for a narrower target", async () => {
    const guarded = new GuardedMemoryStore(fixtureEntityInnerStore([BARE_ORG_CONFIDENTIAL_ENTITY]));
    const ctx: AccessContext = { orgId: ORG_ID, actor: { type: "human", id: "user_1", role: "admin" }, origin: "app" };
    allow("read");

    const result = await guarded.entity(
      ctx,
      { groupId: ORG_ID, entityId: "e-bare-org-confidential" },
      orgRootPath(ORG_ID),
    );

    expect(result?.uuid).toBe("e-bare-org-confidential");
  });

  // The second reachable production call site: the memory_entity MCP tool
  // (mcp/tools.ts) delegates to guardedMemory.entity() with no logic of its
  // own — proves the gate holds on this path too, not just the direct call
  // above.
  it("via the memory_entity MCP tool, a Deal A-only capability gets 'Entity not found' rather than the bare-org-seeded confidential entity", async () => {
    vi.mocked(memory.entity).mockImplementation(entityFixtureStore([BARE_ORG_CONFIDENTIAL_ENTITY]));
    const ctx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const server = fakeMcpServer();
    registerWillderTools(server as unknown as McpServer, ctx, {
      orgId: ORG_ID,
      agentId: "handoff-agent",
      scopePath: DEAL_A,
    });
    const memoryEntity = server.tools.get("memory_entity");
    expect(memoryEntity, "mcp/tools.ts must register a memory_entity tool").toBeDefined();

    const result = await memoryEntity!({ entityId: "e-bare-org-confidential" });

    const text = result.content.map((c) => c.text).join(" | ");
    expect(text).toBe("Entity not found.");
    expect(text).not.toContain("Acme Holdings");
  });
});
