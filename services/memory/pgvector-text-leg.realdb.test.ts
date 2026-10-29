// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The text leg read on its own (PgvectorMemoryStore.retrieveText), and the count of
// rows the graph has yet to absorb (PgvectorMemoryStore.pendingAbsorption).
//
// Real: Postgres with pg_trgm and the vector store's SQL, including its visibility predicate
// and the current-versions filter. Stand-in: the erasure list, which names one row by id; the
// list itself is proven in erasure-before-limit.realdb.test.ts. No embedding is computed:
// the text leg alone never asks for one.
//
// Case types covered: the quote served from the reader's scope, opening rows first; the same
// text in another tenant, a sibling scope and an erased row, none served; a query with no
// quote, nothing; a version another version supersedes, none served; a quote more rows hold than the limit, nothing; a pending count that counts
// only owed extractions the reader could read.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("./store", () => ({ memory: {} }));
vi.mock("./embedding-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedding-service")>()),
  getEmbedding: vi.fn(async () => {
    throw new Error("the text leg must not embed the query");
  }),
}));
vi.mock("./erasure-suppression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./erasure-suppression")>()),
  loadErasedContentFilter: vi.fn(
    async () => (_content: string, _createdAt: Date, _entity: string | null, id: string) => id === "erased",
  ),
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_text_leg";
const OTHER_ORG = "qa_text_leg_other";
const ROOT = `org_${ORG}`;
const RUN = `${ROOT}.w2run`;
const SIBLING = `${ROOT}.w2runb`;
const DIMENSIONS = 384;
const QUOTE = "the deploy freezes every Friday at noon";
const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

describe.skipIf(!QA_URL)("the text leg on its own, real Postgres", () => {
  let db: PrismaClient;
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const insert = (id: string, content: string, scopePath: string | null, orgId = ORG) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'text', 'agent', 'w2-agent', ${scopePath}, ${vector}::vector, NOW())`;
  const owe = (chunkId: string, orgId = ORG) =>
    db.$executeRaw`
      INSERT INTO graph_extraction_retries ("chunkId","orgId","job","lastError","nextAttemptAt")
      VALUES (${chunkId}, ${orgId}, '{}'::jsonb, 'provider timeout', NOW())`;
  const read = { groupId: RUN, tenantId: ORG, scopePath: RUN, limit: 10 };

  async function wipe() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.scope.deleteMany({ where: { orgId: org } });
    }
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    for (const org of [ORG, OTHER_ORG])
      await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
    for (const path of [ROOT, RUN, SIBLING]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    await insert("holds", `Ops says ${QUOTE}, so ship on Thursday.`, RUN);
    await insert("opens", `${QUOTE}; nothing merges after.`, RUN);
    await insert("other-text", "The billing service retries three times.", RUN);
    await insert("sibling", `${QUOTE}.`, SIBLING);
    await insert("erased", `${QUOTE}, Ana said.`, RUN);
    await insert("other-org", `${QUOTE}.`, RUN, OTHER_ORG);
  });

  it("serves the rows in the reader's scope that hold the quote, opening rows first, without embedding the query", async () => {
    const result = await new PgvectorMemoryStore().retrieveText({ ...read, query: QUOTE });
    expect(result.facts.map((f) => [f.uuid, f.textMatchRank])).toEqual([
      ["opens", 1],
      ["holds", 2],
    ]);
    expect(result.facts.every((f) => f.store === "semantic" && f.similarity === undefined)).toBe(true);
    expect(result.storesRead).toEqual([{ store: "semantic", leg: "text" }]);
  });

  it("never serves a version another version supersedes, even when it opens with the quote", async () => {
    await insert("retired", `${QUOTE}, as of last quarter.`, RUN);
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "opens",
        toId: "retired",
        kind: "supersedes",
        scopePath: RUN,
        actorType: "agent",
        actorId: "w2-agent",
      },
    });
    const result = await new PgvectorMemoryStore().retrieveText({ ...read, query: QUOTE });
    expect(result.facts.map((f) => f.uuid)).toEqual(["opens", "holds"]);
  });

  it("a query that quotes nothing reads nothing", async () => {
    const result = await new PgvectorMemoryStore().retrieveText({ ...read, query: "deploy" });
    expect(result).toEqual({ facts: [], storesRead: [{ store: "semantic", leg: "text" }] });
  });

  it("a quote more rows hold than the limit names no one row, and serves none", async () => {
    const result = await new PgvectorMemoryStore().retrieveText({ ...read, query: QUOTE, limit: 1 });
    expect(result.facts).toEqual([]);
  });

  it("counts only the owed extractions of rows the reader could read", async () => {
    for (const id of ["holds", "sibling"]) await owe(id);
    await owe("other-org", OTHER_ORG);
    expect(await new PgvectorMemoryStore().pendingAbsorption({ ...read, query: QUOTE })).toBe(1);
    expect(
      await new PgvectorMemoryStore().pendingAbsorption({
        groupId: ROOT,
        tenantId: ORG,
        scopePath: ROOT,
        query: QUOTE,
      }),
    ).toBe(2);
  });
});
