// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Erasing a person removes the passage embeddings of every row that named them, and a
// row restored from a backup taken before the erasure is never served through one of
// its passages.
//
// Passages (services/memory/passages.ts) are what let vector search find a name that
// sits past the embedding model's 512-token window, so the rows these tests erase name
// the person only after character 3,000: on its own embedding such a row never matches
// a search for them, and only a passage can bring it back. A passage holds no text, so
// the erasure's matching runs on its row; what must hold is that the passages go with
// the row, and that a passage match never serves a row the suppression list hides.
//
// Real: Postgres with pgvector, check(), the erasure's DELETEs, the suppression list,
// the vector read path and reapplyErasures. Stand-in: the graph store, a spy (its own
// erasure is proven on Neo4j in memory-service/tests/test_person_erasure_integration.py),
// and the embedding service, a stub that like bge-small reads only a text's first
// MODEL_WINDOW characters.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { stubEmbedService } from "./embed-service-stub.testsupport";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: vi.fn(async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] })),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_passage_erasure";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_passage_erasure_admin";
const DIMENSIONS = 384;
const MODEL_WINDOW = 2_000;
const NAME = "Orla Brennick";

const vector = (...leading: number[]) => [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];

/** The stub model: a text whose visible window names NAME embeds to the first axis. */
const stubEmbedding = (text: string) => (text.slice(0, MODEL_WINDOW).includes(NAME) ? vector(1) : vector(0, 1));

/** About 4,000 characters that mention `tail` only after character 3,000. */
function longRow(tail: string): string {
  const head = Array.from({ length: 60 }, (_, i) => `Planning note ${i}: the renewal stays on schedule.`)
    .join(" ")
    .slice(0, 3_000);
  return `${head} ${tail} ${"The rest is routine. ".repeat(40)}`;
}

describe.skipIf(!QA_URL)("person erasure and passage embeddings, real Postgres", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
  let store: import("./pgvector-store").PgvectorMemoryStore;
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  const passageCount = async (chunkId: string) =>
    (
      await db.$queryRaw<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM memory_chunk_passages WHERE "chunkId" = ${chunkId}`
    )[0]!.n;

  const write = async (content: string) =>
    (await store.ingest({ groupId: ORG, content, actorType: "human", actorId: ADMIN, origin: "app", scopePath: ROOT }))
      .episodeId;

  const search = async () =>
    (await store.retrieve({ groupId: ROOT, tenantId: ORG, scopePath: ROOT, query: NAME, includeUntagged: true })).facts;

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ reapplyErasures } = await import("./erasure-reapply"));
    store = new (await import("./pgvector-store")).PgvectorMemoryStore();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubEmbedService(stubEmbedding);
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@passage-erasure.test",
        role: "admin",
        clerkId: "clerk-passage-erasure-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "orla", orgId: ORG, name: NAME, email: "orla@brennick.example" } });
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("removes the passages of every row naming the person, and keeps a bystander's", async () => {
    const hers = await write(longRow(`${NAME} asked to move the renewal call to Thursday.`));
    const bystander = await write(longRow("Dana asked to move the renewal call to Friday."));
    expect((await search()).map((f) => f.uuid)).toContain(hers);
    expect(await passageCount(hers)).toBeGreaterThan(0);

    await erasePerson(admin, { contactId: "orla" });

    expect(await passageCount(hers)).toBe(0);
    expect(await passageCount(bystander)).toBeGreaterThan(0);
    expect((await search()).map((f) => f.uuid)).toEqual([bystander]);
  });

  it("never serves a restored row through its restored passages, and reapplyErasures removes both", async () => {
    const content = longRow(`${NAME} asked to move the renewal call to Thursday.`);
    const hers = await write(content);
    // A backup taken now holds the row and its passages.
    const [row] = await db.$queryRaw<{ createdAt: Date; embedding: string }[]>`
      SELECT "createdAt", embedding::text AS embedding FROM memory_chunks WHERE id = ${hers}
    `;
    const passages = await db.$queryRaw<{ ordinal: number; embedding: string }[]>`
      SELECT ordinal, embedding::text AS embedding FROM memory_chunk_passages WHERE "chunkId" = ${hers}
    `;

    await erasePerson(admin, { contactId: "orla" });

    // Restoring both tables from that backup; the suppression list is kept, as the restore procedure requires.
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
      VALUES (${hers}, ${ORG}, ${content}, 'text', 'human', ${ADMIN}, ${ROOT}, ${row!.embedding}::vector, ${row!.createdAt})
    `;
    for (const p of passages) {
      await db.$executeRaw`
        INSERT INTO memory_chunk_passages ("chunkId","ordinal","embedding")
        VALUES (${hers}, ${p.ordinal}, ${p.embedding}::vector)
      `;
    }
    expect(await passageCount(hers)).toBe(passages.length);

    expect(await search()).toEqual([]);

    expect((await reapplyErasures(admin)).chunksRemoved).toBe(1);
    expect(await passageCount(hers)).toBe(0);
  });
});
