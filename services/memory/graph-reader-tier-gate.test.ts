// Mocked end to end: needs no database; runs in every environment.
//
// Every guarded graph reader asks the graph exactly where the routing policy
// says a read on the org's tier may (`graphReadAllowed`), the same rule retrieve() has always
// applied to its graph leg. Driven through the real GuardedMemoryStore over the real
// HybridMemoryStore, with only its two leg stores mocked, so what is asserted is which leg
// each entry point reaches on each tier: the behavioural mirror test.
//
// On enterprise, the tier every org has today, every reader is unchanged: the same store
// calls with the same inputs, and no new field on the answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));
vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  return {
    check: vi.fn(),
    recordReadFactIds: vi.fn(),
    descendantScopePaths: vi.fn(),
    pathCovers: actual.pathCovers,
    orgRootPath: actual.orgRootPath,
    resolveExecutedPartition: actual.resolveExecutedPartition,
    AccessDeniedError: actual.AccessDeniedError,
  };
});
// The serve-time source recheck reads the stored sources behind each graph answer from
// Postgres. It is held to its rule in graph-fact-sources.test.ts and the realdb suites; here every
// answer is supported, so what is asserted stays which leg each tier reaches.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("./store", () => ({ memory: {} }));
vi.mock("./raw-rows", () => ({ rawRowEntityName: vi.fn() }));

import { check, descendantScopePaths, orgRootPath, type AccessContext } from "@/services/access";
import { ACCOUNT_TIERS } from "./account-tiers";
import { GuardedMemoryStore } from "./guarded-store";
import { HybridMemoryStore } from "./hybrid-store";
import type { MemoryStore } from "./memory-store";
import { rawRowEntityName } from "./raw-rows";
import { graphReadAllowed } from "./routing-policy";
import type { AccountTier, MemoryFact } from "@/types/memory";

const ORG = "1";
const ROOT = orgRootPath(ORG);
const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "user_1", role: "owner" }, origin: "app" };

const ENTITY = { uuid: "ent_acme", name: "Acme Corp", type: "company", facts: [] };
const EDGE = { uuid: "edge_1", source: "a", target: "b", fact: "Acme Corp renewed", graphGroupId: ROOT };
const RAW_FACT: MemoryFact = {
  uuid: "chunk_1",
  fact: "Acme Corp renewed for 2027",
  validAt: null,
  actorType: "agent",
  store: "semantic",
};
const OTHER_FACT: MemoryFact = {
  uuid: "chunk_2",
  fact: "The deploy target is Vercel",
  validAt: null,
  actorType: "agent",
  store: "semantic",
};

function legs() {
  const graphiti = {
    retrieve: vi.fn(async () => ({
      facts: [{ uuid: "edge_1", fact: "Acme Corp renewed", validAt: null, store: "graph" as const }],
    })),
    entity: vi.fn(async () => ENTITY),
    graph: vi.fn(async () => ({ nodes: [{ uuid: "ent_acme", name: "Acme Corp", type: "company" }], edges: [EDGE] })),
    findFactById: vi.fn(async (input: { factId: string }) =>
      input.factId === "edge_1" ? { uuid: "edge_1", fact: "Acme Corp renewed", invalidAt: null } : null,
    ),
  };
  const pgvector = {
    retrieve: vi.fn(async () => ({ facts: [RAW_FACT, OTHER_FACT] })),
    entity: vi.fn(async () => null),
    graph: vi.fn(async () => ({ nodes: [], edges: [] })),
    findFactById: vi.fn(async (input: { factId: string }) =>
      input.factId === "chunk_1" ? { uuid: "chunk_1", fact: RAW_FACT.fact, scopePath: null } : null,
    ),
  };
  return { graphiti, pgvector };
}

function guardedOn(tier: AccountTier) {
  const { graphiti, pgvector } = legs();
  const hybrid = new HybridMemoryStore(graphiti as unknown as MemoryStore, pgvector as unknown as MemoryStore);
  return { graphiti, pgvector, guarded: new GuardedMemoryStore(hybrid, async () => tier) };
}

beforeEach(() => {
  vi.mocked(check)
    .mockReset()
    .mockResolvedValue({ allowed: true, reason: "grant" } as never);
  vi.mocked(descendantScopePaths).mockReset().mockResolvedValue({ paths: [], unsearched: [], partial: false });
  vi.mocked(rawRowEntityName).mockReset().mockResolvedValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the behavioural mirror: each guarded graph reader asks the graph only where the tier reads it", () => {
  const entries = {
    retrieve: (g: GuardedMemoryStore) => g.retrieve(ctx, { groupId: ORG, query: "Acme Corp" }, ROOT),
    entity: (g: GuardedMemoryStore) => g.entity(ctx, { groupId: ORG, entityId: "ent_acme" }, ROOT),
    graph: (g: GuardedMemoryStore) => g.graph(ctx, { groupId: ORG }, ROOT),
    findFact: (g: GuardedMemoryStore) => g.findFact(ctx, { groupId: ORG, factId: "edge_1" }, ROOT),
    resolveFacts: (g: GuardedMemoryStore) =>
      g.resolveFacts(ctx, { groupId: ORG, factIds: ["edge_1"], target: "brief:b1/citations" }, ROOT),
  } as const;
  const graphLeg = {
    retrieve: "retrieve",
    entity: "entity",
    graph: "graph",
    findFact: "findFactById",
    resolveFacts: "findFactById",
  } as const;

  for (const tier of ACCOUNT_TIERS) {
    for (const [entry, call] of Object.entries(entries) as [
      keyof typeof entries,
      (typeof entries)[keyof typeof entries],
    ][]) {
      it(`${entry} on ${tier} ${graphReadAllowed(tier) ? "asks" : "never asks"} the graph`, async () => {
        const { graphiti, guarded } = guardedOn(tier);
        await call(guarded);
        const asked = graphiti[graphLeg[entry]].mock.calls.length > 0;
        expect(asked).toBe(graphReadAllowed(tier));
      });
    }
  }
});

describe("enterprise, every org's tier today: each reader is unchanged", () => {
  it("entity answers the graph's entity, with no fallback label", async () => {
    const { graphiti, guarded } = guardedOn("enterprise");
    const entity = await guarded.entity(ctx, { groupId: ORG, entityId: "ent_acme" }, ROOT);
    expect(entity).toEqual(ENTITY);
    expect(graphiti.entity).toHaveBeenCalledWith({ groupId: ROOT, entityId: "ent_acme" });
  });

  it("graph answers the graph's view, with no notRead label", async () => {
    const { graphiti, guarded } = guardedOn("enterprise");
    const graph = await guarded.graph(ctx, { groupId: ORG }, ROOT);
    expect(graph).toEqual({ nodes: [{ uuid: "ent_acme", name: "Acme Corp", type: "company" }], edges: [EDGE] });
    expect(graphiti.graph).toHaveBeenCalledWith({ groupId: ROOT, groupIds: [ROOT] });
  });

  it("findFact asks the graph then the raw rows with today's input, no rawOnly", async () => {
    const { graphiti, pgvector, guarded } = guardedOn("enterprise");
    expect(await guarded.findFact(ctx, { groupId: ORG, factId: "chunk_1" }, ROOT)).toEqual({
      uuid: "chunk_1",
      fact: RAW_FACT.fact,
      scopePath: null,
    });
    expect(graphiti.findFactById.mock.calls[0]).toEqual([{ groupId: ROOT, tenantId: ORG, factId: "chunk_1" }]);
    expect(pgvector.findFactById.mock.calls[0]).toEqual([{ groupId: ROOT, tenantId: ORG, factId: "chunk_1" }]);
  });

  it("resolveFacts answers null for a uuid neither store holds, as today", async () => {
    const { guarded } = guardedOn("enterprise");
    const answers = await guarded.resolveFacts(
      ctx,
      { groupId: ORG, factIds: ["nowhere"], target: "brief:b1/citations" },
      ROOT,
    );
    expect(answers.get("nowhere")).toBeNull();
  });
});

describe("a tier that does not read the graph", () => {
  it("graph answers an empty view labelled notRead, after the same access decision", async () => {
    const { graphiti, guarded } = guardedOn("team");
    const graph = await guarded.graph(ctx, { groupId: ORG }, ROOT);
    expect(graph).toEqual({ nodes: [], edges: [], notRead: "account-tier" });
    expect(graphiti.graph).not.toHaveBeenCalled();
    expect(vi.mocked(check)).toHaveBeenCalledWith(ctx, { action: "memory.read", scope: ROOT, target: "graph" });
  });

  it("findFact resolves a raw row, asked of the raw store alone", async () => {
    const { graphiti, pgvector, guarded } = guardedOn("team");
    expect(await guarded.findFact(ctx, { groupId: ORG, factId: "chunk_1" }, ROOT)).toEqual({
      uuid: "chunk_1",
      fact: RAW_FACT.fact,
      scopePath: null,
    });
    expect(graphiti.findFactById).not.toHaveBeenCalled();
    expect(pgvector.findFactById.mock.calls).toEqual([[{ groupId: ROOT, tenantId: ORG, factId: "chunk_1" }]]);
  });

  it("findFact does not resolve a graph edge the tier does not serve", async () => {
    const { guarded } = guardedOn("team");
    expect(await guarded.findFact(ctx, { groupId: ORG, factId: "edge_1" }, ROOT)).toBeNull();
  });

  it("resolveFacts reports a fact the raw rows do not hold as unknown, not gone: the graph was not asked", async () => {
    const { guarded } = guardedOn("team");
    const answers = await guarded.resolveFacts(
      ctx,
      { groupId: ORG, factIds: ["edge_1", "chunk_1"], target: "brief:b1/citations" },
      ROOT,
    );
    expect(answers.get("edge_1")).toBeInstanceOf(Error);
    expect(answers.get("chunk_1")).toEqual({ uuid: "chunk_1", fact: RAW_FACT.fact, scopePath: null });
  });
});

describe("the raw-row entity fallback when the graph leg is absent", () => {
  it("answers an entity named by the lookup from the raw rows that name it, labelled", async () => {
    const { graphiti, pgvector, guarded } = guardedOn("team");
    const entity = await guarded.entity(ctx, { groupId: ORG, entityId: "Acme Corp" }, ROOT);
    expect(entity).toEqual({
      uuid: "Acme Corp",
      name: "Acme Corp",
      type: "entity",
      facts: [RAW_FACT],
      matchedBy: "raw-name",
    });
    expect(graphiti.entity).not.toHaveBeenCalled();
    expect(pgvector.retrieve).toHaveBeenCalled();
    expect((pgvector.retrieve.mock.calls[0] as unknown[])[0]).toMatchObject({
      query: "Acme Corp",
      accountTier: "team",
    });
  });

  it("takes the entity's name from a raw row the lookup names by id", async () => {
    vi.mocked(rawRowEntityName).mockResolvedValue("Acme Corp");
    const { guarded } = guardedOn("team");
    const entity = await guarded.entity(ctx, { groupId: ORG, entityId: "chunk_1" }, ROOT);
    expect(entity).toMatchObject({ uuid: "chunk_1", name: "Acme Corp", facts: [RAW_FACT], matchedBy: "raw-name" });
    expect(vi.mocked(rawRowEntityName)).toHaveBeenCalledWith(ORG, "chunk_1");
  });

  it("answers not found when no raw row names the entity", async () => {
    const { guarded } = guardedOn("team");
    expect(await guarded.entity(ctx, { groupId: ORG, entityId: "Globex" }, ROOT)).toBeNull();
  });

  it("decides memory.entity on the scope before anything is read, as the graph lookup does", async () => {
    vi.mocked(check).mockResolvedValueOnce({ allowed: false, reason: "no grant" } as never);
    const { pgvector, guarded } = guardedOn("team");
    await expect(guarded.entity(ctx, { groupId: ORG, entityId: "Acme Corp" }, ROOT)).rejects.toThrow();
    expect(pgvector.retrieve).not.toHaveBeenCalled();
    expect(vi.mocked(check).mock.calls[0][1]).toEqual({ action: "memory.entity", scope: ROOT, target: "Acme Corp" });
  });
});

describe("the hybrid store's rawOnly lookup", () => {
  it("asks the raw store alone, without the flag", async () => {
    const { graphiti, pgvector } = legs();
    const hybrid = new HybridMemoryStore(graphiti as unknown as MemoryStore, pgvector as unknown as MemoryStore);
    await hybrid.findFactById({ groupId: ROOT, tenantId: ORG, factId: "chunk_1", rawOnly: true });
    expect(graphiti.findFactById).not.toHaveBeenCalled();
    expect(pgvector.findFactById.mock.calls).toEqual([[{ groupId: ROOT, tenantId: ORG, factId: "chunk_1" }]]);
  });
});
