// Gated: runs only with QA_DATABASE_URL (an isolated, migrated test Postgres),
// MEMORY_SERVICE_TEST_URL and MEMORY_SERVICE_TEST_API_KEY (a memory-service started
// against the disposable Neo4j below) and NEO4J_DELETE_TEST_URI (that Neo4j, loopback
// only); without all four every test here is skipped, not failed.
//
// A fact deleted before its queued ingest job writes the graph must not come back
// through the graph. ingestMemory stores the fact's `memory_chunks` row and queues the
// job; the job later writes a graph episode stamped with that row's id. DELETE
// /api/memory/facts/:id retires the episodes stamped with the id it deletes, so a delete
// that lands after the episode is written is covered. One that lands first found nothing
// to retire, and the job then wrote an episode for a fact that no longer exists, which
// GET /api/memory/graph went on answering with.
//
// Real: ingestMemory's request path and the pgvector row, both queued jobs
// (`memoryIngest` and the inline `runMemoryIngest`), the delete and graph routes with
// check() and its grants, the memory-service's retirement and graph read, and Neo4j.
// Fakes: the Clerk session, the episode cap, and the memory-service's /ingest, which
// needs a model to extract facts. It writes what /ingest leaves for a short fact: an
// episode carrying the request's provenance stamp, the entities it mentions and the fact
// extracted from it, the same shape delete-retires-graph.realdb.test.ts seeds.
//
// Run locally: start Neo4j and the memory-service as described in
// app/api/memory/facts/[id]/delete-retires-graph.realdb.test.ts, then
//   QA_DATABASE_URL=... MEMORY_SERVICE_TEST_URL=http://127.0.0.1:18000 \
//     MEMORY_SERVICE_TEST_API_KEY=k NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 \
//     npx vitest run lib/inngest.delete-before-graph-write.realdb.test.ts
// Run it on its own, not in one vitest run with that suite: that suite empties the whole
// Neo4j before each case. This one only removes what is under its own org.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
  GuardrailError: class extends Error {},
}));

const QA_URL = process.env.QA_DATABASE_URL;
const SERVICE_URL = process.env.MEMORY_SERVICE_TEST_URL;
const SERVICE_KEY = process.env.MEMORY_SERVICE_TEST_API_KEY;
const NEO4J_URI = process.env.NEO4J_DELETE_TEST_URI;
const ENABLED = Boolean(QA_URL && SERVICE_URL && SERVICE_KEY && NEO4J_URI);

const ORG = "qa_delete_before_graph";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const WRITER = "u-delete-before-graph";

type StepCtx = {
  event: { data: unknown };
  runId?: string;
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!ENABLED)("a fact deleted before its ingest job writes the graph stays deleted", () => {
  let db: PrismaClient;
  let graphDb: Driver;
  let jobs: typeof import("./inngest");
  let DELETE_FACT: (typeof import("@/app/api/memory/facts/[id]/route"))["DELETE"];
  let GET_GRAPH: (typeof import("@/app/api/memory/graph/route"))["GET"];
  let queued: IngestInput[];
  /** Runs inside the /ingest fake before it writes: where a test lands a delete. */
  let beforeGraphWrite: (() => Promise<void>) | null;
  /** Runs after the memory-service answers the delete's graph retirement, before the route
   * goes on to delete the row: where a test lands the whole job. */
  let afterChunkRetirement: (() => Promise<void>) | null;
  let graphWrites: number;

  async function cypher(query: string, params: Record<string, unknown> = {}) {
    const session = graphDb.session({ database: "neo4j" });
    try {
      return (await session.run(query, params)).records;
    } finally {
      await session.close();
    }
  }

  /** What the memory-service's /ingest leaves in Neo4j for one short fact. */
  async function writeEpisode(body: Record<string, unknown>): Promise<string> {
    const episode = `episode-${++graphWrites}`;
    const stamp = JSON.stringify({
      actor_type: body.actor_type,
      actor_id: body.actor_id,
      actor_name: body.actor_name,
      source: body.source,
      scope_path: body.scope_path,
      source_id: body.source_id,
      chunk_id: body.chunk_id,
    });
    await cypher(
      `MERGE (a:Entity {uuid: $group + '-acme'}) SET a.name = 'Acme', a.group_id = $group, a.summary = ''
       CREATE (o:Entity {uuid: $episode + '-object', name: $text, group_id: $group, summary: ''})
       CREATE (ep:Episodic {uuid: $episode, group_id: $group, content: $text, source_description: $stamp})
       CREATE (ep)-[:MENTIONS {uuid: $episode + '-m1', group_id: $group}]->(a)
       CREATE (ep)-[:MENTIONS {uuid: $episode + '-m2', group_id: $group}]->(o)
       CREATE (a)-[:RELATES_TO {uuid: $episode + '-edge', group_id: $group, fact: $text, episodes: [$episode]}]->(o)`,
      { group: body.group_id, episode, text: body.content, stamp },
    );
    return episode;
  }

  const as = () =>
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: WRITER, name: WRITER },
      ctx: { orgId: ORG, actor: { type: "human", id: WRITER, role: "member" } },
    } as never);
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];

  async function graphFacts(): Promise<string[]> {
    const res = await GET_GRAPH(new Request(`http://t/api/memory/graph?scope=${DEAL}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: { fact: string }[] };
    return body.edges.map((e) => e.fact).sort();
  }

  async function episodesStampedWith(chunkId: string): Promise<number> {
    const records = await cypher(
      "MATCH (ep:Episodic) WHERE ep.source_description CONTAINS $chunk RETURN count(ep) AS n",
      { chunk: chunkId },
    );
    return records[0].get("n").toNumber();
  }

  const deleteFact = async (id: string) => {
    const res = await DELETE_FACT(new Request(`http://t/api/memory/facts/${id}?scope=${DEAL}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
  };

  /** An agent's short note: stored for reading on the request path, then queued. */
  async function storeAndQueue(text: string): Promise<IngestInput> {
    const ack = await jobs.ingestMemory({
      groupId: ORG,
      content: text,
      name: "Acme renewal",
      source: "text",
      actorType: "agent",
      origin: "mcp",
      actorId: "agent-1",
      actorName: "Agent",
      scopePath: DEAL,
    });
    expect(ack.readableNow).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0].readableId).toBe(ack.versionId);
    return queued[0];
  }

  const runQueuedJob = (data: IngestInput) =>
    (jobs.memoryIngest as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn({
      event: { data },
      runId: "run-1",
      step: { run: async (_name, fn) => fn() },
    });

  /** Empty this suite's own partitions; other suites' nodes in the same Neo4j stay. */
  const wipeGraph = () => cypher("MATCH (n) WHERE n.group_id STARTS WITH $root DETACH DELETE n", { root: ROOT });

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
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

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${SERVICE_URL}/ingest`) {
        if (beforeGraphWrite) await beforeGraphWrite();
        const episode = await writeEpisode(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ episode_id: episode }), { status: 200 });
      }
      if (url.startsWith(`${SERVICE_URL}/ingest`)) throw new Error(`unexpected fetch to ${url}`);
      const response = await realFetch(input, init);
      if (url.startsWith(`${SERVICE_URL}/chunks/`) && afterChunkRetirement) {
        const hook = afterChunkRetirement;
        afterChunkRetirement = null;
        await hook();
      }
      return response;
    });

    jobs = await import("./inngest");
    ({ DELETE: DELETE_FACT } = await import("@/app/api/memory/facts/[id]/route"));
    ({ GET: GET_GRAPH } = await import("@/app/api/memory/graph/route"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    vi.spyOn(jobs.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      queued.push(event.data);
      return { ids: [] };
    }) as never);

    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.user.create({
      data: {
        id: WRITER,
        orgId: ORG,
        email: `${WRITER}@delete-before-graph.test`,
        role: "member",
        clerkId: `clerk-${WRITER}`,
      },
    });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    const deal = await db.scope.create({ data: { orgId: ORG, path: DEAL, name: DEAL } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: WRITER, permission: "write" },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await wipe();
    await wipeGraph();
    await graphDb.close();
    await db.$disconnect();
  });

  beforeEach(async () => {
    queued = [];
    beforeGraphWrite = null;
    afterChunkRetirement = null;
    graphWrites = 0;
    as();
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await wipeGraph();
  });

  it("a fact nobody deleted is in the graph once its job has run", async () => {
    const data = await storeAndQueue("Acme renewal is due in March");

    await runQueuedJob(data);

    expect(await graphFacts()).toEqual(["Acme renewal is due in March"]);
    expect(await episodesStampedWith(data.readableId!)).toBe(1);
  });

  it("a delete that lands before the queued job runs leaves nothing for the job to write", async () => {
    const data = await storeAndQueue("Acme renewal is due in April");
    await deleteFact(data.readableId!);

    await runQueuedJob(data);

    expect(await graphFacts()).toEqual([]);
    expect(await episodesStampedWith(data.readableId!)).toBe(0);
    expect(graphWrites).toBe(0);
  });

  it("the same holds for the job run inline without a queue", async () => {
    const data = await storeAndQueue("Acme renewal is due in May");
    await deleteFact(data.readableId!);

    await jobs.runMemoryIngest(data);

    expect(await graphFacts()).toEqual([]);
    expect(await episodesStampedWith(data.readableId!)).toBe(0);
    expect(graphWrites).toBe(0);
  });

  it("a delete that lands while the job writes the episode does not leave it behind", async () => {
    // The job's first check passes; the delete then retires nothing, because the episode
    // is not there yet, and removes the row before the episode lands.
    const data = await storeAndQueue("Acme renewal is due in June");
    beforeGraphWrite = async () => {
      beforeGraphWrite = null;
      await deleteFact(data.readableId!);
    };

    await runQueuedJob(data);

    expect(graphWrites).toBe(1);
    expect(await graphFacts()).toEqual([]);
    expect(await episodesStampedWith(data.readableId!)).toBe(0);
  });

  it("the inline job retires an episode written during a delete as well", async () => {
    const data = await storeAndQueue("Acme renewal is due in July");
    beforeGraphWrite = async () => {
      beforeGraphWrite = null;
      await deleteFact(data.readableId!);
    };

    await jobs.runMemoryIngest(data);

    expect(graphWrites).toBe(1);
    expect(await graphFacts()).toEqual([]);
    expect(await episodesStampedWith(data.readableId!)).toBe(0);
  });

  it("a job that writes after the delete retired the graph but before it removed the row leaves nothing", async () => {
    // The delete retires the chunk's graph facts first, then removes the row. A job whose
    // episode lands in between finds the row still there when it checks after writing.
    const data = await storeAndQueue("Acme renewal is due in August");
    afterChunkRetirement = async () => {
      await runQueuedJob(data);
      expect(graphWrites).toBe(1);
    };

    await deleteFact(data.readableId!);

    expect(await graphFacts()).toEqual([]);
    expect(await episodesStampedWith(data.readableId!)).toBe(0);
  });
});
