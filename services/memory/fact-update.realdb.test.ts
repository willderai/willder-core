// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A lost update. Agent A reads a fact, agent B writes a new
// version of it, and A writes back from its stale read. B's version must stay the
// current one, and A must be told rather than silently accepted.
//
// Measured before this file existed, on the request path below: with no way to say
// which version a write was based on, a write-back that landed within the one-second
// contention window made the ORIGINAL version the winner, so B's update was recorded as
// superseded by the very version it replaced and no read served it; a write-back that
// landed later left all three versions current side by side, with nothing to say which.
//
// Everything below the store client is real: the request-path ingest into Postgres, the
// per-org lock, the dependency-graph edges, the change feed, check() against live
// capabilities, and pgvector's read SQL. Only Graphiti and the embedding service are
// doubles, as in conflict-read.realdb.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/services/memory/store", () => ({
  memory: {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }),
    // memory_query reads the real pgvector rows; the graph leg has nothing to add here.
    retrieve: async (input: never) => new (await import("./pgvector-store")).PgvectorMemoryStore().retrieve(input),
  },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "factupdate";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;
/** Races per run: a rule that lost one race in ten would pass thirty only 4% of the time. */
const RACES = 30;

const write = (actorId: string, name: string, content: string, baseVersion?: string): IngestInput => ({
  groupId: ORG,
  content,
  name,
  actorType: "agent",
  actorId,
  actorName: "MCP session",
  source: "mcp",
  origin: "mcp",
  scopePath: SCOPE,
  ...(baseVersion === undefined ? {} : { baseVersion }),
});

describe.skipIf(!QA_URL)("a write-back from a stale read never replaces a newer version", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let recordIngestApplied: (typeof import("./fact-change-event"))["recordIngestApplied"];
  let readMemoryVersion: (typeof import("./versions"))["readMemoryVersion"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let StaleBaseVersionError: (typeof import("./fact-update"))["StaleBaseVersionError"];
  let UnreadVersionError: (typeof import("./fact-reads"))["UnreadVersionError"];
  let unreadVersionError: (typeof import("./fact-reads"))["unreadVersionError"];
  let UnknownBaseVersionError: (typeof import("./fact-update"))["UnknownBaseVersionError"];
  let changeNotice: (typeof import("@/mcp/change-notices"))["changeNotice"];
  let recordConvention: (typeof import("./conventions"))["recordConvention"];
  let ConventionNotReplaceableError: (typeof import("./conventions"))["ConventionNotReplaceableError"];
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];

  type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
  /** The real MCP tool handlers, registered for `agentId` holding a write capability on SCOPE. */
  async function toolsFor(
    agentId: string,
  ): Promise<Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>> {
    const ctx = await contextFor(agentId);
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath: SCOPE });
    return tools;
  }
  const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
  const versionIn = (reply: ToolReply) => /Version: (\S+?)\./.exec(textOf(reply))?.[1];

  /** `agentId`'s access context, holding `permission` on `scopePath`. */
  async function contextFor(
    agentId: string,
    permission: "read" | "write" = "write",
    scopePath = SCOPE,
  ): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  /** Wait until writes made so far are outside the contention window of the next one. */
  const pastContentionWindow = () => new Promise((resolve) => setTimeout(resolve, 1_100));

  /** The id of the one stored version carrying `content`. */
  async function versionOf(content: string): Promise<string> {
    const row = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content }, select: { id: true } });
    return row.id;
  }

  /** Every `supersedes` edge in the org, as `from>to` strings. */
  async function supersedesEdges(): Promise<string[]> {
    const edges = await db.factEdge.findMany({
      where: { orgId: ORG, kind: "supersedes" },
      select: { fromId: true, toId: true },
    });
    return edges.map((edge) => `${edge.fromId}>${edge.toId}`);
  }

  /** What memory_query's vector leg serves for `scopePath`. */
  async function servedIn(scopePath: string): Promise<string[]> {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "When does the release train leave?",
      limit: 200,
      scopePath,
    });
    return facts.map((fact) => fact.fact);
  }
  const served = () => servedIn(SCOPE);

  /** Store one version the way a concurrent request path does: the row first, marked a version (and, for a
   * based write, with its base) in its own INSERT, then its announcement. */
  async function storeRow(
    id: string,
    actorId: string,
    name: string,
    content: string,
    storedAt: Date,
    baseVersion?: string,
  ): Promise<void> {
    await db.$executeRaw`
      INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath","factVersion","baseVersionId","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'mcp', 'agent', ${actorId}, ${name}, ${SCOPE}, true, ${baseVersion ?? null}, ${storedAt})
    `;
  }

  /** Record that `agentId` was served `versionId` whole at `readAt`. */
  async function recordRead(agentId: string, versionId: string, readAt: Date): Promise<void> {
    await db.$executeRaw`
      INSERT INTO "fact_version_reads" ("id","orgId","agentId","versionId","readAt")
      VALUES (${`read-${agentId}-${versionId}`}, ${ORG}, ${agentId}, ${versionId}, ${readAt})
    `;
  }

  /** How many `supersede` events the feed holds for `recordId`. */
  const supersedeEventsOn = (recordId: string) =>
    db.changeEvent.count({ where: { orgId: ORG, recordId, op: "supersede" } });

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ ingestMemory } = inngestModule);
    ({ recordIngestApplied } = await import("./fact-change-event"));
    ({ readMemoryVersion } = await import("./versions"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ StaleBaseVersionError, UnknownBaseVersionError } = await import("./fact-update"));
    ({ UnreadVersionError, unreadVersionError } = await import("./fact-reads"));
    ({ changeNotice } = await import("@/mcp/change-notices"));
    ({ recordConvention, ConventionNotReplaceableError } = await import("./conventions"));
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
    vi.mocked((await import("@/lib/inngest")).inngest.send).mockClear();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it(`keeps B's version current in ${RACES} races where A writes back from a stale read`, async () => {
    const reader = await contextFor("reader", "read");
    let lost = 0;
    let refused = 0;
    for (let race = 0; race < RACES; race++) {
      const name = `Release train ${race}`;
      const original = `Race ${race}: the release train leaves on Monday.`;
      const fromB = `Race ${race}: the release train leaves on Tuesday.`;
      const staleFromA = `Race ${race}: the release train leaves on Wednesday.`;
      await ingestMemory(write("seed", name, original));
      // A reads the original, and so does B.
      const read = await versionOf(original);
      await ingestMemory(write("writer-b", name, fromB, read));
      const bVersion = await versionOf(fromB);
      const writeBack = await ingestMemory(write("writer-a", name, staleFromA, read)).then(
        () => null,
        (e: unknown) => e,
      );
      if (writeBack instanceof StaleBaseVersionError && writeBack.currentVersionId === bVersion) refused++;

      const b = await readMemoryVersion(reader, bVersion);
      const answer = (await served()).filter((fact) => fact.startsWith(`Race ${race}:`));
      if (b?.status !== "current" || answer.length !== 1 || answer[0] !== fromB) lost++;
    }
    expect({ lost, refused }).toEqual({ lost: 0, refused: RACES });
  }, 60_000);

  it(`keeps B's version current in ${RACES} races where agents read and write back without baseVersion`, async () => {
    // What a client that never sends baseVersion does: read with memory_query, write with
    // memory_ingest. Each race gets its own scope so one race's facts cannot answer another's.
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const reader = await contextFor("reader", "read");
    let lost = 0;
    let told = 0;
    for (let race = 0; race < RACES; race++) {
      const scopePath = `${SCOPE}.r${race}`;
      await db.scope.create({ data: { orgId: ORG, path: scopePath, name: `r${race}` } });
      const ingest = (tools: typeof a, content: string) =>
        tools.get("memory_ingest")!({ name: "Release train", content, scopePath });
      const query = (tools: typeof a) =>
        tools.get("memory_query")!({ query: "When does the release train leave?", limit: 50, scopePath });

      await ingest(a, `Race ${race}: the release train leaves on Monday.`);
      await query(a);
      await query(b);
      const bVersion = versionIn(await ingest(b, `Race ${race}: the release train leaves on Tuesday.`))!;
      const back = await ingest(a, `Race ${race}: the release train leaves on Wednesday.`);
      // Inside the contention window the write-back is stored and loses to B's version;
      // after it, the write-back is refused. Either way A's reply names B's version.
      const answer = back.content[0]!.text;
      const refusedNamingB = back.isError === true && answer.startsWith("stale_version:") && answer.includes(bVersion);
      if (refusedNamingB || answer.startsWith(`Stored, but superseded by ${bVersion}`)) told++;

      const bRead = await readMemoryVersion(reader, bVersion);
      const served = await servedIn(scopePath);
      if (
        bRead?.status !== "current" ||
        !served.includes(`Race ${race}: the release train leaves on Tuesday.`) ||
        served.some((fact) => fact.includes("Wednesday"))
      )
        lost++;
    }
    expect({ lost, told }).toEqual({ lost: 0, told: RACES });
  }, 60_000);

  it("adds a version as before when the writer has neither read nor written the fact", async () => {
    const a = await toolsFor("writer-a");
    const c = await toolsFor("writer-c");
    await a.get("memory_ingest")!({
      name: "Release train",
      content: "The release train leaves on Monday.",
      scopePath: SCOPE,
    });

    const fromC = await c.get("memory_ingest")!({
      name: "Release train",
      content: "The release train is twelve cars long.",
      scopePath: SCOPE,
    });

    expect(fromC.isError).toBeUndefined();
    expect(versionIn(fromC)).toBeDefined();
  });

  it("accepts a write without a base once the writer has read the version it had missed", async () => {
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    await a.get("memory_ingest")!({
      name: "Release train",
      content: "The release train leaves on Monday.",
      scopePath: SCOPE,
    });
    await b.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    const fromB = versionIn(
      await b.get("memory_ingest")!({
        name: "Release train",
        content: "The release train leaves on Tuesday.",
        scopePath: SCOPE,
      }),
    )!;
    await pastContentionWindow();
    expect(
      (
        await a.get("memory_ingest")!({
          name: "Release train",
          content: "The release train leaves on Wednesday.",
          scopePath: SCOPE,
        })
      ).isError,
    ).toBe(true);
    expect(
      await db.memoryChunk.count({ where: { orgId: ORG, content: "The release train leaves on Wednesday." } }),
    ).toBe(0);

    await a.get("memory_version")!({ versionId: fromB });
    const informed = await a.get("memory_ingest")!({
      name: "Release train",
      content: "The release train leaves on Wednesday.",
      scopePath: SCOPE,
    });

    expect(informed.isError).toBeUndefined();
    const reader = await contextFor("reader", "read");
    expect((await readMemoryVersion(reader, fromB))?.status).toBe("current");
    expect((await readMemoryVersion(reader, versionIn(informed)!))?.status).toBe("current");
  });

  it("replays an identical retry of a write without a base, even after another writer wrote", async () => {
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const first = versionIn(
      await a.get("memory_ingest")!({
        name: "Release train",
        content: "The release train leaves on Monday.",
        scopePath: SCOPE,
      }),
    );
    await b.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    await b.get("memory_ingest")!({
      name: "Release train",
      content: "The release train leaves on Tuesday.",
      scopePath: SCOPE,
    });

    const retry = await a.get("memory_ingest")!({
      name: "Release train",
      content: "The release train leaves on Monday.",
      scopePath: SCOPE,
    });

    expect(retry.isError).toBeUndefined();
    expect(versionIn(retry)).toBe(first);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(2);
  });

  it("does not call a write made after reading a version a conflict with it, in either announcement order", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordRead("writer-b", "v-monday", new Date(t0.getTime() + 100));
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 200));

    await recordIngestApplied({ ...write("writer-b", "Release train", "Tuesday."), readsTracked: true }, "v-tuesday");
    await recordIngestApplied(write("seed", "Release train", "Monday."), "v-monday");

    expect(await supersedesEdges()).toEqual([]);
  });

  it("accepts a write after the writer's own later write, and refuses one after another writer's update", async () => {
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const ingest = (tools: typeof a, content: string) =>
      tools.get("memory_ingest")!({ name: "Release train", content, scopePath: SCOPE });
    await ingest(b, "The release train leaves on Monday.");
    await a.get("memory_query")!({ query: "release train", scopePath: SCOPE });

    // A's own notes about the fact, each written after the version A last read.
    expect((await ingest(a, "The release train has twelve cars.")).isError).toBeUndefined();
    expect((await ingest(a, "The release train stops at Lyon.")).isError).toBeUndefined();

    await b.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday."))!;
    await pastContentionWindow();
    const back = await ingest(a, "The release train leaves on Wednesday.");

    expect(back.isError).toBe(true);
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));
  });

  it("settles a write-back inside the contention window by the winner rule: stored, superseded by the update, and told", async () => {
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const ingest = (tools: typeof a, content: string) =>
      tools.get("memory_ingest")!({ name: "Release train", content, scopePath: SCOPE });
    await ingest(a, "The release train leaves on Monday.");
    await b.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday."))!;

    const back = await ingest(a, "The release train leaves on Wednesday.");

    expect(textOf(back)).toMatch(new RegExp(`^Stored, but superseded by ${fromB}`));
    const reader = await contextFor("reader", "read");
    expect((await readMemoryVersion(reader, fromB))?.status).toBe("current");
    expect((await readMemoryVersion(reader, versionIn(back)!))?.status).toBe("superseded");
  });

  it("keeps an update made after reading current when a third writer writes inside the window", async () => {
    const seed = await toolsFor("seed");
    const b = await toolsFor("writer-b");
    const c = await toolsFor("writer-c");
    const ingest = (tools: typeof b, content: string) =>
      tools.get("memory_ingest")!({ name: "Release train", content, scopePath: SCOPE });
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    await b.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday."))!;

    // C has read nothing and writes a note about the same entity within the same second.
    const fromC = await ingest(c, "The release train has twelve cars.");

    const reader = await contextFor("reader", "read");
    expect((await readMemoryVersion(reader, fromB))?.status).toBe("current");
    expect((await readMemoryVersion(reader, original))?.status).toBe("current");
    expect(textOf(fromC)).toMatch(new RegExp(`^Stored, but superseded by ${original}`));
  });

  it("accepts a write after the writer's own write that only the queued job stored", async () => {
    // A queued write's reply names no version, so nothing records it as served to its
    // writer; that the writer wrote it is what makes it seen.
    const now = Date.now();
    await storeRow("v-monday", "seed", "Release train", "The release train leaves on Monday.", new Date(now - 10_000));
    await recordIngestApplied(write("seed", "Release train", "The release train leaves on Monday."), "v-monday");
    const a = await toolsFor("writer-a");
    await a.get("memory_version")!({ versionId: "v-monday" });
    await storeRow(
      "v-queued",
      "writer-a",
      "Release train",
      "The release train has twelve cars.",
      new Date(now - 5_000),
    );
    await recordIngestApplied(
      { ...write("writer-a", "Release train", "The release train has twelve cars."), readsTracked: true },
      "v-queued",
    );

    const next = await a.get("memory_ingest")!({
      name: "Release train",
      content: "The release train stops at Lyon.",
      scopePath: SCOPE,
    });

    expect(textOf(next)).not.toMatch(/stale_version/);
    expect(versionIn(next)).toBeDefined();
  });

  it("decides nothing again for a version superseded before its own late announcement", async () => {
    // P's version is stored, but its announcement fails on the request path and the queued
    // job announces it later. Meanwhile B reads it and replaces it, and E reads B's version
    // and writes beside it. P's late announcement must not make P's superseded version the
    // winner over E's.
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-p", "writer-p", "Release train", "Monday.", t0);
    await recordRead("writer-b", "v-p", new Date(t0.getTime() + 100));
    await storeRow("v-b", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 200));
    await recordIngestApplied(write("writer-b", "Release train", "Tuesday.", "v-p"), "v-b");
    await recordRead("writer-e", "v-b", new Date(t0.getTime() + 300));
    await storeRow("v-e", "writer-e", "Release train", "Thursday.", new Date(t0.getTime() + 400));
    await recordIngestApplied({ ...write("writer-e", "Release train", "Thursday."), readsTracked: true }, "v-e");

    await recordIngestApplied({ ...write("writer-p", "Release train", "Monday."), readsTracked: true }, "v-p");

    expect(await supersedesEdges()).toEqual(["v-b>v-p"]);
    const reader = await contextFor("reader", "read");
    expect((await readMemoryVersion(reader, "v-e"))?.status).toBe("current");
    expect((await readMemoryVersion(reader, "v-b"))?.status).toBe("current");
  });

  it("stores a write without a base that raced a version its writer had not read as superseded, and says so", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordIngestApplied(write("seed", "Release train", "Monday."), "v-monday");
    await recordRead("writer-a", "v-monday", new Date(t0.getTime() + 100));
    await recordRead("writer-b", "v-monday", new Date(t0.getTime() + 100));
    // B's version is stored first, A's announcement runs first, and they are further apart
    // than the contention window, so only what A had read decides.
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 3000));
    await storeRow("v-wednesday", "writer-a", "Release train", "Wednesday.", new Date(t0.getTime() + 5000));

    const fromA = await recordIngestApplied(
      { ...write("writer-a", "Release train", "Wednesday."), readsTracked: true },
      "v-wednesday",
    );
    await recordIngestApplied({ ...write("writer-b", "Release train", "Tuesday."), readsTracked: true }, "v-tuesday");

    expect(fromA).toEqual({ supersededBy: "v-tuesday", cause: "stale-read" });
    expect(await supersedesEdges()).toEqual(["v-tuesday>v-wednesday"]);
    const notice = await changeNotice(await contextFor("writer-a"), SCOPE);
    expect(notice).toContain("supersede fact v-wednesday by writer-b");
  });

  it("contends a write with a version its writer read only after storing it", async () => {
    // A queued write is announced after it is stored; a read its writer makes in between
    // says nothing about what the write was based on.
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 200));
    await recordRead("writer-b", "v-monday", new Date(t0.getTime() + 500));

    const fromB = await recordIngestApplied(
      { ...write("writer-b", "Release train", "Tuesday."), readsTracked: true },
      "v-tuesday",
    );

    expect(fromB).toEqual({ supersededBy: "v-monday", cause: "conflict" });
    expect(await supersedesEdges()).toEqual(["v-monday>v-tuesday"]);
  });

  it("refuses a stale write under the lock even when its writer read the newer version after storing it", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordRead("writer-a", "v-monday", new Date(t0.getTime() + 100));
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 3000));
    await storeRow("v-wednesday", "writer-a", "Release train", "Wednesday.", new Date(t0.getTime() + 5000));
    // Between storing A's write and announcing it, A reads B's version.
    await recordRead("writer-a", "v-tuesday", new Date(t0.getTime() + 6000));

    const fromA = await recordIngestApplied(
      { ...write("writer-a", "Release train", "Wednesday."), readsTracked: true },
      "v-wednesday",
    );

    expect(fromA).toEqual({ supersededBy: "v-tuesday", cause: "stale-read" });
    expect(await supersedesEdges()).toEqual(["v-tuesday>v-wednesday"]);
  });

  it("counts a version with no recorded writer as another writer's when checking a stale write", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordRead("writer-a", "v-monday", new Date(t0.getTime() + 100));
    await db.$executeRaw`
      INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath","factVersion","createdAt")
      VALUES ('v-imported', ${ORG}, 'Tuesday.', 'import', 'agent', NULL, 'Release train', ${SCOPE}, true, ${new Date(t0.getTime() + 3000)})
    `;
    await storeRow("v-wednesday", "writer-a", "Release train", "Wednesday.", new Date(t0.getTime() + 5000));

    const fromA = await recordIngestApplied(
      { ...write("writer-a", "Release train", "Wednesday."), readsTracked: true },
      "v-wednesday",
    );

    expect(fromA).toEqual({ supersededBy: "v-imported", cause: "stale-read" });
  });

  it("leaves a based write current when its announcement is replayed, and announces the replacement once", async () => {
    // The queued job's announcing step, retried after its transaction committed.
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordIngestApplied(write("seed", "Release train", "Monday."), "v-monday");
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 3000));

    const first = await recordIngestApplied(write("writer-b", "Release train", "Tuesday.", "v-monday"), "v-tuesday");
    const replay = await recordIngestApplied(write("writer-b", "Release train", "Tuesday.", "v-monday"), "v-tuesday");

    expect([first, replay]).toEqual([{ supersededBy: null }, { supersededBy: null }]);
    expect(await supersedesEdges()).toEqual(["v-tuesday>v-monday"]);
    expect((await readMemoryVersion(await contextFor("reader", "read"), "v-tuesday"))?.status).toBe("current");
    expect(await supersedeEventsOn("v-monday")).toBe(1);
    expect(await supersedeEventsOn("v-tuesday")).toBe(0);
  });

  it("tells a stale writer once when the announcement of its write is replayed", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordRead("writer-a", "v-monday", new Date(t0.getTime() + 100));
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 3000));
    await storeRow("v-wednesday", "writer-a", "Release train", "Wednesday.", new Date(t0.getTime() + 5000));

    const announce = () =>
      recordIngestApplied({ ...write("writer-a", "Release train", "Wednesday."), readsTracked: true }, "v-wednesday");
    const first = await announce();
    const replay = await announce();

    expect([first, replay]).toEqual([
      { supersededBy: "v-tuesday", cause: "stale-read" },
      { supersededBy: "v-tuesday", cause: "stale-read" },
    ]);
    expect(await supersedesEdges()).toEqual(["v-tuesday>v-wednesday"]);
    expect(await supersedeEventsOn("v-wednesday")).toBe(1);
  });

  it("counts the other writer's version an identical write was answered with as read by the writer", async () => {
    // B's version and A's write carry the same text, so A's write stores nothing and its
    // reply names B's version: A has seen that version whole, by sending it.
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const ingest = (tools: typeof a, content: string) =>
      tools.get("memory_ingest")!({ name: "Release train", content, scopePath: SCOPE });
    await ingest(b, "The release train leaves on Monday.");
    await a.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    await b.get("memory_query")!({ query: "release train", scopePath: SCOPE });
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday."))!;
    await pastContentionWindow();

    const same = await ingest(a, "The release train leaves on Tuesday.");
    const next = await ingest(a, "The release train has twelve cars.");

    expect(versionIn(same)).toBe(fromB);
    expect(textOf(next)).not.toMatch(/stale_version/);
    expect(versionIn(next)).toBeDefined();
  });

  it("runs the race through the MCP tools: A's stale write-back is refused naming B's version", async () => {
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const ingest = (tools: typeof a, content: string, baseVersion?: string) =>
      tools.get("memory_ingest")!({
        name: "Release train",
        content,
        scopePath: SCOPE,
        ...(baseVersion ? { baseVersion } : {}),
      });

    const seeded = await ingest(a, "The release train leaves on Monday.");
    const read = versionIn(seeded)!;
    expect(textOf(await a.get("memory_version")!({ versionId: read }))).toContain(`fact ${read} (current)`);
    const fromB = versionIn(await ingest(b, "The release train leaves on Tuesday.", read))!;
    const back = await ingest(a, "The release train leaves on Wednesday.", read);

    expect(back.isError).toBe(true);
    expect(back.content[0]!.text).toMatch(
      new RegExp(
        `^stale_version: baseVersion ${read} does not match the current version of "Release train" in ${SCOPE.replace(".", "\\.")}: the fact it is a version of is now ${fromB}\\.`,
      ),
    );
    // The same reply tells A what changed since its read, before it tries again.
    expect(textOf(back)).toContain(`supersede fact ${read} by writer-b`);
    expect(textOf(await b.get("memory_version")!({ versionId: fromB }))).toContain(`fact ${fromB} (current)`);
    const refusedBase = await ingest(a, "The release train leaves on Friday.", "no-such-version");
    expect(refusedBase.content[0]!.text).toMatch(/^unknown_version: /);
  });

  it("stores nothing for a write-back refused before it was stored", async () => {
    await ingestMemory(write("seed", "Release train", "The release train leaves on Monday."));
    const read = await versionOf("The release train leaves on Monday.");
    await ingestMemory(write("writer-b", "Release train", "The release train leaves on Tuesday.", read));
    vi.mocked((await import("@/lib/inngest")).inngest.send).mockClear();

    const error = await ingestMemory(
      write("writer-a", "Release train", "The release train leaves on Wednesday.", read),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StaleBaseVersionError);
    expect((error as Error).message).toContain(await versionOf("The release train leaves on Tuesday."));
    expect((error as Error).message).toMatch(/memory_version/);
    expect(
      await db.memoryChunk.count({ where: { orgId: ORG, content: "The release train leaves on Wednesday." } }),
    ).toBe(0);
    expect((await import("@/lib/inngest")).inngest.send).not.toHaveBeenCalled();
  });

  it("makes a based write replace the version it read, even inside the contention window", async () => {
    await ingestMemory(write("seed", "Release train", "The release train leaves on Monday."));
    const original = await versionOf("The release train leaves on Monday.");

    const ack = await ingestMemory(
      write("writer-b", "Release train", "The release train leaves on Tuesday.", original),
    );
    const update = await versionOf("The release train leaves on Tuesday.");

    expect(ack.versionId).toBe(update);
    expect(await supersedesEdges()).toEqual([`${update}>${original}`]);
    expect(await served()).toEqual(["The release train leaves on Tuesday."]);
  });

  it("tells A, on its next call, that the version it read was replaced", async () => {
    const a = await contextFor("writer-a");
    await ingestMemory(write("seed", "Release train", "The release train leaves on Monday."));
    const original = await versionOf("The release train leaves on Monday.");
    await changeNotice(a, SCOPE);

    await ingestMemory(write("writer-b", "Release train", "The release train leaves on Tuesday.", original));

    const notice = await changeNotice(a, SCOPE);
    expect(notice).toContain(`supersede fact ${original} by writer-b`);
    expect(notice).toContain(`replaced by ${await versionOf("The release train leaves on Tuesday.")}`);
  });

  it("replays an identical retry of a based write instead of refusing it", async () => {
    await ingestMemory(write("seed", "Release train", "The release train leaves on Monday."));
    const original = await versionOf("The release train leaves on Monday.");
    const first = await ingestMemory(
      write("writer-b", "Release train", "The release train leaves on Tuesday.", original),
    );

    const retry = await ingestMemory(
      write("writer-b", "Release train", "The release train leaves on Tuesday.", original),
    );

    expect(retry.versionId).toBe(first.versionId);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(2);
  });

  it("stores a based write whose text matches an older, replaced version as a new current version", async () => {
    await ingestMemory(write("seed", "Release train", "The release train leaves on Monday."));
    const monday = await versionOf("The release train leaves on Monday.");
    const tuesdayAck = await ingestMemory(
      write("writer-b", "Release train", "The release train leaves on Tuesday.", monday),
    );

    // A read Tuesday, the current version, and deliberately puts Monday back.
    const revert = await ingestMemory(
      write("writer-a", "Release train", "The release train leaves on Monday.", tuesdayAck.versionId),
    );

    expect(revert.versionId).not.toBe(monday);
    expect(await served()).toEqual(["The release train leaves on Monday."]);
    expect((await readMemoryVersion(await contextFor("reader", "read"), revert.versionId!))?.status).toBe("current");
  });

  it("refuses a base that is not a version of this fact, storing nothing", async () => {
    await ingestMemory(write("seed", "Freeze window", "The freeze starts Friday."));
    const otherFact = await versionOf("The freeze starts Friday.");

    const error = await ingestMemory(
      write("writer-a", "Release train", "The release train leaves on Monday.", otherFact),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnknownBaseVersionError);
    expect(await db.memoryChunk.count({ where: { orgId: ORG, entityName: "Release train" } })).toBe(0);
  });

  it("stores a stale write that slipped past the check as superseded by the newer version, and says so", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordIngestApplied(write("seed", "Release train", "Monday."), "v-monday");
    // B and A both read Monday; B's version is stored first, and A's announcement runs first.
    await storeRow("v-tuesday", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 3000), "v-monday");
    await storeRow("v-wednesday", "writer-a", "Release train", "Wednesday.", new Date(t0.getTime() + 3010), "v-monday");

    const fromA = await recordIngestApplied(
      write("writer-a", "Release train", "Wednesday.", "v-monday"),
      "v-wednesday",
    );
    const fromB = await recordIngestApplied(write("writer-b", "Release train", "Tuesday.", "v-monday"), "v-tuesday");

    expect(fromA).toEqual({ supersededBy: "v-tuesday", cause: "stale-read" });
    expect(fromB).toEqual({ supersededBy: null });
    expect((await supersedesEdges()).sort()).toEqual(["v-tuesday>v-monday", "v-tuesday>v-wednesday"]);
    const notice = await changeNotice(await contextFor("writer-a"), SCOPE);
    expect(notice).toContain("supersede fact v-wednesday by writer-b");
  });

  it("never records a cycle when a based write races an unbased write to the same fact", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordIngestApplied(write("seed", "Release train", "Monday."), "v-monday");
    await storeRow("v-based", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 200), "v-monday");
    await storeRow("v-unbased", "writer-c", "Release train", "Thursday.", new Date(t0.getTime() + 210));

    // Every announcement order: the based write first, then the unbased one, and the reverse.
    await recordIngestApplied(write("writer-b", "Release train", "Tuesday.", "v-monday"), "v-based");
    await recordIngestApplied(write("writer-c", "Release train", "Thursday."), "v-unbased");

    const edges = await supersedesEdges();
    for (const edge of edges) {
      const [from, to] = edge.split(">");
      expect(edges).not.toContain(`${to}>${from}`);
    }
    const reader = await contextFor("reader", "read");
    const statuses = await Promise.all(["v-monday", "v-based", "v-unbased"].map((id) => readMemoryVersion(reader, id)));
    expect(statuses.filter((v) => v?.status === "current")).toHaveLength(1);
  });

  it("never records a cycle when the unbased write is announced before the based one", async () => {
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    await storeRow("v-monday", "seed", "Release train", "Monday.", t0);
    await recordIngestApplied(write("seed", "Release train", "Monday."), "v-monday");
    await storeRow("v-based", "writer-b", "Release train", "Tuesday.", new Date(t0.getTime() + 200), "v-monday");
    await storeRow("v-unbased", "writer-c", "Release train", "Thursday.", new Date(t0.getTime() + 210));

    await recordIngestApplied(write("writer-c", "Release train", "Thursday."), "v-unbased");
    const fromB = await recordIngestApplied(write("writer-b", "Release train", "Tuesday.", "v-monday"), "v-based");

    const edges = await supersedesEdges();
    for (const edge of edges) {
      const [from, to] = edge.split(">");
      expect(edges).not.toContain(`${to}>${from}`);
    }
    const reader = await contextFor("reader", "read");
    const statuses = await Promise.all(["v-monday", "v-based", "v-unbased"].map((id) => readMemoryVersion(reader, id)));
    expect(statuses.filter((v) => v?.status === "current")).toHaveLength(1);
    // B is told whenever its version is not the current one.
    if (statuses[1]?.status !== "current") expect(fromB.supersededBy).not.toBeNull();
  });

  it("follows a replacement lineage of any length to its current version", async () => {
    const { currentVersionReplacing } = await import("./fact-update");
    const t0 = new Date("2026-10-06T12:00:00.000Z");
    const lineage = Array.from({ length: 60 }, (_, i) => `v-${String(i).padStart(2, "0")}`);
    for (const [i, id] of lineage.entries())
      await storeRow(id, "seed", "Release train", `Version ${i}.`, new Date(t0.getTime() + i * 2000));
    await db.factEdge.createMany({
      data: lineage.slice(1).map((id, i) => ({
        orgId: ORG,
        fromId: id,
        toId: lineage[i]!,
        kind: "supersedes",
        scopePath: SCOPE,
        actorType: "agent",
        actorId: "seed",
      })),
    });

    expect(await currentVersionReplacing(db, ORG, lineage[0]!)).toBe(lineage.at(-1));
  });

  it("refuses a rule replacement made from a stale read, keeps B's rule served, and points at it", async () => {
    const seed = await contextFor("seed");
    const b = await contextFor("writer-b");
    const a = await contextFor("writer-a");
    const original = await recordConvention(seed, {
      kind: "convention",
      subject: "Dedupe",
      text: "by email",
      scopePath: SCOPE,
    });

    const fromB = await recordConvention(b, {
      kind: "convention",
      subject: "Dedupe",
      text: "by domain",
      scopePath: SCOPE,
      supersedes: original,
    });
    const error = await recordConvention(a, {
      kind: "convention",
      subject: "Dedupe",
      text: "by name",
      scopePath: SCOPE,
      supersedes: original,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConventionNotReplaceableError);
    // The refusal reads alike for every rule that cannot be replaced, so an id cannot probe
    // what exists; the way to the current version is memory_version, which checks access.
    expect((error as Error).message).toMatch(/memory_version on the id you passed/);
    expect((await readMemoryVersion(a, original))?.supersededById).toBe(fromB);
    const served = await db.convention.findMany({
      where: { orgId: ORG, replacedBy: null, supersededById: null, retiredAt: null },
      select: { id: true },
    });
    expect(served.map((rule) => rule.id)).toEqual([fromB]);
    expect(await db.convention.count({ where: { orgId: ORG, text: "by name" } })).toBe(0);
  });

  // An entity name holds many facts: memory_ingest's `name` is the entity a write is about,
  // and save_memory, contacts and accounts all write several facts under one name. A base
  // is stale only when its own fact moved on, never because another fact about the entity
  // is newer (item basever-names-entity-not-fact-20261019).
  describe("a base is judged against its own fact, not every fact about the entity", () => {
    const ENTITY = "Acme Corp";
    const renewal = "Acme renews its contract in March.";
    const cto = "Acme's CTO is Dana Reyes.";

    it("accepts a write based on an older fact about the entity, and leaves the newer, unrelated fact current", async () => {
      await ingestMemory(write("seed", ENTITY, renewal));
      const renewalV1 = await versionOf(renewal);
      // Another fact about Acme, stored later by another writer, outside the contention window.
      await pastContentionWindow();
      await ingestMemory(write("writer-b", ENTITY, cto));
      const ctoVersion = await versionOf(cto);

      const ack = await ingestMemory(write("writer-a", ENTITY, "Acme renews its contract in April.", renewalV1));

      expect(await supersedesEdges()).toEqual([`${ack.versionId}>${renewalV1}`]);
      const reader = await contextFor("reader", "read");
      expect((await readMemoryVersion(reader, ctoVersion))?.status).toBe("current");
      expect((await readMemoryVersion(reader, ack.versionId!))?.status).toBe("current");
      expect((await served()).sort()).toEqual([cto, "Acme renews its contract in April."].sort());
    });

    it("still refuses a truly stale base, naming its own fact's current version, not a newer unrelated fact", async () => {
      await ingestMemory(write("seed", ENTITY, renewal));
      const renewalV1 = await versionOf(renewal);
      const v2 = await ingestMemory(write("writer-b", ENTITY, "Acme renews its contract in May.", renewalV1));
      await pastContentionWindow();
      // The newest version under the name is now another fact.
      await ingestMemory(write("writer-c", ENTITY, cto));
      const ctoVersion = await versionOf(cto);

      const error = await ingestMemory(write("writer-a", ENTITY, "Acme renews its contract in June.", renewalV1)).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(StaleBaseVersionError);
      expect((error as InstanceType<typeof StaleBaseVersionError>).currentVersionId).toBe(v2.versionId);
      expect((error as Error).message).toContain(v2.versionId!);
      expect((error as Error).message).not.toContain(ctoVersion);
      expect(await db.memoryChunk.count({ where: { orgId: ORG, content: "Acme renews its contract in June." } })).toBe(
        0,
      );
    });

    it("never retires an unrelated fact when the writer follows the refusal's advice", async () => {
      await ingestMemory(write("seed", ENTITY, renewal));
      const renewalV1 = await versionOf(renewal);
      const v2 = await ingestMemory(write("writer-b", ENTITY, "Acme renews its contract in May.", renewalV1));
      await pastContentionWindow();
      await ingestMemory(write("writer-c", ENTITY, cto));
      const ctoVersion = await versionOf(cto);

      const error = (await ingestMemory(
        write("writer-a", ENTITY, "Acme renews its contract in June.", renewalV1),
      ).catch((e: unknown) => e)) as InstanceType<typeof StaleBaseVersionError>;
      // What the refusal tells the writer to do: read the version it names, write again on it.
      const retry = await ingestMemory(
        write("writer-a", ENTITY, "Acme renews its contract in June.", error.currentVersionId),
      );

      const reader = await contextFor("reader", "read");
      expect((await readMemoryVersion(reader, ctoVersion))?.status).toBe("current");
      expect((await readMemoryVersion(reader, v2.versionId!))?.supersededById).toBe(retry.versionId);
      expect(await supersedesEdges()).not.toContainEqual(expect.stringMatching(new RegExp(`>${ctoVersion}$`)));
      expect((await served()).sort()).toEqual([cto, "Acme renews its contract in June."].sort());
    });

    it("refuses through the MCP tool naming the fact's own current version, and the advised retry keeps the other fact", async () => {
      const a = await toolsFor("writer-a");
      const b = await toolsFor("writer-b");
      const ingest = (tools: typeof a, content: string, baseVersion?: string) =>
        tools.get("memory_ingest")!({ name: ENTITY, content, ...(baseVersion ? { baseVersion } : {}) });
      const renewalV1 = versionIn(await ingest(a, renewal))!;
      const v2 = versionIn(await ingest(b, "Acme renews its contract in May.", renewalV1))!;
      await pastContentionWindow();
      const ctoVersion = versionIn(await ingest(b, cto))!;

      const refused = await ingest(a, "Acme renews its contract in June.", renewalV1);
      // The refusal itself; the change notice after it may list the other fact as news.
      const refusal = refused.content[0]!.text;
      expect(refused.isError).toBe(true);
      expect(refusal).toMatch(/^stale_version:/);
      expect(refusal).toContain(v2);
      expect(refusal).not.toContain(ctoVersion);

      await a.get("memory_version")!({ versionId: v2 });
      const retry = await ingest(a, "Acme renews its contract in June.", v2);
      expect(retry.isError).toBeFalsy();
      const reader = await contextFor("reader", "read");
      expect((await readMemoryVersion(reader, ctoVersion))?.status).toBe("current");
    });

    it("lets a based write that raced another fact's unannounced row replace its base, in either announcement order", async () => {
      const t0 = new Date("2026-10-06T12:00:00.000Z");
      await storeRow("v-renewal", "seed", ENTITY, renewal, t0);
      await recordIngestApplied(write("seed", ENTITY, renewal), "v-renewal");
      // Another fact about Acme is stored, then a write based on the renewal, before either is
      // announced; outside each other's contention window, where the winner rule would decide.
      await storeRow("v-cto", "writer-c", ENTITY, cto, new Date(t0.getTime() + 3000));
      await storeRow("v-april", "writer-a", ENTITY, "April.", new Date(t0.getTime() + 4500), "v-renewal");

      const fromA = await recordIngestApplied(write("writer-a", ENTITY, "April.", "v-renewal"), "v-april");
      await recordIngestApplied(write("writer-c", ENTITY, cto), "v-cto");

      expect(fromA).toEqual({ supersededBy: null });
      expect(await supersedesEdges()).toEqual(["v-april>v-renewal"]);
      const reader = await contextFor("reader", "read");
      expect((await readMemoryVersion(reader, "v-cto"))?.status).toBe("current");
      expect((await readMemoryVersion(reader, "v-april"))?.status).toBe("current");
    });

    it("still lets the write stored first win when two writes based on one version race, beside another fact", async () => {
      const t0 = new Date("2026-10-06T12:00:00.000Z");
      await storeRow("v-renewal", "seed", ENTITY, renewal, t0);
      await recordIngestApplied(write("seed", ENTITY, renewal), "v-renewal");
      await storeRow("v-may", "writer-b", ENTITY, "May.", new Date(t0.getTime() + 3000), "v-renewal");
      // Another fact about Acme between the two, outside either's contention window.
      await storeRow("v-cto", "writer-c", ENTITY, cto, new Date(t0.getTime() + 4500));
      await storeRow("v-june", "writer-a", ENTITY, "June.", new Date(t0.getTime() + 6000), "v-renewal");

      const fromA = await recordIngestApplied(write("writer-a", ENTITY, "June.", "v-renewal"), "v-june");
      const fromB = await recordIngestApplied(write("writer-b", ENTITY, "May.", "v-renewal"), "v-may");
      await recordIngestApplied(write("writer-c", ENTITY, cto), "v-cto");

      expect(fromA).toEqual({ supersededBy: "v-may", cause: "stale-read" });
      expect(fromB).toEqual({ supersededBy: null });
      expect((await supersedesEdges()).sort()).toEqual(["v-may>v-june", "v-may>v-renewal"]);
      expect((await readMemoryVersion(await contextFor("reader", "read"), "v-cto"))?.status).toBe("current");
    });

    // The tests above write rows by hand with their base. This one stores them through the real
    // store, so it fails if ingestOnce stops recording the base on the row it marks a version.
    it("records the base in the real store's INSERT, so the write stored first wins when the later one is announced first", async () => {
      await ingestMemory(write("seed", ENTITY, renewal));
      const renewalV1 = await versionOf(renewal);
      const store = new PgvectorMemoryStore();
      const may = write("writer-b", ENTITY, "Acme renews its contract in May.", renewalV1);
      const june = write("writer-a", ENTITY, "Acme renews its contract in June.", renewalV1);
      const { episodeId: mayId } = await store.ingestOnce(may);
      const { episodeId: juneId } = await store.ingestOnce(june);

      const fromJune = await recordIngestApplied(june, juneId);
      const fromMay = await recordIngestApplied(may, mayId);

      expect(fromJune).toEqual({ supersededBy: mayId, cause: "stale-read" });
      expect(fromMay).toEqual({ supersededBy: null });
      expect((await supersedesEdges()).sort()).toEqual([`${mayId}>${juneId}`, `${mayId}>${renewalV1}`].sort());
    });

    // The test above failed about half the time:
    // its two writes were often stored in one millisecond, and "stored first" was decided by
    // (createdAt, id) with random ids, so the write stored second won whenever its id sorted
    // first. These three pin that case: the same millisecond, and the later row's id sorting
    // first, so ordering by the clock and then the id gets every one of them wrong.
    describe("a tie on the clock never decides which version was stored first", () => {
      const t0 = new Date("2026-10-06T12:00:00.000Z");

      it("lets the write stored first win when two writes based on one version are stored in the same millisecond", async () => {
        await storeRow("v-renewal", "seed", ENTITY, renewal, t0);
        await recordIngestApplied(write("seed", ENTITY, renewal), "v-renewal");
        const sameMillisecond = new Date(t0.getTime() + 3000);
        await storeRow("v-may", "writer-b", ENTITY, "May.", sameMillisecond, "v-renewal");
        // Stored second, with an id that sorts before the first one's.
        await storeRow("v-a-june", "writer-a", ENTITY, "June.", sameMillisecond, "v-renewal");

        const fromJune = await recordIngestApplied(write("writer-a", ENTITY, "June.", "v-renewal"), "v-a-june");
        const fromMay = await recordIngestApplied(write("writer-b", ENTITY, "May.", "v-renewal"), "v-may");

        expect(fromJune).toEqual({ supersededBy: "v-may", cause: "stale-read" });
        expect(fromMay).toEqual({ supersededBy: null });
        expect((await supersedesEdges()).sort()).toEqual(["v-may>v-a-june", "v-may>v-renewal"]);
      });

      it("counts a write based on a version as stored after it, even in the version's own millisecond", async () => {
        await storeRow("v-renewal", "seed", ENTITY, renewal, t0);
        await recordIngestApplied(write("seed", ENTITY, renewal), "v-renewal");
        // Stored after its base, in the base's millisecond, with an id that sorts before the base's.
        await storeRow("v-a-may", "writer-b", ENTITY, "May.", t0, "v-renewal");
        await storeRow("v-june", "writer-a", ENTITY, "June.", new Date(t0.getTime() + 3000), "v-renewal");

        const fromJune = await recordIngestApplied(write("writer-a", ENTITY, "June.", "v-renewal"), "v-june");
        const fromMay = await recordIngestApplied(write("writer-b", ENTITY, "May.", "v-renewal"), "v-a-may");

        expect(fromJune).toEqual({ supersededBy: "v-a-may", cause: "stale-read" });
        expect(fromMay).toEqual({ supersededBy: null });
        expect((await supersedesEdges()).sort()).toEqual(["v-a-may>v-june", "v-a-may>v-renewal"]);
      });

      it("lets the version stored first win a conflict between two writes without a base in the same millisecond", async () => {
        await storeRow("v-may", "writer-b", ENTITY, "May.", t0);
        await storeRow("v-a-june", "writer-a", ENTITY, "June.", t0);

        await recordIngestApplied(write("writer-a", ENTITY, "June."), "v-a-june");
        await recordIngestApplied(write("writer-b", ENTITY, "May."), "v-may");

        expect(await supersedesEdges()).toEqual(["v-may>v-a-june"]);
        const reader = await contextFor("reader", "read");
        expect((await readMemoryVersion(reader, "v-may"))?.status).toBe("current");
        expect((await readMemoryVersion(reader, "v-a-june"))?.supersededById).toBe("v-may");
      });

      it("refuses a write without a base whose writer never read the version stored after its last read, in that read's millisecond", async () => {
        await storeRow("v-renewal", "seed", ENTITY, renewal, t0);
        await recordRead("writer-a", "v-renewal", new Date(t0.getTime() + 100));
        // Stored after the version A read, in its millisecond, with an id that sorts before it.
        await storeRow("v-a-may", "writer-b", ENTITY, "May.", t0);
        await storeRow("v-june", "writer-a", ENTITY, "June.", new Date(t0.getTime() + 5000));

        const fromA = await recordIngestApplied(
          { ...write("writer-a", ENTITY, "June."), readsTracked: true },
          "v-june",
        );

        expect(fromA).toEqual({ supersededBy: "v-a-may", cause: "stale-read" });
        expect(await supersedesEdges()).toEqual(["v-a-may>v-june"]);
      });
    });
  });

  // The same defect on the unbased path: a write without a base, refused because its writer
  // has not read a newer version under the name, was advised to pass that version as its
  // baseVersion. That version is only the newest row under the entity name, so following the
  // advice retired whatever unrelated fact about the entity was stored last
  // (item unread-version-advice-names-fact-20261019).
  describe("an unbased write's refusal advises a base of the writer's own fact, or none", () => {
    const ENTITY = "Acme Corp";
    const renewal = "Acme renews its contract in March.";
    const cto = "Acme's CTO is Dana Reyes.";
    const tracked = (actorId: string, content: string, baseVersion?: string): IngestInput => ({
      ...write(actorId, ENTITY, content, baseVersion),
      readsTracked: true,
    });
    const writerA = {
      orgId: ORG,
      agentId: "writer-a",
      entityName: ENTITY,
      storedScopePath: SCOPE,
      eventScopePath: SCOPE,
    };
    type Unread = InstanceType<typeof UnreadVersionError>;

    it("names no base when the only unread version is another fact about the entity", async () => {
      const renewalV1 = (await ingestMemory(tracked("writer-a", renewal))).versionId!;
      await pastContentionWindow();
      const ctoVersion = (await ingestMemory(tracked("writer-b", cto))).versionId!;
      await pastContentionWindow();

      const error = (await ingestMemory(tracked("writer-a", "Acme renews its contract in April.")).catch(
        (e: unknown) => e,
      )) as Unread;

      expect(error).toBeInstanceOf(UnreadVersionError);
      // Still refused and told which version it has not read.
      expect(error.unreadVersionId).toBe(ctoVersion);
      expect(error.lastReadVersionId).toBe(renewalV1);
      expect(error.replaceVersionId).toBeUndefined();
      expect(error.message).not.toContain(`baseVersion ${ctoVersion}`);
      expect(error.message).toContain("no baseVersion is named");
      expect(await db.memoryChunk.count({ where: { orgId: ORG, content: "Acme renews its contract in April." } })).toBe(
        0,
      );
    });

    it("names the current version of the fact the writer read, and following it never retires the newer unrelated fact", async () => {
      const renewalV1 = (await ingestMemory(tracked("writer-a", renewal))).versionId!;
      const v2 = (await ingestMemory(tracked("writer-b", "Acme renews its contract in May.", renewalV1))).versionId!;
      await pastContentionWindow();
      // The newest row under the name is now another fact.
      const ctoVersion = (await ingestMemory(tracked("writer-c", cto))).versionId!;
      await pastContentionWindow();

      const error = (await ingestMemory(tracked("writer-a", "Acme renews its contract in June.")).catch(
        (e: unknown) => e,
      )) as Unread;

      expect(error).toBeInstanceOf(UnreadVersionError);
      expect(error.unreadVersionId).toBe(ctoVersion);
      expect(error.replaceVersionId).toBe(v2);
      expect(error.message).toContain(`pass baseVersion ${v2}`);
      expect(error.message).not.toContain(`baseVersion ${ctoVersion}`);

      // What the refusal tells the writer to do: write again on the base it names.
      const retry = await ingestMemory(
        tracked("writer-a", "Acme renews its contract in June.", error.replaceVersionId),
      );
      const reader = await contextFor("reader", "read");
      expect((await readMemoryVersion(reader, ctoVersion))?.status).toBe("current");
      expect((await readMemoryVersion(reader, v2))?.supersededById).toBe(retry.versionId);
      expect(await supersedesEdges()).not.toContainEqual(expect.stringMatching(new RegExp(`>${ctoVersion}$`)));
      expect((await served()).sort()).toEqual([cto, "Acme renews its contract in June."].sort());
    });

    it("still names the unread version as the base when it is the newer version of the fact the writer read", async () => {
      const renewalV1 = (await ingestMemory(tracked("writer-a", renewal))).versionId!;
      const v2 = (await ingestMemory(tracked("writer-b", "Acme renews its contract in May.", renewalV1))).versionId!;
      await pastContentionWindow();

      const error = (await ingestMemory(tracked("writer-a", "Acme renews its contract in June.")).catch(
        (e: unknown) => e,
      )) as Unread;

      expect(error).toBeInstanceOf(UnreadVersionError);
      expect(error.unreadVersionId).toBe(v2);
      expect(error.replaceVersionId).toBe(v2);
      expect(error.message).toContain(
        `it is the current version of ${renewalV1}'s fact; to replace it, pass baseVersion ${v2}.`,
      );
    });

    it("names no base for a stored write superseded by another fact it raced", async () => {
      const t0 = new Date("2026-10-06T12:00:00.000Z");
      await storeRow("v-renewal", "writer-a", ENTITY, renewal, t0);
      await recordIngestApplied(tracked("writer-a", renewal), "v-renewal");
      // Another fact about Acme, then A's unbased write, stored before either is announced and
      // outside each other's contention window.
      await storeRow("v-cto", "writer-b", ENTITY, cto, new Date(t0.getTime() + 3000));
      await storeRow("v-april", "writer-a", ENTITY, "April.", new Date(t0.getTime() + 4500));
      await recordIngestApplied(tracked("writer-b", cto), "v-cto");

      const fromA = await recordIngestApplied(tracked("writer-a", "April."), "v-april");
      expect(fromA).toEqual({ supersededBy: "v-cto", cause: "stale-read" });

      const error = await unreadVersionError(db, writerA, { storedVersionId: "v-april", current: "v-cto" });
      expect(error.storedVersionId).toBe("v-april");
      expect(error.lastReadVersionId).toBe("v-renewal");
      expect(error.replaceVersionId).toBeUndefined();
      expect(error.message).toContain("superseded by v-cto");
      expect(error.message).not.toContain("baseVersion v-cto");
      // Its stored copy makes the same text a replay, which gets this answer again.
      expect(error.message).toContain("The same text again without a baseVersion only repeats this answer.");
    });

    it("names the writer's own fact's newer version for a stored write that raced it", async () => {
      const t0 = new Date("2026-10-06T12:00:00.000Z");
      await storeRow("v-renewal", "writer-a", ENTITY, renewal, t0);
      await recordIngestApplied(tracked("writer-a", renewal), "v-renewal");
      await storeRow("v-may", "writer-b", ENTITY, "May.", new Date(t0.getTime() + 3000), "v-renewal");
      await storeRow("v-cto", "writer-c", ENTITY, cto, new Date(t0.getTime() + 4500));
      await storeRow("v-june", "writer-a", ENTITY, "June.", new Date(t0.getTime() + 6000));
      await recordIngestApplied(tracked("writer-b", "May.", "v-renewal"), "v-may");
      await recordIngestApplied(tracked("writer-c", cto), "v-cto");

      const fromA = await recordIngestApplied(tracked("writer-a", "June."), "v-june");
      expect(fromA).toEqual({ supersededBy: "v-cto", cause: "stale-read" });

      const error = await unreadVersionError(db, writerA, { storedVersionId: "v-june", current: "v-cto" });
      expect(error.replaceVersionId).toBe("v-may");
      expect(error.message).toContain("pass baseVersion v-may");
      expect(error.message).not.toContain("baseVersion v-cto");
    });
  });
});
