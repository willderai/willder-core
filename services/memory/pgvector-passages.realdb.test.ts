// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Passage embeddings in PgvectorMemoryStore, against real Postgres with pgvector.
//
// A long row is stored with overlapping passages (services/memory/passages.ts), each
// embedded on its own, and a search scores the row by the best of its own embedding and
// its passages' while serving the row itself. What only a database can show: the score
// is that maximum, every filter the row query applies still decides which rows are
// served (a passage never brings back a row the read could not see), and deleting the
// row deletes its passages.
//
// The embedding service is stubbed with a model that, like bge-small, reads only the
// first MODEL_WINDOW characters of a text: a text whose window mentions "lighthouse"
// embeds to the first axis, anything else to the second. The query embeds to the first
// axis, so a row's similarity is 1 exactly when some embedding of it saw the word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";
import { stubEmbedService } from "./embed-service-stub.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "passq1";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const SUPPORT = `${ROOT}.support`;
const DIMENSIONS = 384;
const MODEL_WINDOW = 2_000;

function vector(...leading: number[]): number[] {
  return [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];
}
const pgVector = (v: number[]) => `[${v.join(",")}]`;

/** What the stub model returns for `text`: it sees only the first MODEL_WINDOW characters. */
function stubEmbedding(text: string): number[] {
  return text.slice(0, MODEL_WINDOW).includes("lighthouse") ? vector(1) : vector(0, 1);
}

/** About 4,400 characters, with "lighthouse" only after character 3,000. */
function longRow(label: string): string {
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `${label} note ${i}: the quarterly plan moved forward without changes.`).join(
      " ",
    );
  const head = filler(50).slice(0, 3_000);
  return `${head} The answer: the offsite is at the lighthouse in Montauk. ${filler(20)}`;
}

describe.skipIf(!QA_URL)("PgvectorMemoryStore: passage embeddings, real Postgres", () => {
  let db: PrismaClient;
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let splitPassages: (typeof import("./passages"))["splitPassages"];
  let failEmbedFor: ((text: string) => boolean) | null;

  const input = (content: string, scopePath: string | undefined, extra: Partial<IngestInput> = {}): IngestInput => ({
    groupId: ORG,
    content,
    actorType: "human",
    actorId: "u1",
    origin: "app",
    ...(scopePath === undefined ? {} : { scopePath }),
    ...extra,
  });

  const passagesOf = async (chunkId: string) =>
    (
      await db.$queryRaw<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM memory_chunk_passages WHERE "chunkId" = ${chunkId}`
    )[0]!.n;

  const read = (scopePath: string, extra: { includeUntagged?: boolean } = {}) =>
    new PgvectorMemoryStore().retrieve({ groupId: scopePath, tenantId: ORG, scopePath, query: "lighthouse", ...extra });

  async function wipe() {
    await db.$executeRaw`DELETE FROM fact_edges WHERE "orgId" = ${ORG}`;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ splitPassages } = await import("./passages"));
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  beforeEach(async () => {
    await wipe();
    failEmbedFor = null;
    stubEmbedService((text) => (failEmbedFor?.(text) ? null : stubEmbedding(text)));
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("serves a long row its passage matches, after the best whole-row match", async () => {
    const store = new PgvectorMemoryStore();
    const content = longRow("ops");
    const { episodeId: long } = await store.ingest(input(content, SALES));
    // Half-similar and short: on the row embedding alone it outranks the long row, so it
    // keeps the first slot; the long row takes the first passage slot.
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES ('half', ${ORG}, 'a short note', 'text', 'human', ${SALES}, ${pgVector(vector(Math.SQRT1_2, Math.SQRT1_2))}::vector, NOW())
    `;

    const result = await read(SALES);

    expect(result.facts.map((f) => f.uuid)).toEqual(["half", long]);
    expect(result.facts[1]!.similarity).toBeCloseTo(1, 6);
    expect(result.facts[1]!.fact).toBe(content);
  });

  it("orders the passage slots by each row's best passage, not its worst", async () => {
    const row = (id: string, embedding: number[]) => db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${`row ${id}`}, 'text', 'human', ${SALES}, ${pgVector(embedding)}::vector, NOW())
    `;
    const passage = (chunkId: string, ordinal: number, embedding: number[]) => db.$executeRaw`
      INSERT INTO memory_chunk_passages ("chunkId","ordinal","embedding") VALUES (${chunkId}, ${ordinal}, ${pgVector(embedding)}::vector)
    `;
    await row("c-short", vector(Math.SQRT1_2, Math.SQRT1_2));
    // One passage exactly on the query, one orthogonal to it.
    await row("a-one-exact", vector(0, 1));
    await passage("a-one-exact", 0, vector(1));
    await passage("a-one-exact", 1, vector(0, 1));
    // Every passage at 0.6.
    await row("b-all-middling", vector(0, 1));
    await passage("b-all-middling", 0, vector(0.6, 0.8));
    await passage("b-all-middling", 1, vector(0.6, 0.8));

    const { facts } = await read(SALES);

    // Whole-row order: c, a, b. Best-passage order: a (1), c (0.71, its own), b (0.6).
    expect(facts.map((f) => f.uuid)).toEqual(["c-short", "a-one-exact", "b-all-middling"]);
  });

  it("stores passages for a long row and none for a row that fits in one", async () => {
    const store = new PgvectorMemoryStore();
    const { episodeId: long } = await store.ingest(input(longRow("ops"), SALES));
    const { episodeId: short } = await store.ingest(input("A short fact about the lighthouse.", SALES));

    expect(await passagesOf(long)).toBeGreaterThanOrEqual(3);
    expect(await passagesOf(short)).toBe(0);
  });

  it("stores one set of passages when ingestOnce sees the same content twice", async () => {
    const store = new PgvectorMemoryStore();
    const content = longRow("dup");
    const first = await store.ingestOnce(input(content, SALES, { name: "Offsite" }));
    const second = await store.ingestOnce(input(content, SALES, { name: "Offsite" }));

    expect(second).toEqual({ episodeId: first.episodeId, inserted: false, existingDates: expect.any(Object) });
    const passages = await passagesOf(first.episodeId);
    expect(passages).toBeGreaterThanOrEqual(3);
    expect(await db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM memory_chunk_passages`).toEqual([
      { n: passages },
    ]);
  });

  it("ingestAll stores every long input's passages, or nothing when one passage cannot be embedded", async () => {
    const store = new PgvectorMemoryStore();
    const ids = await store.ingestAll([input(longRow("a"), SALES), input("short", SALES)]);
    expect(await passagesOf(ids[0]!)).toBeGreaterThanOrEqual(3);
    expect(await passagesOf(ids[1]!)).toBe(0);

    const content = longRow("b");
    failEmbedFor = (text) => text !== content && content.includes(text);
    await expect(store.ingestAll([input(content, SALES)])).rejects.toThrow(/none were stored/);
    await expect(store.ingest(input(content, SALES))).rejects.toThrow(/embed failed/);
    expect(await db.memoryChunk.count({ where: { orgId: ORG, content } })).toBe(0);
  });

  it("ingestAll stores 100 document chunks of 3,000 characters, passages and all", async () => {
    // The shape a file sync writes (lib/inngest/file-ingest.ts): every chunk long enough
    // to have passages, all in one call.
    const chunk = (i: number) =>
      Array.from({ length: 60 }, (_, j) => `Chunk ${i} line ${j} of the quarterly report, kept verbatim.`)
        .join(" ")
        .slice(0, 3_000);
    const inputs = Array.from({ length: 100 }, (_, i) => input(chunk(i), SALES, { sourceId: "file-sync" }));
    // Each statement that writes passages costs 60 ms, about a round trip to a hosted
    // database plus the index insert: what a test database next to its client hides.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION passq1_slow_statement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.06); RETURN NULL; END $$`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER passq1_slow_statement AFTER INSERT ON memory_chunk_passages
      FOR EACH STATEMENT EXECUTE FUNCTION passq1_slow_statement()`);

    let ids: string[];
    try {
      ids = await new PgvectorMemoryStore().ingestAll(inputs);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER passq1_slow_statement ON memory_chunk_passages`);
      await db.$executeRawUnsafe(`DROP FUNCTION passq1_slow_statement()`);
    }

    expect(ids).toHaveLength(100);
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM memory_chunk_passages p JOIN memory_chunks c ON c.id = p."chunkId" WHERE c."orgId" = ${ORG}
    `;
    expect(n).toBe(inputs.reduce((sum, { content }) => sum + splitPassages(content).length, 0));
  }, 60_000);

  it("keeps ingestAll's rows, searchable, when their passages fail to write after the rows committed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION passq1_refuse_passages() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'passages refused'; END $$`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER passq1_refuse_passages BEFORE INSERT ON memory_chunk_passages
      FOR EACH STATEMENT EXECUTE FUNCTION passq1_refuse_passages()`);

    let ids: string[];
    try {
      ids = await new PgvectorMemoryStore().ingestAll([input(longRow("doc"), SALES)]);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER passq1_refuse_passages ON memory_chunk_passages`);
      await db.$executeRawUnsafe(`DROP FUNCTION passq1_refuse_passages()`);
    }

    expect(await db.memoryChunk.count({ where: { orgId: ORG, id: ids[0] } })).toBe(1);
    expect(await passagesOf(ids[0]!)).toBe(0);
    // Searchable by its own embedding, as a row without passages always was.
    expect((await read(SALES)).facts.map((f) => f.uuid)).toEqual(ids);
  });

  it("never serves a row outside the read's scope, however well its passage matches", async () => {
    const store = new PgvectorMemoryStore();
    await store.ingest(input(longRow("support"), SUPPORT));
    await store.ingest(input(longRow("untagged"), undefined));

    expect((await read(SALES)).facts).toEqual([]);
    // The org root's reader sees both, and the untagged row only with org-root coverage.
    expect((await read(ROOT, { includeUntagged: true })).facts).toHaveLength(2);
    expect((await read(ROOT, { includeUntagged: false })).facts).toHaveLength(1);
  });

  it("never serves a superseded version through its passages", async () => {
    const store = new PgvectorMemoryStore();
    const { episodeId: loser } = await store.ingest(input(longRow("old"), SALES));
    const { episodeId: winner } = await store.ingest(input("The offsite moved; no venue yet.", SALES));
    await db.$executeRaw`
      INSERT INTO fact_edges ("id","orgId","fromId","toId","kind","scopePath","actorType","actorId")
      VALUES ('edge1', ${ORG}, ${winner}, ${loser}, 'supersedes', ${SALES}, 'human', 'u1')
    `;

    expect((await read(SALES)).facts.map((f) => f.uuid)).toEqual([winner]);
  });

  it("fills the page from readable rows when far more unreadable passages sit nearer the query", async () => {
    // A unit vector near `axis`, nudged by a deterministic amount so no two are equal.
    const near = (axis: number[], seed: number) => {
      const v = vector(...axis).map((x, d) => (d >= 3 && d < 12 ? x + Math.sin(seed * 7 + d) * 0.01 : x));
      const norm = Math.hypot(...v);
      return pgVector(v.map((x) => x / norm));
    };
    const row = (id: string, scopePath: string, embedding: string) => db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${`row ${id}`}, 'text', 'human', ${scopePath}, ${embedding}::vector, NOW())
    `;
    const passage = (chunkId: string, ordinal: number, embedding: string) => db.$executeRaw`
      INSERT INTO memory_chunk_passages ("chunkId","ordinal","embedding")
      VALUES (${chunkId}, ${ordinal}, ${embedding}::vector)
    `;
    // 300 rows the read cannot see, each with three passages almost on the query.
    for (let i = 0; i < 300; i++) {
      await row(`hidden-${i}`, SUPPORT, near([0, 1], i));
      for (let o = 0; o < 3; o++) await passage(`hidden-${i}`, o, near([1], i * 3 + o));
    }
    // 10 readable long rows whose only near embedding is one passage (similarity 0.9).
    for (let i = 0; i < 10; i++) {
      await row(`long-${i}`, SALES, near([0, 1], 1_000 + i));
      await passage(`long-${i}`, 0, near([0.9, Math.sqrt(1 - 0.81)], 2_000 + i));
      await passage(`long-${i}`, 1, near([0, 1], 3_000 + i));
    }
    // 30 readable short rows, nearer by their own embedding than the long rows are (0.5 against 0).
    for (let i = 0; i < 30; i++) await row(`short-${i}`, SALES, near([0.5, 0, Math.sqrt(0.75)], 4_000 + i));
    await db.$executeRaw`ANALYZE memory_chunk_passages`;

    const page = (limit: number) =>
      new PgvectorMemoryStore().retrieve({
        groupId: SALES,
        tenantId: ORG,
        scopePath: SALES,
        query: "lighthouse",
        limit,
      });

    // The short rows win the whole-row slots, the long rows every passage slot.
    const twenty = (await page(20)).facts;
    const longRows = twenty.filter((f) => f.uuid.startsWith("long-"));
    expect(longRows.map((f) => f.uuid).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `long-${i}`).sort());
    expect(Math.min(...longRows.map((f) => f.similarity!))).toBeGreaterThan(0.85);
    // Every readable row, when the page asks for all of them.
    const forty = (await page(40)).facts;
    expect(forty).toHaveLength(40);
    expect(forty.every((f) => !f.uuid.startsWith("hidden-"))).toBe(true);
  }, 30_000);

  it("deletes a row's passages with the row, through removeFact and through a plain DELETE", async () => {
    const store = new PgvectorMemoryStore();
    const { episodeId: removed } = await store.ingest(input(longRow("x"), SALES));
    const { episodeId: retired } = await store.ingest(input(longRow("y"), SALES, { sourceId: "src1" }));
    expect(await passagesOf(removed)).toBeGreaterThan(0);

    expect(await store.removeFact({ groupId: SALES, tenantId: ORG, factId: removed })).toEqual({
      removed: true,
      storedScopePath: SALES,
      storedEntityName: null,
    });
    // The connector-retirement path deletes rows by source, with no knowledge of passages.
    await db.memoryChunk.deleteMany({ where: { orgId: ORG, sourceId: "src1" } });

    expect(await passagesOf(removed)).toBe(0);
    expect(await passagesOf(retired)).toBe(0);
  });
});
