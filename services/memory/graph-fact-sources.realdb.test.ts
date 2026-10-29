// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The serve-time source check (services/memory/graph-fact-sources.ts) on every guarded read
// that hands out graph text: retrieve, entity, the graph view, and a fact resolved by id
// (findFact, and resolveFacts behind a brief's citation check). Each serves a graph answer
// only while a stored source supports it: a live chunk it is stamped with, a live synced file
// of its source, or a current direct write of its text. Plus the check's cost: one statement
// per graph call, by index, timed on a few hundred facts. The deleted- and erased-chunk cases
// of retrieve are in graph-fact-source-recheck.realdb.test.ts.
//
// Real: Postgres, check() against a live grant, GuardedMemoryStore, the suppression list.
// Stand-in: the graph store, which answers with what each test gives it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type {
  FindFactByIdResult,
  MemoryEdge,
  MemoryEntity,
  MemoryFact,
  MemoryGraph,
  SearchResult,
} from "@/types/memory";
import type { MemoryStore } from "./memory-store";

vi.mock("./store", () => ({ memory: { ingest: vi.fn() }, graphitiStore: {} }));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_graph_sources";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_graph_sources_admin";
const SOURCE = "qa-gs-slack";
const FACTS = 300;

describe.skipIf(!QA_URL)("every guarded graph read serves only what a stored source still supports", () => {
  let db: PrismaClient;
  let appDb: (typeof import("@/lib/db"))["db"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let sources: typeof import("./graph-fact-sources");
  let recordSuppressions: (typeof import("./erasure-suppression"))["recordSuppressions"];
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  /** What the stand-in graph answers each call with. */
  let answer: {
    facts: MemoryFact[];
    entity: MemoryEntity | null;
    graph: MemoryGraph;
    found: FindFactByIdResult | null;
  };
  const graphStore = {
    retrieve: async (): Promise<SearchResult> => ({ facts: answer.facts, storesRead: [{ store: "graph" }] }),
    entity: async () => answer.entity,
    graph: async () => answer.graph,
    findFactById: async () => answer.found,
  } as unknown as MemoryStore;
  const guarded = () => new GuardedMemoryStore(graphStore, async () => "enterprise");
  const retrieved = async (facts: MemoryFact[], limit = 10) => {
    answer.facts = facts;
    return (await guarded().retrieve(admin, { groupId: ORG, query: "Heron", limit }, SALES)).facts;
  };
  const graph = (uuid: string, fact: string, extra: Partial<MemoryFact> = {}): MemoryFact =>
    ({ uuid, fact, validAt: null, store: "graph", actorType: "human", ...extra }) as MemoryFact;
  const edge = (uuid: string, source: string, target: string, extra: Partial<MemoryEdge> = {}): MemoryEdge =>
    ({
      uuid,
      source,
      target,
      fact: `${source} knows ${target}`,
      graphGroupId: "org_qa_graph_sources-sales",
      ...extra,
    }) as MemoryEdge;
  const insertChunk = (id: string, content: string) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'human', ${SALES}, now() - interval '1 day')`;

  async function wipe() {
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ db: appDb } = await import("@/lib/db"));
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    sources = await import("./graph-fact-sources");
    ({ recordSuppressions } = await import("./erasure-suppression"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    answer = { facts: [], entity: null, graph: { nodes: [], edges: [] }, found: null };
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@graph-sources.test", role: "admin", clerkId: "clerk-graph-sources" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.source.create({
      data: { id: SOURCE, orgId: ORG, type: "slack", externalId: "C-gs", name: "Slack", scopePath: SALES },
    });
    await db.sourceFile.create({
      data: {
        sourceId: SOURCE,
        externalFileId: "msg-1",
        checksum: "v1",
        episodeId: "ep-live",
        episodeScopePath: SALES,
      },
    });
  });

  describe("retrieve", () => {
    it("serves an unstamped fact a live synced item or a current direct write supports, and nothing else", async () => {
      await insertChunk("qa-gs-direct", "Heron is based in Lyon.");
      const page = await retrieved([
        graph("e-synced", "Heron renewed for two years.", { sourceId: SOURCE, sourceEventIds: ["ep-live"] }),
        graph("e-retired-item", "Heron asked for a pilot.", { sourceId: SOURCE, sourceEventIds: ["ep-retired"] }),
        graph("e-direct", "Heron is based in Lyon."),
        graph("e-paraphrase", "Heron's office is in Lyon."),
      ]);
      expect(page.map((f) => f.uuid).sort()).toEqual(["e-direct", "e-synced"]);
    });

    it("QA probe: does not serve an unstamped fact whose source was deleted", async () => {
      const fact = graph("e-deleted-source", "Heron renewed for two years.", {
        sourceId: SOURCE,
        sourceEventIds: ["ep-live"],
      });
      expect((await retrieved([fact])).map((f) => f.uuid)).toEqual(["e-deleted-source"]);
      await db.source.delete({ where: { id: SOURCE } });
      expect(await retrieved([fact])).toEqual([]);
    });

    it("QA probe: does not serve an unstamped fact with no source once its stored write is gone", async () => {
      await insertChunk("qa-gs-direct", "Heron is based in Lyon.");
      const fact = graph("e-no-source", "Heron is based in Lyon.");
      expect((await retrieved([fact])).map((f) => f.uuid)).toEqual(["e-no-source"]);
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = 'qa-gs-direct'`;
      expect(await retrieved([fact])).toEqual([]);
    });

    it("the bare-org leg matches an unscoped fact against the bare-org partition, not the scope the read was narrowed to", async () => {
      // A direct write with no scope is stored in the bare-org partition. A read of the org
      // root asks the root scope's partition, then the bare-org one (the org-wide leg); only
      // the second leg's copy of the fact can be served. Checked against the root scope's
      // partition, or none, it is dropped.
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt")
        VALUES ('qa-gs-org-direct', ${ORG}, 'Heron is based in Oslo.', 'text', 'human', NULL, now() - interval '1 day')`;
      answer.facts = [graph("e-org-direct", "Heron is based in Oslo.")];
      const atRoot = async () =>
        (await guarded().retrieve(admin, { groupId: ORG, query: "Heron", limit: 10 }, ROOT)).facts.map((f) => f.uuid);
      expect(await atRoot()).toEqual(["e-org-direct"]);
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = 'qa-gs-org-direct'`;
      expect(await atRoot()).toEqual([]);
    });

    it("does not serve an unstamped fact whose stored write a later version superseded", async () => {
      await insertChunk("qa-gs-old", "Heron is based in Lyon.");
      await insertChunk("qa-gs-new", "Heron moved to Paris.");
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "qa-gs-new",
          toId: "qa-gs-old",
          kind: "supersedes",
          scopePath: SALES,
          actorType: "human",
          actorId: ADMIN,
        },
      });
      expect(await retrieved([graph("e-old", "Heron is based in Lyon.")])).toEqual([]);
    });

    it("does not serve an unstamped fact naming an erased person, even with a current write behind it", async () => {
      await insertChunk("qa-gs-direct", "Ines Varga runs the Heron account.");
      await recordSuppressions(appDb, ORG, "qa-gs-erasure", { emails: [], names: ["Ines Varga"], contactIds: [] });
      expect(await retrieved([graph("e-ines", "Ines Varga runs the Heron account.")])).toEqual([]);
    });

    it("does not serve a stamped fact whose chunk a backup put back after an erasure", async () => {
      await insertChunk("qa-gs-restored", "Ines Varga approved the Heron discount.");
      await recordSuppressions(appDb, ORG, "qa-gs-erasure", { emails: [], names: ["Ines Varga"], contactIds: [] });
      expect(
        await retrieved([graph("e-restored", "The Heron discount was approved.", { chunkIds: ["qa-gs-restored"] })]),
      ).toEqual([]);
    });
  });

  it("entity: a fact whose only chunk was deleted is not served on the entity", async () => {
    await insertChunk("qa-gs-live", "Heron signed.");
    answer.entity = {
      uuid: "n-heron",
      name: "Heron",
      type: "Account",
      facts: [
        graph("e-live", "Heron signed.", { chunkIds: ["qa-gs-live"] }),
        graph("e-gone", "Heron's discount is 12%.", { chunkIds: ["qa-gs-gone"] }),
      ],
    };
    const entity = await guarded().entity(admin, { groupId: ORG, entityId: "n-heron" }, SALES);
    expect(entity?.facts?.map((f) => f.uuid)).toEqual(["e-live"]);
  });

  it("graph: an edge whose only chunk was deleted is not shown, nor a node it alone held", async () => {
    await insertChunk("qa-gs-live", "Ana knows Bo.");
    answer.graph = {
      nodes: [
        { uuid: "ana", name: "Ana", type: "Person" },
        { uuid: "bo", name: "Bo", type: "Person" },
        { uuid: "cy", name: "Cy", type: "Person" },
        { uuid: "lone", name: "Lone", type: "Person" },
      ],
      edges: [
        edge("ab", "ana", "bo", { chunkIds: ["qa-gs-live"] }),
        edge("ac", "ana", "cy", { chunkIds: ["qa-gs-gone"] }),
        edge("x", "ana", "bo", { sourceId: "deleted-source", sourceEventIds: ["ep-x"] }),
      ],
    };
    const view = await guarded().graph(admin, { groupId: ORG }, SALES);
    expect(view.edges.map((e) => e.uuid)).toEqual(["ab"]);
    // A node with no edges to begin with is still shown; one only a dropped edge reached is not.
    expect(view.nodes.map((n) => n.uuid)).toEqual(["ana", "bo", "lone"]);
  });

  it("findFact and resolveFacts: a graph fact whose source was deleted reads as not found, so a brief cannot call it current", async () => {
    answer.found = {
      uuid: "e-cited",
      fact: "Heron renewed for two years.",
      invalidAt: null,
      store: "graph",
      sourceId: SOURCE,
      sourceEventIds: ["ep-live"],
    };
    expect(await guarded().findFact(admin, { groupId: ORG, factId: "e-cited" }, SALES)).toEqual(answer.found);
    await db.source.delete({ where: { id: SOURCE } });
    expect(await guarded().findFact(admin, { groupId: ORG, factId: "e-cited" }, SALES)).toBeNull();
    const resolved = await guarded().resolveFacts(
      admin,
      { groupId: ORG, factIds: ["e-cited"], target: "brief:qa" },
      SALES,
    );
    expect(resolved.get("e-cited")).toBeNull();
  });

  it(`${FACTS} graph facts cost one source statement per graph call, by index, and are timed`, async () => {
    // Enough rows in the org (50,000) that a scan would show in the plan, and the facts' own chunks.
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt")
      SELECT 'qa-gs-chunk-' || g, ${ORG}, 'Heron note ' || g, 'text', 'human', ${SALES}, now()
      FROM generate_series(1, 50000) AS g`;
    await db.$executeRawUnsafe(`ANALYZE memory_chunks`);
    const facts = Array.from({ length: FACTS }, (_, i) =>
      i % 10 === 0
        ? graph(
            `e-${i}`,
            i % 20 === 0 ? `Heron note ${i}` : `Heron fact ${i}.`,
            i % 20 === 0 ? {} : { sourceId: SOURCE, sourceEventIds: [i === 10 ? "ep-live" : `ep-${i}`] },
          )
        : graph(`e-${i}`, `Heron fact ${i}.`, { chunkIds: [`qa-gs-chunk-${i % 2 === 0 ? i : 90_000 + i}`] }),
    );

    const statements: string[] = [];
    const raw = appDb.$queryRaw.bind(appDb);
    vi.spyOn(appDb, "$queryRaw").mockImplementation(((query: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(Array.isArray(query) ? query.join("?") : String(query));
      return raw(query, ...values);
    }) as typeof appDb.$queryRaw);

    const start = performance.now();
    const page = await retrieved(facts, FACTS);
    const elapsed = performance.now() - start;
    // This read makes one graph call (no descendant scope, no org-root leg): one statement.
    expect(
      statements.filter((sql) => sql.includes(`"source_files"`) && sql.includes(`"memory_chunks" c`)),
    ).toHaveLength(1);
    const ids = new Set(page.map((f) => f.uuid));
    expect([ids.has("e-2"), ids.has("e-3"), ids.has("e-10"), ids.has("e-20"), ids.has("e-30")]).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);

    // The check alone, median of five, outside the rest of the read.
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t = performance.now();
      await sources.loadGraphSources(ORG, facts);
      times.push(performance.now() - t);
    }
    const median = times.sort((a, b) => a - b)[2]!;
    process.stderr.write(
      `[graph-fact-sources] ${FACTS} facts: whole read ${elapsed.toFixed(1)} ms, source check median ${median.toFixed(1)} ms\n`,
    );

    const chunkIds = facts.flatMap((f) => f.chunkIds ?? []);
    const texts = facts.filter((f) => !f.chunkIds).map((f) => f.fact);
    const plan = await db.$queryRaw<
      { "QUERY PLAN": string }[]
    >`EXPLAIN ${sources.graphSourcesSql(ORG, chunkIds, [SOURCE], ["ep-live"], texts)}`;
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    process.stderr.write(`[graph-fact-sources] plan:\n${text.replace(/\{[^}]{200,}\}/g, "{…}")}\n`);
    expect(text).not.toMatch(/Seq Scan on memory_chunks/);
    // The direct-write leg is one btree equality probe per text, not a trigram GIN probe.
    expect(text).toMatch(/Index Scan using memory_chunks_direct_content_md5_idx on memory_chunks/);
    expect(text).not.toMatch(/memory_chunks_content_trgm_idx/);
    // A ceiling for seeding 50,000 rows on a loaded machine, not a speed claim.
  }, 60_000);
});
