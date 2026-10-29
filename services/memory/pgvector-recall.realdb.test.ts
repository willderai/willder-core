// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Semantic search returns the chunks an exact search returns, at the index settings
// production runs with.
//
// memory_chunks_embedding_idx is an IVFFlat index with 100 lists, created by the
// migrations while the table is still empty, which is how every database gets it.
// An IVFFlat search reads only `ivfflat.probes` of those lists, and pgvector's
// default is one, so a near chunk filed under an unread list is silently left out
// and a page can come back short. This suite seeds a table at a realistic size and
// shape, then compares what PgvectorMemoryStore.retrieve returns with an exact
// search over the same rows.
//
// The store's connections are opened with `ivfflat.probes=1`, the value production
// runs with. A test database configured for exact search therefore cannot make this
// suite pass; only the store's own query can (it scores every visible row, so it does
// not read the index at all).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "recallorg";
// A second tenant in the same table: an IVFFlat list holds every org's rows, so the
// searched org's share of each list is what decides how short a page can come back.
const NEIGHBOR_ORG = "recallneighbor";
const CHUNKS_PER_ORG = 3_000;
const CHUNKS_PER_TOPIC = 75;
const QUERIES = 25;
// What GuardedMemoryStore asks the vector store for when memory_query is called with
// its default page of 10 (overfetchLimit in guarded-store.ts).
const K = 40;
const INSERT_BATCH = 250;

/** Deterministic uniform [0, 1) generator (mulberry32), so every run seeds the same table. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitVector(random: () => number): number[] {
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const v = Array.from({ length: DIMENSIONS }, gaussian);
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

/**
 * A chunk's embedding: a direction every chunk shares, its topic's direction, and its
 * own noise. Sentence-embedding models put all text in a narrow cone, so unrelated
 * chunks still score around 0.45 cosine and chunks on one topic around 0.75; these
 * weights reproduce those two levels. They are an approximation of real embeddings,
 * not real ones.
 */
function chunkEmbedding(shared: number[], topic: number[], random: () => number): number[] {
  const noise = randomUnitVector(random);
  const v = shared.map((s, i) => Math.sqrt(0.45) * s + Math.sqrt(0.3) * topic[i] + Math.sqrt(0.25) * noise[i]);
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

const pgVector = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(",")}]`;

/** The connection string with the probe count pinned to pgvector's default, which production runs with. */
function atProductionProbes(url: string): string {
  const pinned = new URL(url);
  pinned.searchParams.set("options", "-c ivfflat.probes=1");
  return pinned.toString();
}

describe.skipIf(!QA_URL)("semantic search at production index settings, real Postgres", () => {
  let db: PrismaClient;
  let storeDb: (typeof import("@/lib/db"))["db"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let queries: number[][];
  let queryEmbedding: number[];

  /** The K nearest chunks of the org, read with index scans disabled so nothing is approximate. */
  async function exactNearest(query: number[]): Promise<string[]> {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
      return tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM memory_chunks
        WHERE "orgId" = ${ORG} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${pgVector(query)}::vector
        LIMIT ${K}
      `;
    });
    return rows.map((r) => r.id);
  }

  async function search(query: number[]): Promise<string[]> {
    queryEmbedding = query;
    const result = await new PgvectorMemoryStore().retrieve({ groupId: ORG, tenantId: ORG, query: "q", limit: K });
    expect(result.storesRead).toEqual([{ store: "semantic" }]);
    return result.facts.map((f) => f.uuid);
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    process.env.DATABASE_URL = atProductionProbes(QA_URL!);
    ({ db: storeDb } = await import("@/lib/db"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: queryEmbedding }), { status: 200 })),
    );

    const random = seededRandom(20261007);
    const shared = randomUnitVector(random);
    for (const orgId of [ORG, NEIGHBOR_ORG]) {
      await db.org.deleteMany({ where: { id: orgId } });
      await db.org.create({ data: { id: orgId, name: orgId } });
      const topics = Array.from({ length: CHUNKS_PER_ORG / CHUNKS_PER_TOPIC }, () => randomUnitVector(random));
      if (orgId === ORG) {
        queries = Array.from({ length: QUERIES }, () =>
          chunkEmbedding(shared, topics[Math.floor(random() * topics.length)], random),
        );
      }
      for (let start = 0; start < CHUNKS_PER_ORG; start += INSERT_BATCH) {
        const rows = Array.from({ length: INSERT_BATCH }, (_, i) => {
          const n = start + i;
          const embedding = chunkEmbedding(shared, topics[n % topics.length], random);
          return Prisma.sql`(${`${orgId}-${n}`}, ${orgId}, ${`chunk ${n}`}, 'text', 'human', ${pgVector(embedding)}::vector, NOW())`;
        });
        await db.$executeRaw`
          INSERT INTO memory_chunks ("id","orgId","content","source","actorType","embedding","createdAt")
          VALUES ${Prisma.join(rows)}
        `;
      }
    }
    // Production's autovacuum keeps planner statistics current; a freshly seeded
    // table has none until this runs.
    await db.$executeRaw`ANALYZE memory_chunks`;
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.org.deleteMany({ where: { id: { in: [ORG, NEIGHBOR_ORG] } } });
    await db.$disconnect();
    await storeDb?.$disconnect();
  });

  it("searches the index production has, at the probe count production uses", async () => {
    const [index] = await db.$queryRaw<{ method: string; options: string[] }[]>`
      SELECT am.amname AS method, c.reloptions AS options
      FROM pg_class c JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'memory_chunks_embedding_idx'
    `;
    expect(index).toEqual({ method: "ivfflat", options: ["lists=100"] });
    const [session] = await storeDb.$queryRaw<{ probes: string }[]>`SELECT current_setting('ivfflat.probes') AS probes`;
    expect(session.probes).toBe("1");
  });

  it("returns every one of the nearest chunks an exact search finds", async () => {
    const recalls: number[] = [];
    for (const query of queries) {
      const exact = await exactNearest(query);
      const found = new Set(await search(query));
      recalls.push(exact.filter((id) => found.has(id)).length / K);
    }
    const recallAtK = recalls.reduce((sum, r) => sum + r, 0) / recalls.length;
    expect({ recallAtK, queriesMissingChunks: recalls.filter((r) => r < 1).length }).toEqual({
      recallAtK: 1,
      queriesMissingChunks: 0,
    });
  }, 60_000);

  it("leaves the connection's probe count as it found it", async () => {
    await search(queries[0]);
    const [session] = await storeDb.$queryRaw<{ probes: string }[]>`SELECT current_setting('ivfflat.probes') AS probes`;
    expect(session.probes).toBe("1");
  });
});
