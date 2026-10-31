// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A row stored under a fact's name is a version of that fact only when the fact path
// stored it as one.
//
// memory_ingest stores each write as a version of the fact its name and scope identify,
// and the winner rule, the stale-read check and the based-write check (services/memory/
// conflict.ts, fact-reads.ts, fact-update.ts) decide between those versions. The vector
// store is written by other code too: the hybrid store's `ingest` (seeds, connector text,
// any future job), file passages, Drive files. When such a writer stored its row under the
// fact's name, every one of those rules read the row as one more version, announced to no
// one and read by no one: it superseded another writer's update, got a writer who had read
// the newest version refused, and moved its own writer's horizon past an update it never
// read. Writers were fixed one at a time by storing no name; this suite stores a named row
// through the hybrid store, as the next such writer would, and checks none of it happens.
//
// Rows stored before versions were marked carry no mark. Such a row counts as a version
// exactly when the change feed announced it as a fact, which is what the fact path always
// did and no other writer ever did; the last two cases cover both halves.
//
// The races are the lost-update race: A
// seeds, A and B read with memory_query, B writes, A writes back at once. Real: Postgres,
// the MCP tool handlers, check() against live capabilities, the request-path store and
// announcement, the per-org lock, the hybrid store and pgvector's SQL. Doubles: the
// embedding service (one fixed vector) and the graph service (accepts writes, finds
// nothing). Each write's queued graph job is dropped: it is not the writer under test.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => undefined,
}));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const nothing = async () => null;
  const graph = {
    ingest: async () => ({ episodeId: "graph-episode" }),
    ingestBulk: async (inputs: IngestInput[]) => inputs.map((_, i) => `graph-episode-${i}`),
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    entity: nothing,
    graph: async () => ({ nodes: [], edges: [] }),
    removeFact: async () => ({ removed: false }),
    removeEntity: async () => ({ removed: false }),
    transferEntity: async () => ({ transferred: 0 }),
    findFactById: nothing,
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "namedrows";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;
const PAST_CONTENTION_WINDOW_MS = 1_100;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)("a row stored under a fact's name is a version only when the fact path stored it", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let memory: (typeof import("@/services/memory/store"))["memory"];
  let recordIngestApplied: (typeof import("@/services/memory/fact-change-event"))["recordIngestApplied"];
  let pgvectorStore: (typeof import("@/services/memory/pgvector-store"))["pgvectorStore"];
  let recordDocumentIngested: (typeof import("@/services/memory/content-change-event"))["recordDocumentIngested"];

  async function toolsFor(agentId: string): Promise<Tools> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "write",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const tools: Tools = new Map();
    const server = {
      registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath: ROOT });
    return tools;
  }
  const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
  const versionIn = (reply: ToolReply) => /\bVersion: (\S+?)\.?(?:\s|$)/.exec(textOf(reply))?.[1];
  const pastContentionWindow = () => new Promise((resolve) => setTimeout(resolve, PAST_CONTENTION_WINDOW_MS));

  /** One fact, as the agents of one race write and read it. */
  function factIn(scopePath: string, name: string) {
    const text = (day: string) => `${name}: the release train leaves on ${day}`;
    return {
      name,
      scopePath,
      text,
      ingest: (tools: Tools, day: string, baseVersion?: string) =>
        tools.get("memory_ingest")!({
          content: text(day),
          name,
          scopePath,
          ...(baseVersion === undefined ? {} : { baseVersion }),
        }),
      lookUp: (tools: Tools) => tools.get("memory_query")!({ query: text("Monday"), limit: 10, scopePath }),
      async statusOf(reader: Tools, versionId: string): Promise<string | null> {
        const reply = await reader.get("memory_version")!({ versionId });
        return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(textOf(reply))?.[1] ?? null;
      },
      async served(reader: Tools, day: string): Promise<boolean> {
        const answer = textOf(await reader.get("memory_query")!({ query: text(day), limit: 10, scopePath }));
        return answer.split("\n").some((line) => line.startsWith("•") && line.includes(text(day)));
      },
    };
  }
  type Fact = ReturnType<typeof factIn>;

  /**
   * Store a row under the fact's name through the hybrid store, as writer-a's own
   * process would outside memory_ingest: here, the decision its ingest job drew from
   * the seed, which is the row production stored before job records lost their name.
   */
  async function storeNamedRecord(fact: Fact): Promise<string> {
    const content = `Decision by writer-a: ${fact.text("Monday")}`;
    await memory.ingest({
      groupId: ORG,
      content,
      name: fact.name,
      scopePath: fact.scopePath,
      actorType: "agent",
      actorId: "writer-a",
      actorName: "MCP session",
      source: "mcp",
      origin: "mcp",
    });
    const row = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content }, select: { id: true } });
    return row.id;
  }

  /**
   * Store a row the way the code before version marks did: no mark, optionally announced as a fact.
   * Its createdAt is UTC wall-clock time, as Prisma writes every other row here: a bare now()
   * stores session-local time, which on a server west of UTC dates the row hours before B's
   * read, so the stale-read check rightly ignores it and the case fails for the wrong reason.
   */
  async function storeUnmarkedRow(fact: Fact, id: string, day: string, announced: boolean): Promise<void> {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath","createdAt")
      VALUES (${id}, ${ORG}, ${fact.text(day)}, 'mcp', 'agent', 'writer-c', ${fact.name}, ${fact.scopePath}, ${sqlUtcNow})
    `);
    if (!announced) return;
    await recordIngestApplied(
      {
        groupId: ORG,
        content: fact.text(day),
        name: fact.name,
        scopePath: fact.scopePath,
        actorType: "agent",
        actorId: "writer-c",
        source: "mcp",
        origin: "mcp",
      },
      id,
    );
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    ({ registerWillderTools } = await import("@/mcp/tools"));
    ({ memory } = await import("@/services/memory/store"));
    ({ recordIngestApplied } = await import("@/services/memory/fact-change-event"));
    ({ pgvectorStore } = await import("@/services/memory/pgvector-store"));
    ({ recordDocumentIngested } = await import("@/services/memory/content-change-event"));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });
  beforeEach(async () => {
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("keeps B's update current when a named row of A's lands between B's read and B's write", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    await fact.lookUp(a);
    await fact.lookUp(b);
    const record = await storeNamedRecord(fact);

    const fromB = versionIn(await fact.ingest(b, "Tuesday"))!;
    const back = await fact.ingest(a, "Wednesday");

    expect(await fact.statusOf(reader, record)).toBe("current");
    expect(await fact.statusOf(reader, fromB)).toBe("current");
    expect(await fact.served(reader, "Tuesday")).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^Stored, but superseded by ${fromB}`));
  }, 30_000);

  it("accepts B's write when B read the newest version and a named row of A's was stored after that read", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    await fact.lookUp(b);
    await storeNamedRecord(fact);
    await pastContentionWindow();

    const fromB = await fact.ingest(b, "Tuesday");

    expect(textOf(fromB)).not.toMatch(/stale_version/);
    expect(await fact.statusOf(reader, versionIn(fromB)!)).toBe("current");
  }, 30_000);

  it("refuses A's stale write-back when A's own named row was stored after B's update", async () => {
    const [a, b] = [await toolsFor("writer-a"), await toolsFor("writer-b")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    await fact.lookUp(b);
    const fromB = versionIn(await fact.ingest(b, "Tuesday"))!;
    await storeNamedRecord(fact);
    await pastContentionWindow();

    const back = await fact.ingest(a, "Wednesday");

    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));
  }, 30_000);

  it("lets B replace the version B read when a named row was stored after it", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    const seed = versionIn(await fact.ingest(a, "Monday"))!;
    await fact.lookUp(b);
    await storeNamedRecord(fact);
    await pastContentionWindow();

    const fromB = await fact.ingest(b, "Tuesday", seed);

    expect(textOf(fromB)).not.toMatch(/stale_version/);
    expect(await fact.statusOf(reader, versionIn(fromB)!)).toBe("current");
    expect(await fact.statusOf(reader, seed)).toBe("superseded");
  }, 30_000);

  it("refuses a named row as the base of an update, since it is not a version of the fact", async () => {
    const [a, b] = [await toolsFor("writer-a"), await toolsFor("writer-b")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    const record = await storeNamedRecord(fact);

    const fromB = await fact.ingest(b, "Tuesday", record);

    expect(fromB.isError).toBe(true);
    expect(textOf(fromB)).toMatch(new RegExp(`^unknown_version: baseVersion ${record} is not a version of`));
  }, 30_000);

  it("does not count passages stored in one batch under the fact's name, so B's write is accepted past them", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    await fact.lookUp(b);
    const passage = (day: string): IngestInput => ({
      groupId: ORG,
      content: `${fact.name}.pdf: ${fact.text(day)}`,
      name: fact.name,
      scopePath: fact.scopePath,
      actorType: "agent",
      actorId: "writer-a",
      actorName: "MCP session",
      source: "document",
      origin: "mcp",
    });
    const passages = await pgvectorStore.ingestAll([passage("Thursday"), passage("Friday")], (tx) =>
      recordDocumentIngested(
        {
          orgId: ORG,
          scopePath: fact.scopePath,
          actorId: "writer-a",
          actorType: "agent",
          origin: "mcp",
          filename: `${fact.name}.pdf`,
        },
        "doc_release_train",
        tx,
      ),
    );

    const fromB = await fact.ingest(b, "Tuesday");

    expect(textOf(fromB)).not.toMatch(/stale_version/);
    expect(await fact.statusOf(reader, versionIn(fromB)!)).toBe("current");
    expect(await fact.served(reader, "Tuesday")).toBe(true);
    const stored = await db.memoryChunk.findMany({ where: { id: { in: passages } }, select: { factVersion: true } });
    expect(stored.map((row) => row.factVersion)).toEqual([false, false]);
  }, 30_000);

  it("loses no update in thirty races, wherever in the race A's named row lands", async () => {
    const slots = [
      "before B reads",
      "between B's read and B's write",
      "between B's write and A's write-back",
      "after A's write-back",
    ] as const;
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const lost: string[] = [];
    for (let race = 0; race < 30; race += 1) {
      // One scope per race, so the fixed embedding cannot serve one race's versions to another.
      const scopePath = `${SCOPE}.r${race}`;
      await db.scope.create({ data: { orgId: ORG, path: scopePath, name: `r${race}` } });
      const slot = slots[race % slots.length];
      const fact = factIn(scopePath, `Release train ${race}`);
      const recordLandsAt = async (point: (typeof slots)[number]) => {
        if (slot === point) await storeNamedRecord(fact);
      };

      await fact.ingest(a, "Monday");
      await fact.lookUp(a);
      await recordLandsAt("before B reads");
      await fact.lookUp(b);
      await recordLandsAt("between B's read and B's write");
      const fromB = versionIn(await fact.ingest(b, "Tuesday"))!;
      await recordLandsAt("between B's write and A's write-back");
      const back = await fact.ingest(a, "Wednesday");
      await recordLandsAt("after A's write-back");

      const aVersion = back.isError ? null : versionIn(back);
      const staleAcceptedCurrent =
        !back.isError && (aVersion === undefined || (await fact.statusOf(reader, aVersion!)) === "current");
      const bCurrent = (await fact.statusOf(reader, fromB)) === "current";
      const bServed = await fact.served(reader, "Tuesday");
      if (!bCurrent || !bServed || staleAcceptedCurrent) lost.push(`race ${race} (${slot})`);
    }

    console.log(`lost updates: ${lost.length} of 30 races${lost.length ? `: ${lost.join(", ")}` : ""}`);
    expect(lost).toEqual([]);
  }, 180_000);

  it("still counts an unmarked row the change feed announced as a fact, so B is refused past it", async () => {
    const [a, b] = [await toolsFor("writer-a"), await toolsFor("writer-b")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    await fact.lookUp(b);
    await pastContentionWindow();
    await storeUnmarkedRow(fact, "v-unmarked-announced", "Tuesday", true);
    await pastContentionWindow();

    const fromB = await fact.ingest(b, "Wednesday");

    expect(fromB.isError).toBe(true);
    expect(textOf(fromB)).toMatch(/^stale_version: .*v-unmarked-announced/);
  }, 30_000);

  it("does not count an unmarked row nobody announced, so B's write is accepted", async () => {
    const [a, b, reader] = [await toolsFor("writer-a"), await toolsFor("writer-b"), await toolsFor("reader")];
    const fact = factIn(SCOPE, "Release train");
    await fact.ingest(a, "Monday");
    await fact.lookUp(b);
    await pastContentionWindow();
    await storeUnmarkedRow(fact, "v-unmarked-silent", "Tuesday", false);
    await pastContentionWindow();

    const fromB = await fact.ingest(b, "Wednesday");

    expect(textOf(fromB)).not.toMatch(/stale_version/);
    expect(await fact.statusOf(reader, versionIn(fromB)!)).toBe("current");
  }, 30_000);
});
