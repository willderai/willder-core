// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// retrieve()'s erasure-before-LIMIT rounds (services/memory/pgvector-store.ts),
// alongside erasure-before-limit.realdb.test.ts. Two things that file does not pin:
//  - Tenancy: one org's suppression list never hides another org's rows, and the rows one
//    org's rounds exclude never let another org's rows onto its page.
//  - Cost: a read with no suppressed candidate runs exactly one search, as before; a read
//    whose candidates keep coming back suppressed stops after MAX_SUPPRESSION_ROUNDS (3)
//    more searches, never more.
//
// Real: Postgres with pgvector, check() against live capabilities, GuardedMemoryStore,
// HybridMemoryStore, the erasure's DELETEs and the suppression list. Stand-in: the graph
// store and the embedding service (the question and every row naming the person on one
// axis, every other row at a cosine of 0.6 from it).
//
// Case types: normal (no suppressed rows, one search), edge (more restored rows than the
// rounds exclude), memory side (two tenants with identical content, one erased).
// Not covered: the graph store; production latency (measured on task-start,
// which reads through services/memory/task-start.ts, not retrieve()).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
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

const ERASED_ORG = "qa_ebl_tenant_erased";
const KEPT_ORG = "qa_ebl_tenant_kept";
const ORGS = [ERASED_ORG, KEPT_ORG];
const sales = (org: string) => `org_${org}.sales`;
const ADMIN = "qa_ebl_tenant_admin";
const PERSON = "Orla Brennick";
const QUESTION = "Where does the renewal key live?";
const DIMENSIONS = 384;

const vector = (...leading: number[]) => [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];
const stubEmbedding = (text: string) => (text === QUESTION || text.includes(PERSON) ? vector(1) : vector(0.6, 0.8));

type BackupRow = { id: string; content: string; embedding: string; createdAt: Date };

describe.skipIf(!QA_URL)("erasure-before-LIMIT rounds: tenancy and cost, real Postgres", () => {
  let db: PrismaClient;
  let appDb: (typeof import("@/lib/db"))["db"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  const readable: Record<string, string> = {};

  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;
  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => "enterprise");
  const admin = (org: string): AccessContext => ({
    orgId: org,
    actor: { type: "human", id: `${ADMIN}_${org}`, role: "admin" },
    origin: "app",
  });

  async function salesReader(org: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: org,
        agentId: "sales-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: sales(org),
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: org, actor: { type: "agent", id: "sales-reader", capabilityToken: token }, origin: "mcp" };
  }

  const write = async (org: string, content: string) =>
    (
      await new PgvectorMemoryStore().ingest({
        groupId: org,
        content,
        actorType: "human",
        actorId: "u1",
        origin: "app",
        scopePath: sales(org),
      })
    ).episodeId;

  const page = async (org: string, ctx: AccessContext, limit: number) =>
    (await reader().retrieve(ctx, { groupId: org, query: QUESTION, limit }, sales(org))).facts.map((f) => ({
      uuid: f.uuid,
      fact: f.fact,
    }));

  async function writePersonRows(org: string, count: number): Promise<BackupRow[]> {
    const rows: BackupRow[] = [];
    for (let i = 0; i < count; i++) {
      const content = `${PERSON} keeps renewal key copy ${i}.`;
      const id = await write(org, content);
      const [row] = await db.$queryRaw<{ createdAt: Date; embedding: string }[]>`
        SELECT "createdAt", embedding::text AS embedding FROM memory_chunks WHERE "orgId" = ${org} AND id = ${id}`;
      rows.push({ id, content, ...row! });
    }
    return rows;
  }

  async function restore(org: string, backup: BackupRow[]) {
    for (const row of backup) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
        VALUES (${row.id}, ${org}, ${row.content}, 'text', 'human', 'u1', ${sales(org)}, ${row.embedding}::vector, ${row.createdAt})`;
    }
  }

  /** Counts the vector searches retrieve() runs (each is one $queryRaw naming nearest_rows). */
  async function countSearches(run: () => Promise<unknown>) {
    const spy = vi.spyOn(appDb, "$queryRaw");
    try {
      await run();
      return spy.mock.calls.filter((args) => JSON.stringify(args[0]).includes("nearest_rows")).length;
    } finally {
      spy.mockRestore();
    }
  }

  async function wipe() {
    for (const org of ORGS) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.changeEvent.deleteMany({ where: { orgId: org } });
      await db.erasureSuppression.deleteMany({ where: { orgId: org } });
      await db.contact.deleteMany({ where: { orgId: org } });
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.capability.deleteMany({ where: { orgId: org } });
      await db.grant.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ db: appDb } = await import("@/lib/db"));
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
    for (const org of ORGS) {
      await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
      const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: `org_${org}` } });
      await db.scope.create({ data: { orgId: org, path: sales(org), name: sales(org) } });
      await db.user.create({
        data: { id: `${ADMIN}_${org}`, orgId: org, email: `admin@${org}.test`, role: "admin", clerkId: `clerk-${org}` },
      });
      await db.grant.create({
        data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: `${ADMIN}_${org}`, permission: "admin" },
      });
      await db.contact.create({ data: { id: `orla_${org}`, orgId: org, name: PERSON, email: `orla@${org}.example` } });
      readable[org] = await write(org, `Sales note for ${org}: the renewal key lives in the second drawer.`);
    }
  });

  it("one org's erasure never hides the other org's identical rows, and neither page carries the other's rows", async () => {
    const keptRows = await writePersonRows(KEPT_ORG, 3);
    const erasedRows = await writePersonRows(ERASED_ORG, 6);
    await erasePerson(admin(ERASED_ORG), { contactId: `orla_${ERASED_ORG}` });
    await restore(ERASED_ORG, erasedRows);

    const keptPage = await page(KEPT_ORG, await salesReader(KEPT_ORG), 4);
    const erasedPage = await page(ERASED_ORG, await salesReader(ERASED_ORG), 1);

    // Same content in both orgs, but only the erasing org's list applies to its own rows.
    expect(keptPage.map((f) => f.uuid).sort()).toEqual([...keptRows.map((r) => r.id), readable[KEPT_ORG]].sort());
    expect(erasedPage.map((f) => f.uuid)).toEqual([readable[ERASED_ORG]]);
    const erasedIds = new Set(erasedRows.map((r) => r.id));
    expect(keptPage.some((f) => erasedIds.has(f.uuid))).toBe(false);
    expect(erasedPage.some((f) => f.uuid === readable[KEPT_ORG] || keptRows.some((r) => r.id === f.uuid))).toBe(false);
  });

  it("runs one search when no candidate is suppressed", async () => {
    await writePersonRows(ERASED_ORG, 6);
    const ctx = await salesReader(ERASED_ORG);
    expect(await countSearches(() => page(ERASED_ORG, ctx, 1))).toBe(1);
  });

  it("runs one search when the org has a suppression list but none of the candidates match it", async () => {
    await writePersonRows(ERASED_ORG, 2);
    await erasePerson(admin(ERASED_ORG), { contactId: `orla_${ERASED_ORG}` });
    const ctx = await salesReader(ERASED_ORG);
    expect(await countSearches(() => page(ERASED_ORG, ctx, 1))).toBe(1);
  });

  it("stops after three more searches when every round comes back suppressed, and serves none", async () => {
    const backup = await writePersonRows(ERASED_ORG, 40);
    await erasePerson(admin(ERASED_ORG), { contactId: `orla_${ERASED_ORG}` });
    await restore(ERASED_ORG, backup);
    const ctx = await salesReader(ERASED_ORG);

    let served: { uuid: string }[] = [];
    const searches = await countSearches(async () => {
      served = await page(ERASED_ORG, ctx, 1);
    });

    expect(searches).toBe(4);
    expect(served.some((f) => backup.some((b) => b.id === f.uuid))).toBe(false);
  });
});
