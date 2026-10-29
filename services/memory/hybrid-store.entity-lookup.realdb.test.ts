// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An entity lookup ("what is X") made while extraction is behind, against real pgvector.
//
// A new chunk is in pgvector as soon as ingest returns; the facts extracted from it reach
// the graph only later. Until then the graph still holds the answer from before the
// change. This proves the hybrid read asks pgvector for an entity lookup, so the new
// chunk answers, and that the vector leg still keeps to the read's scope. The graph is
// a stub holding the old fact; the embedding service is stubbed with one fixed vector.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { MemoryStore } from "./memory-store";
import type { SearchInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "entlk1";
const SALES = "org_entlk1.sales";
const SUPPORT = "org_entlk1.support";
const DIMENSIONS = 384;
const QUERY = "what is the launch date";
const STALE = "The launch date is October 20";
const FRESH = "The launch date is now October 27";

const embedding = [1, ...Array(DIMENSIONS - 1).fill(0)];

/** A graph store that has not yet extracted the new chunk: it holds only the old fact, in SALES. */
function graphBeforeExtraction(): MemoryStore {
  return {
    retrieve: vi.fn(async (input: SearchInput) => ({
      facts:
        input.groupId === SALES
          ? [{ uuid: "graph-stale", fact: STALE, validAt: null, actorType: "extraction", store: "graph" }]
          : [],
      storesRead: [{ store: "graph" }],
    })),
  } as unknown as MemoryStore;
}

describe.skipIf(!QA_URL)("HybridMemoryStore.retrieve: entity lookup while extraction is behind, real Postgres", () => {
  let db: PrismaClient;
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));

    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES ('fresh-chunk', ${ORG}, ${FRESH}, 'text', 'agent', ${SALES}, ${`[${embedding.join(",")}]`}::vector, NOW())
    `;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding }), { status: 200 })),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.$disconnect();
  });

  it("answers with the new chunk alongside the graph's old fact, in the writer's scope", async () => {
    const store = new HybridMemoryStore(graphBeforeExtraction(), new PgvectorMemoryStore());

    const result = await store.retrieve({ groupId: SALES, tenantId: ORG, scopePath: SALES, query: QUERY });

    expect(result.facts.map((f) => [f.fact, f.store])).toEqual([
      [STALE, "graph"],
      [FRESH, "semantic"],
    ]);
    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
  });

  it("gives a sibling scope nothing: the vector leg still keeps to the read's scope", async () => {
    const store = new HybridMemoryStore(graphBeforeExtraction(), new PgvectorMemoryStore());

    const result = await store.retrieve({ groupId: SUPPORT, tenantId: ORG, scopePath: SUPPORT, query: QUERY });

    expect(result.facts).toEqual([]);
    expect(result.storesRead).toEqual([{ store: "graph" }, { store: "semantic" }]);
  });
});
