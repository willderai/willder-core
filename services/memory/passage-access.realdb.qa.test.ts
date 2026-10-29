// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Passage embeddings (services/memory/passages.ts) under two tenants and two scopes,
// read through the real entry point: check() against a live capability,
// GuardedMemoryStore, HybridMemoryStore and pgvector's SQL against Postgres.
//
// The claim under test: a passage can change how a row the caller may read ranks, and
// nothing else. A row in another tenant (under a textually identical scope path), in a
// sibling scope, or at the untagged org root never comes back through its passages,
// however well they match, and deleting a row by any path (source retirement, an org
// deletion) leaves none of its passages behind.
//
// The embedding service is a stub model that, like bge-small, reads only the first
// MODEL_WINDOW characters: a text whose window mentions "lighthouse" embeds to the
// query's axis, anything else away from it. Every long row below holds "lighthouse"
// only past that window, so its own embedding is far from the query and only its
// passages can surface it; a leak would rank first.
//
// Case types covered: normal (a permitted read found only through a passage), edge
// (identical path in another tenant, untagged partition, sibling scope), error (a
// denied scope, with the denial text checked), memory side (passage rows after each
// delete path, and the in-flight bound on /embed-batch under concurrent long ingests).
// Not covered: user side (no screen), the graph store, production scale (the builder's
// 20k-row latency figures are theirs, not re-measured here).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";
import type { MemoryStore } from "./memory-store";

// The graph store answers nothing and removes nothing: only Postgres is under test.
vi.mock("./store", () => ({ memory: {}, graphitiStore: { removeGroupFacts: async () => ({ removedCount: 0 }) } }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_passage_access";
const OTHER_ORG = "qa_passage_access_other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const SUPPORT = `${ROOT}.support`;
const DIMENSIONS = 384;
const MODEL_WINDOW = 2_000;

const vector = (...leading: number[]) => [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];

function stubEmbedding(text: string): number[] {
  return text.slice(0, MODEL_WINDOW).includes("lighthouse") ? vector(1) : vector(0, 1);
}

/** About 4,400 characters naming `marker` only past the model window, next to "lighthouse". */
function longRow(marker: string): string {
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `Planning note ${i}: the quarterly plan moved forward without changes.`).join(
      " ",
    );
  return `${filler(50).slice(0, 3_000)} The offsite is at the lighthouse; contact ${marker}. ${filler(20)}`;
}

const ROWS = {
  sales: { orgId: ORG, scopePath: SALES as string | undefined, marker: "sales-marker@example.org" },
  support: { orgId: ORG, scopePath: SUPPORT as string | undefined, marker: "support-marker@example.org" },
  untagged: { orgId: ORG, scopePath: undefined as string | undefined, marker: "untagged-marker@example.org" },
  otherTenant: { orgId: OTHER_ORG, scopePath: SALES as string | undefined, marker: "other-tenant-marker@example.com" },
} as const;
type RowKey = keyof typeof ROWS;

describe.skipIf(!QA_URL)("passage embeddings: two tenants, two scopes, real entry point", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let retireLateSourceWrite: (typeof import("./source-retirement"))["retireLateSourceWrite"];
  let embedBatchesInFlight = 0;
  let maxEmbedBatchesInFlight = 0;
  const ids: Partial<Record<RowKey, string>> = {};

  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => "enterprise");

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

  const input = (key: RowKey, extra: Partial<IngestInput> = {}): IngestInput => ({
    groupId: ROWS[key].orgId,
    content: longRow(ROWS[key].marker),
    actorType: "human",
    actorId: "u1",
    origin: "app",
    ...(ROWS[key].scopePath === undefined ? {} : { scopePath: ROWS[key].scopePath }),
    ...extra,
  });

  const passageCount = async (chunkIds: string[]) =>
    (
      await db.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM memory_chunk_passages WHERE "chunkId" = ANY (${chunkIds}::text[])`
    )[0]!.n;

  const markersIn = (text: string, keys: RowKey[]) => keys.map((k) => ROWS[k].marker).filter((m) => text.includes(m));

  async function readAs(ctx: AccessContext, orgId: string, scope?: string): Promise<string> {
    try {
      return JSON.stringify(await reader().retrieve(ctx, { groupId: orgId, query: "lighthouse" }, scope));
    } catch (e) {
      return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ retireLateSourceWrite } = await import("./source-retirement"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    embedBatchesInFlight = 0;
    maxEmbedBatchesInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { text?: string; texts?: string[] };
        if (new URL(url).pathname === "/embed-batch") {
          embedBatchesInFlight++;
          maxEmbedBatchesInFlight = Math.max(maxEmbedBatchesInFlight, embedBatchesInFlight);
          // Long enough that concurrent callers really overlap.
          await new Promise((resolve) => setTimeout(resolve, 5));
          embedBatchesInFlight--;
          return new Response(JSON.stringify({ embeddings: body.texts!.map(stubEmbedding) }), { status: 200 });
        }
        return new Response(JSON.stringify({ embedding: stubEmbedding(body.text!) }), { status: 200 });
      }),
    );
    await wipe();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.scope.createMany({ data: [ROOT, SALES, SUPPORT].map((path) => ({ orgId: ORG, path, name: path })) });
    await db.scope.createMany({
      data: [`org_${OTHER_ORG}`, SALES].map((path) => ({ orgId: OTHER_ORG, path, name: path })),
    });
    const store = new PgvectorMemoryStore();
    for (const key of Object.keys(ROWS) as RowKey[]) {
      ids[key] = (await store.ingest(input(key))).episodeId;
    }
  });

  it("stores the rows in their own tenant, each with passages", async () => {
    // Precondition for every probe below: the rows really are where the probes assume.
    const rows = await db.$queryRaw<{ id: string; orgId: string; scopePath: string | null }[]>`
      SELECT id, "orgId", "scopePath" FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG}) ORDER BY id`;
    expect(rows).toHaveLength(4);
    for (const key of Object.keys(ROWS) as RowKey[]) {
      const row = rows.find((r) => r.id === ids[key])!;
      expect(row.orgId).toBe(ROWS[key].orgId);
      expect(row.scopePath).toBe(ROWS[key].scopePath ?? null);
      expect(await passageCount([ids[key]!])).toBeGreaterThanOrEqual(3);
    }
  });

  it("a sales reader finds the sales row through its passage, and no other tenant's, scope's or root row", async () => {
    const ctx = await agent(ORG, "sales-reader", SALES);

    const response = await readAs(ctx, ORG, SALES);
    const result = JSON.parse(response) as { facts: { uuid: string; similarity?: number }[] };

    // Positive control: found only because of its passage (its own embedding is orthogonal).
    expect(result.facts.map((f) => f.uuid)).toEqual([ids.sales]);
    expect(result.facts[0]!.similarity).toBeCloseTo(1, 6);
    expect(markersIn(response, ["support", "untagged", "otherTenant"])).toEqual([]);
  });

  it("the other tenant, whose row sits under a path identical to this tenant's sales scope, gets only its own row", async () => {
    const ctx = await agent(OTHER_ORG, "other-reader", `org_${OTHER_ORG}`);

    const response = await readAs(ctx, OTHER_ORG);
    const result = JSON.parse(response) as { facts: { uuid: string }[] };

    expect(result.facts.map((f) => f.uuid)).toEqual([ids.otherTenant]);
    expect(markersIn(response, ["sales", "support", "untagged"])).toEqual([]);
  });

  it("an org-root reader gets this tenant's three rows and never the other tenant's", async () => {
    const ctx = await agent(ORG, "root-reader", ROOT);

    const response = await readAs(ctx, ORG, ROOT);
    const result = JSON.parse(response) as { facts: { uuid: string }[] };

    expect(result.facts.map((f) => f.uuid).sort()).toEqual([ids.sales, ids.support, ids.untagged].sort());
    expect(markersIn(response, ["otherTenant"])).toEqual([]);
  });

  it("a reader denied a scope learns nothing from it, including from the denial", async () => {
    const ctx = await agent(ORG, "sales-reader", SALES);

    const response = await readAs(ctx, ORG, SUPPORT);

    expect(response.startsWith("AccessDeniedError")).toBe(true);
    expect(markersIn(response, ["sales", "support", "untagged", "otherTenant"])).toEqual([]);
  });

  it("retiring a source's rows deletes their passages; the other tenant's stay", async () => {
    const store = new PgvectorMemoryStore();
    const { episodeId: synced } = await store.ingest({ ...input("sales"), sourceId: "src_qa_passages" });
    expect(await passageCount([synced])).toBeGreaterThanOrEqual(3);

    await retireLateSourceWrite({ orgId: ORG, sourceId: "src_qa_passages", scopePath: SALES });

    expect(await passageCount([synced])).toBe(0);
    expect(await passageCount([ids.sales!, ids.otherTenant!])).toBeGreaterThanOrEqual(6);
  });

  it("deleting a tenant deletes its rows' passages and nobody else's", async () => {
    await db.capability.deleteMany({ where: { orgId: OTHER_ORG } });
    await db.scope.deleteMany({ where: { orgId: OTHER_ORG } });
    await db.org.delete({ where: { id: OTHER_ORG } });

    expect(await passageCount([ids.otherTenant!])).toBe(0);
    expect(await passageCount([ids.sales!, ids.support!, ids.untagged!])).toBeGreaterThanOrEqual(9);
  });

  it("concurrent long ingests keep at most two /embed-batch requests in flight, and every row gets all its passages", async () => {
    const store = new PgvectorMemoryStore();
    maxEmbedBatchesInFlight = 0;
    // 20 rows of about 12,000 characters (about 30 passages each), written at once.
    const big = (i: number) => `${longRow(`load-${i}`)} ${longRow(`load-${i}-b`)} ${longRow(`load-${i}-c`)}`;
    const written = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.ingest({ ...input("sales"), content: big(i) })),
    );

    expect(maxEmbedBatchesInFlight).toBeGreaterThan(0);
    expect(maxEmbedBatchesInFlight).toBeLessThanOrEqual(2);
    const { splitPassages } = await import("./passages");
    for (const [i, { episodeId }] of written.entries()) {
      expect(await passageCount([episodeId])).toBe(splitPassages(big(i)).length);
    }
  });
});
