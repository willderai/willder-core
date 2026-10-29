// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The read side of conflict detection
// (conflict-read.realdb.test.ts holds the builder's cases). These cover the edges of
// the current-versions filter in PgvectorMemoryStore.retrieve that those cases leave
// open: the read with no scope, a page of one, and the same fact name written in two
// sibling scopes, where nothing races and neither version may be hidden.
//
// Same harness as the builder's suite: real request-path ingest into Postgres, the
// real per-org conflict lock, real pgvector SQL; Graphiti and the embedding service
// are stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "conflictreadqa";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const SIBLING = `${ROOT}.ops`;
const DIMENSIONS = 384;

const write = (actorId: string, day: string, name = "Release train", scopePath = SCOPE): IngestInput => ({
  groupId: ORG,
  content: `The release train leaves on ${day}.`,
  name,
  actorType: "agent",
  origin: "mcp",
  actorId,
  actorName: "MCP session",
  source: "mcp",
  scopePath,
});

describe.skipIf(!QA_URL)("conflict read: edges of the current-versions filter", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  /** Both writes at once, then the version the write side recorded as the winner. */
  async function raceTwoWriters(): Promise<{ winnerId: string; loserId: string }> {
    await Promise.all([ingestMemory(write("writer-a", "Monday")), ingestMemory(write("writer-b", "Tuesday"))]);
    const edges = await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } });
    expect(edges).toHaveLength(1);
    return { winnerId: edges[0].fromId, loserId: edges[0].toId };
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
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
    await db.scope.create({ data: { orgId: ORG, path: SIBLING, name: "ops" } });
  });

  it("serves only the winner to a read that names no scope", async () => {
    const { winnerId } = await raceTwoWriters();

    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "When does the release train leave?",
      limit: 10,
    });

    expect(facts.map((f) => f.uuid)).toEqual([winnerId]);
  });

  it("fills a page of one with the winner, because the loser is dropped before the LIMIT", async () => {
    const { winnerId } = await raceTwoWriters();
    // Nudge the winner off the query so the loser is the nearest row: a filter applied
    // after the LIMIT would then drop the only row on the page and answer nothing. Only a
    // nudge: the ivfflat index probes one list, and a vector moved far from the query can
    // land in a list the probe never reads, which would fail this test for another reason.
    const away = Array.from({ length: DIMENSIONS }, (_, i) => (i < 8 ? 0.005 : 0.01));
    await db.$executeRaw`UPDATE memory_chunks SET embedding = ${`[${away.join(",")}]`}::vector WHERE id = ${winnerId}`;

    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "When does the release train leave?",
      limit: 1,
      scopePath: SCOPE,
    });

    expect(facts.map((f) => f.uuid)).toEqual([winnerId]);
  });

  it("hides nothing when the same fact name is written in two sibling scopes", async () => {
    await Promise.all([
      ingestMemory(write("writer-a", "Monday")),
      ingestMemory(write("writer-b", "Tuesday", "Release train", SIBLING)),
    ]);
    expect(await db.factEdge.count({ where: { orgId: ORG, kind: "supersedes" } })).toBe(0);
    const release = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, scopePath: SCOPE } });
    const ops = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, scopePath: SIBLING } });
    const store = new PgvectorMemoryStore();
    const read = (scopePath: string) =>
      store.retrieve({
        groupId: ORG,
        tenantId: ORG,
        query: "When does the release train leave?",
        limit: 10,
        scopePath,
      });

    expect((await read(SCOPE)).facts.map((f) => f.uuid)).toEqual([release.id]);
    expect((await read(SIBLING)).facts.map((f) => f.uuid)).toEqual([ops.id]);
  });
});
