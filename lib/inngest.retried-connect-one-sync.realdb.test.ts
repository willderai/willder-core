// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A connect retried while the first connect's sync is queued or running leaves ONE
// sync doing the work. The connector failure measure runs exactly this as case D:
// connect a repository, connect it again 15 s later.
// Each connect fires a `source-sync` run, and the per-source `concurrency` key on
// `sourceSync` serializes steps, not runs, so Inngest alternates the two runs' steps.
// Before this fix both ran to the end: every item was ingested twice (26 items, 52
// stored facts), and the first run finished only near the end of the second, about
// twice one sync's time, past case D's 540 s budget on one measured build.
//
// The claim under test: the newest sync request for a source is the only run that
// writes. An older run stands down at its next step (`"superseded"`), keeps what it
// already wrote (the scope did not change, so it retires nothing), and the newer run
// finds that already ingested. So the source gets each item once, in about one
// sync's steps, and still finishes with its terminal status.
//
// The real POST and DELETE handlers and the real `sourceSync` job run against
// Postgres, with real sealing. The step runner below models Inngest's per-source
// step slot: one step at a time, taken in turn by the runs waiting for it.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited DATABASE_URL
// that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const TOKEN = "github_pat_scratch";
const ITEMS = Array.from({ length: 8 }, (_, i) => ({
  id: `item-${i}`,
  text: `Scratch fact number ${i}.`,
  checksum: `c${i}`,
}));

const graphiti = vi.hoisted(() => {
  const facts: { group: string; sourceId: string | undefined; episodeId: string; text: string }[] = [];
  let nextId = 0;
  let beforeWrite: ((content: string) => Promise<void>) | null = null;
  return {
    facts,
    reset() {
      facts.length = 0;
      nextId = 0;
      beforeWrite = null;
    },
    duringIngest(fn: ((content: string) => Promise<void>) | null) {
      beforeWrite = fn;
    },
    retrievable: (group: string, sourceId: string) =>
      facts.filter((f) => f.group === group && f.sourceId === sourceId).map((f) => f.text),
    memory: {
      ingest: async (input: { groupId: string; scopePath?: string; content: string; sourceId?: string }) => {
        if (beforeWrite) await beforeWrite(input.content);
        const episodeId = `episode-${++nextId}`;
        facts.push({
          group: input.scopePath ?? input.groupId,
          sourceId: input.sourceId,
          episodeId,
          text: input.content,
        });
        return { episodeId };
      },
    },
    store: {
      removeGroupFacts: async ({ groupId, sourceId }: { groupId: string; sourceId?: string }) => {
        const before = facts.length;
        for (let i = facts.length - 1; i >= 0; i--) {
          if (facts[i].group === groupId && facts[i].sourceId === sourceId) facts.splice(i, 1);
        }
        return { removedCount: before - facts.length };
      },
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => {
        const i = facts.findIndex((f) => f.group === groupId && f.episodeId === episodeId);
        if (i >= 0) facts.splice(i, 1);
        return { removed: i >= 0 };
      },
      dedupeNodes: async () => 0,
    },
  };
});

vi.mock("@/services/memory/store", () => ({ memory: graphiti.memory, graphitiStore: graphiti.store }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/services/connectors/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/connectors/github")>();
  return {
    ...actual,
    assertRepositoryReadable: async () => undefined,
    listRepositoryItems: async () => ({ items: ITEMS, unreadable: [], gone: [] }),
  };
});
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = async () => ({ allowed: true, reason: "" });
  return { ...actual, check, authorizeRecord: actual.recordAuthorizer({ check, can: actual.can }) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-retried-connect-one-sync";
const USER = "user-qa-retried-connect-one-sync";
const REPO = "acme/scratch";
const SCOPE = "org_qa.retried_connect_one_sync";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string } };
type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};
type SyncResult = Record<string, unknown>;

describe.skipIf(!QA_URL)("a connect retried while the first connect's sync is queued or running", () => {
  let db: PrismaClient;
  let handler: (ctx: StepCtx) => Promise<SyncResult>;
  let POST: (typeof import("@/app/api/sources/route"))["POST"];
  let DELETE: (typeof import("@/app/api/sources/[id]/route"))["DELETE"];
  const sent: SyncEvent[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: SyncEvent) => {
      sent.push(event);
      return { ids: [`job-${sent.length}`] };
    }) as never);
    handler = (inngestModule.sourceSync as unknown as { fn: typeof handler }).fn;
    ({ POST } = await import("@/app/api/sources/route"));
    ({ DELETE } = await import("@/app/api/sources/[id]/route"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: USER },
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "owner" } },
    } as never);
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graphiti.reset();
    sent.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "scratch" } });
  });

  const connect = async () => {
    const res = await POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "github", repo: REPO, token: TOKEN, scopePath: SCOPE }),
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { source: { id: string } }).source.id;
  };

  const disconnect = async (id: string) => {
    const res = await DELETE(new Request(`http://test/api/sources/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
  };

  /**
   * Inngest's per-source step slot: one step runs at a time, and the runs waiting for
   * it take it in turn. `executed` counts every step that ran, across runs.
   */
  const stepSlot = () => {
    let tail: Promise<unknown> = Promise.resolve();
    const executed: string[] = [];
    const run = (label: string, event: SyncEvent) =>
      handler({
        event: { data: event.data },
        step: {
          run: (name, fn) => {
            const turn = tail.then(async () => {
              // Let the other run queue its next step before this one ends its turn.
              await new Promise((resolve) => setImmediate(resolve));
              executed.push(`${label}:${name}`);
              return fn();
            });
            tail = turn.catch(() => undefined);
            return turn;
          },
        },
      });
    return { run, executed };
  };

  const itemSteps = (executed: string[]) => executed.filter((s) => s.includes(":process-item-"));
  const row = (id: string) => db.source.findUniqueOrThrow({ where: { id } });
  const allTexts = ITEMS.map((i) => i.text).sort();

  it("the retry lands mid-sync: each item is ingested once, in about one sync's steps, and the sync finishes", async () => {
    const id = await connect();
    const slot = stepSlot();
    let retried: Promise<SyncResult> | null = null;
    let ingests = 0;
    graphiti.duringIngest(async () => {
      // The retry lands while the first run's third item is being written.
      if (++ingests === 3 && !retried) {
        expect(await connect()).toBe(id);
        retried = slot.run("retry", sent[1]);
      }
    });

    const first = await slot.run("first", sent[0]);
    expect(retried).not.toBeNull();
    const second = await retried!;

    // One copy of each item, all still there, each named by the source's sync record.
    expect(graphiti.retrievable(SCOPE, id).sort()).toEqual(allTexts);
    const files = await db.sourceFile.findMany({ where: { sourceId: id } });
    expect(files.map((f) => f.externalFileId).sort()).toEqual(ITEMS.map((i) => i.id).sort());

    // The older run stood down; the newer one finished and wrote the terminal status.
    expect(first).toMatchObject({ superseded: true, disconnected: false });
    expect(second).toMatchObject({ superseded: false, disconnected: false, failed: 0 });
    const done = await row(id);
    expect(done.status).toBe("active");
    expect((done.meta as { lastSyncAt?: string }).lastSyncAt).toEqual(expect.any(String));

    // About one sync's worth of item steps: the items, plus the one where the old run stood down.
    expect(itemSteps(slot.executed).length).toBeLessThanOrEqual(ITEMS.length + 1);
  });

  it("the retry lands before the first sync starts: the older queued run writes nothing", async () => {
    const id = await connect();
    expect(await connect()).toBe(id);
    const slot = stepSlot();

    const [first, second] = await Promise.all([slot.run("first", sent[0]), slot.run("retry", sent[1])]);

    expect(graphiti.retrievable(SCOPE, id).sort()).toEqual(allTexts);
    expect(first).toMatchObject({ superseded: true, synced: 0 });
    expect(second).toMatchObject({ superseded: false, synced: ITEMS.length });
    expect(itemSteps(slot.executed).filter((s) => s.startsWith("first:"))).toEqual([]);
    expect((await row(id)).status).toBe("active");
  });

  it("a disconnect and reconnect under a run that has not yet noticed: the old run writes nothing more", async () => {
    const id = await connect();
    const slot = stepSlot();
    let again: Promise<SyncResult> | null = null;
    let ingests = 0;
    graphiti.duringIngest(async () => {
      if (++ingests === 2 && !again) {
        await disconnect(id);
        expect(await connect()).toBe(id);
        again = slot.run("reconnect", sent[1]);
      }
    });

    const first = await slot.run("first", sent[0]);
    await again!;

    // The old run's later items never came from its own listing after the reconnect.
    expect(first).toMatchObject({ superseded: true });
    expect(itemSteps(slot.executed).filter((s) => s.startsWith("first:")).length).toBeLessThanOrEqual(3);
    // The reconnect's own content is all there, once.
    expect(graphiti.retrievable(SCOPE, id).sort()).toEqual(allTexts);
    expect((await row(id)).status).toBe("active");
  });

  it("control: one connect, one run, every item once", async () => {
    const id = await connect();
    const slot = stepSlot();
    const only = await slot.run("only", sent[0]);
    expect(only).toMatchObject({ superseded: false, synced: ITEMS.length, failed: 0 });
    expect(graphiti.retrievable(SCOPE, id).sort()).toEqual(allTexts);
    expect(itemSteps(slot.executed)).toHaveLength(ITEMS.length);
  });
});
