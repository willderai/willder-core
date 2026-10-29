// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// [tests-only] A graph fact is served only while a stored version behind it still exists.
//
// Postgres (memory_chunks) and the graph (Neo4j) are not one snapshot. When a chunk is
// deleted, or erased, and the graph copy is not retired (the graph call failed, timed out,
// or the erasure's name match missed an episode), GuardedMemoryStore.retrieve()
// (services/memory/guarded-store.ts:543-783) still serves the graph fact: it filters graph
// facts only for supersession (supersededAt, superseded-facts.ts:158-178, which returns
// null for a chunk id missing from the record), successor substitution and collapse.
// Nothing rechecks a stamped fact's `chunkIds` against memory_chunks or the erasure
// suppression list at serve time.
//
// Real: Postgres, check() against a live grant, GuardedMemoryStore, erasePerson and its
// suppression list. Stand-in: the graph store, which still holds one fact stamped with the
// deleted chunk's id, exactly as a graph whose retirement failed would.
//
// Written to fail before the fix it covers.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type { MemoryFact, SearchResult } from "@/types/memory";
import type { MemoryStore } from "./memory-store";

vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    // The graph side of the erasure finds nothing to remove: the copy below survives it.
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_graph_recheck";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_graph_recheck_admin";
const NAME = "Ines Varga";
const EMAIL = "ines.varga@graph-recheck.example";
const CHUNK = "chunk-ines";
const CHUNK_TEXT = `${NAME} approved a 12 percent discount for Heron.`;
const GRAPH_FACT = `${NAME} approved the Heron discount.`;
const DIMENSIONS = 384;
const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

describe.skipIf(!QA_URL)("graph facts are rechecked against memory_chunks when served", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  /** A graph that still holds one extracted fact stamped with CHUNK. */
  const staleGraph = {
    retrieve: async (): Promise<SearchResult> => ({
      facts: [
        {
          uuid: "edge-ines",
          fact: GRAPH_FACT,
          validAt: null,
          store: "graph",
          chunkIds: [CHUNK],
          actorType: "human",
        } as MemoryFact,
      ],
      storesRead: [{ store: "graph" }],
    }),
  } as unknown as MemoryStore;
  const served = async () =>
    (
      await new GuardedMemoryStore(staleGraph, async () => "enterprise").retrieve(
        admin,
        { groupId: ORG, query: "Heron discount", limit: 10 },
        SALES,
      )
    ).facts.map((f) => f.fact);

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ erasePerson } = await import("./person-erasure"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@graph-recheck.test", role: "admin", clerkId: "clerk-graph-recheck" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({
      data: { id: "ines", orgId: ORG, name: NAME, email: EMAIL, createdAt: new Date(Date.now() - 86_400_000) },
    });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
      VALUES (${CHUNK}, ${ORG}, ${CHUNK_TEXT}, 'text', 'human', ${ADMIN}, ${SALES}, ${vector}::vector, now())`;
  });

  it("control: while its chunk is stored, the graph fact is served", async () => {
    expect(await served()).toContain(GRAPH_FACT);
  });

  it("a graph fact whose only source chunk was deleted is not served", async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = ${CHUNK}`;
    expect(await served()).not.toContain(GRAPH_FACT);
  });

  it("after a person erasure whose graph leg left a copy, the copy naming her is not served", async () => {
    await erasePerson(admin, { email: EMAIL });
    expect(await db.memoryChunk.count({ where: { orgId: ORG, id: CHUNK } })).toBe(0);

    const facts = await served();
    expect(facts.filter((f) => f.includes(NAME))).toEqual([]);
  });
});
