// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The store breakdown and vector similarity on a read, against a real database.
//
// The unit suite stubs check() and the stores. Here the whole read path is
// real except Graphiti and the embedding service: check() runs against live
// capabilities, the hybrid store routes the read, and pgvector's SQL runs against
// Postgres. The questions this answers:
//
//   - Adding the similarity column did not widen what a read returns: the tenant
//     predicate and scope containment still hold, including against a `_`
//     wildcard impostor scope and another tenant's rows under the same path.
//   - The breakdown counts only the facts the caller received, after the account
//     tier's token budget cut, never the candidates the stores returned.
//   - A vector search that could not run is reported as failed, not as zero hits.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { AccountTier } from "@/types/memory";

vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "case298";
const OTHER_ORG = "case298_other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.dept_sales`;
/** Matches `dept_sales` if `_` were left as a LIKE wildcard. */
const IMPOSTOR = `${ROOT}.deptXsales.eu`;
const SUPPORT = `${ROOT}.support`;
const BUDGET = `${ROOT}.budget`;
const DIMENSIONS = 384;

function vector(...leading: number[]): number[] {
  return [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];
}
const pgVector = (v: number[]) => `[${v.join(",")}]`;

describe.skipIf(!QA_URL)("store breakdown and similarity on a real read", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let AccessDeniedError: (typeof import("@/services/access/check"))["AccessDeniedError"];

  /** Graphiti stand-in: answers nothing, reports the graph as read. */
  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  const reader = (tier: AccountTier = "enterprise") =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => tier);

  const insertChunk = (
    orgId: string,
    id: string,
    scopePath: string | null,
    embedding: number[],
    content = `chunk ${id}`,
  ) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'text', 'human', ${scopePath}, ${pgVector(embedding)}::vector, NOW())
    `;

  async function agent(orgId: string, agentId: string, scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  const embeddingService = (ok: boolean) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok
          ? new Response(JSON.stringify({ embedding: vector(1) }), { status: 200 })
          : new Response("down", { status: 503 }),
      ),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ AccessDeniedError } = await import("@/services/access/check"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    embeddingService(true);
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.scope.createMany({
      data: [ROOT, SALES, `${ROOT}.deptXsales`, IMPOSTOR, SUPPORT, BUDGET].map((path) => ({
        orgId: ORG,
        path,
        name: path,
      })),
    });
    await db.scope.createMany({ data: [`org_${OTHER_ORG}`].map((path) => ({ orgId: OTHER_ORG, path, name: path })) });

    await insertChunk(ORG, "sales-same", SALES, vector(1));
    await insertChunk(ORG, "sales-half", `${SALES}.eu`, vector(Math.SQRT1_2, Math.SQRT1_2));
    // Each of these is identical to the query, so it would rank first if its guard failed.
    await insertChunk(ORG, "impostor", IMPOSTOR, vector(1));
    await insertChunk(ORG, "support", SUPPORT, vector(1));
    await insertChunk(ORG, "untagged", null, vector(1));
    await insertChunk(OTHER_ORG, "other-tenant-same-path", SALES, vector(1));
  });

  it("returns only the caller's scope, scored by cosine similarity, and counts exactly those hits", async () => {
    const ctx = await agent(ORG, "sales-reader", SALES);

    const result = await reader().retrieve(ctx, { groupId: ORG, query: "what have we discussed about pricing" }, SALES);

    expect(result.facts.map((f) => f.uuid)).toEqual(["sales-same", "sales-half"]);
    expect(result.facts[0].similarity).toBeCloseTo(1, 6);
    expect(result.facts[1].similarity).toBeCloseTo(Math.SQRT1_2, 6);
    expect(result.breakdown).toEqual({
      stores: [
        { store: "graph", hits: 0 },
        { store: "semantic", hits: 2 },
      ],
      contextTokens: result.facts.reduce((sum, f) => sum + Math.ceil(f.fact.length / 4), 0),
    });
    // storesRead is the stores' internal report; the checked read returns the breakdown only.
    expect(result.storesRead).toBeUndefined();
  });

  it("denies a scope the capability does not cover, before any store is asked", async () => {
    const ctx = await agent(ORG, "sales-reader", SALES);
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(reader().retrieve(ctx, { groupId: ORG, query: "pricing" }, SUPPORT)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps each tenant to its own rows even under an identical scope path", async () => {
    const ctx = await agent(OTHER_ORG, "other-reader", `org_${OTHER_ORG}`);

    const result = await reader().retrieve(ctx, { groupId: OTHER_ORG, query: "what have we discussed about pricing" });

    expect(result.facts.map((f) => f.uuid)).toEqual(["other-tenant-same-path"]);
    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 0 },
      { store: "semantic", hits: 1 },
    ]);
  });

  it("counts only the facts that survived the tier's token budget, not the candidates fetched", async () => {
    // Ten 3,000-character chunks: 750 tokens each, so the team tier's 6,000 keeps eight.
    for (let i = 0; i < 10; i++) {
      await insertChunk(ORG, `budget-${i}`, BUDGET, vector(1, i / 100), `${i}`.padEnd(3000, "x"));
    }
    const ctx = await agent(ORG, "budget-reader", BUDGET);

    const result = await reader("team").retrieve(
      ctx,
      { groupId: ORG, query: "what have we discussed about pricing" },
      BUDGET,
    );

    expect(result.facts).toHaveLength(8);
    expect(result.breakdown).toEqual({ stores: [{ store: "semantic", hits: 8 }], contextTokens: 6000 });
  });

  it("reports vector search as failed, not as zero hits, when the embedding service is down", async () => {
    embeddingService(false);
    const ctx = await agent(ORG, "sales-reader", SALES);

    const result = await reader().retrieve(ctx, { groupId: ORG, query: "what have we discussed about pricing" }, SALES);

    expect(result.facts).toEqual([]);
    expect(result.breakdown?.stores).toEqual([
      { store: "graph", hits: 0 },
      { store: "semantic", hits: 0, failed: true },
    ]);
  });
});
