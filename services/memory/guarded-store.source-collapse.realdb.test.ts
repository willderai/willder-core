// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Collapsing extracted facts into their source chunk, on a real read. Everything below
// the checked read is real except the graph store and the embedding service: check()
// runs against a live capability, descendant scopes come from the scopes table, the
// hybrid store routes the read, pgvector's scoped SQL and erasure suppression run on
// Postgres. The graph fake answers per partition, so it can hold facts whose source
// chunk sits in a scope the reader cannot read, and the reverse.
//
// The rule under test: collapsing only ever swaps a fact for a chunk the same read
// already returned. It never brings in a chunk or a fact the reader may not read, and a
// chunk an erasure suppressed stays unserved even when a fact names it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { toGid } from "./graphiti-store";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact, SearchInput } from "@/types/memory";

vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "collapseacl";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const HR = `${ROOT}.hr`;
const DIMENSIONS = 384;
const QUERY_VECTOR = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

function graphFact(uuid: string, chunkIds: string[]): MemoryFact {
  return { uuid, fact: `graph ${uuid}`, validAt: null, actorType: "agent", store: "graph", chunkIds };
}

/** Graph facts per partition. Each partition holds a fact citing a chunk in the other. */
const GRAPH_BY_PARTITION: Record<string, MemoryFact[]> = {
  sales: [graphFact("g-sales-paraphrase", ["c-sales"]), graphFact("g-sales-cites-hr", ["c-hr"])],
  hr: [graphFact("g-hr-cites-sales", ["c-sales"]), graphFact("g-hr-own", [])],
};

describe.skipIf(!QA_URL)("collapsing extracted facts into their source chunk, on a real read", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  const partitionsAsked: string[] = [];

  const graph = {
    retrieve: vi.fn(async (input: SearchInput) => {
      partitionsAsked.push(input.groupId);
      const partition = input.groupId.endsWith(".sales") ? "sales" : input.groupId.endsWith(".hr") ? "hr" : null;
      // The real graph store names the partition on every fact it returns.
      const facts = partition
        ? GRAPH_BY_PARTITION[partition].map((fact) => ({ ...fact, graphGroupId: toGid(input.groupId) }))
        : [];
      return { facts, storesRead: [{ store: "graph" as const }] };
    }),
  } as unknown as MemoryStore;

  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(graph, new PgvectorMemoryStore()), async () => "enterprise");

  const insertChunk = (id: string, content: string, scopePath: string, createdAt = "(NOW() AT TIME ZONE 'UTC')") =>
    db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', $4, $5::vector, ${createdAt})`,
      id,
      ORG,
      content,
      scopePath,
      QUERY_VECTOR,
    );

  async function readerAt(scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    const agentId = `reader-${scopePath}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  async function clear() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
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
    partitionsAsked.length = 0;
    await clear();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    for (const path of [ROOT, SALES, HR]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    await insertChunk("c-sales", "Renewal call moved to Friday 9:00", SALES);
    await insertChunk("c-hr", "Salary band review closes in March", HR);
    // The direct write "g-hr-own" was distilled from verbatim, stored with no embedding so the
    // vector leg never returns it: the graph fact is served only while it is stored
    // (services/memory/graph-fact-sources.ts).
    await db.$executeRaw`INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt") VALUES ('c-hr-own', ${ORG}, 'graph g-hr-own', 'text', 'agent', ${HR}, now())`;
  });

  it("a reader of one scope gets its chunk in place of the paraphrase, and nothing from the other scope", async () => {
    const { facts } = await reader().retrieve(await readerAt(SALES), { groupId: ORG, query: "what changed" }, SALES);
    const served = facts.map((f) => f.uuid);

    // The paraphrase of the readable chunk is collapsed into it.
    expect(served).toContain("c-sales");
    expect(served).not.toContain("g-sales-paraphrase");
    // A readable fact naming an unreadable chunk stays a fact; the chunk is never fetched for it.
    expect(served).toContain("g-sales-cites-hr");
    expect(served).not.toContain("c-hr");
    expect(facts.map((f) => f.fact).join("\n")).not.toContain("Salary band");
    // A fact in the unreadable scope naming the readable chunk is never asked for, let alone served.
    expect(served).not.toContain("g-hr-cites-sales");
    expect(served).not.toContain("g-hr-own");
    expect(partitionsAsked.some((p) => p.endsWith(".hr"))).toBe(false);
  });

  it("an org-root reader gets each chunk once, in place of the facts extracted from it in every scope", async () => {
    const { facts } = await reader().retrieve(await readerAt(ROOT), { groupId: ORG, query: "what changed" });
    const served = facts.map((f) => f.uuid).sort();

    expect(served).toEqual(["c-hr", "c-sales", "g-hr-own"]);
  });

  it("never serves a chunk an erasure suppressed, even when a served fact names it", async () => {
    // The chunk names an erased person and was written before the erasure, as a restored
    // backup would put it back. Suppression is recorded after the row.
    await insertChunk(
      "c-erased",
      "Dana Whitfield asked to move the renewal call",
      SALES,
      "(NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour'",
    );
    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, ORG, "collapse-erasure", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    GRAPH_BY_PARTITION.sales.push(graphFact("g-from-erased", ["c-erased"]));
    try {
      const { facts } = await reader().retrieve(await readerAt(SALES), { groupId: ORG, query: "what changed" }, SALES);

      expect(facts.map((f) => f.uuid)).not.toContain("c-erased");
      expect(facts.map((f) => f.fact).join("\n")).not.toContain("Dana Whitfield");
      // Nor is the graph fact extracted from it: its only source is suppressed, and a graph
      // fact is served only while an unsuppressed source is (services/memory/graph-fact-sources.ts),
      // whether or not the erasure's own graph retirement reached it.
      expect(facts.map((f) => f.uuid)).not.toContain("g-from-erased");
    } finally {
      GRAPH_BY_PARTITION.sales.pop();
    }
  });
});
