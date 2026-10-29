// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Conflict resolution, the graph half of the read side, as Graphiti really
// answers. A `supersedes` edge keys `memory_chunks` ids, and a Graphiti fact is a sentence
// its extractor wrote, not the one that was stored, so neither its uuid nor its text
// names the version it came from. Without the rule below, a real race answers with both
// versions, both attributed to the graph store.
//
// The write path stamps the chunk id on the graph episode, so a graph fact names the
// stored versions it belongs to, and the guarded read drops it when every one of them
// lost (services/memory/superseded-facts.ts). The text match that file falls back to
// cannot do this on its own: every fact below is worded differently from what was stored.
//
// Everything below the read is real except Graphiti itself: both ingests run the request
// path into Postgres, the conflict is resolved under the real per-org lock, and pgvector's
// SQL runs. `RecordingGraph` stands in for the memory service, and only for the part this
// test is about: it keeps whatever chunk id the write path stamped on each episode and
// hands it back on every fact that episode produced, which is the contract
// memory-service/tests/test_api.py holds the service to.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { IngestInput, MemoryFact, SearchInput, SearchResult } from "@/types/memory";

/** One episode the write path sent to the graph, as the memory service would hold it. */
interface Episode {
  content: string;
  /** The `memory_chunks` row the write path stamped on it, if any. */
  chunkId: string | undefined;
}

/** The sentence an extractor distils from a stored one: same claim, different words. */
const extracted = (content: string) =>
  `Release train departure: ${content.replace(/^The release train leaves on /, "")}`;

/**
 * A stand-in for the memory service: it remembers the episodes the write path sent and
 * answers a read with one extracted fact per episode, carrying the chunk id that episode
 * was stamped with — exactly what `/search` returns in `chunk_ids`. It filters nothing,
 * which is the point: Graphiti holds every version ever written and cannot tell them apart.
 */
class RecordingGraph implements Pick<MemoryStore, "ingest" | "retrieve"> {
  readonly episodes: Episode[] = [];

  async ingest(input: IngestInput) {
    this.episodes.push({ content: input.content, chunkId: input.readableId });
    return { episodeId: `ep-${this.episodes.length}` };
  }

  async retrieve(): Promise<SearchResult> {
    const facts: MemoryFact[] = this.episodes.map((episode, i) => ({
      uuid: `edge-${i}`,
      fact: extracted(episode.content),
      validAt: null,
      actorType: "agent",
      chunkIds: episode.chunkId === undefined ? [] : [episode.chunkId],
      store: "graph",
    }));
    return { facts, storesRead: [{ store: "graph" }] };
  }
}

// The write path reaches the graph through this singleton; the fake behind it is rebuilt
// per test and read back through `recording`.
vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: {
    ingest: vi.fn(async (input: IngestInput) => recording.ingest(input)),
    ingestBulk: vi.fn(),
  },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
// Distillation is not what this test is about, and a real client would reach the network.
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
}));

let recording: RecordingGraph;

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "conflictgraphleg";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;
const QUESTION = "When does the release train leave?";
/** A read of the graph leg alone: the vector leg is skipped, so no stored chunk can stand in for a graph fact. */
const graphRead = { query: QUESTION, limit: 10, skipPgvector: true };

const write = (actorId: string, day: string, name = "Release train"): IngestInput => ({
  groupId: ORG,
  content: `The release train leaves on ${day}.`,
  name,
  actorType: "agent",
  origin: "mcp",
  actorId,
  actorName: "MCP session",
  source: "mcp",
  scopePath: SCOPE,
});

describe.skipIf(!QA_URL)("conflict: the graph leg answers with the winner only", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];

  /** Both writes at once, then the version the write side recorded as the winner. */
  async function raceTwoWriters(): Promise<{ winnerId: string; loserId: string }> {
    await Promise.all([ingestMemory(write("writer-a", "Monday")), ingestMemory(write("writer-b", "Tuesday"))]);
    const edges = await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } });
    expect(edges).toHaveLength(1);
    return { winnerId: edges[0].fromId, loserId: edges[0].toId };
  }

  async function rootReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "root-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "root-reader", capabilityToken: token }, origin: "mcp" };
  }

  /** The read `memory_query` makes: the guarded hybrid store over both legs. */
  function reader() {
    return new GuardedMemoryStore(
      new HybridMemoryStore(recording as unknown as MemoryStore, new PgvectorMemoryStore()),
      async () => "enterprise",
    );
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    const inngestModule = await import("@/lib/inngest");
    // Run the queued job inline instead of sending it, so the graph write the request
    // path defers really happens and `RecordingGraph` sees what it was stamped with.
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      await inngestModule.runMemoryIngest(event.data);
      return { ids: ["job"] };
    }) as never);
    ({ ingestMemory } = inngestModule);
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ GuardedMemoryStore } = await import("./guarded-store"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    recording = new RecordingGraph();
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("stamps the stored chunk on every graph episode the ingest writes", async () => {
    const { winnerId, loserId } = await raceTwoWriters();

    expect(recording.episodes.map((e) => e.chunkId).sort()).toEqual([winnerId, loserId].sort());
  });

  it("answers the race with one version, though the graph still holds both", async () => {
    const { winnerId, loserId } = await raceTwoWriters();
    const winner = await db.memoryChunk.findUniqueOrThrow({ where: { id: winnerId } });
    const loser = await db.memoryChunk.findUniqueOrThrow({ where: { id: loserId } });
    // The defect this closes: the graph answers with both, in words no stored version uses.
    expect((await recording.retrieve()).facts.map((f) => f.fact).sort()).toEqual(
      [extracted(winner.content), extracted(loser.content)].sort(),
    );

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUESTION, limit: 10 }, SCOPE);

    // The winner once: its graph paraphrase is served as the stored chunk it was
    // extracted from (collapseIntoSourceChunks). The loser's paraphrase has no chunk on
    // the page to collapse into, so only the supersession filter keeps it out.
    expect(facts.map((f) => f.fact)).toEqual([winner.content]);
    expect(facts.map((f) => f.fact)).not.toContain(extracted(loser.content));
    // The graph leg on its own, so the vector leg cannot answer for it: the winner's
    // extracted fact is served, the loser's is not.
    const graphOnly = await reader().retrieve(await rootReader(), { ...graphRead, groupId: ORG }, SCOPE);
    expect(graphOnly.facts.map((f) => f.fact)).toEqual([extracted(winner.content)]);
  });

  it("keeps a version that lost no race, served once as its stored chunk", async () => {
    await ingestMemory(write("writer-c", "Friday", "Freeze window"));

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUESTION, limit: 10 }, SCOPE);

    // On the hybrid read the graph's paraphrase is collapsed into the chunk it came from.
    expect(facts.map((f) => f.fact)).toEqual(["The release train leaves on Friday."]);
    // On the graph leg alone the paraphrase itself is served: no race retired it.
    const graphOnly = await reader().retrieve(await rootReader(), { ...graphRead, groupId: ORG }, SCOPE);
    expect(graphOnly.facts.map((f) => f.fact)).toEqual(["Release train departure: Friday."]);
  });

  it("checks each descendant scope's graph facts against that scope's own races", async () => {
    // Two scopes below the reader's, each with its own race. The graph answers each
    // scope's search with the losing version in its stored words and no stamp, so only
    // the per-scope text record can drop it, and only when each fact is checked against
    // the scope it was read from.
    const FREEZE = `${ROOT}.freeze`;
    await db.scope.create({ data: { orgId: ORG, path: FREEZE, name: "freeze" } });
    const inFreeze = (actorId: string, day: string): IngestInput => ({
      ...write(actorId, day, "Freeze window"),
      content: `The code freeze starts on ${day}.`,
      scopePath: FREEZE,
    });
    await Promise.all([ingestMemory(write("writer-a", "Monday")), ingestMemory(write("writer-b", "Tuesday"))]);
    await Promise.all([
      ingestMemory(inFreeze("writer-c", "Wednesday")),
      ingestMemory(inFreeze("writer-d", "Thursday")),
    ]);
    const edges = await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } });
    expect(edges).toHaveLength(2);
    const losers = await db.memoryChunk.findMany({ where: { id: { in: edges.map((e) => e.toId) } } });
    const loserIn = new Map(losers.map((chunk) => [chunk.scopePath, chunk.content]));
    const served: string[] = [];
    vi.spyOn(recording, "retrieve").mockImplementation(async (input?: SearchInput) => {
      // One search over several groups answers from each, naming the group of every fact.
      const facts: MemoryFact[] = (input ? [input.groupId, ...(input.groupIds ?? [])] : []).flatMap((group) => {
        const content = loserIn.get(group);
        if (!content) return [];
        served.push(content);
        return [
          { uuid: `edge-${group}`, fact: content, validAt: null, store: "graph" as const, graphGroupId: toGid(group) },
        ];
      });
      return { facts, storesRead: [{ store: "graph" }] };
    });

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUESTION, limit: 20 }, ROOT);

    // The graph did hand back both losers; the read dropped them.
    expect(served.sort()).toEqual([loserIn.get(SCOPE), loserIn.get(FREEZE)].sort());
    const graphFacts = facts.filter((f) => f.store === "graph").map((f) => f.fact);
    expect(graphFacts).not.toContain(loserIn.get(SCOPE));
    expect(graphFacts).not.toContain(loserIn.get(FREEZE));
  });

  it("falls back to the stored text for a graph fact written before the stamp", async () => {
    const { loserId } = await raceTwoWriters();
    const loser = await db.memoryChunk.findUniqueOrThrow({ where: { id: loserId } });
    // An episode from before the stamp existed whose fact kept the stored wording.
    recording.episodes.length = 0;
    const legacy: MemoryFact = { uuid: "edge-legacy", fact: loser.content, validAt: null, store: "graph" };
    vi.spyOn(recording, "retrieve").mockResolvedValueOnce({ facts: [legacy], storesRead: [{ store: "graph" }] });

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUESTION, limit: 10 }, SCOPE);

    expect(facts.map((f) => f.fact)).not.toContain(loser.content);
  });
});
