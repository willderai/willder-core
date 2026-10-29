// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Reserved vector slots on a real read. Everything below the checked read is
// real except Graphiti and the embedding service: check() runs against a live
// capability, the hybrid store routes the read, and pgvector's similarity SQL
// runs against Postgres. The graph fake returns more extraction-tier facts
// than the page holds, the shape that used to leave Ask with no chunks at all.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact } from "@/types/memory";

// The stand-in graph's facts here have no stored rows behind them, and this file is about
// how a page is shared between the stores, not about which facts a stored source supports: the serve-time source check
// (services/memory/graph-fact-sources.ts) supports them all. It is proven against real rows in
// services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "vecreserve";
const ROOT = `org_${ORG}`;
const DIMENSIONS = 384;

/** A unit vector whose cosine similarity to the query vector [1, 0, ...] is `similarity`. */
function vectorAt(similarity: number): string {
  const rest = Array(DIMENSIONS - 2).fill(0);
  return `[${[similarity, Math.sqrt(1 - similarity ** 2), ...rest].join(",")}]`;
}

const graphFacts: MemoryFact[] = Array.from({ length: 20 }, (_, i) => ({
  uuid: `graph-${i + 1}`,
  fact: `graph fact ${i + 1}`,
  validAt: null,
  actorType: "extraction",
  store: "graph",
}));

describe.skipIf(!QA_URL)("reserved vector slots on a real org-root read", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  let graphPage: MemoryFact[] = graphFacts;
  const busyGraph = {
    retrieve: vi.fn(async () => ({ facts: graphPage, storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(busyGraph, new PgvectorMemoryStore()), async () => "enterprise");

  const insertChunk = (id: string, similarity: number, scopePath = ROOT) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${`chunk ${id}`}, 'text', 'extraction', ${scopePath}, ${vectorAt(similarity)}::vector, NOW())
    `;

  async function rootReader(scopePath = ROOT): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "root-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "root-reader", capabilityToken: token }, origin: "mcp" };
  }

  async function clear() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await clear();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ embedding: [1, ...Array(DIMENSIONS - 1).fill(0)] }), { status: 200 }),
      ),
    );
    await clear();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    graphPage = graphFacts;
  });

  it("returns the closest chunks next to graph facts at the 15-fact limit", async () => {
    const similarities = [0.6, 0.59, 0.58, 0.57, 0.56, 0.55, 0.55, 0.54, 0.54];
    for (const [i, similarity] of similarities.entries()) await insertChunk(`chunk-${i + 1}`, similarity);

    const result = await reader().retrieve(await rootReader(), { groupId: ORG, query: "what changed", limit: 15 });

    expect(result.facts).toHaveLength(15);
    expect(result.facts.filter((f) => f.store === "semantic").map((f) => f.uuid)).toEqual([
      "chunk-1",
      "chunk-2",
      "chunk-3",
      "chunk-4",
      "chunk-5",
    ]);
    expect(result.facts.filter((f) => f.store === "graph").map((f) => f.uuid)).toEqual(
      graphFacts.slice(0, 10).map((f) => f.uuid),
    );
    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 10 },
      { store: "semantic", hits: 5 },
    ]);
  });

  it("leaves the page to graph facts when no chunk clears the similarity floor", async () => {
    for (const [i, similarity] of [0.45, 0.3].entries()) await insertChunk(`far-${i + 1}`, similarity);

    const result = await reader().retrieve(await rootReader(), { groupId: ORG, query: "what changed", limit: 15 });

    expect(result.facts.map((f) => f.uuid)).toEqual(graphFacts.slice(0, 15).map((f) => f.uuid));
    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 15 },
      { store: "semantic", hits: 0 },
    ]);
  });

  // The slot a pulled-up chunk gives up only ever goes to a
  // fact this read may serve. The closest chunks are another scope's and a superseded version;
  // every slot holds a chunk its graph paraphrase pulled up.
  it("gives a pulled-up chunk's slot only to a hit the reader may see", async () => {
    const SALES = `${ROOT}.sales`;
    const HR = `${ROOT}.hr`;
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: SALES } });
    await db.scope.create({ data: { orgId: ORG, path: HR, name: HR } });
    for (let i = 1; i <= 12; i++) await insertChunk(`para-${i}`, 0.3, SALES);
    await insertChunk("hr-secret", 1, HR);
    await insertChunk("own-v1", 0.99, SALES);
    await insertChunk("own-v2", 0.9, SALES);
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "own-v2",
        toId: "own-v1",
        kind: "supersedes",
        scopePath: SALES,
        actorType: "agent",
        actorId: "w",
      },
    });
    graphPage = Array.from({ length: 12 }, (_, i) => ({ ...graphFacts[i]!, chunkIds: [`para-${i + 1}`] }));
    graphPage.push({ ...graphFacts[12]!, chunkIds: ["hr-secret"] }, { ...graphFacts[13]!, chunkIds: ["own-v1"] });

    const result = await reader().retrieve(
      await rootReader(SALES),
      { groupId: ORG, query: "what changed", scopePath: SALES, limit: 10 },
      SALES,
    );
    const served = result.facts.map((f) => f.uuid);

    expect(served).toHaveLength(10);
    expect(served[0]).toBe("own-v2");
    expect(served).not.toContain("own-v1");
    expect(served).not.toContain("hr-secret");
    expect(result.facts.some((f) => f.fact.includes("hr-secret") || f.fact.includes("own-v1"))).toBe(false);
  });
});
