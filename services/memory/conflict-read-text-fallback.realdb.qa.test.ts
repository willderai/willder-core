// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The supersede filter's text fallback (services/memory/superseded-facts.ts).
// The fallback exists for graph facts written before the chunk stamp. A version stored
// in `memory_chunks` is a different case: its id is the key the record is written in, so
// whether it is current is known exactly, and a text match must never overrule that.
//
// Same harness as conflict-read-graph-leg.realdb.test.ts: real request path, real
// conflict resolution, real pgvector SQL, a recording fake for Graphiti.
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
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** One episode the write path sent to the graph, as the memory service would hold it. */
interface Episode {
  content: string;
  /** The `memory_chunks` row the write path stamped on it, if any. */
  chunkId: string | undefined;
}

/** The sentence an extractor distils from a stored one: same claim, different words. */
const extracted = (content: string) =>
  `Release train departure: ${content.replace(/^The release train leaves on /, "")}`;

/** A fact Graphiti holds from an episode written before the chunk stamp existed. */
interface LegacyFact {
  /** The partition a read must ask for to see it, as the guarded store passes it. */
  groupId: string;
  text: string;
}

/**
 * A fake for the memory service: it remembers the episodes the write path sent and
 * answers a read with one extracted fact per episode, carrying the chunk id that episode
 * was stamped with — exactly what `/search` returns in `chunk_ids`. It filters nothing,
 * which is the point: Graphiti holds every version ever written and cannot tell them apart.
 * Legacy facts are answered only to a read of their own group, as Graphiti partitions them.
 */
class RecordingGraph implements Pick<MemoryStore, "ingest" | "retrieve"> {
  readonly episodes: Episode[] = [];
  readonly legacy: LegacyFact[] = [];

  async ingest(input: IngestInput) {
    this.episodes.push({ content: input.content, chunkId: input.readableId });
    return { episodeId: `ep-${this.episodes.length}` };
  }

  async retrieve(input: SearchInput): Promise<SearchResult> {
    // One search over several groups answers from each, naming the group of every fact.
    const asked = [input.groupId, ...(input.groupIds ?? [])];
    const legacy: MemoryFact[] = this.legacy
      .filter((fact) => asked.includes(fact.groupId))
      .map((fact, i) => ({
        uuid: `legacy-${fact.groupId}-${i}`,
        fact: fact.text,
        validAt: null,
        actorType: "agent",
        store: "graph",
        graphGroupId: toGid(fact.groupId),
      }));
    const facts: MemoryFact[] = this.episodes.map((episode, i) => ({
      uuid: `edge-${i}`,
      fact: extracted(episode.content),
      validAt: null,
      actorType: "agent",
      chunkIds: episode.chunkId === undefined ? [] : [episode.chunkId],
      store: "graph",
      // These episodes have no group of their own here; they answer as the first one asked.
      graphGroupId: toGid(input.groupId),
    }));
    return { facts: [...facts, ...legacy], storesRead: [{ store: "graph" }] };
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
const ORG = "conflicttextfallback";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;
const QUESTION = "When does the release train leave?";

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

describe.skipIf(!QA_URL)("conflict: a current stored version is never hidden by a text match", () => {
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
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    recording = new RecordingGraph();
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("keeps a current stored version whose text a superseded version in another scope also had", async () => {
    const { loserId } = await raceTwoWriters();
    const loser = await db.memoryChunk.findUniqueOrThrow({ where: { id: loserId } });
    // Whichever writer lost, a different team states the same sentence in its own scope. No race, no edge:
    // this version is current by the record.
    const OTHER = `${ROOT}.ops`;
    await db.scope.create({ data: { orgId: ORG, path: OTHER, name: "ops" } });
    await ingestMemory({ ...write("writer-c", "Tuesday"), content: loser.content, scopePath: OTHER });
    const current = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, scopePath: OTHER } });
    expect(current.content).toBe(loser.content);
    expect(await db.factEdge.count({ where: { orgId: ORG, toId: current.id } })).toBe(0);

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUESTION, limit: 10 }, OTHER);

    expect(facts.map((f) => f.uuid)).toContain(current.id);
  });

  it("hides an unstamped loser read from a descendant scope's group, not only from the target's", async () => {
    const { loserId } = await raceTwoWriters();
    const loser = await db.memoryChunk.findUniqueOrThrow({ where: { id: loserId } });
    // A pre-stamp episode in the scope the race happened in, worded exactly like the loser.
    // A root reader reaches it only through the descendant leg, which reads SCOPE's group.
    recording.legacy.push({ groupId: SCOPE, text: loser.content });

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUESTION, limit: 10 }, ROOT);

    expect(facts.map((f) => f.fact)).not.toContain(loser.content);
  });
});
