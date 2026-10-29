// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Rows an erasure suppresses hold no place in a vector search's LIMIT.
//
// A person erasure deletes every row naming them and records digests on a suppression
// list (services/memory/erasure-suppression.ts). A backup restored afterwards can put such
// rows back; the read path must then answer as if they were absent. The suppression list
// is matched in the app, not in SQL, so the search used to filter them out after each leg's
// LIMIT: restored rows nearer the question than a readable one filled the leg, were then
// dropped, and the readable row never reached the page. retrieve() now excludes them by id
// and searches again (services/memory/pgvector-store.ts).
//
// Real: Postgres with pgvector, check() against a live capability, GuardedMemoryStore,
// HybridMemoryStore, the erasure's DELETEs and the suppression list. Stand-in: the graph
// store (answers and erases nothing) and the embedding service, a stub that puts the
// question and every row naming the erased person on one axis and the readable row at a
// cosine of 0.6 from it.
//
// Case types covered: a page of one whose leg (an overfetch of 4) the restored rows would
// fill; a page of ten with one restored row; hidden versus absent on both (same rows, same
// order, same similarity); more restored rows than MAX_SUPPRESSION_ROUNDS rounds can
// exclude (the rest are filtered as before: never served, though the page can come back
// short); a question in a restored row's own words, which the text leg matches. Not covered:
// the graph store.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import { stubEmbedService } from "./embed-service-stub.testsupport";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    removeGroupFacts: async () => ({ removedCount: 0 }),
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure_before_limit";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_erasure_before_limit_admin";
const ERASED_NAME = "Orla Brennick";
const QUESTION = "Where does the renewal key live?";
const READABLE = "Sales note: the renewal key lives in the second drawer.";
const DIMENSIONS = 384;

const vector = (...leading: number[]) => [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];
const stubEmbedding = (text: string) =>
  text === QUESTION || text.includes(ERASED_NAME) ? vector(1) : vector(0.6, 0.8);

describe.skipIf(!QA_URL)("erasure-suppressed rows hold no place in the search's LIMIT, real Postgres", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let readable: string;

  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;
  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => "enterprise");
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function salesReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "sales-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: SALES,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "sales-reader", capabilityToken: token }, origin: "mcp" };
  }

  const write = async (content: string) =>
    (
      await new PgvectorMemoryStore().ingest({
        groupId: ORG,
        content,
        actorType: "human",
        actorId: "u1",
        origin: "app",
        scopePath: SALES,
      })
    ).episodeId;

  /** The page as a reader sees it: which rows, in what order, with what text and similarity. */
  const page = async (ctx: AccessContext, limit: number) =>
    (await reader().retrieve(ctx, { groupId: ORG, query: QUESTION, limit }, SALES)).facts.map((f) => ({
      uuid: f.uuid,
      fact: f.fact,
      similarity: f.similarity,
    }));

  /** Write `count` rows naming the person, erase her, and return what a backup taken before held. */
  async function writeThenErase(count: number) {
    const backup: { id: string; content: string; embedding: string; createdAt: Date }[] = [];
    for (let i = 0; i < count; i++) {
      const content = `${ERASED_NAME} keeps renewal key copy ${i}.`;
      const id = await write(content);
      const [row] = await db.$queryRaw<{ createdAt: Date; embedding: string }[]>`
        SELECT "createdAt", embedding::text AS embedding FROM memory_chunks WHERE "orgId" = ${ORG} AND id = ${id}`;
      backup.push({ id, content, ...row! });
    }
    await erasePerson(admin, { contactId: "orla" });
    return backup;
  }

  /** Put the backup's rows back; the suppression list is kept, as the restore procedure requires. */
  async function restore(backup: { id: string; content: string; embedding: string; createdAt: Date }[]) {
    for (const row of backup) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
        VALUES (${row.id}, ${ORG}, ${row.content}, 'text', 'human', 'u1', ${SALES}, ${row.embedding}::vector, ${row.createdAt})`;
    }
  }

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ erasePerson } = await import("./person-erasure"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubEmbedService(stubEmbedding);
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: SALES } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@erasure-before-limit.test",
        role: "admin",
        clerkId: "clerk-erasure-before-limit-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "orla", orgId: ORG, name: ERASED_NAME, email: "orla@brennick.example" } });
    readable = await write(READABLE);
  });

  it("serves a page of one the readable row, though more restored rows than the leg's LIMIT are nearer the question", async () => {
    // Six restored rows against a vector leg of 4 for a page of 1 (GuardedMemoryStore's overfetch).
    const backup = await writeThenErase(6);
    const ctx = await salesReader();
    const absent = await page(ctx, 1);
    expect(absent.map((f) => f.uuid)).toEqual([readable]);

    await restore(backup);
    const restored = await page(ctx, 1);

    expect(restored).toEqual(absent);
    expect(JSON.stringify(restored)).not.toContain(ERASED_NAME);
  });

  it("answers a page of ten the same with one restored row as without it", async () => {
    const backup = await writeThenErase(1);
    for (let i = 0; i < 3; i++) await write(`Sales note ${i}: the quarterly plan moved forward.`);
    const ctx = await salesReader();
    const absent = await page(ctx, 10);

    await restore(backup);
    const restored = await page(ctx, 10);

    expect(restored).toEqual(absent);
    expect(restored.map((f) => f.uuid)).toContain(readable);
    expect(JSON.stringify(restored)).not.toContain(ERASED_NAME);
  });

  it("past the rows its rounds can exclude, still serves none of them", async () => {
    // 20 restored rows against a leg of 4: three rounds exclude 12, and the fourth round's
    // rows are only filtered out, so the page may come back short, never with one of them.
    const backup = await writeThenErase(20);
    await restore(backup);
    const ctx = await salesReader();

    const served = await page(ctx, 1);

    expect(served.map((f) => f.uuid).filter((id) => backup.some((b) => b.id === id))).toEqual([]);
    expect(JSON.stringify(served)).not.toContain(ERASED_NAME);
  });

  it("asked by a restored row's own words, serves none of the restored rows", async () => {
    // The text leg (services/memory/text-match-fusion.ts) finds each restored row by its words,
    // and the excluded rows must hold no place in its LIMIT either.
    const backup = await writeThenErase(6);
    await restore(backup);
    const ctx = await salesReader();

    const served = (await reader().retrieve(ctx, { groupId: ORG, query: backup[0]!.content, limit: 1 }, SALES)).facts;

    expect(served.map((f) => f.uuid)).toEqual([readable]);
    expect(JSON.stringify(served)).not.toContain(ERASED_NAME);
  });

  it("is set up so that the restored rows are nearer the question than the readable row", async () => {
    await restore(await writeThenErase(2));
    const nearest = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_chunks WHERE "orgId" = ${ORG}
      ORDER BY embedding <=> ${`[${vector(1).join(",")}]`}::vector, id LIMIT 2`;
    expect(nearest.map((r) => r.id)).not.toContain(readable);
  });
});
