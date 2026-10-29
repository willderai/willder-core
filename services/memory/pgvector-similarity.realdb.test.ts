// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// PgvectorMemoryStore.retrieve's similarity score, against real Postgres with pgvector.
//
// The score is computed in SQL (`1 - (embedding <=> query)`), so only a real
// database can show it is the cosine similarity the Chunks tab displays, that
// hits come back best first, and that a chunk outside the read's scope still
// contributes nothing. The embedding service is stubbed with fixed unit vectors,
// so every expected score is exact.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "simq1";
const SALES = "org_simq1.sales";
const SUPPORT = "org_simq1.support";
const DIMENSIONS = 384;

/** A 384-dimension vector with the given leading components, then zeros. */
function vector(...leading: number[]): number[] {
  return [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];
}
const pgVector = (v: number[]) => `[${v.join(",")}]`;

describe.skipIf(!QA_URL)("PgvectorMemoryStore.retrieve: similarity score, real Postgres", () => {
  let db: PrismaClient;
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const insertChunk = (id: string, scopePath: string, embedding: number[]) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${`chunk ${id}`}, 'text', 'human', ${scopePath}, ${pgVector(embedding)}::vector, NOW())
    `;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));

    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await insertChunk("same", SALES, vector(1));
    await insertChunk("half", SALES, vector(Math.SQRT1_2, Math.SQRT1_2));
    await insertChunk("orthogonal", SALES, vector(0, 1));
    // Identical to the query, so it would rank first if the scope filter let it through.
    await insertChunk("other-scope", SUPPORT, vector(1));

    // The query embeds to the first axis.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector(1) }), { status: 200 })),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.$disconnect();
  });

  it("scores each hit by cosine similarity to the query, best first, inside the read's scope only", async () => {
    const result = await new PgvectorMemoryStore().retrieve({
      groupId: SALES,
      tenantId: ORG,
      scopePath: SALES,
      query: "pricing",
    });

    expect(result.facts.map((f) => f.uuid)).toEqual(["same", "half", "orthogonal"]);
    const [same, half, orthogonal] = result.facts.map((f) => f.similarity!);
    expect(same).toBeCloseTo(1, 6);
    expect(half).toBeCloseTo(Math.SQRT1_2, 6);
    expect(orthogonal).toBeCloseTo(0, 6);
    expect(result.facts.every((f) => f.store === "semantic")).toBe(true);
    expect(result.storesRead).toEqual([{ store: "semantic" }]);
  });
});
