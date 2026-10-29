// Scale, concurrency and malformed-input eval — the memory read path under the
// shapes production actually produces, rather than the three-fact fixtures the
// rest of the suite uses.
//
// Every other access-control test runs against a handful of facts, one caller
// at a time, with well-formed input. The documented SaaS failure classes are
// the opposite of that — tenant-isolation breaks that only appear on a small
// parameter change, concurrency bugs invisible to single-user tests, and
// unhandled edge-case input. A scope filter that is correct for six facts and
// wrong for six thousand, or correct alone and wrong interleaved, is exactly
// the bug class that ships.
//
// Seam under test: the real (unmocked) GuardedMemoryStore over a fixture store
// whose filter mirrors pgvector-store.ts's production WHERE clause (same
// approach, and the same faithfulness obligation, as
// access-leakage-eval.test.ts's fixtureScopedStore). Only @/lib/db and the
// store singleton are mocked.
//
// Cases here assert CORRECT behavior — they are regression guards for
// properties that hold, not documentation of bugs.
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

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    // retrieve() sends its SELECT in one transaction with the index's probe count.
    $executeRawUnsafe: vi.fn(),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    auditLog: { create: vi.fn(), update: vi.fn() },
    brief: { findFirst: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
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

import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { PgvectorMemoryStore } from "./pgvector-store";
import { AccessDeniedError, hashCapabilityToken, type AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact, SearchInput } from "@/types/memory";

const ORG = "org_scale";

interface FixtureFact extends MemoryFact {
  scopePath: string | null;
}

// ---------------------------------------------------------------------------
// A production-shaped graph: 12 sibling deals, each 5 scopes deep, 100 facts per
// leaf — 6,000 scoped facts plus org-wide and org-root ones. Deep enough that a
// prefix bug (`startsWith(scope)` instead of `startsWith(scope + ".")`) has
// somewhere to hide, and wide enough that a caller scoped to one leaf has
// thousands of facts it must never see.
// ---------------------------------------------------------------------------
const DEALS = Array.from({ length: 12 }, (_, i) => `deal${i}`);
const DEPTH = ["", ".notes", ".notes.legal", ".notes.legal.redlines", ".notes.legal.redlines.v2"];

function buildGraph(): FixtureFact[] {
  const facts: FixtureFact[] = [];
  for (const deal of DEALS) {
    for (const suffix of DEPTH) {
      const scope = `${ORG}.${deal}${suffix}`;
      for (let n = 0; n < 100; n++) {
        facts.push({
          uuid: `f-${deal}${suffix}-${n}`,
          fact: `[${scope}] confidential item ${n}`,
          validAt: null,
          scopePath: scope,
        });
      }
    }
  }
  facts.push({ uuid: "f-orgwide", fact: "[org-wide] list price starts at $99/mo", validAt: null, scopePath: null });
  facts.push({ uuid: "f-orgroot", fact: "[org-root] Q4 layoffs, confidential", validAt: null, scopePath: ORG });
  // The adversarial neighbours: scope names that are string-prefixes of deal1's
  // path but are NOT descendants of it. A containment check written with a bare
  // startsWith(scope) — no dot — hands every one of these to a deal1 caller.
  // Labelled `[<own scope>] COLLIDER ...` like every other fact, so the ordinary
  // scope assertions treat them as normal members of their own scope, and the
  // collision case below can find them by the COLLIDER marker.
  facts.push({
    uuid: "f-deal10-collider",
    fact: `[${ORG}.deal10] COLLIDER sibling whose name extends deal1`,
    validAt: null,
    scopePath: `${ORG}.deal10`,
  });
  facts.push({
    uuid: "f-deal1x-collider",
    fact: `[${ORG}.deal1x] COLLIDER another extending sibling`,
    validAt: null,
    scopePath: `${ORG}.deal1x`,
  });
  facts.push({
    uuid: "f-deal1-notes-collider",
    fact: `[${ORG}.deal1-notes] COLLIDER hyphen, not a child`,
    validAt: null,
    scopePath: `${ORG}.deal1-notes`,
  });
  // Underscore neighbours, for the LIKE-wildcard case at the bottom of this
  // file. ltree labels permit `_`, and Postgres LIKE treats `_` as a
  // single-character wildcard — so a scope label containing an underscore makes
  // the production `scope + ".%"` pattern match same-tenant siblings that differ
  // exactly at that character. `deptXsales` is that sibling for `dept_sales`.
  facts.push({
    uuid: "f-deptsales-own",
    fact: `[${ORG}.dept_sales.q3] own child, legitimately in scope`,
    validAt: null,
    scopePath: `${ORG}.dept_sales.q3`,
  });
  facts.push({
    uuid: "f-deptXsales-collider",
    fact: `[${ORG}.deptXsales.q3] UNDERSCORE-COLLIDER different scope subtree`,
    validAt: null,
    scopePath: `${ORG}.deptXsales.q3`,
  });
  return facts;
}

const GRAPH = buildGraph();

/** Mirrors pgvector-store.ts's real filter: null scope is org-wide, exact match,
 *  or a `scope + "."` descendant.
 *
 *  A fixture that reimplements the production predicate can drift from it, and
 *  then every volume case below goes on passing while the real SQL regresses —
 *  a fair criticism raised on this file's first review. Two things answer it, so
 *  the fidelity is enforced rather than asserted: the "production boundary"
 *  describe at the bottom of this file drives the REAL PgvectorMemoryStore and
 *  pins the actual WHERE clause and bound parameters, and a case there replays
 *  the production LIKE pattern over this same graph and requires it to classify
 *  every fact identically to this function. If pgvector's filter changes, that
 *  case fails. */
function fixtureScopedStore(graph: FixtureFact[]): MemoryStore {
  return {
    ingest: vi.fn(),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
    retrieve: vi.fn(async (input: SearchInput) => {
      const scope = input.scopePath;
      const visible = graph.filter((f) => {
        if (!scope) return true;
        // Mirrors pgvector-store.ts's real input.includeUntagged gate
        // (set by GuardedMemoryStore from a pure org-root containment check) —
        // untagged content is only visible when this leg's checked scope genuinely
        // covers org root, not for every scoped caller.
        if (f.scopePath === null) return !!input.includeUntagged;
        if (f.scopePath === scope) return true;
        return f.scopePath.startsWith(scope + ".");
      });
      // Honour the caller's limit the way a real backend's LIMIT would.
      const capped = input.limit ? visible.slice(0, input.limit) : visible;
      return { facts: capped.map(({ scopePath: _drop, ...f }) => f) };
    }),
  } as unknown as MemoryStore;
}

// Every capabilityToken an agent context in this file presents, mapped to the
// agentId a real Capability row would carry for it (evaluate() compares the
// two, so a static "always allow" row needs a real match per
// token rather than one fixed agentId for every caller). Human contexts hit
// the same mocked $queryRaw but never read `agentId`, so an unmatched hash
// (any human call, or a token this map doesn't know) is harmless here.
const AGENT_ID_BY_TOKEN: Record<string, string> = {
  t: "a1",
  tok: "shared-agent",
  ...Object.fromEntries(DEALS.map((deal) => [`tok-${deal}`, `agent-${deal}`])),
};
const AGENT_ID_BY_HASH: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_ID_BY_TOKEN).map(([token, agentId]) => [hashCapabilityToken(token), agentId]),
);
const allow = () =>
  vi.mocked(db.$queryRaw).mockImplementation(((_strings: unknown, ...values: unknown[]) => {
    const hash = values[1] as string;
    return Promise.resolve([{ permission: "write", agentId: AGENT_ID_BY_HASH[hash] }]);
  }) as never);
const deny = () => vi.mocked(db.$queryRaw).mockResolvedValue([] as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
});

// ---------------------------------------------------------------------------
// Scope isolation at volume + depth
// ---------------------------------------------------------------------------

describe("scale — scope isolation holds across a 6,000-fact graph", () => {
  it("a caller scoped to one leaf sees only that leaf, not the other 5,900 facts", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "u1", role: "member" }, origin: "app" };
    allow();

    const scope = `${ORG}.deal3.notes.legal.redlines`;
    const { facts } = await guarded.retrieve(ctx, { groupId: ORG, query: "everything", limit: 10_000 }, scope);

    // 100 at the scope itself + 100 in its one descendant (.v2). No + 1 for the
    // org-wide fact — this scope doesn't cover org root, so untagged content is
    // excluded.
    expect(facts).toHaveLength(200);
    const foreign = facts.filter((f) => !f.fact.startsWith(`[${scope}`) && !f.fact.startsWith("[org-wide]"));
    expect(
      foreign,
      `leaked: ${foreign
        .slice(0, 3)
        .map((f) => f.fact)
        .join(" | ")}`,
    ).toEqual([]);
  });

  it("deep traversal: an ancestor scope pulls its whole 5-level subtree and nothing sideways", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "u1", role: "member" }, origin: "app" };
    allow();

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG, query: "everything", limit: 10_000 }, `${ORG}.deal1`);

    // 5 levels x 100 facts. No + 1 for the org-wide fact — `${ORG}.deal1`
    // doesn't cover org root either.
    expect(facts).toHaveLength(500);
    expect(facts.every((f) => f.fact.startsWith(`[${ORG}.deal1.`) || f.fact.startsWith(`[${ORG}.deal1]`))).toBe(true);
  });

  it("the prefix-collision neighbours (deal10, deal1x, deal1-notes) never reach a deal1 caller", async () => {
    // This is the small-parameter-change tenant break in miniature: three scope
    // names that a dot-less prefix check would treat as children of deal1.
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "u1", role: "member" }, origin: "app" };
    allow();

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG, query: "everything", limit: 10_000 }, `${ORG}.deal1`);

    const text = facts.map((f) => f.fact).join(" | ");
    expect(text, "a prefix-collision sibling leaked into a deal1-scoped read").not.toContain("COLLIDER");
    const ids = facts.map((f) => f.uuid);
    for (const leaked of ["f-deal10-collider", "f-deal1x-collider", "f-deal1-notes-collider"]) {
      expect(ids, `${leaked} leaked into a deal1-scoped read`).not.toContain(leaked);
    }
    // And the collision facts really are in the graph — otherwise this case
    // would pass simply because there was nothing to leak. Matched by id, not
    // by the COLLIDER marker, since the underscore case at the bottom of this
    // file adds its own separately-named collider.
    for (const id of ["f-deal10-collider", "f-deal1x-collider", "f-deal1-notes-collider"]) {
      expect(
        GRAPH.map((f) => f.uuid),
        `${id} must exist to be leakable`,
      ).toContain(id);
    }
  });

  it("a large read writes ONE audit row carrying every returned fact id — the trail scales with the read", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "a1", capabilityToken: "t" },
      origin: "mcp",
      runId: "run_1",
    };
    allow();

    const { facts } = await guarded.retrieve(ctx, { groupId: ORG, query: "everything", limit: 10_000 }, `${ORG}.deal1`);

    const factIdRows = vi
      .mocked(db.auditLog.create)
      .mock.calls.map(([a]) => (a as { data: { action: string; metadata?: { factIds?: string[] } } }).data)
      .filter((d) => d.action === "memory.read.factIds");
    expect(factIdRows).toHaveLength(1);
    expect(factIdRows[0].metadata?.factIds).toHaveLength(facts.length);
    // Operational note for the report, asserted rather than assumed: a single
    // scoped read already puts a ~14KB JSON array in one audit_log row. This is
    // correct behavior (the trail must be complete) but it is the number that
    // decides whether audit_log needs its own retention story.
    const bytes = JSON.stringify(factIdRows[0].metadata?.factIds).length;
    expect(bytes).toBeGreaterThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — overlapping callers
// ---------------------------------------------------------------------------

describe("concurrency — interleaved reads by different callers never cross scopes", () => {
  it("12 different deal-scoped callers reading at once each get only their own deal", async () => {
    // GuardedMemoryStore holds no per-request state today. This pins that: if
    // anyone later caches a scope, decision, or ctx on the instance, these
    // interleaved reads start bleeding into each other and this fails.
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    allow();

    const results = await Promise.all(
      DEALS.map((deal) =>
        guarded
          .retrieve(
            {
              orgId: ORG,
              actor: { type: "agent", id: `agent-${deal}`, capabilityToken: `tok-${deal}` },
              runId: `run-${deal}`,
              origin: "mcp",
            },
            { groupId: ORG, query: "everything", limit: 10_000 },
            `${ORG}.${deal}`,
          )
          .then((r) => ({ deal, facts: r.facts })),
      ),
    );

    for (const { deal, facts } of results) {
      const foreign = facts.filter(
        (f) =>
          !f.fact.startsWith(`[${ORG}.${deal}]`) &&
          !f.fact.startsWith(`[${ORG}.${deal}.`) &&
          !f.fact.startsWith("[org-wide]"),
      );
      expect(foreign, `${deal} saw ${foreign[0]?.fact}`).toEqual([]);
    }
  });

  it("each concurrent run's fact-ids audit row carries its OWN runId, never a neighbour's", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    allow();

    await Promise.all(
      DEALS.map((deal) =>
        guarded.retrieve(
          {
            orgId: ORG,
            actor: { type: "agent", id: "shared-agent", capabilityToken: "tok" },
            origin: "mcp",
            runId: `run-${deal}`,
          },
          { groupId: ORG, query: "everything", limit: 10_000 },
          `${ORG}.${deal}`,
        ),
      ),
    );

    // Same actorId across all 12 runs — runId is the only thing that can tell
    // them apart, which is precisely why it exists.
    const rows = vi
      .mocked(db.auditLog.create)
      .mock.calls.map(
        ([a]) => (a as { data: { action: string; runId?: string; metadata?: { factIds?: string[] } } }).data,
      )
      .filter((d) => d.action === "memory.read.factIds");
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.runId))).toEqual(new Set(DEALS.map((d) => `run-${d}`)));

    // And each row's fact ids belong to that row's own deal — either an
    // org-wide fact (legitimately visible from every scope) or an id of the
    // form `f-<deal>-<n>` / `f-<deal>.<sub>-<n>`. The delimiter matters: a bare
    // `startsWith("f-deal1")` would also accept deal10's ids, which is the very
    // confusion these cases exist to catch.
    for (const row of rows) {
      const deal = row.runId!.replace("run-", "");
      const own = new RegExp(`^f-${deal}[.-]`);
      const strays = (row.metadata?.factIds ?? []).filter((id) => id !== "f-orgwide" && !own.test(id));
      expect(strays, `${row.runId} audited fact ids from another scope: ${strays.slice(0, 3).join(", ")}`).toEqual([]);
    }
  });

  it("a denied caller in the middle of a concurrent batch does not affect the allowed ones", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(GRAPH));
    // Deny only the second call; every other call is allowed. Interleaving a
    // denial is where a shared-state bug would most likely surface.
    let call = 0;
    vi.mocked(db.$queryRaw).mockImplementation((() => {
      call += 1;
      return Promise.resolve(call === 2 ? [] : [{ permission: "read" }]);
    }) as never);

    const settled = await Promise.allSettled(
      DEALS.slice(0, 4).map((deal) =>
        guarded.retrieve(
          { orgId: ORG, actor: { type: "human", id: `u-${deal}`, role: "member" }, origin: "app" },
          { groupId: ORG, query: "everything", limit: 10_000 },
          `${ORG}.${deal}`,
        ),
      ),
    );

    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AccessDeniedError);
    for (const s of settled.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      facts: MemoryFact[];
    }>[]) {
      expect(s.value.facts.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed and partial input
// ---------------------------------------------------------------------------

describe("malformed input — the tenant guard against near-miss group ids", () => {
  const guarded = () => new GuardedMemoryStore(fixtureScopedStore(GRAPH));
  const ctxFor = (): AccessContext => ({
    orgId: ORG,
    actor: { type: "human", id: "u1", role: "admin" },
    origin: "app",
  });

  it.each([
    [`${ORG}_evil`, "underscore-extended org id"],
    [`${ORG}x`, "character-extended org id"],
    [`${ORG}-other`, "hyphen-extended org id"],
    ["org_scal", "truncated org id"],
    ["", "empty group id"],
  ])("rejects group id %s (%s) before any store call", async (groupId) => {
    allow();
    const store = fixtureScopedStore(GRAPH);
    const g = new GuardedMemoryStore(store);

    await expect(g.retrieve(ctxFor(), { groupId, query: "everything" })).rejects.toBeInstanceOf(AccessDeniedError);
    // The guard must short-circuit before the gate and the store, and its refusal
    // is the one row audited (every refusal leaves a deny row).
    expect(store.retrieve).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data).toMatchObject({
      actorId: "u1",
      action: "memory.read",
      target: groupId,
      decision: "deny",
    });
  });

  it.each([
    [ORG, "the org root itself"],
    [`${ORG}.deal1`, "a direct child"],
    [`${ORG}.deal1.notes.legal`, "a deep descendant"],
  ])("accepts group id %s (%s)", async (groupId) => {
    allow();
    await expect(guarded().retrieve(ctxFor(), { groupId, query: "everything" })).resolves.toBeTruthy();
  });

  it("an empty query still passes through the gate and is audited, never silently skipped", async () => {
    // A partial/blank payload from a broken client must not bypass the
    // chokepoint — an unaudited read is worse than a useless one.
    allow();
    await guarded().retrieve(
      { orgId: ORG, actor: { type: "human", id: "u1", role: "member" }, origin: "app" },
      { groupId: ORG, query: "" },
      `${ORG}.deal1`,
    );

    const reads = vi
      .mocked(db.auditLog.create)
      .mock.calls.map(([a]) => (a as { data: { action: string; target: string } }).data)
      .filter((d) => d.action === "memory.read");
    expect(reads).toHaveLength(1);
    expect(reads[0].target).toContain("query:");
  });

  it("a denied read at volume returns nothing at all — not a truncated page", async () => {
    deny();
    await expect(
      guarded().retrieve(
        { orgId: ORG, actor: { type: "agent", id: "a1", capabilityToken: "revoked" }, origin: "mcp" },
        { groupId: ORG, query: "everything", limit: 10_000 },
        `${ORG}.deal1`,
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const factIdRows = vi
      .mocked(db.auditLog.create)
      .mock.calls.map(([a]) => (a as { data: { action: string } }).data)
      .filter((d) => d.action === "memory.read.factIds");
    expect(factIdRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The production boundary.
//
// Everything above runs against fixtureScopedStore(), which reimplements
// pgvector's scope predicate. That is what makes the volume and concurrency
// cases readable — but on its own it is coverage of the fixture, not of
// production: the real SQL could regress and those cases would stay green.
//
// These cases close that. They drive the REAL PgvectorMemoryStore through the
// REAL GuardedMemoryStore, pin the actual WHERE clause and bound parameters at
// depth, and then replay the production LIKE pattern over the same 6,000-fact
// graph and require it to agree with the fixture fact-for-fact. Drift between
// the two is a failure here, so the fixture cannot quietly stop representing
// production.
//
// (access-leakage-eval.test.ts pins the same boundary for a depth-1 scope; this
// adds the deep scope and the equivalence check, which is where the `.%` in the
// LIKE pattern actually earns its keep.)
// ---------------------------------------------------------------------------

/** Faithful-enough SQL LIKE: `%` is any run, `_` is any single character,
 *  everything else literal. `escape` mirrors SQL's `ESCAPE` clause — a character
 *  that makes the next `%`/`_` literal — which is how the underscore escape
 *  below is written. Enough for the `scope + ".%"` pattern pgvector sends.
 *
 *  `_` really is a wildcard here rather than a literal, and that is deliberate:
 *  treating it as literal is precisely the mistake that hides the sibling
 *  match. */
function sqlLike(value: string, pattern: string, escape?: string): boolean {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escape && ch === escape && i + 1 < pattern.length) {
      rx += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escaped: literal
      continue;
    }
    if (ch === "%") rx += ".*";
    else if (ch === "_") rx += ".";
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`).test(value);
}

/** Mirrors pgvector-store.ts's own escapeLikePrefix — an independent oracle for
 *  what the production bound LIKE parameter should look like, so the
 *  assertions below aren't just re-reading the implementation's own output. */
function likeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Run one real pgvector-backed retrieve and hand back the SQL + bound values. */
async function captureProductionQuery(scope: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: [0, 0, 0] }) }));
  const pgQuery = vi.fn().mockResolvedValue([]);
  // db.$queryRaw backs both check()'s grant lookup (first) and pgvector's own
  // SELECT (second) — queue the grant as a one-off ahead of the standing
  // pgvector implementation, same reasoning as access-leakage-eval.test.ts.
  // The descendant lookup is the separately mocked scope-registry module (no
  // descendants), so it doesn't touch this query count.
  vi.mocked(db.$queryRaw)
    .mockResolvedValueOnce([{ permission: "read" }] as never)
    .mockImplementation(pgQuery as never);

  const guarded = new GuardedMemoryStore(new PgvectorMemoryStore());
  await guarded.retrieve(
    { orgId: ORG, actor: { type: "human", id: "u1", role: "member" }, origin: "app" },
    { groupId: ORG, query: "everything", limit: 10_000 },
    scope,
  );

  expect(pgQuery).toHaveBeenCalledTimes(1);
  const [strings, ...values] = pgQuery.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join(""), values };
}

describe("production boundary — the real pgvector predicate, at depth", () => {
  it("a 4-level-deep scoped read sends the real isolation clause with the bare org id as tenant", async () => {
    const scope = `${ORG}.deal1.notes.legal.redlines`;
    const { sql, values } = await captureProductionQuery(scope);

    // Tenant isolation keys on the bare org id, never the scope-encoded path —
    // the guard forwards `tenantId` for exactly this reason.
    expect(sql).toContain('"orgId" = ');
    expect(values).toContain(ORG);
    expect(values).not.toContain(`${ORG}.deal1`);

    // Scope predicate: exact or descendant. The untagged/org-wide (NULL) branch
    // is absent here — this scope is narrower than orgRootPath(ORG), so the
    // caller's checked scope doesn't cover org root and the untagged partition
    // must not be included (see access-leakage-eval.test.ts's "production SQL
    // filter (pgvector)" cases for the full org-root-vs-narrow pin).
    expect(sql).not.toContain("IS NULL");
    expect(sql).toContain('"scopePath" = ');
    expect(sql).toContain('OR "scopePath" LIKE');
    expect(sql).toContain("ESCAPE");
    expect(values).toContain(scope);

    // The dot in the LIKE pattern is the whole ballgame: `scope + "%"` would
    // make deal10 a child of deal1. Pin the exact bound pattern — escaped
    // (see the underscore cases below), since `scope` itself carries an
    // underscore (`org_scale`).
    expect(values).toContain(`${likeEscape(scope)}.%`);
    expect(values).not.toContain(`${scope}.%`);
    expect(values).not.toContain(`${scope}%`);
  });

  it("the production LIKE pattern classifies all 6,000+ facts exactly as the fixture does", async () => {
    // This is the anti-drift check. Take the real bound parameters out of the
    // real query, apply real SQL LIKE semantics to the whole graph, and require
    // the result to equal what fixtureScopedStore() returns for the same scope.
    // If pgvector's predicate changes shape, these two disagree and this fails.
    const scope = `${ORG}.deal1`;
    const { values } = await captureProductionQuery(scope);
    const exact = values.find((v) => v === scope) as string;
    const likePattern = values.find((v) => typeof v === "string" && v.endsWith(".%")) as string;
    expect(exact, "the exact-match parameter must be bound").toBeDefined();
    expect(likePattern, "the descendant LIKE parameter must be bound").toBeDefined();

    // No `f.scopePath === null ||` branch — `scope` here ("org_scale.deal1")
    // doesn't cover org root, so the real SQL (pinned above:
    // `expect(sql).not.toContain("IS NULL")`) excludes untagged rows entirely,
    // and this JS reimplementation must classify the same way to stay a real
    // anti-drift check rather than one that's drifted itself.
    const bySql = GRAPH.filter(
      (f) => f.scopePath !== null && (f.scopePath === exact || sqlLike(f.scopePath, likePattern, "\\")),
    )
      .map((f) => f.uuid)
      .sort();

    const store = fixtureScopedStore(GRAPH);
    const { facts } = await store.retrieve({
      groupId: ORG,
      query: "everything",
      scopePath: scope,
      includeUntagged: false,
    });
    const byFixture = facts.map((f) => f.uuid).sort();

    // Exactly the 5-level x 100-fact subtree — no +1 org-wide fact, since this
    // scope doesn't cover org root.
    expect(bySql.length).toBe(500);
    expect(byFixture).toEqual(bySql);
    // And the prefix-collision siblings are excluded by the PRODUCTION pattern,
    // not merely by the fixture's own logic.
    for (const id of ["f-deal10-collider", "f-deal1x-collider", "f-deal1-notes-collider"]) {
      expect(bySql, `${id} matched the production LIKE pattern`).not.toContain(id);
    }
  });

  it('control: a `scope + "%"` pattern WOULD leak the collision siblings — proving the dot matters', async () => {
    // Without this, the case above only shows that today's pattern is fine, not
    // that the assertion would notice a bad one.
    const scope = `${ORG}.deal1`;
    const leaky = GRAPH.filter((f) => f.scopePath !== null && sqlLike(f.scopePath, `${scope}%`)).map((f) => f.uuid);
    expect(leaky).toContain("f-deal10-collider");
    expect(leaky).toContain("f-deal1x-collider");
    expect(leaky).toContain("f-deal1-notes-collider");
  });
});

// ---------------------------------------------------------------------------
// Postgres LIKE treats `_` as a wildcard, so pgvector's scope filter must
// escape it or match a sibling subtree.
//
// The anti-drift case above is blind to this class on its own, because every
// scope it uses (`deal1`, `deal3.notes.legal.redlines`) has no underscore in a
// CHILD label. Give it one and an unescaped fixture and production stop
// agreeing.
//
// Mechanism: in SQL LIKE, `_` matches any single character and has to be
// escaped to be literal. ltree labels permit `_`, and scopes are created via
// POST /api/access/scopes with user-chosen labels. So for a caller scoped to
// `org.dept_sales`, an unescaped `org.dept_sales.%` also matches
// `org.deptXsales.q3` — a different subtree, same tenant. That is a real
// cross-scope read of pgvector chunks, the one thing the scope filter exists
// to prevent.
//
// Bounded, stated precisely rather than over-claimed:
//   - It never crosses tenants: the query's separate `"orgId" = $tenant`
//     predicate still holds, so the underscore inside the `org_<cuid>` root
//     label is not exploitable.
//   - It never affects check()'s allow/deny decision, which uses ltree `@>`
//     containment, not LIKE. The gate is correct; only the DATA returned past
//     it would be wrong.
//   - It only bites a scope whose label contains `_` with a sibling differing
//     at exactly that position.
//
// pgvector-store.ts escapes `_` and `%` (and the escape character itself) in
// the bound prefix and adds an ESCAPE clause — see escapeLikePrefix() there,
// mirrored here as likeEscape(). check()'s own ltree containment logic (the
// gate itself) is separate.
// ---------------------------------------------------------------------------

describe("production boundary — an underscore in a scope label does not make LIKE match a sibling subtree", () => {
  it("the real bound pattern for a dept_sales scope is escaped and does not match deptXsales", async () => {
    const scope = `${ORG}.dept_sales`;
    const { sql, values } = await captureProductionQuery(scope);
    const likePattern = values.find((v) => typeof v === "string" && v.endsWith(".%")) as string;

    expect(likePattern).toBe(`${likeEscape(scope)}.%`);
    // The underscore is escaped and the SQL carries an ESCAPE clause, so
    // Postgres reads it literally instead of as a wildcard.
    expect(likePattern).toContain("\\_");
    expect(sql).toContain("ESCAPE");

    // Its own child still matches, as intended...
    expect(sqlLike(`${ORG}.dept_sales.q3`, likePattern, "\\")).toBe(true);
    // ...and the sibling subtree does not.
    expect(sqlLike(`${ORG}.deptXsales.q3`, likePattern, "\\")).toBe(false);
    // A sibling differing anywhere else is still excluded — which is what shows
    // this is the `_` wildcard specifically, not a wholesale broken pattern.
    expect(sqlLike(`${ORG}.dept_other.q3`, likePattern, "\\")).toBe(false);
  });

  it("production and the fixture agree on an underscore scope", async () => {
    // The anti-drift case above REQUIRES these two to agree; an unescaped
    // pattern is exactly where they would diverge.
    const scope = `${ORG}.dept_sales`;
    const { values } = await captureProductionQuery(scope);
    const exact = values.find((v) => v === scope) as string;
    const likePattern = values.find((v) => typeof v === "string" && v.endsWith(".%")) as string;

    const bySql = GRAPH.filter(
      (f) => f.scopePath === null || f.scopePath === exact || sqlLike(f.scopePath, likePattern, "\\"),
    ).map((f) => f.uuid);
    const { facts } = await fixtureScopedStore(GRAPH).retrieve({
      groupId: ORG,
      query: "everything",
      scopePath: scope,
    });
    const byFixture = facts.map((f) => f.uuid);

    // Both agree the caller's own child is visible.
    expect(bySql).toContain("f-deptsales-own");
    expect(byFixture).toContain("f-deptsales-own");

    // They agree on the collider: production does not leak it.
    expect(bySql, "production LIKE no longer matches the sibling subtree").not.toContain("f-deptXsales-collider");
    expect(byFixture, "the fixture correctly excludes it").not.toContain("f-deptXsales-collider");
  });

  it("control: escaping the underscore is what closes the sibling match", async () => {
    // Not an assertion about production — it demonstrates that the escape
    // itself is the mechanism, not something incidental.
    const escapedPattern = `${ORG}.dept\\_sales.%`;

    expect(sqlLike(`${ORG}.dept_sales.q3`, escapedPattern, "\\")).toBe(true);
    expect(sqlLike(`${ORG}.deptXsales.q3`, escapedPattern, "\\")).toBe(false);
    // And the same pattern WITHOUT the escape clause still leaks, so the escape
    // is doing the work rather than the backslash happening to break the match.
    expect(sqlLike(`${ORG}.deptXsales.q3`, `${ORG}.dept_sales.%`)).toBe(true);
  });
});
