/**
 * The authorized-descendant query must fire on the shape production reads
 * with.
 *
 * access-leakage-eval.test.ts's Case 6 proves the descendant walk on a
 * fixture where the registered descendant scopes are children of the BARE
 * tenant id (`org_1.dealA`, with `ORG_ID = "org_1"`). Production never has
 * that shape. Two separate strings are involved and they are NOT the same:
 *
 *   • the bare tenant/org id            — `Org.id`, a cuid, e.g. "clx1abcd"
 *     (this is `input.groupId`: app/api/memory/query/route.ts passes
 *      `groupId: rc.org.id`, mcp/tools.ts passes `groupId: ctx.orgId`)
 *   • the org-root SCOPE path           — `orgRootPath(orgId)` = "org_clx1abcd"
 *     (this is what `scopes.path` is actually seeded with — lib/tenant.ts's
 *      ensureAccessRoot — and what every real descendant scope hangs off:
 *      app/api/sources/route.ts roots a Drive folder's scope at
 *      `orgRootPath(rc.org.id)`)
 *
 * So in production every registered `Scope.path` starts with `org_<orgId>`,
 * never with the bare `<orgId>`.
 *
 * That matters because GuardedMemoryStore uses `target = scope ?? input.groupId`
 * (the BARE org id when no scope is supplied) while check() authorizes
 * `req.scope ?? orgRootPath(ctx.orgId)` (the org ROOT PATH). The descendant
 * walk feeds `target` to descendantScopePaths(), which does
 * `path: { startsWith: `${targetPath}.` }`.
 *
 * These tests model the registered-scope lookup as the real DB would answer
 * it (a genuine prefix filter over a registry of production-shaped paths,
 * not a canned array that ignores the `where` clause), so they can tell the
 * difference between "the fix ran" and "the mock handed back rows".
 */
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
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_test_id" }),
      update: vi.fn(),
    },
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
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { toGid } from "./graphiti-store";
import { orgRootPath, type AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { EntityLookup, MemoryEntity, MemoryFact, SearchInput } from "@/types/memory";

/** Production shape: a cuid tenant id, NOT something that looks like a path. */
const ORG_ID = "clx1abcd";
/** What lib/tenant.ts actually seeds `scopes.path` with for that org. */
const ORG_ROOT = orgRootPath(ORG_ID); // "org_clx1abcd"
const DEAL_A = `${ORG_ROOT}.dealA`;
const DEAL_B = `${ORG_ROOT}.dealB`;

/**
 * The org's real `scopes` table, exactly as lib/tenant.ts + app/api/sources
 * would have created it: root seeded by ensureAccessRoot, one scope per
 * Drive-connected folder, each rooted at `orgRootPath(orgId)`.
 */
const REGISTERED_SCOPES = [ORG_ROOT, DEAL_A, DEAL_B];

interface FixtureFact extends MemoryFact {
  scopePath: string | null;
}

/**
 * Drive-extracted content: `actorType: "extraction"`, which hybrid-store.ts
 * routes to Graphiti ONLY (pgvector never holds it), partitioned under its
 * own scopePath. This is precisely the content the descendant walk un-hides.
 */
const MEMORY_GRAPH: FixtureFact[] = [
  {
    uuid: "f-dealA-drive",
    fact: "Deal A: MSA extracted from Drive, term is 24 months",
    validAt: null,
    actorType: "extraction",
    scopePath: DEAL_A,
  },
  {
    uuid: "f-dealB-drive",
    fact: "Deal B: MSA extracted from Drive, term is 12 months",
    validAt: null,
    actorType: "extraction",
    scopePath: DEAL_B,
  },
  { uuid: "f-org-wide", fact: "Willder's list price starts at $99/mo", validAt: null, scopePath: null },
];

/** graphiti-store.ts's `group_id: toGid(input.scopePath ?? input.groupId)`. */
const graphitiGroupOf = (f: FixtureFact): string => f.scopePath ?? ORG_ID;

/** The partitions one graph call asks: `groupId`, plus `groupIds` when set (graphiti-store.ts). */
const groupsAsked = (input: { groupId: string; groupIds?: string[] }): string[] => [
  input.groupId,
  ...(input.groupIds ?? []),
];

/** Same two-leg shape as access-leakage-eval.test.ts's own fixture store. */
function fixtureScopedStore(graph: FixtureFact[]): MemoryStore {
  const retrieve = vi.fn(async (input: SearchInput & { skipPgvector?: boolean; tenantId?: string }) => {
    const graphitiHits = graph.filter((f) => groupsAsked(input).includes(graphitiGroupOf(f)));
    if (input.skipPgvector) {
      return { facts: graphitiHits.map(toFact) };
    }
    const scope = input.scopePath;
    const pgHits = graph.filter((f) => {
      if (f.actorType === "extraction") return false; // Graphiti-only tier
      if (!scope) return true;
      if (f.scopePath === null) return true;
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
    return { facts: merged.map(toFact) };
  });
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

/**
 * An entity store keyed the way Graphiti actually partitions entities: an
 * exact `group_id` match and nothing else (graphiti-store.ts entity()), with
 * no pgvector leg at all to fall back on (pgvector-store.ts entity() is a
 * hard `return null`). `entitiesByScope` maps the scope an entity was seeded
 * under to the entity itself; every other group_id gets null.
 */
function fixtureEntityStore(entitiesByScope: Record<string, MemoryEntity>): MemoryStore {
  return {
    ingest: vi.fn(),
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn(async (input: EntityLookup) => {
      const scope = (input.groupIds ?? [input.groupId]).find((groupId) => entitiesByScope[groupId]);
      return scope ? { ...entitiesByScope[scope], graphGroupId: toGid(scope) } : null;
    }),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

/** A Drive-seeded entity living under deal A, one level below the org root. */
const DEAL_A_ENTITY: MemoryEntity = {
  uuid: "e-dealA",
  name: "Acme Corp",
  type: "Company",
  facts: [],
} as unknown as MemoryEntity;

const toFact = (f: FixtureFact): MemoryFact => ({
  uuid: f.uuid,
  fact: f.fact,
  validAt: f.validAt,
  actorType: f.actorType,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  // check(): an org-root admin grant. This caller is authorized for
  // `orgRootPath(ORG_ID)` and therefore, by ltree `@>` containment, for every
  // descendant scope in the org — the broad/ancestor-scoped capability the
  // descendant walk serves.
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "admin" }] as never);
  // Answer the registry lookup the way strictDescendantScopePaths() does:
  // strict descendants of the requested target over the org's real registered
  // scope paths, rather than a canned list that ignores the target.
  vi.mocked(strictDescendantScopePaths).mockImplementation(async (_orgId, target) =>
    REGISTERED_SCOPES.filter((p) => p.startsWith(`${target}.`)),
  );
});

const ctx: AccessContext = {
  orgId: ORG_ID,
  actor: { type: "human", id: "user_1", role: "admin" },
  origin: "app",
};

describe("authorized-descendant-query on the shape production actually reads with", () => {
  it("CONTROL: an explicitly org-ROOT-scoped read does surface both deals' Drive-extracted content", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));

    // scope = orgRootPath(orgId): what mcp/tools.ts resolves to via
    // resolveCallerScopePath() when a capability is scoped at the org root.
    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, ORG_ROOT);

    expect(strictDescendantScopePaths).toHaveBeenCalledWith(ORG_ID, ORG_ROOT);
    expect(facts.map((f) => f.uuid)).toEqual(expect.arrayContaining(["f-dealA-drive", "f-dealB-drive"]));
  });

  it("a scope-less read (app/api/memory/query with no `scope` in the body) ALSO surfaces descendant Drive-extracted content — the caller holds org-root admin, so this content is fully authorized", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));

    // Exactly what app/api/memory/query/route.ts does when the request body
    // carries no `scope`: `body.scope?.trim() || undefined` -> undefined.
    // check() authorizes orgRootPath(ORG_ID) for this caller (default-deny
    // gate passed), so every deal below it is inside the caller's envelope.
    const { facts } = await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, undefined);

    expect(facts.map((f) => f.uuid)).toEqual(expect.arrayContaining(["f-dealA-drive", "f-dealB-drive"]));
  });

  it("the scope-less read's descendant lookup is issued against the org ROOT PATH, not the bare tenant id (no registered scope can ever start with the bare id)", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(MEMORY_GRAPH));

    await guarded.retrieve(ctx, { groupId: ORG_ID, query: "deal status" }, undefined);

    // `${ORG_ID}.` can never match a registered path: lib/tenant.ts seeds the
    // root as `org_<orgId>` and every descendant hangs off that.
    expect(strictDescendantScopePaths).not.toHaveBeenCalledWith(ORG_ID, ORG_ID);
    expect(strictDescendantScopePaths).toHaveBeenCalledWith(ORG_ID, ORG_ROOT);
  });

  /**
   * entity() carries the identical `target` vs. authorized-scope split as
   * retrieve(). access-flow.test.ts's descendant entity case passes an
   * EXPLICIT scope ("org_1.dealA"), and when `scope` is set `scope ??
   * orgRootPath(ctx.orgId)` and `target` are the same string — so that test
   * passes either way and cannot see a leg that walks from `target`. These two
   * pin the scope-less shape.
   */
  it("a scope-less entity() lookup finds an entity that lives under a real registered descendant scope", async () => {
    const guarded = new GuardedMemoryStore(fixtureEntityStore({ [DEAL_A]: DEAL_A_ENTITY }));

    // No `scope` argument at all — the shape app/api/memory/chat/route.ts:206
    // reads with. The caller holds org-root admin, so deal A is inside their
    // envelope; the entity is only reachable under DEAL_A's own partition.
    const hit = await guarded.entity(ctx, { groupId: ORG_ID, entityId: "e-dealA" });

    expect(hit?.uuid).toBe("e-dealA");
  });

  it("the scope-less entity() descendant lookup is issued against the org ROOT PATH, not the bare tenant id", async () => {
    const guarded = new GuardedMemoryStore(fixtureEntityStore({ [DEAL_A]: DEAL_A_ENTITY }));

    await guarded.entity(ctx, { groupId: ORG_ID, entityId: "e-dealA" });

    expect(strictDescendantScopePaths).not.toHaveBeenCalledWith(ORG_ID, ORG_ID);
    expect(strictDescendantScopePaths).toHaveBeenCalledWith(ORG_ID, ORG_ROOT);
  });
});
