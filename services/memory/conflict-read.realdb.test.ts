// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Conflicting writes, read side: after two agents write the same fact inside
// the contention window, a reader asking for that fact gets one current answer, the
// winner, and the losing version stays stored and readable by id.
//
// The write side records the winner (services/memory/conflict.ts); this proves the read
// consults it, so `memory_query` never returns the winner and the loser side by side.
//
// Everything below the read is real except Graphiti and the embedding service: both
// ingests run the request path into Postgres, the conflict is resolved under the real
// per-org lock, check() authorizes against a live capability, and pgvector's SQL runs.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import { toGid } from "./graphiti-store";
import type { IngestInput, MemoryFact } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "conflictread";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;

const write = (actorId: string, day: string, name = "Release train"): IngestInput => ({
  groupId: ORG,
  content: `The release train leaves on ${day}.`,
  name,
  actorType: "agent",
  origin: "mcp",
  actorId,
  actorName: "MCP session",
  source: "mcp",
  scopePath: SCOPE,
});

const emptyGraph = {
  retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
} as unknown as MemoryStore;

/**
 * A graph leg that answers with the text of every version given, the way Graphiti does:
 * its own edge uuids, and nothing pointing back at the `memory_chunks` row the same
 * ingest wrote. This is the shape that produced the measured failure — the vector leg's
 * SQL filter cannot reach these rows, so without a filter over the assembled result a
 * reader gets both versions of one fact.
 */
function graphWithEveryVersion(versions: readonly { id: string; content: string }[]): MemoryStore {
  const facts: MemoryFact[] = versions.map((version, i) => ({
    uuid: `graphiti-edge-${i}`,
    fact: version.content,
    validAt: null,
    actorType: "agent",
    store: "graph",
  }));
  return {
    retrieve: vi.fn(async () => ({ facts, storesRead: [{ store: "graph" as const }] })),
    entity: vi.fn(async () => ({ uuid: "entity-1", name: "Release train", type: "Project", summary: "", facts })),
    graph: vi.fn(async () => ({
      nodes: [{ uuid: "entity-1", name: "Release train", type: "Project" }],
      // Every version here was written in SCOPE, so Graphiti holds each edge in its group.
      edges: facts.map((fact) => ({
        uuid: fact.uuid,
        source: "entity-1",
        target: "entity-1",
        fact: fact.fact,
        graphGroupId: toGid(SCOPE),
      })),
    })),
  } as unknown as MemoryStore;
}

describe.skipIf(!QA_URL)("conflicting writes: a reader of the fact gets one current answer", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let readMemoryVersion: (typeof import("./versions"))["readMemoryVersion"];
  let changeNotice: (typeof import("@/mcp/change-notices"))["changeNotice"];

  /** Both writes at once, then the version the write side recorded as the winner. */
  async function raceTwoWriters(): Promise<{ winnerId: string; loserId: string }> {
    await Promise.all([ingestMemory(write("writer-a", "Monday")), ingestMemory(write("writer-b", "Tuesday"))]);
    const edges = await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } });
    expect(edges).toHaveLength(1);
    return { winnerId: edges[0].fromId, loserId: edges[0].toId };
  }

  async function rootReader(agentId = "root-reader"): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ ingestMemory } = inngestModule);
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ readMemoryVersion } = await import("./versions"));
    ({ changeNotice } = await import("@/mcp/change-notices"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("serves only the winner from the vector store, and keeps the loser stored", async () => {
    const { winnerId, loserId } = await raceTwoWriters();

    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "When does the release train leave?",
      limit: 10,
      scopePath: SCOPE,
    });

    expect(facts.map((f) => f.uuid)).toEqual([winnerId]);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(2);
    expect(await db.memoryChunk.count({ where: { id: loserId } })).toBe(1);
  });

  it("answers memory_query's read with one current version", async () => {
    const { winnerId } = await raceTwoWriters();
    const reader = new GuardedMemoryStore(
      new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()),
      async () => "enterprise",
    );

    const { facts } = await reader.retrieve(
      await rootReader(),
      { groupId: ORG, query: "When does the release train leave?", limit: 10 },
      SCOPE,
    );

    expect(facts.map((f) => f.uuid)).toEqual([winnerId]);
  });

  it("still reads the losing version by id, marked superseded by the winner", async () => {
    const { winnerId, loserId } = await raceTwoWriters();

    const loser = await readMemoryVersion(await rootReader(), loserId);

    expect(loser).toMatchObject({ id: loserId, status: "superseded", supersededById: winnerId });
  });

  it("leaves a fact that lost no race in the answer", async () => {
    const { winnerId } = await raceTwoWriters();
    await ingestMemory(write("writer-c", "Friday", "Freeze window"));
    const freeze = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, entityName: "Freeze window" } });

    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "When does the release train leave?",
      limit: 10,
      scopePath: SCOPE,
    });

    expect(facts.map((f) => f.uuid).sort()).toEqual([winnerId, freeze.id].sort());
  });

  /** Every stored version of the contended fact, newest id order aside. */
  async function storedVersions() {
    return db.memoryChunk.findMany({
      where: { orgId: ORG, entityName: "Release train" },
      select: { id: true, content: true, actorId: true },
      orderBy: { createdAt: "asc" },
    });
  }

  it("answers memory_query with one current version when the graph leg returns both", async () => {
    const { winnerId, loserId } = await raceTwoWriters();
    const versions = await storedVersions();
    const winner = versions.find((v) => v.id === winnerId)!;
    const loser = versions.find((v) => v.id === loserId)!;
    const reader = new GuardedMemoryStore(
      new HybridMemoryStore(graphWithEveryVersion(versions), new PgvectorMemoryStore()),
      async () => "enterprise",
    );

    const { facts } = await reader.retrieve(
      await rootReader(),
      { groupId: ORG, query: "When does the release train leave?", limit: 10 },
      SCOPE,
    );

    expect(facts.map((f) => f.fact)).toEqual([winner.content]);
    expect(facts.map((f) => f.fact)).not.toContain(loser.content);
  });

  it("answers memory_entity with the winner alone", async () => {
    const { winnerId, loserId } = await raceTwoWriters();
    const versions = await storedVersions();
    const winner = versions.find((v) => v.id === winnerId)!;
    const loser = versions.find((v) => v.id === loserId)!;
    const reader = new GuardedMemoryStore(graphWithEveryVersion(versions), async () => "enterprise");

    const entity = await reader.entity(await rootReader(), { groupId: ORG, entityId: "entity-1" }, SCOPE);

    expect(entity?.facts?.map((f) => f.fact)).toEqual([winner.content]);
    expect(entity?.facts?.map((f) => f.fact)).not.toContain(loser.content);
  });

  it("shows the losing version in the graph view, marked no longer valid", async () => {
    const { winnerId, loserId } = await raceTwoWriters();
    const versions = await storedVersions();
    const winner = versions.find((v) => v.id === winnerId)!;
    const loser = versions.find((v) => v.id === loserId)!;
    const reader = new GuardedMemoryStore(graphWithEveryVersion(versions), async () => "enterprise");

    const graph = await reader.graph(await rootReader(), { groupId: ORG }, SCOPE);
    const byText = new Map(graph.edges.map((edge) => [edge.fact, edge.invalidAt ?? null]));

    expect(byText.get(winner.content)).toBeNull();
    expect(byText.get(loser.content)).toBeTruthy();
  });

  it("reads both versions by id, the winner current and the loser superseded", async () => {
    const { winnerId, loserId } = await raceTwoWriters();
    const versions = await storedVersions();
    const ctx = await rootReader();

    const winner = await readMemoryVersion(ctx, winnerId);
    const loser = await readMemoryVersion(ctx, loserId);

    expect(winner).toMatchObject({ id: winnerId, status: "current", supersedesIds: [loserId] });
    expect(loser).toMatchObject({ id: loserId, status: "superseded", supersededById: winnerId });
    expect(winner?.content).toBe(versions.find((v) => v.id === winnerId)!.content);
    expect(loser?.content).toBe(versions.find((v) => v.id === loserId)!.content);
  });

  it("tells the losing writer its version was superseded, on its next call", async () => {
    const { winnerId, loserId } = await raceTwoWriters();
    const losingWriter = (await storedVersions()).find((v) => v.id === loserId)!.actorId!;

    const notice = await changeNotice(await rootReader(losingWriter), SCOPE);

    expect(notice).toContain(`superseded by ${winnerId}`);
  });
});
