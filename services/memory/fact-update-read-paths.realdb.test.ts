// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test here is skipped, not failed.
//
// A lost update, by read path: a write-back from a stale read must not end
// with the stale version current beside the newer one, whichever tool the writer read
// the fact with. The stale-read check (services/memory/fact-reads.ts) knows what an agent
// read only from the replies that record it, so every read path that serves a fact's
// text is raced here: memory_query, memory_entity and the change feed. Each race waits
// out the one-second contention window before the write-back, because inside it the
// conflict model settles the pair instead.
//
// Real: Postgres, the request-path ingest, the per-org lock, edges, change feed, check()
// against live capabilities, the MCP tool handlers, pgvector's read SQL. Doubles: the
// embedding service, and a graph leg that serves the stored rows of the entities a test
// registers as graph facts carrying their chunk ids, as memory-service does.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

/** The graph leg's entities: entity id to the fact names whose stored rows it serves. */
const graphEntities = vi.hoisted(() => new Map<string, string[]>());
/** Set to make the next record of a served read fail, as a dropped connection would. */
const readRecord = vi.hoisted(() => ({ failNext: false }));

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/services/memory/store", () => ({
  memory: {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }),
    retrieve: async (input: never) => new (await import("./pgvector-store")).PgvectorMemoryStore().retrieve(input),
    // The graph leg for memory_entity: every stored row of the entity's facts, each as a
    // graph fact derived from that row.
    entity: async ({ entityId }: { entityId: string }) => {
      const names = graphEntities.get(entityId);
      if (!names) return null;
      const { db } = await import("@/lib/db");
      const rows = await db.memoryChunk.findMany({
        where: { orgId: "factreadpaths", entityName: { in: names } },
        orderBy: { createdAt: "asc" },
        select: { id: true, content: true },
      });
      return {
        uuid: entityId,
        name: names[0],
        type: "project",
        facts: rows.map((row) => ({ uuid: `graph-${row.id}`, fact: row.content, chunkIds: [row.id], store: "graph" })),
      };
    },
  },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/memory/fact-reads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fact-reads")>();
  return {
    ...actual,
    recordVersionsRead: async (...args: Parameters<typeof actual.recordVersionsRead>) => {
      if (readRecord.failNext) {
        readRecord.failNext = false;
        throw new Error("Connection terminated unexpectedly");
      }
      return actual.recordVersionsRead(...args);
    },
  };
});
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "factreadpaths";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)("a stale write-back is caught whichever tool the writer read with", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];

  async function toolsFor(agentId: string): Promise<Tools> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
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
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const tools: Tools = new Map();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath: SCOPE });
    return tools;
  }
  const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
  const versionIn = (reply: ToolReply) => /Version: (\S+?)\./.exec(textOf(reply))?.[1];
  const ingest = (tools: Tools, content: string, baseVersion?: string) =>
    tools.get("memory_ingest")!({
      name: "Release train",
      content,
      scopePath: SCOPE,
      ...(baseVersion ? { baseVersion } : {}),
    });

  /** Use up `tools`' task-start block while the org is empty, so it can show no fact later. */
  const taskStartSpent = (tools: Tools) => tools.get("memory_changes")!({ scopePath: SCOPE });
  /** Move `agentId`'s change-feed cursor past everything written so far: no notice can show it. */
  async function feedCaughtUp(agentId: string): Promise<void> {
    const latest = await db.changeEvent.aggregate({ where: { orgId: ORG }, _max: { seq: true } });
    const lastSeq = latest._max.seq ?? BigInt(0);
    await db.agentCursor.upsert({
      where: { orgId_agentId: { orgId: ORG, agentId } },
      update: { lastSeq },
      create: { orgId: ORG, agentId, lastSeq },
    });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ registerWillderTools } = await import("@/mcp/tools"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
    graphEntities.clear();
    graphEntities.set("entity-release-train", ["Release train", "Release freeze"]);
  });

  /**
   * Seed, A reads with `readTool`, B updates the version it read, and after the contention
   * window A writes back without a base. Returns A's reply and the status of both versions.
   * For memory_query and memory_entity, that tool is A's only sight of the seed: no
   * task-start block or change notice shows it to A first.
   */
  async function race(readTool: "memory_query" | "memory_entity" | "memory_changes") {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    if (readTool !== "memory_changes") await taskStartSpent(a);
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    if (readTool !== "memory_changes") await feedCaughtUp("writer-a");

    const read =
      readTool === "memory_query"
        ? await a.get("memory_query")!({ query: "When does the release train leave?", scopePath: SCOPE })
        : readTool === "memory_entity"
          ? await a.get("memory_entity")!({ entityId: "entity-release-train", scopePath: SCOPE })
          : await a.get("memory_changes")!({ scopePath: SCOPE });
    expect(textOf(read)).toContain("The release train leaves on Monday.");
    if (readTool === "memory_changes") expect(textOf(read)).toContain(original);

    await b.get("memory_version")!({ versionId: original });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday.", original))!;
    // Agents take seconds between a read and a write; past the window the conflict model
    // no longer settles the pair.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await ingest(a, "The release train leaves on Wednesday.");

    const statusOf = async (id: string | undefined) =>
      id
        ? /\((current|superseded)[^)]*\)/.exec(textOf(await b.get("memory_version")!({ versionId: id })))?.[1]
        : "not stored";
    return { back, bStatus: await statusOf(fromB), aStatus: await statusOf(versionIn(back)) };
  }

  it("refuses A's write-back when A read the fact with memory_query", async () => {
    const { back, bStatus } = await race("memory_query");
    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(/^stale_version: /);
    expect(bStatus).toBe("current");
  }, 30_000);

  it("refuses A's write-back when A read the same fact with memory_entity", async () => {
    const { back, bStatus, aStatus } = await race("memory_entity");
    expect({ refused: back.isError === true, bStatus, aStatus }).toEqual({
      refused: true,
      bStatus: "current",
      aStatus: "not stored",
    });
  }, 30_000);

  // For a fact shorter than the feed's 200-character summary cap, memory_changes serves
  // the whole version text and its id, so it is a read path like the two above.
  it("refuses A's write-back when A read the fact on the change feed (memory_changes)", async () => {
    const { back, bStatus, aStatus } = await race("memory_changes");
    expect({ refused: back.isError === true, bStatus, aStatus }).toEqual({
      refused: true,
      bStatus: "current",
      aStatus: "not stored",
    });
  }, 30_000);

  // memory_entity answers with every fact of the entity; the stale write-back here is to
  // the second one, so recording only the first fact's versions would not pass.
  it("refuses A's write-back to the second of two facts it read with memory_entity", async () => {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const freeze = (tools: Tools, content: string, baseVersion?: string) =>
      tools.get("memory_ingest")!({
        name: "Release freeze",
        content,
        scopePath: SCOPE,
        ...(baseVersion ? { baseVersion } : {}),
      });
    await taskStartSpent(a);
    await ingest(seed, "The release train leaves on Monday.");
    const original = versionIn(await freeze(seed, "The freeze starts on Friday."))!;
    // memory_entity is A's only sight of the fact: no block or notice shows the seed's writes.
    await feedCaughtUp("writer-a");

    const read = await a.get("memory_entity")!({ entityId: "entity-release-train", scopePath: SCOPE });
    expect(textOf(read)).toContain("The freeze starts on Friday.");

    await b.get("memory_version")!({ versionId: original });
    const fromB = versionIn(await freeze(b, "The freeze starts on Thursday.", original))!;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await freeze(a, "The freeze starts on Saturday.");

    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));
  }, 30_000);

  // A change-feed line shows a version's text cut at 200 characters, so it is a
  // sighting, not a read (services/memory/fact-reads.ts).
  // Seeing B's version only that way does not let A write past it; reading it does.
  it("refuses A's write-back after A only saw B's version in the change feed, and accepts it once A reads it", async () => {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    await a.get("memory_query")!({ query: "When does the release train leave?", scopePath: SCOPE });
    await b.get("memory_version")!({ versionId: original });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday.", original))!;

    expect(textOf(await a.get("memory_changes")!({ scopePath: SCOPE }))).toContain(`create fact ${fromB}`);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await ingest(a, "The release train leaves on Wednesday.");
    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));

    await a.get("memory_version")!({ versionId: fromB });
    const afterReading = await ingest(a, "The release train leaves on Wednesday.");
    expect(afterReading.isError).not.toBe(true);
  }, 30_000);

  // The memory_changes case above passes through the task-start block as well, which
  // shows the seed's write on A's first call. Here the feed is A's only sight of it.
  it("refuses A's write-back when A's only sight of the fact was the change feed", async () => {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    await taskStartSpent(a);
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    expect(textOf(await a.get("memory_changes")!({ scopePath: SCOPE }))).toContain(`create fact ${original}`);

    await b.get("memory_version")!({ versionId: original });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday.", original))!;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await ingest(a, "The release train leaves on Wednesday.");

    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}.*which you saw only in part`));
  }, 30_000);

  it("answers a read it could not record with an error, so no write-back can follow from it unchecked", async () => {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    await taskStartSpent(a);
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    await feedCaughtUp("writer-a");

    readRecord.failNext = true;
    const unrecorded = await a.get("memory_entity")!({ entityId: "entity-release-train", scopePath: SCOPE });
    expect(unrecorded.isError).toBe(true);
    expect(textOf(unrecorded)).not.toContain("The release train leaves on Monday.");

    // The agent retries the read, as it would any failed call, and this time it is recorded.
    expect(textOf(await a.get("memory_entity")!({ entityId: "entity-release-train", scopePath: SCOPE }))).toContain(
      "The release train leaves on Monday.",
    );
    await b.get("memory_version")!({ versionId: original });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday.", original))!;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await ingest(a, "The release train leaves on Wednesday.");

    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));
  }, 30_000);

  // A team's workflow at volume: three agents share one release scope and keep an on-call fact per service, thirty services at once, so
  // their calls interleave and their announcements queue on the one per-org lock. In each
  // race one agent seeds the fact, a second reads it (memory_query for half the races,
  // memory_entity for the other half), a third reads and updates it (with baseVersion for
  // half, without for the rest) and retries that call with the same idempotencyKey as a
  // client that lost the reply would, then the reader writes back from its stale read once
  // the contention window has passed. A race is lost when the update is not current or
  // not served, or the stale write-back is current beside it. The reader then does what the refusal says (reads
  // the update, retries with the same key) and writes one more note of its own, which
  // must not be refused for the reader's own earlier write.
  it("loses no update in thirty interleaved races among three agents, through both read tools, with retries", async () => {
    const RACES = 30;
    const agentIds = ["planning-agent", "build-agent", "support-agent"];
    const agents: Tools[] = [];
    for (const agentId of agentIds) agents.push(await toolsFor(agentId));
    const auditor = await toolsFor("auditor");
    for (let i = 0; i < RACES; i++) {
      await db.scope.create({ data: { orgId: ORG, path: `${SCOPE}.svc${i}`, name: `svc${i}` } });
      graphEntities.set(`entity-svc-${i}`, [`Service ${i} on-call`]);
    }
    const statusOf = async (id: string) =>
      /\((current|superseded)[^)]*\)/.exec(textOf(await auditor.get("memory_version")!({ versionId: id })))?.[1];

    async function runRace(i: number) {
      const scopePath = `${SCOPE}.svc${i}`;
      const name = `Service ${i} on-call`;
      const [owner, reader, updater] = [agents[i % 3]!, agents[(i + 1) % 3]!, agents[(i + 2) % 3]!];
      const write = (tools: Tools, content: string, extra: Record<string, unknown> = {}) =>
        tools.get("memory_ingest")!({ name, content, scopePath, ...extra });
      const query = (tools: Tools) =>
        tools.get("memory_query")!({ query: `Who is on call for service ${i}?`, limit: 50, scopePath });
      const stale = `Service ${i}: Cara is on call.`;

      const seeded = versionIn(await write(owner, `Service ${i}: Ana is on call.`))!;
      const read =
        i % 2 === 0
          ? await reader.get("memory_entity")!({ entityId: `entity-svc-${i}`, scopePath })
          : await query(reader);
      expect(textOf(read)).toContain(`Service ${i}: Ana is on call.`);

      await query(updater);
      const updateArgs = { idempotencyKey: `on-call-update-${i}`, ...(i % 4 < 2 ? { baseVersion: seeded } : {}) };
      const update = versionIn(await write(updater, `Service ${i}: Ben is on call.`, updateArgs))!;
      const updateRetry = versionIn(await write(updater, `Service ${i}: Ben is on call.`, updateArgs));

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const writeBackArgs = { idempotencyKey: `on-call-write-back-${i}` };
      const back = await write(reader, stale, writeBackArgs);
      const staleRow = await db.memoryChunk.findFirst({ where: { orgId: ORG, content: stale }, select: { id: true } });
      const lost =
        (await statusOf(update)) !== "current" ||
        !textOf(await query(auditor)).includes(`Service ${i}: Ben is on call.`) ||
        (staleRow !== null && (await statusOf(staleRow.id)) === "current");

      await reader.get("memory_version")!({ versionId: update });
      const informed = await write(reader, stale, writeBackArgs);
      const followUp = await write(reader, `Service ${i}: Cara hands over to Ana at 18:00.`);

      return {
        lost,
        refusedNamingUpdate:
          back.isError === true && /^stale_version: /.test(textOf(back)) && textOf(back).includes(update),
        informedAccepted: informed.isError !== true && (await statusOf(update)) === "current",
        followUpRefused: followUp.isError === true,
        updateStoredTwice: updateRetry !== update,
      };
    }

    const races = await Promise.all(Array.from({ length: RACES }, (_, i) => runRace(i)));
    const count = (key: keyof (typeof races)[number]) => races.filter((race) => race[key]).length;

    expect({
      lost: count("lost"),
      refusedNamingUpdate: count("refusedNamingUpdate"),
      informedAccepted: count("informedAccepted"),
      followUpRefused: count("followUpRefused"),
      updateStoredTwice: count("updateStoredTwice"),
    }).toEqual({
      lost: 0,
      refusedNamingUpdate: RACES,
      informedAccepted: RACES,
      followUpRefused: 0,
      updateStoredTwice: 0,
    });
  }, 120_000);
});
