// A retried identical ingest keeps one row, one event and one job, against a
// real database.
//
// The claim under test: `ingestMemory`'s write-through stores the content in
// pgvector and announces it before queueing graph extraction, so three identical
// `memory_ingest` calls could leave three rows, three events and three jobs. The
// store write is now keyed on the content (`PgvectorMemoryStore.ingestOnce`,
// services/memory/ingest-content-key.ts) under a unique index, so the second and third calls
// find the row and write nothing, while still replying that the content is
// readable. The unique index is what makes two concurrent identical ingests
// collapse too, which no in-memory double can show.
//
// Postgres, the pgvector store, the change feed and the audit row are real. The
// graph store and the queue are doubles; the embedding service answers a fixed
// vector so the embedded INSERT branch is the one exercised.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }) },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-write-through-idempotency";
const OTHER_ORG = "org-qa-write-through-idempotency-other";
const SCOPE = "org_qa.write_through_idempotency";

/** The embedding service's answer: a fixed vector, so the embedded INSERT branch runs. */
const embeddingResponse = () => ({ ok: true, json: async () => ({ embedding: new Array(384).fill(0.01) }) });

const acmeRenewal = (overrides: Partial<IngestInput> = {}): IngestInput => ({
  groupId: ORG,
  content: "Acme renewed its contract with Willder for 2027.",
  name: "Acme Corp",
  actorType: "agent",
  origin: "mcp",
  actorId: "agent-writer",
  actorName: "MCP session",
  source: "mcp",
  scopePath: SCOPE,
  ...overrides,
});

describe.skipIf(!QA_URL)("a retried identical ingest on the write-through path", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let ingestContentKey: (typeof import("@/services/memory/ingest-content-key"))["ingestContentKey"];
  let queued: number;

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => {
      queued += 1;
      return { ids: [`job-${queued}`] };
    }) as never);
    ({ ingestMemory } = inngestModule);
    // Also after the env: this module reaches `@/lib/db` through `@/services/access`.
    ({ ingestContentKey } = await import("@/services/memory/ingest-content-key"));
  });

  afterAll(async () => {
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queued = 0;
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => embeddingResponse() as never);
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  const rows = () => db.memoryChunk.findMany({ where: { orgId: ORG }, orderBy: { createdAt: "asc" } });
  const events = () => db.changeEvent.findMany({ where: { orgId: ORG, recordType: "fact" } });
  const creates = () => db.changeEvent.findMany({ where: { orgId: ORG, recordType: "fact", op: "create" } });
  const supersedes = () => db.changeEvent.findMany({ where: { orgId: ORG, recordType: "fact", op: "supersede" } });
  const appliedWrites = () => db.auditLog.findMany({ where: { orgId: ORG, action: "memory.write.applied" } });

  it("three identical ingests: three success replies, one row, one event, one job", async () => {
    const acks = [];
    for (let i = 0; i < 3; i++) acks.push(await ingestMemory(acmeRenewal()));

    const stored = await rows();
    expect(stored).toHaveLength(1);
    // Every reply names the one stored version, the first write and both replays alike.
    // The replays also say they wrote nothing: the text was stored by an earlier write.
    const ack = { readableNow: true, versionId: stored[0].id };
    const replay = { ...ack, graphExtraction: "earlier" };
    expect(acks).toEqual([ack, replay, replay]);
    expect(stored[0]).toMatchObject({ content: acmeRenewal().content, scopePath: SCOPE });
    const announced = await events();
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ op: "create", recordId: stored[0].id, scopePath: SCOPE });
    expect(await appliedWrites()).toHaveLength(1);
    expect(queued).toBe(1);
  });

  it("two concurrent identical ingests collapse to one row and one event", async () => {
    // Both embedding calls are held until both have been made, so the two
    // INSERTs are issued in the same turn: neither can land before the other
    // has started. Without this, Promise.all alone lets the first INSERT commit
    // before the second is sent, which is the sequential case again.
    const waitingForEmbedding: Array<() => void> = [];
    vi.mocked(globalThis.fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          waitingForEmbedding.push(() => resolve(embeddingResponse() as never));
          if (waitingForEmbedding.length === 2) for (const release of waitingForEmbedding) release();
        }),
    );

    const acks = await Promise.all([ingestMemory(acmeRenewal()), ingestMemory(acmeRenewal())]);

    expect(waitingForEmbedding).toHaveLength(2);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    // One stored the row; the other found it and says an earlier write stored it.
    expect(acks).toEqual(
      expect.arrayContaining([
        { readableNow: true, versionId: stored[0].id },
        { readableNow: true, versionId: stored[0].id, graphExtraction: "earlier" },
      ]),
    );
    expect(await events()).toHaveLength(1);
    expect(queued).toBe(1);
  });

  it("an identical ingest arriving while the first is still uncommitted waits for it, then collapses", async () => {
    // The first writer's row is in the unique index but its transaction is
    // open, which is the window two real concurrent requests race in. The
    // second ingest's INSERT ... ON CONFLICT must wait for that transaction
    // and then do nothing: no error, no second row, and a success reply once
    // the first commit is visible.
    const first = acmeRenewal();
    let rowIsInIndex!: () => void;
    const firstRowInIndex = new Promise<void>((resolve) => {
      rowIsInIndex = resolve;
    });
    let commitFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      commitFirst = resolve;
    });
    const firstWriter = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","contentKey","createdAt")
          VALUES ('held-row', ${ORG}, ${first.content}, 'mcp', 'agent', 'MCP session', ${SCOPE}, ${ingestContentKey(first)}, NOW())
        `;
        rowIsInIndex();
        await firstHeld;
      },
      { timeout: 15_000 },
    );
    await firstRowInIndex;

    let secondSettled = false;
    const second = ingestMemory(first).then((ack) => {
      secondSettled = true;
      return ack;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondSettled).toBe(false);

    commitFirst();
    await firstWriter;

    expect(await second).toEqual({ readableNow: true, versionId: "held-row", graphExtraction: "earlier" });
    expect((await rows()).map((row) => row.id)).toEqual(["held-row"]);
    expect(await events()).toHaveLength(0);
    expect(queued).toBe(0);
  }, 30_000);

  it("the same fact in another org is that org's own row", async () => {
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });

    await ingestMemory(acmeRenewal());
    await ingestMemory(acmeRenewal({ groupId: OTHER_ORG }));

    expect(await rows()).toHaveLength(1);
    expect(await db.memoryChunk.findMany({ where: { orgId: OTHER_ORG } })).toHaveLength(1);
    expect(queued).toBe(2);
  });

  // The store writes no row it could not read back: `retrieve` filters on
  // `embedding IS NOT NULL` and nothing backfills the column, so a failed
  // embedding throws instead of leaving an unreadable row behind. The
  // write-through path's defined answer to that throw is to store and announce
  // nothing and leave the write to the queued job, which is what `readableNow:
  // false` tells the caller. Content-key dedup cannot run on an attempt that
  // stored nothing, so the guarantee this suite exists for resumes with the
  // first attempt the service is up for.
  it("an ingest while the embedding service is down stores nothing and leaves the write to the queued job", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("embed: connection refused"));

    expect(await ingestMemory(acmeRenewal())).toEqual({ readableNow: false });
    expect(await ingestMemory(acmeRenewal())).toEqual({ readableNow: false });

    const stored = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_chunks WHERE "orgId" = ${ORG}
    `;
    expect(stored).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    expect(await appliedWrites()).toHaveLength(0);
    expect(queued).toBe(2);

    // Back up: the next ingest stores and announces the fact exactly once.
    vi.mocked(globalThis.fetch).mockImplementation(async () => embeddingResponse() as never);
    const ack = await ingestMemory(acmeRenewal());
    const storedOnceUp = await rows();
    expect(storedOnceUp).toHaveLength(1);
    expect(ack).toEqual({ readableNow: true, versionId: storedOnceUp[0].id });
    expect(await events()).toHaveLength(1);
    expect(queued).toBe(3);
  });

  it("an identical text with another occurredAt keeps the stored date and says so", async () => {
    const first = await ingestMemory(acmeRenewal({ occurredAt: "2026-03-01T00:00:00.000Z" }));
    const sameDate = await ingestMemory(acmeRenewal({ occurredAt: "2026-03-01T00:00:00.000Z" }));
    const otherDate = await ingestMemory(acmeRenewal({ occurredAt: "2026-04-01T00:00:00.000Z" }));

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].occurredAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(sameDate).toEqual({ ...first, graphExtraction: "earlier" });
    expect(otherDate).toEqual({
      ...first,
      graphExtraction: "earlier",
      storedDateKept: { occurredAt: "2026-03-01T00:00:00.000Z" },
    });
  });

  it("tells another writer's undated identical write that the stored, stated date stands", async () => {
    const first = await ingestMemory(acmeRenewal({ occurredAt: "2020-01-01T00:00:00.000Z" }));
    const undated = await ingestMemory(acmeRenewal({ actorId: "agent-other" }));

    expect(undated).toEqual({
      ...first,
      graphExtraction: "earlier",
      storedDateKept: { occurredAt: "2020-01-01T00:00:00.000Z" },
    });
  });

  it("tells a dated write that the identical text it found is dated by when it was stored", async () => {
    const first = await ingestMemory(acmeRenewal());
    const dated = await ingestMemory(acmeRenewal({ occurredAt: "2020-01-01T00:00:00.000Z" }));

    expect(dated).toEqual({ ...first, graphExtraction: "earlier", storedDateKept: { occurredAt: null } });
  });

  it("replays a post-dated write as applied: its clamped date is the date it asked for", async () => {
    const ahead = { occurredAt: new Date(Date.now() + 4 * 60_000).toISOString() };
    const first = await ingestMemory(acmeRenewal(ahead));
    const retry = await ingestMemory(acmeRenewal(ahead));

    const [row] = await rows();
    expect(row.occurredAt?.toISOString()).toBe(row.createdAt.toISOString());
    expect(retry).toEqual({ ...first, graphExtraction: "earlier" });
  });

  it("a retry that differs only by surrounding whitespace is the same fact", async () => {
    await ingestMemory(acmeRenewal());
    await ingestMemory(acmeRenewal({ content: `  ${acmeRenewal().content}\n` }));

    expect(await rows()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("different content, name or scope is a different fact with its own row and event", async () => {
    await ingestMemory(acmeRenewal());
    await ingestMemory(acmeRenewal({ content: "Acme cancelled its contract with Willder.", actorId: "agent-other" }));
    await ingestMemory(acmeRenewal({ name: "Acme Inc" }));
    await ingestMemory(acmeRenewal({ scopePath: `${SCOPE}.renewals` }));

    const stored = await rows();
    expect(stored).toHaveLength(4);
    expect(await creates()).toHaveLength(4);
    expect(queued).toBe(4);

    // The first two name one entity in one scope from two different writers, so they are
    // two versions of one fact and land inside the contention window: the one stored first
    // wins and the second is announced as superseded by it, attributed to the winner's
    // writer (services/memory/conflict.ts; one writer's own writes never contend). Dedup
    // and contention are separate questions -- both still get their own row and their own
    // create event.
    // The third differs by entity name and the fourth by scope, so neither contends.
    const [winner, loser] = stored;
    expect(await supersedes()).toMatchObject([
      { recordId: loser.id, summary: `superseded by ${winner.id}: Acme Corp`, actorId: "agent-writer" },
    ]);
  });
});
