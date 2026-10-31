// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// pgvector validAt against a real database.
//
// PgvectorMemoryStore.retrieve renders a chunk's createdAt as ISO-8601. The
// unit test mocks db.$queryRaw with a Date, which proves the mapping but not
// that the real driver hands the column back as a Date. Here the real query runs
// against Postgres 16 with pgvector, through both SELECT branches (scoped and
// unscoped), with the process in a non-UTC time zone so an offset slip in the
// `timestamp without time zone` column would show. Only the embedding HTTP call
// is stubbed.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL. Skips cleanly without it, and also when memory_chunks has no
// `embedding` column (a `prisma db push` database does not carry it).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-247";
const SALES = `${ORG}.sales`;
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
/** Stored with millisecond precision, the column's timestamp(3). */
const CREATED_AT = "2026-09-24T23:41:24.123Z";

describe.skipIf(!QA_URL)("pgvector validAt against a real database", () => {
  let db: PrismaClient;
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let hasEmbeddingColumn = false;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: EMBEDDING }) }));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const columns = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_chunks' AND column_name = 'embedding'`;
    hasEmbeddingColumn = columns.length > 0;
    if (!hasEmbeddingColumn) return;
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","actorType","scopePath","createdAt","embedding")
       VALUES ($1,$2,$3,'human',$4,$5::timestamp,$6::vector)`,
      "case247-chunk",
      ORG,
      "release ships Friday",
      SALES,
      CREATED_AT.replace("T", " ").replace("Z", ""),
      JSON.stringify(EMBEDDING),
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  it("returns the stored createdAt as exact ISO-8601 UTC on the scoped SELECT", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "release",
      scopePath: SALES,
    });
    expect(facts.map((f) => f.validAt)).toEqual([CREATED_AT]);
  });

  it("returns the same ISO-8601 value on the unscoped SELECT", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    const { facts } = await new PgvectorMemoryStore().retrieve({ groupId: ORG, tenantId: ORG, query: "release" });
    expect(facts.map((f) => f.validAt)).toEqual([CREATED_AT]);
  });
});
