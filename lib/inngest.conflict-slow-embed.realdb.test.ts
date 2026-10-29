// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Two writers send one fact at the same moment, and the memory service takes longer than
// the contention window to embed one of them. The writes still conflict: whether two
// writes compete is decided by when the server received them, not by when each one's
// embedding came back.
//
// Before this, a version was dated by its storing transaction's start, which comes after
// the embedding call, so 1.5 s of embedding latency on one write turned a real race into an
// ordinary later update: two `create` events, no `supersede`, and the losing writer never
// told (one measured run: acks 715 ms and 2236 ms apart).
//
// Real: Postgres, the request path's store-and-announce transaction (`ingestMemory`), the
// per-org lock, the winner rule (services/memory/conflict.ts), the change feed. Stand-ins:
// the graph store (writes skipped) and the memory service's /embed, which answers one
// writer's content after a delay longer than the window.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: async () => ({ episodeId: "graph-episode" }) },
  graphitiStore: { ingest: async () => ({ episodeId: "graph-episode" }) },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
  GuardrailError: class extends Error {},
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-slow-embed";
const SCOPE = "org_org-qa-slow-embed.release";
const FACT = "Release train";
/**
 * services/memory/conflict.ts's CONTENTION_WINDOW_MS, checked against it in beforeAll. Not
 * imported at the top: that module reaches the `@/lib/db` singleton, which would be built
 * before beforeAll points DATABASE_URL at the QA database.
 */
const CONTENTION_WINDOW_MS = 1000;
/** Longer than the contention window, as the C24 run's slower write was. */
const SLOW_EMBED_MS = CONTENTION_WINDOW_MS + 500;
const SLOW_MARK = "(slow embed)";
/** Longer still: long enough for a second write, sent more than a window later, to be stored first. */
const SLOWER_EMBED_MS = 3 * CONTENTION_WINDOW_MS;
const SLOWER_MARK = "(slower embed)";

/** /embed, answering content that carries {@link SLOW_MARK} only after {@link SLOW_EMBED_MS}. */
function stubSlowEmbedding(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/embed")) throw new Error(`unexpected fetch to ${url}`);
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes(SLOW_MARK)) await new Promise((resolve) => setTimeout(resolve, SLOW_EMBED_MS));
    if (body.includes(SLOWER_MARK)) await new Promise((resolve) => setTimeout(resolve, SLOWER_EMBED_MS));
    return { ok: true, status: 200, json: async () => ({ embedding: new Array(384).fill(0.01) }) } as Response;
  });
}

describe.skipIf(!QA_URL)("two simultaneous writes of one fact, one embedded slowly", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("./inngest"))["ingestMemory"];

  const write = (agentId: string, content: string) =>
    ingestMemory({
      groupId: ORG,
      content,
      name: FACT,
      source: "mcp",
      actorType: "agent",
      origin: "mcp",
      actorId: agentId,
      actorName: agentId,
      scopePath: SCOPE,
      readsTracked: true,
      skipGraphExtraction: true,
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    stubSlowEmbedding();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ ingestMemory } = await import("./inngest"));
    expect((await import("@/services/memory/conflict")).CONTENTION_WINDOW_MS).toBe(CONTENTION_WINDOW_MS);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`DELETE FROM fact_edges WHERE "orgId" = ${ORG}`;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("is a conflict: one version supersedes the other and the loser is told", async () => {
    const started = Date.now();
    const [slow, fast] = await Promise.all([
      write("agent-slow", `The release train leaves on Monday ${SLOW_MARK}.`),
      write("agent-fast", "The release train leaves on Tuesday."),
    ]);
    // The precondition the bug needs: the two stores landed further apart than the window.
    expect(Date.now() - started).toBeGreaterThan(CONTENTION_WINDOW_MS);
    expect(slow.versionId).toBeDefined();
    expect(fast.versionId).toBeDefined();

    const edges = await db.$queryRaw<{ fromId: string; toId: string }[]>`
      SELECT "fromId", "toId" FROM fact_edges WHERE "orgId" = ${ORG} AND kind = 'supersedes'
    `;
    expect(edges).toHaveLength(1);
    const supersedes = await db.changeEvent.findMany({ where: { orgId: ORG, op: "supersede" } });
    expect(supersedes).toHaveLength(1);
    expect(supersedes[0]!.recordId).toBe(edges[0]!.toId);

    // Stored first wins: the fast write committed first and was acknowledged as current, so
    // it stays current; the slow write loses, is told so in its own ack, and the
    // supersede event on it is attributed to the winner's writer, which is what puts it in
    // the slow writer's next change notice.
    expect(edges[0]).toEqual({ fromId: fast.versionId, toId: slow.versionId });
    expect(fast.supersededBy).toBeUndefined();
    expect(slow.supersededBy).toBe(fast.versionId);
    expect(supersedes[0]!.actorId).toBe("agent-fast");
  });

  it("records when each version was received, before its embedding, on the database clock", async () => {
    const [slow] = await Promise.all([
      write("agent-slow", `The release train leaves on Wednesday ${SLOW_MARK}.`),
      write("agent-fast", "The release train leaves on Thursday."),
    ]);
    const [row] = await db.$queryRaw<{ receivedAt: Date | null; createdAt: Date }[]>`
      SELECT "receivedAt", "createdAt" FROM memory_chunks WHERE id = ${slow.versionId!}
    `;
    expect(row!.receivedAt).not.toBeNull();
    expect(row!.createdAt.getTime() - row!.receivedAt!.getTime()).toBeGreaterThanOrEqual(CONTENTION_WINDOW_MS);
  });

  it("is a conflict when the second write is received more than a window later but stored while the first is in flight", async () => {
    const slow = write("agent-slow", `The release train leaves on Sunday ${SLOWER_MARK}.`);
    await new Promise((resolve) => setTimeout(resolve, CONTENTION_WINDOW_MS + 300));
    const fast = await write("agent-fast", "The release train leaves on Saturday morning.");
    const slowAck = await slow;

    expect(fast.supersededBy).toBeUndefined();
    expect(slowAck.supersededBy).toBe(fast.versionId);
    const supersedes = await db.changeEvent.findMany({ where: { orgId: ORG, op: "supersede" } });
    expect(supersedes.map((event) => event.recordId)).toEqual([slowAck.versionId]);
  });

  it("two writes received further apart than the window are still an ordinary later update", async () => {
    const first = await write("agent-fast", "The release train leaves on Friday.");
    await new Promise((resolve) => setTimeout(resolve, CONTENTION_WINDOW_MS + 200));
    const second = await write("agent-other", "The release train leaves on Saturday.");
    expect(second.supersededBy).toBeUndefined();
    expect(first.supersededBy).toBeUndefined();
    expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede" } })).toBe(0);
  });
});
