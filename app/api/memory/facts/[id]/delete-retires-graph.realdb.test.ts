// Gated: runs only with QA_DATABASE_URL (an isolated, migrated test Postgres),
// MEMORY_SERVICE_TEST_URL and MEMORY_SERVICE_TEST_API_KEY (a memory-service started
// against the disposable Neo4j below) and NEO4J_DELETE_TEST_URI (that Neo4j, loopback
// only); without all four every test here is skipped, not failed.
//
// A fact deleted through DELETE /api/memory/facts/:id must not come back through the
// graph. Ingest stores a fact twice: a `memory_chunks` row, whose id is the fact id a
// reader sees and deletes, and a Graphiti episode stamped with that id, from which the
// graph's facts are extracted. Deleting only the row left the episode and its facts in
// Neo4j, so GET /api/memory/graph went on answering with the deleted fact.
//
// Real: the two routes, check() and its grant query, the pgvector delete, the HTTP
// call to the memory-service, its Cypher, and Neo4j. Faked: the Clerk session only.
// The graph is seeded in the shape ingest() writes (an episode stamped with the chunk
// id, an extracted edge listing that episode), since extraction itself needs a model.
//
// Run locally:
//   neo4j on 127.0.0.1:17687 with auth off (memory-service/tests/GRAPH_DELETE_TESTS.md)
//   NEO4J_URI=bolt://127.0.0.1:17687 NEO4J_DATABASE=neo4j GRAPHITI_SERVICE_API_KEY=k \
//     uvicorn app.main:app --port 18000            (from memory-service/)
//   QA_DATABASE_URL=... MEMORY_SERVICE_TEST_URL=http://127.0.0.1:18000 \
//     MEMORY_SERVICE_TEST_API_KEY=k NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 \
//     npx vitest run "app/api/memory/facts/[id]/delete-retires-graph.realdb.test.ts"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { toGid } from "@/services/memory/graphiti-store";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const SERVICE_URL = process.env.MEMORY_SERVICE_TEST_URL;
const SERVICE_KEY = process.env.MEMORY_SERVICE_TEST_API_KEY;
const NEO4J_URI = process.env.NEO4J_DELETE_TEST_URI;
const ENABLED = Boolean(QA_URL && SERVICE_URL && SERVICE_KEY && NEO4J_URI);

const ORG = "qa_fact_graph_retire";
const OTHER_ORG = "qa_fact_graph_retire_other";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const WRITER = "u-graph-retire-writer";
const ADMIN = "u-graph-retire-admin";
const OTHER_ADMIN = "u-graph-retire-other-admin";

// The fact a writer deletes, and one in the same scope that must survive the delete.
const DELETED = { chunk: "chunk-graph-retire-deleted", text: "Acme renewal is due in March" };
const KEPT = { chunk: "chunk-graph-retire-kept", text: "Acme pays annually by invoice" };

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!ENABLED)("DELETE /api/memory/facts/:id retires the fact from the graph", () => {
  let db: PrismaClient;
  let graphDb: Driver;
  let DELETE_FACT: (typeof import("./route"))["DELETE"];
  let GET_GRAPH: (typeof import("../../graph/route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  const as = (orgId: string, userId: string, role: "admin" | "member") =>
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId, name: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role } },
    });

  async function cypher(query: string, params: Record<string, unknown> = {}) {
    const session = graphDb.session({ database: "neo4j" });
    try {
      return (await session.run(query, params)).records;
    } finally {
      await session.close();
    }
  }

  /**
   * One ingest as the memory-service leaves it: an episode stamped with the chunk id,
   * the two entities it mentions, and the fact extracted from it.
   */
  async function seedIngest(groupId: string, fact: { chunk: string; text: string }) {
    await cypher(
      `MERGE (a:Entity {uuid: $group + '-acme'}) SET a.name = 'Acme', a.group_id = $group, a.summary = ''
       CREATE (o:Entity {uuid: $chunk + '-object', name: $text, group_id: $group, summary: ''})
       CREATE (ep:Episodic {uuid: $chunk + '-episode', group_id: $group, content: $text,
                            source_description: $stamp})
       CREATE (ep)-[:MENTIONS {uuid: $chunk + '-m1', group_id: $group}]->(a)
       CREATE (ep)-[:MENTIONS {uuid: $chunk + '-m2', group_id: $group}]->(o)
       CREATE (a)-[:RELATES_TO {uuid: $chunk + '-edge', group_id: $group, fact: $text,
                                episodes: [$chunk + '-episode']}]->(o)`,
      {
        group: groupId,
        chunk: fact.chunk,
        text: fact.text,
        stamp: JSON.stringify({ actor_type: "human", actor_id: WRITER, scope_path: DEAL, chunk_id: fact.chunk }),
      },
    );
  }

  async function seedChunk(orgId: string, scopePath: string, fact: { chunk: string; text: string }) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, "actorType", "scopePath")
      VALUES (${fact.chunk}, ${orgId}, ${fact.text}, 'human', ${scopePath})`;
  }

  async function graphFacts(scope?: string): Promise<string[]> {
    const qs = scope ? `?scope=${scope}` : "";
    const res = await GET_GRAPH(new Request(`http://t/api/memory/graph${qs}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: { fact: string }[] };
    return body.edges.map((e) => e.fact).sort();
  }

  const deleteFact = (id: string, scope?: string) =>
    DELETE_FACT(new Request(`http://t/api/memory/facts/${id}${scope ? `?scope=${scope}` : ""}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });

  const orgs = [ORG, OTHER_ORG];
  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ANY(${orgs})`;
    await db.changeEvent.deleteMany({ where: { orgId: { in: orgs } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await db.grant.deleteMany({ where: { orgId: { in: orgs } } });
    await db.scope.deleteMany({ where: { orgId: { in: orgs } } });
    await db.user.deleteMany({ where: { orgId: { in: orgs } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: orgs } } });
  }

  beforeAll(async () => {
    const neo4jUrl = new URL(NEO4J_URI!);
    // Every case starts by emptying this database, so it must be the disposable one.
    expect(neo4jUrl.protocol).toBe("bolt:");
    expect(neo4jUrl.hostname).toBe("127.0.0.1");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = SERVICE_URL;
    process.env.GRAPHITI_SERVICE_API_KEY = SERVICE_KEY;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    graphDb = neo4j.driver(NEO4J_URI!);
    ({ DELETE: DELETE_FACT } = await import("./route"));
    ({ GET: GET_GRAPH } = await import("../../graph/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await wipe();
    for (const id of orgs) await db.org.create({ data: { id, name: id } });
    for (const [id, orgId, role] of [
      [WRITER, ORG, "member"],
      [ADMIN, ORG, "admin"],
      [OTHER_ADMIN, OTHER_ORG, "admin"],
    ] as const) {
      await db.user.create({ data: { id, orgId, email: `${id}@graph-retire.test`, role, clerkId: `clerk-${id}` } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    const deal = await db.scope.create({ data: { orgId: ORG, path: DEAL, name: DEAL } });
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: OTHER_ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: WRITER, permission: "write" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: {
        orgId: OTHER_ORG,
        scopeId: otherRoot.id,
        granteeType: "user",
        granteeId: OTHER_ADMIN,
        permission: "admin",
      },
    });
  });

  afterAll(async () => {
    await wipe();
    await cypher("MATCH (n) DETACH DELETE n");
    await graphDb.close();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ANY(${orgs})`;
    await cypher("MATCH (n) DETACH DELETE n");
    for (const fact of [DELETED, KEPT]) {
      await seedChunk(ORG, DEAL, fact);
      await seedIngest(toGid(DEAL), fact);
    }
  });

  // The first case pays one-time cold costs inside this process (the route's Prisma
  // pool, Neo4j planning on a fresh database) that the CI warm-up step cannot reach.
  // On CI it has taken 3.6 to 6.2 s against vitest's 5 s default, so it gets its own
  // budget. The other cases run in well under a second and keep the default.
  const FIRST_CASE_TIMEOUT_MS = 20_000;

  it(
    "a writer's delete in the fact's own scope removes it from the graph and keeps its neighbour",
    async () => {
      as(ORG, WRITER, "member");
      expect(await graphFacts(DEAL)).toEqual([DELETED.text, KEPT.text].sort());

      const res = await deleteFact(DELETED.chunk, DEAL);

      expect(res.status).toBe(200);
      expect(await graphFacts(DEAL)).toEqual([KEPT.text]);
      // The raw body goes with it, not only the edge: the episode holds the deleted text.
      const episodes = await cypher("MATCH (ep:Episodic) RETURN ep.uuid AS uuid ORDER BY uuid");
      expect(episodes.map((r) => r.get("uuid"))).toEqual([`${KEPT.chunk}-episode`]);
    },
    FIRST_CASE_TIMEOUT_MS,
  );

  it("an org-root delete of a fact stored in a child scope retires it from that scope's graph", async () => {
    as(ORG, ADMIN, "admin");

    const res = await deleteFact(DELETED.chunk);

    expect(res.status).toBe(200);
    expect(await graphFacts()).toEqual([KEPT.text]);
  });

  it("a delete that finds no stored row of its own leaves every graph untouched", async () => {
    // Another tenant's graph holds an episode stamped with the same chunk id. A stamp
    // is not ownership: without a row of its own, that tenant's delete removes nothing.
    await seedIngest(toGid(OTHER_ROOT), { chunk: DELETED.chunk, text: DELETED.text });
    const count = async () => (await cypher("MATCH (n) RETURN count(n) AS n"))[0].get("n").toNumber();
    const before = await count();
    as(OTHER_ORG, OTHER_ADMIN, "admin");

    const res = await deleteFact(DELETED.chunk);

    expect(res.status).toBe(404);
    expect(await count()).toBe(before);
  });
});
