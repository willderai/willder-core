// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The unbased lost-update race, below the MCP layer: A reads a fact, B
// writes a new version of it, and A writes back from its stale read without naming a
// version. B's version must stay current and be what a reader's query returns, and A
// must not be stored as a second current version. Every step is the one the MCP tools
// take: a write is `ingestMemory` with reads tracked, and every read records the
// versions it served (services/memory/fact-reads.ts), exactly as memory_query and
// memory_ingest do.
//
// Everything is real except the memory service: Postgres, the per-org lock, the winner
// rule, the stale-read checks and pgvector's SQL. `FallbackGraph` stands in for the
// graph the way it answers one-entity sentences since the fallback hangs a fact on the
// entities extraction resolved: the stored sentence word for word, once per entity,
// stamped with the chunk it came from, ranked by the words it shares with the query.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "unbasedlostupdate";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.demo`;
const DIMENSIONS = 384;
const TAG = "lostupdate-test";
/** How many entities extraction resolves for each sentence; the fallback writes one edge per entity. */
const ENTITIES_PER_FACT = 2;

/** Lowercased words, the way a keyword index splits a sentence. */
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A deterministic embedding: one bucket per word, normalized, so identical text is similarity 1. */
function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of words(text)) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
    vector[hash] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}

/** One graph edge, as the memory service's `/search` returns it. */
interface Edge {
  fact: string;
  chunkId: string | undefined;
  order: number;
}

class FallbackGraph implements Pick<MemoryStore, "ingest" | "retrieve"> {
  readonly edges: Edge[] = [];

  async ingest(input: IngestInput) {
    for (let i = 0; i < ENTITIES_PER_FACT; i++) {
      this.edges.push({ fact: input.content, chunkId: input.readableId, order: this.edges.length });
    }
    return { episodeId: `ep-${this.edges.length}` };
  }

  async retrieve(input: SearchInput): Promise<SearchResult> {
    const asked = new Set(words(input.query));
    const score = (edge: Edge) => words(edge.fact).filter((w) => asked.has(w)).length;
    const ranked = [...this.edges].sort((a, b) => score(b) - score(a) || b.order - a.order);
    const facts: MemoryFact[] = ranked.slice(0, input.limit ?? 10).map((edge) => ({
      uuid: `edge-${edge.order}`,
      fact: edge.fact,
      validAt: null,
      actorType: "agent",
      chunkIds: edge.chunkId === undefined ? [] : [edge.chunkId],
      store: "graph",
    }));
    return { facts, storesRead: [{ store: "graph" }] };
  }
}

let graph: FallbackGraph;

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: {
    ingest: vi.fn(async (input: IngestInput) => graph.ingest(input)),
    ingestBulk: vi.fn(),
  },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
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

/** What one race ended with, in the live lost-update measure's terms. */
interface RaceOutcome {
  bCurrent: boolean;
  bServed: boolean;
  staleAcceptedCurrent: boolean;
  /** A's write-back named B's version, refused or stored superseded by it. */
  notified: boolean;
}

describe.skipIf(!QA_URL)("an unbased write-back from a stale read loses nothing", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let recordVersionsRead: (typeof import("./fact-reads"))["recordVersionsRead"];
  let storedVersionsBehind: (typeof import("@/mcp/fact-citation"))["storedVersionsBehind"];
  let reader: () => import("./guarded-store").GuardedMemoryStore;
  const contexts = new Map<string, AccessContext>();

  async function agent(agentId: string): Promise<AccessContext> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  /** memory_query: the guarded hybrid read, then the versions it served recorded as read. */
  async function lookUp(agentId: string, query: string): Promise<MemoryFact[]> {
    const { facts } = await reader().retrieve(contexts.get(agentId)!, { groupId: ORG, query, limit: 10 }, SCOPE);
    await recordVersionsRead(db, { orgId: ORG, agentId, versionIds: facts.flatMap(storedVersionsBehind) });
    return facts;
  }

  /** memory_ingest without baseVersion: the write, then its reply's version recorded as read. */
  async function write(agentId: string, name: string, content: string) {
    const ack = await ingestMemory({
      groupId: ORG,
      content,
      name,
      actorType: "agent",
      origin: "mcp",
      actorId: agentId,
      actorName: "MCP session",
      source: "mcp",
      scopePath: SCOPE,
      readsTracked: true,
    });
    if (ack.versionId) await recordVersionsRead(db, { orgId: ORG, agentId, versionIds: [ack.versionId] });
    return ack;
  }

  async function isCurrent(versionId: string): Promise<boolean> {
    return (await db.factEdge.count({ where: { orgId: ORG, toId: versionId, kind: "supersedes" } })) === 0;
  }

  /** One race, step for step as the live measure runs it; `pause` is waited before the named step. */
  async function race(n: number, pause: { beforeB?: number; beforeWriteBack?: number } = {}): Promise<RaceOutcome> {
    const name = `${TAG}-unbased-r${n}`;
    const text = (day: string) => `${TAG} unbased r${n}: the release train leaves on ${day}`;

    await write("writer-a", name, text("Monday"));
    await lookUp("writer-a", text("Monday"));
    if (pause.beforeB) await new Promise((resolve) => setTimeout(resolve, pause.beforeB));
    await lookUp("writer-b", text("Monday"));
    const fromB = await write("writer-b", name, text("Tuesday"));
    const bVersion = fromB.versionId!;

    if (pause.beforeWriteBack) await new Promise((resolve) => setTimeout(resolve, pause.beforeWriteBack));
    let staleAcceptedCurrent = false;
    let notified: boolean;
    try {
      const back = await write("writer-a", name, text("Wednesday"));
      staleAcceptedCurrent = back.versionId === undefined || (await isCurrent(back.versionId));
      notified = back.supersededBy === bVersion;
    } catch (e) {
      notified = e instanceof Error && e.message.includes(bVersion);
    }

    const answer = await lookUp("feed-reader", text("Tuesday"));
    return {
      bCurrent: await isCurrent(bVersion),
      bServed: answer.some((fact) => fact.fact === text("Tuesday")),
      staleAcceptedCurrent,
      notified,
    };
  }

  const kept: RaceOutcome = { bCurrent: true, bServed: true, staleAcceptedCurrent: false, notified: true };

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { text } = JSON.parse(String(init?.body)) as { text: string };
        return new Response(JSON.stringify({ embedding: embed(text) }));
      }),
    );
    const inngestModule = await import("@/lib/inngest");
    // Run the queued job inline, so the graph holds each write the way the job leaves it.
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      await inngestModule.runMemoryIngest(event.data);
      return { ids: ["job"] };
    }) as never);
    ({ ingestMemory } = inngestModule);
    ({ recordVersionsRead } = await import("./fact-reads"));
    ({ storedVersionsBehind } = await import("@/mcp/fact-citation"));
    const { PgvectorMemoryStore } = await import("./pgvector-store");
    const { HybridMemoryStore } = await import("./hybrid-store");
    const { GuardedMemoryStore } = await import("./guarded-store");
    reader = () =>
      new GuardedMemoryStore(
        new HybridMemoryStore(graph as unknown as MemoryStore, new PgvectorMemoryStore()),
        async () => "enterprise",
      );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graph = new FallbackGraph();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "demo" } });
    contexts.clear();
    for (const id of ["writer-a", "writer-b", "feed-reader"]) contexts.set(id, await agent(id));
  });

  it("keeps B's version through 30 back-to-back races in one scope", async () => {
    const outcomes: RaceOutcome[] = [];
    for (let n = 1; n <= 30; n++) outcomes.push(await race(n));

    expect(outcomes.map((o, i) => ({ race: i + 1, ...o }))).toEqual(outcomes.map((_, i) => ({ race: i + 1, ...kept })));
  }, 120_000);

  it("keeps B's version when A writes back after the contention window", async () => {
    for (let n = 1; n <= 3; n++) await race(n);

    expect(await race(4, { beforeWriteBack: 1_100 })).toEqual(kept);
  }, 30_000);

  it("keeps B's version when B writes after the contention window of A's first write", async () => {
    for (let n = 1; n <= 3; n++) await race(n);

    expect(await race(4, { beforeB: 1_100 })).toEqual(kept);
  }, 30_000);
});
