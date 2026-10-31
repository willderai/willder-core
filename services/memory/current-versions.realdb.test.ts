// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A retired version's place on a read's page goes to its current successor
// (services/memory/current-versions.ts). The defect: a read dropped a version a
// `supersedes` edge retired and served nothing in its place, so a question worded like the
// old version never reached the update its writer recorded. Only explicit records retire a
// version (a based write, a race the conflict model settled); two writes that merely share
// an entity name are two facts.
//
// Real: Postgres with pgvector, the request path's ingest (conflict resolution and the
// change feed under the per-org lock), check() against live capabilities, the erasure's
// DELETEs and suppression list, GuardedMemoryStore, HybridMemoryStore and pgvector's SQL.
// Stand-ins: the memory service's graph (`RecordingGraph`, which keeps the chunk id the
// write path stamps on each episode, the contract memory-service/tests/test_api.py holds
// the service to) and its embedding endpoint, which puts the question and every text that
// starts "The standup" on one axis, the fillers at a cosine of 0.8 and everything else at 0.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { IngestInput, MemoryFact, SearchResult } from "@/types/memory";
import { stubEmbedService } from "./embed-service-stub.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** One episode the write path sent to the graph, with the chunk id it was stamped with. */
interface Episode {
  content: string;
  chunkId: string | undefined;
}

/**
 * The memory service's graph as far as these reads need it: one extracted fact per
 * episode, carrying the stamped chunk id. `answers` picks which episodes a search returns,
 * so a test can have the graph answer with an older version alone, as Graphiti does when
 * the newer version's wording does not match the question.
 */
class RecordingGraph {
  readonly episodes: Episode[] = [];
  answers: (episode: Episode) => boolean = () => false;

  async ingest(input: IngestInput) {
    this.episodes.push({ content: input.content, chunkId: input.readableId });
    return { episodeId: `ep-${this.episodes.length}` };
  }

  async retrieve(): Promise<SearchResult> {
    const facts: MemoryFact[] = this.episodes.filter(this.answers).map((episode, i) => ({
      uuid: `edge-${i}`,
      fact: `Extracted: ${episode.content}`,
      validAt: null,
      actorType: "agent",
      chunkIds: episode.chunkId === undefined ? [] : [episode.chunkId],
      store: "graph",
    }));
    return { facts, storesRead: [{ store: "graph" }] };
  }
}

let recording: RecordingGraph;

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: {
    ingest: vi.fn(async (input: IngestInput) => recording.ingest(input)),
    ingestBulk: vi.fn(),
    removeGroupFacts: async () => ({ removedCount: 0 }),
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
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

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_current_versions";
const ROOT = `org_${ORG}`;
const TEAM = `${ROOT}.team`;
const OTHER = `${ROOT}.other`;
const ADMIN = "qa_current_versions_admin";
const ERASED_NAME = "Orla Brennick";
const NAME = "Standup room";
const QUESTION = "Which room is the standup in?";
const V1 = "The standup is in room Alder.";
const DIMENSIONS = 384;

const vector = (...leading: number[]) => [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];
/** The question and every text starting "The standup" on one axis; fillers near it; everything else off it. */
const embed = (text: string) =>
  text === QUESTION || text.startsWith("The standup")
    ? vector(1)
    : text.startsWith("Team note")
      ? vector(0.8, 0.6)
      : vector(0, 0, 1);

const write = (
  content: string,
  opts: { actorId?: string; scopePath?: string; name?: string; baseVersion?: string } = {},
): IngestInput => ({
  groupId: ORG,
  content,
  name: opts.name ?? NAME,
  actorType: "agent",
  origin: "mcp",
  actorId: opts.actorId ?? "writer-a",
  actorName: "MCP session",
  source: "mcp",
  scopePath: opts.scopePath ?? TEAM,
  ...(opts.baseVersion ? { baseVersion: opts.baseVersion } : {}),
});

describe.skipIf(!QA_URL)("a retired version's place goes to its current successor, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let appDb: (typeof import("@/lib/db"))["db"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function readerOf(scopePath: string, agentId = "reader"): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
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

  const store = () =>
    new GuardedMemoryStore(
      new HybridMemoryStore(recording as unknown as MemoryStore, new PgvectorMemoryStore()),
      async () => "enterprise",
    );

  /** The page `memory_query` would serve: ids, text and store. */
  async function page(ctx: AccessContext, scope: string, limit = 3, extra: { skipPgvector?: boolean } = {}) {
    const { facts } = await store().retrieve(ctx, { groupId: ORG, query: QUESTION, limit, ...extra }, scope);
    return facts.map((f) => ({ uuid: f.uuid, fact: f.fact, store: f.store }));
  }

  /** Store a version through the request path and return its id. */
  async function stored(input: IngestInput): Promise<string> {
    const ack = await ingestMemory(input);
    const row = await db.memoryChunk.findFirstOrThrow({
      where: { orgId: ORG, content: input.content },
      orderBy: { createdAt: "desc" },
    });
    expect(ack).toBeTruthy();
    return row.id;
  }

  /** Three fillers nearer the question than any successor, so a page of three fills without one. */
  async function fillers(scopePath = TEAM) {
    for (const n of [1, 2, 3])
      await stored(write(`Team note ${n}: the sprint review is on Thursday.`, { name: `Team note ${n}`, scopePath }));
  }

  /** A `supersedes` edge written directly, for states the request path reaches only by a race. */
  const edge = (id: string, fromId: string, toId: string, createdAt = new Date()) => db.$executeRaw`
    INSERT INTO fact_edges ("id","orgId","fromId","toId","kind","scopePath","actorType","actorId","createdAt")
    VALUES (${id}, ${ORG}, ${fromId}, ${toId}, 'supersedes', ${TEAM}, 'agent', 'writer-a', ${createdAt})`;

  async function wipe() {
    await db.$executeRaw`DELETE FROM fact_edges WHERE "orgId" = ${ORG}`;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    ({ ingestMemory } = inngestModule);
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ erasePerson } = await import("./person-erasure"));
    ({ db: appDb } = await import("@/lib/db"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inngestModule = await import("@/lib/inngest");
    // Run the queued job inline, so the graph write the request path defers happens and
    // `RecordingGraph` sees the chunk id it was stamped with.
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      await inngestModule.runMemoryIngest(event.data);
      return { ids: ["job"] };
    }) as never);
    recording = new RecordingGraph();
    stubEmbedService(embed);
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: TEAM, name: "team" } });
    await db.scope.create({ data: { orgId: ORG, path: OTHER, name: "other" } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@current-versions.test",
        role: "admin",
        clerkId: "clerk-current-versions-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  it("an update recorded with baseVersion takes the place of the version it replaced, though the question matched only the old one", async () => {
    const v1 = await stored(write(V1));
    await fillers();
    const v2 = await stored(write("Correction: it now meets in Birch on the third floor.", { baseVersion: v1 }));
    const ctx = await readerOf(TEAM);

    const served = await page(ctx, TEAM);

    // Before this change the page was the three fillers: v1 was dropped, and nothing took its place.
    expect(served.map((f) => f.uuid)).toEqual([v2, expect.any(String), expect.any(String)]);
    expect(served.map((f) => f.uuid)).not.toContain(v1);
  });

  it("follows a chain of updates to its head, and serves no version along it", async () => {
    const v1 = await stored(write(V1));
    const v2 = await stored(write("Moved to Birch for the week.", { baseVersion: v1 }));
    const v3 = await stored(write("Back to Cedar from Monday.", { baseVersion: v2 }));
    await fillers();
    const ctx = await readerOf(TEAM);

    const served = (await page(ctx, TEAM, 10)).map((f) => f.uuid);

    expect(served[0]).toBe(v3);
    expect(served.filter((id) => id === v3)).toHaveLength(1);
    expect(served).not.toContain(v1);
    expect(served).not.toContain(v2);
  });

  it("gives the place of a graph fact from the replaced version's episode to the update", async () => {
    const v1 = await stored(write(V1));
    const v2 = await stored(write("Correction: it now meets in Birch on the third floor.", { baseVersion: v1 }));
    recording.answers = (episode) => episode.chunkId === v1;
    const ctx = await readerOf(TEAM);

    const served = await page(ctx, TEAM, 3, { skipPgvector: true });

    expect(served.map((f) => [f.store, f.uuid])).toEqual([["semantic", v2]]);
  });

  it("serves a writer its own update when it asks in the replaced version's words (2.9)", async () => {
    const v1 = await stored(write(V1));
    const v2 = await stored(write("Correction: it now meets in Birch on the third floor.", { baseVersion: v1 }));
    await fillers();
    const writer = await readerOf(TEAM, "writer-a");

    expect((await page(writer, TEAM, 1)).map((f) => f.uuid)).toEqual([v2]);
  });

  it("two writers within the contention window: the winner takes the matched loser's place, and the loser's writer is told (2.4)", async () => {
    const [a, b] = ["Room Birch, says writer A.", "Room Cedar, says writer B."];
    await Promise.all([stored(write(a, { actorId: "writer-a" })), stored(write(b, { actorId: "writer-b" }))]);
    const edges = await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } });
    expect(edges).toHaveLength(1);
    const [{ fromId: winner, toId: loser }] = edges;
    // Which writer wins is decided by the race, so the question is pointed at the loser after it.
    await db.$executeRaw`UPDATE memory_chunks SET embedding = ${`[${vector(1).join(",")}]`}::vector WHERE id = ${loser}`;
    await fillers();
    const ctx = await readerOf(TEAM);

    const served = (await page(ctx, TEAM)).map((f) => f.uuid);

    expect(served[0]).toBe(winner);
    expect(served).not.toContain(loser);
    expect(await db.changeEvent.findFirst({ where: { orgId: ORG, recordId: loser, op: "supersede" } })).not.toBeNull();
  });

  it("another fact about the same entity, not written as an update of the served one: the page is unchanged", async () => {
    // memory_ingest's `name` is "the entity it is about, e.g. 'Acme Corp'" (mcp/tools/memory-ingest.ts),
    // and fact-reads.ts says a second write under it "may be a new fact rather than an update". With
    // the real embedder, a CTO fact was served above "Acme Corp's contract renews on November 1" and
    // the renewal line was marked "a newer version of this fact is on this page" (found in review).
    await stored(write("The standup with Acme Corp is every Monday at 9.", { name: "Acme Corp" }));
    await fillers();
    const ctx = await readerOf(TEAM);
    const without = await page(ctx, TEAM);

    await stored(write("Acme Corp's CTO is Jane Doe.", { name: "Acme Corp" }));

    expect(await page(ctx, TEAM)).toEqual(without);
  });

  describe("serves no successor the reader may not read, and leaves no trace of one", () => {
    it("a successor in a scope the reader cannot read: the page is the one it gets when the successor is gone", async () => {
      const v1 = await stored(write(V1));
      await fillers();
      const hidden = await stored(
        write("Off the record: standup moves to Larch.", { scopePath: OTHER, actorId: "writer-b" }),
      );
      await edge("qa-edge-hidden", hidden, v1);
      const ctx = await readerOf(TEAM);

      const withHidden = await page(ctx, TEAM);
      await db.$executeRaw`DELETE FROM memory_chunks WHERE id = ${hidden} AND "orgId" = ${ORG}`;
      const absent = await page(ctx, TEAM);

      expect(withHidden).toEqual(absent);
      expect(JSON.stringify(withHidden)).not.toContain(hidden);
      expect(JSON.stringify(withHidden)).not.toContain("Larch");
    });

    it("a graph fact stamped with a retired version in a scope the reader cannot read: that scope's successor is not served", async () => {
      // A mis-stamped episode is the memory service's defect, not the reader's grant: the
      // read's own scope bounds what it adds, whatever a graph fact names.
      const elsewhere = await stored(write(V1, { scopePath: OTHER, actorId: "writer-b" }));
      await stored(
        write("Off the record: standup moves to Larch.", {
          scopePath: OTHER,
          actorId: "writer-b",
          baseVersion: elsewhere,
        }),
      );
      recording.answers = (episode) => episode.chunkId === elsewhere;
      const ctx = await readerOf(TEAM);

      const served = await page(ctx, TEAM, 3, { skipPgvector: true });

      expect(served).toEqual([]);
    });

    it("an erased successor a restored backup put back is never served, and the replaced version stays out", async () => {
      await db.contact.create({ data: { id: "orla", orgId: ORG, name: ERASED_NAME, email: "orla@brennick.example" } });
      const v1 = await stored(write(V1));
      await fillers();
      const erasedContent = `${ERASED_NAME} booked Birch for the standup.`;
      const v2 = await stored(write(erasedContent, { baseVersion: v1 }));
      const [backup] = await db.$queryRaw<{ createdAt: Date; embedding: string }[]>`
        SELECT "createdAt", embedding::text AS embedding FROM memory_chunks WHERE id = ${v2}`;
      await erasePerson(admin, { contactId: "orla" });
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","factVersion","scopePath","embedding","createdAt")
        VALUES (${v2}, ${ORG}, ${erasedContent}, 'mcp', 'agent', 'writer-a', ${NAME}, true, ${TEAM}, ${backup!.embedding}::vector, ${backup!.createdAt})`;
      if ((await db.factEdge.count({ where: { orgId: ORG, fromId: v2, toId: v1 } })) === 0)
        await edge("qa-edge-restored", v2, v1);
      const ctx = await readerOf(TEAM);

      const served = await page(ctx, TEAM);

      expect(served.map((f) => f.uuid)).not.toContain(v1);
      expect(JSON.stringify(served)).not.toContain(v2);
      expect(JSON.stringify(served)).not.toContain(ERASED_NAME);
    });

    const rule = (id: string, text: string, retired: boolean, subject = NAME) => db.$executeRaw`
      INSERT INTO conventions ("id","orgId","scopePath","kind","subject","text","actorId","retiredAt")
      VALUES (${id}, ${ORG}, ${TEAM}, 'decision', ${subject}, ${text}, ${ADMIN}, ${retired ? new Date() : null})`;
    it.each([
      {
        // A person's confirmed rule is replaced in the conventions table, under its own checks,
        // never by a fact written over its copy.
        case: "a person's rule copy an agent's fact update retired: the update does not take its place",
        setup: async () => {
          await rule("qa-rule-person", V1, false);
          const copy = await stored(write(V1));
          return stored(write("Agent proposal: standup in Birch.", { baseVersion: copy, actorId: "agent-b" }));
        },
      },
      {
        // An identical write replayed onto the agent's row: the copy's stored text is the
        // agent's, not the rule's, which differs from it by a trailing newline.
        case: "a rule copy whose stored text differs from the rule's by whitespace: the update does not take its place",
        setup: async () => {
          const copy = await stored(write(`${V1}\n`));
          await rule("qa-rule-whitespace", V1, false);
          return stored(write("Agent proposal: standup in Birch.", { baseVersion: copy, actorId: "agent-b" }));
        },
      },
      {
        // A correction or an upstream edit can join two names; each end is checked on its own.
        case: "a rule copy retired by an edge from a version under another name: that version does not take its place",
        setup: async () => {
          await rule("qa-rule-joined", V1, false, "Standup rule");
          const copy = await stored(write(V1, { name: "Standup rule" }));
          const other = await stored(
            write("Agent proposal: standup in Birch.", { name: "Agent standup", actorId: "agent-b" }),
          );
          await edge("qa-edge-joined", other, copy);
          return other;
        },
      },
      {
        case: "a head stored under a retired rule's subject, joined from a plain fact: never served as current",
        setup: async () => {
          const v1 = await stored(write(V1));
          await rule("qa-rule-old", "Rule (since retired): standup in Birch.", true, "Old rule");
          const head = await stored(write("Rule (since retired): standup in Birch.", { name: "Old rule" }));
          await edge("qa-edge-old-rule", head, v1);
          return head;
        },
      },
      {
        case: "a lineage that loops: neither version is served",
        setup: async () => {
          const v1 = await stored(write(V1));
          const v2 = await stored(write("Moved to Birch for the week.", { baseVersion: v1 }));
          await edge("qa-edge-loop", v1, v2);
          return v2;
        },
      },
      {
        case: "a retired rule's copy at the head of a chain: never served as current",
        setup: async () => {
          const v1 = await stored(write(V1));
          const retiredRuleText = "Rule (since retired): standup in Birch.";
          await rule("qa-rule-retired", retiredRuleText, true);
          return stored(write(retiredRuleText, { baseVersion: v1 }));
        },
      },
      {
        // Stored back when a failed embedding was swallowed: the vector search cannot read it either.
        case: "a successor stored without an embedding",
        setup: async () => {
          const v1 = await stored(write(V1));
          await db.$executeRaw`
            INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","factVersion","scopePath","createdAt")
            VALUES ('qa-unembedded', ${ORG}, 'Unembedded: standup in Spruce.', 'mcp', 'agent', 'writer-a', ${NAME}, true, ${TEAM}, ${new Date()})`;
          await edge("qa-edge-unembedded", "qa-unembedded", v1);
          return "qa-unembedded";
        },
      },
    ])("$case", async ({ setup }) => {
      const successor = await setup();
      await fillers();
      const ctx = await readerOf(TEAM);

      const served = await page(ctx, TEAM);

      expect(served.map((f) => f.uuid)).not.toContain(successor);
      expect(served.every((f) => f.fact.startsWith("Team note"))).toBe(true);
    });
  });

  it("retired rows with no successor to serve hold no place in the search's LIMIT: the current rows are main's", async () => {
    // Twelve retired rows nearer the question than anything else fill the vector leg's overfetch
    // of 12 for a page of 3, were they ranked in it; their successors are gone.
    for (let n = 0; n < 12; n++) {
      const old = await stored(write(`The standup for squad ${n} is in room Alder.`, { name: `Squad ${n}` }));
      await edge(`qa-edge-gone-${n}`, `qa-gone-${n}`, old);
    }
    await fillers();
    const ctx = await readerOf(TEAM);

    const served = await page(ctx, TEAM);

    expect(served.map((f) => f.fact).sort()).toEqual([
      "Team note 1: the sprint review is on Thursday.",
      "Team note 2: the sprint review is on Thursday.",
      "Team note 3: the sprint review is on Thursday.",
    ]);
  });

  it("takes the successor named by the earliest edge, by id among edges recorded at one instant", async () => {
    const v1 = await stored(write(V1));
    const a = await stored(write("Room Birch.", { actorId: "writer-a", name: "Successor A" }));
    const b = await stored(write("Room Cedar.", { actorId: "writer-a", name: "Successor B" }));
    const at = new Date();
    await edge("qa-edge-2", a, v1, at);
    await edge("qa-edge-1", b, v1, at);
    await fillers();
    const ctx = await readerOf(TEAM);

    expect((await page(ctx, TEAM, 1)).map((f) => f.uuid)).toEqual([b]);
  });

  it("looks successors up once per read that ranked retired versions, and not at all when it ranked none", async () => {
    // Every call's SQL text, whether it came as a template's strings or as a Prisma.Sql.
    const textOf = (sql: unknown) =>
      Array.isArray(sql) ? sql.join("?") : ((sql as { strings?: string[] }).strings ?? []).join("?");
    const lookups = () =>
      vi.mocked(appDb.$queryRaw).mock.calls.filter(([sql]) => textOf(sql).includes("lineage_heads"));
    for (let n = 0; n < 10; n++) {
      const old = await stored(write(`The standup for team ${n} is in room Alder.`, { name: `Room ${n}` }));
      await stored(write(`Moved to room ${n} on the third floor.`, { name: `Room ${n}`, baseVersion: old }));
    }
    await fillers();
    const ctx = await readerOf(TEAM);
    vi.spyOn(appDb, "$queryRaw");

    const served = await page(ctx, TEAM, 10);
    expect(lookups()).toHaveLength(1);
    expect(served.filter((f) => f.fact.startsWith("Moved to room"))).toHaveLength(10);

    vi.mocked(appDb.$queryRaw).mockClear();
    await db.$executeRaw`DELETE FROM fact_edges WHERE "orgId" = ${ORG}`;
    await page(ctx, TEAM, 10);
    expect(lookups()).toHaveLength(0);
  });
});
