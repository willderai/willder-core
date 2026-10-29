// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The two removals a
// refused or late connector ingest makes reach only that source's own rows. A late write is
// removed by org, scope AND source (retireLateSourceWrite), and the row the request path stored
// is removed by id, org AND source (dropRefusedSourceRow). Each test seeds the row that a
// wider delete would take, so dropping any one of those filters turns it red.
//
// Real: Postgres and pgvector's write path. Stand-in: the graph store, which records what it
// was asked to remove.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";

const removals = vi.hoisted(() => [] as { groupId: string; sourceId?: string }[]);
vi.mock("@/services/memory/store", () => ({
  memory: { ingest: async () => ({ episodeId: "e" }) },
  graphitiStore: {
    removeGroupFacts: async (input: { groupId: string; sourceId?: string }) => {
      removals.push(input);
      return { removedCount: 0 };
    },
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-removal-scope";
const OTHER_ORG = "org-qa-removal-scope-other";
const SCOPE = "org_org-qa-removal-scope.engineering";
const GONE = "src-qa-removal-gone";
const NEIGHBOUR = "src-qa-removal-neighbour";

describe.skipIf(!QA_URL)("a refused or late connector ingest removes only its own source's rows", () => {
  let db: PrismaClient;
  let retirement: typeof import("@/services/memory/source-retirement");
  let pg: (typeof import("@/services/memory/pgvector-store"))["pgvectorStore"];

  const chunk = async (orgId: string, sourceId: string | undefined, content: string) =>
    (
      await pg.ingestOnce({
        groupId: orgId,
        content,
        name: "n",
        source: "text",
        actorType: "agent",
        actorId: "a",
        actorName: "A",
        scopePath: SCOPE,
        sourceId,
      } as never)
    ).episodeId;
  const contents = async (orgId: string) =>
    (await db.memoryChunk.findMany({ where: { orgId }, select: { content: true } })).map((c) => c.content).sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    stubEmbeddingService();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    retirement = await import("@/services/memory/source-retirement");
    ({ pgvectorStore: pg } = await import("@/services/memory/pgvector-store"));
  });

  afterAll(async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.org.deleteMany({ where: { id: orgId } });
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    removals.length = 0;
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  it("a late write's removal leaves another source's and a member's rows at the same scope, and asks the graph for the source only", async () => {
    await chunk(ORG, GONE, "late write of the gone source");
    await chunk(ORG, NEIGHBOUR, "the neighbour source's fact");
    await chunk(ORG, undefined, "a member's own note");

    await retirement.retireLateSourceWrite({ orgId: ORG, sourceId: GONE, scopePath: SCOPE });

    expect(await contents(ORG)).toEqual(["a member's own note", "the neighbour source's fact"]);
    expect(removals).toEqual([{ groupId: SCOPE, sourceId: GONE }]);
  });

  it("a late write's removal never reaches another org's rows of the same source id and scope", async () => {
    await chunk(OTHER_ORG, GONE, "the other org's row");
    await retirement.retireLateSourceWrite({ orgId: ORG, sourceId: GONE, scopePath: SCOPE });
    expect(await contents(OTHER_ORG)).toEqual(["the other org's row"]);
  });

  it("dropping a refused ingest's row by id never reaches a row of another org or another source", async () => {
    const foreign = await chunk(OTHER_ORG, GONE, "the other org's row");
    const neighbours = await chunk(ORG, NEIGHBOUR, "the neighbour source's fact");
    const manual = await chunk(ORG, undefined, "a member's own note");

    await retirement.dropRefusedSourceRow({ orgId: ORG, sourceId: GONE, chunkId: foreign });
    await retirement.dropRefusedSourceRow({ orgId: ORG, sourceId: GONE, chunkId: neighbours });
    await retirement.dropRefusedSourceRow({ orgId: ORG, sourceId: GONE, chunkId: manual });

    expect(await contents(OTHER_ORG)).toEqual(["the other org's row"]);
    expect(await contents(ORG)).toEqual(["a member's own note", "the neighbour source's fact"]);
  });

  it("control: dropping a refused ingest's own row removes it", async () => {
    const own = await chunk(ORG, GONE, "the refused row");
    await retirement.dropRefusedSourceRow({ orgId: ORG, sourceId: GONE, chunkId: own });
    expect(await contents(ORG)).toEqual([]);
  });
});
