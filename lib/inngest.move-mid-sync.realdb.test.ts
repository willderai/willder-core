// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A source moved to another scope while a sync is still running leaves none of
// that sync's content readable at the scope it left, against a real database.
//
// The claim under test: once `POST /api/sources` has moved a source from one
// scope to another, nothing that source's in-flight sync wrote is retrievable at
// the old scope — not its facts, not the item text in the change feed — and no
// sync record pins an item to the old scope, including for writes that landed
// after the route's purge. The per-item guard stops the old run before its next
// write; the write it was already making is what these tests race.
//
// The real POST handler and the real `sourceSync` job run against Postgres:
// `Source` and `SourceFile` rows, the change feed and the conditional status
// writes are real. Graphiti is an in-memory double holding facts by group and
// stamped source id, which is how the real store's `removeGroupFacts` selects
// them. GitHub is a double because it is a remote service. The Inngest client is
// spied so the test runs the exact event the route sent.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The connect's widening gate has its own tests (app/api/sources/route.widening.realdb.test.ts).
// Here the source reports anyone can read it, so connects widen nothing and these
// tests stay on what they cover; the scope's readers are still counted for real.
vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

/** Graphiti, reduced to what a GitHub sync and a move use. */
const graphiti = vi.hoisted(() => {
  const facts: { group: string; sourceId: string | undefined; episodeId: string; text: string }[] = [];
  let nextId = 0;
  /** Runs inside an ingest, before its fact lands: the interleaving under test. */
  let beforeWrite: ((content: string) => Promise<void>) | null = null;
  /** Runs once, right after the next group purge finishes. */
  let afterPurge: (() => Promise<void>) | null = null;
  return {
    facts,
    reset() {
      facts.length = 0;
      nextId = 0;
      beforeWrite = null;
      afterPurge = null;
    },
    duringIngest(fn: ((content: string) => Promise<void>) | null) {
      beforeWrite = fn;
    },
    afterNextPurge(fn: () => Promise<void>) {
      afterPurge = fn;
    },
    /** What a scope read returns for this source: the facts still stamped with it. */
    retrievable: (group: string, sourceId: string) =>
      facts.filter((f) => f.group === group && f.sourceId === sourceId).map((f) => f.text),
    memory: {
      // A connector ingest names the org as `groupId` and its partition as `scopePath`.
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
        const removedCount = before - facts.length;
        const hook = afterPurge;
        afterPurge = null;
        if (hook) await hook();
        return { removedCount };
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

const ITEMS = [
  { id: "README.md", text: "The WebSocket server pushes 55 updates per minute.", checksum: "r1" },
  { id: "src/server.ts", text: "Price updates are batched every second.", checksum: "s1" },
  { id: "docs/ops.md", text: "Deploys run from main.", checksum: "o1" },
];

vi.mock("@/services/memory/store", () => ({ memory: graphiti.memory, graphitiStore: graphiti.store }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/services/connectors/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/connectors/github")>()),
  assertRepositoryReadable: async () => undefined,
  listRepositoryItems: async () => ({ items: ITEMS, unreadable: [] }),
}));
// Who is asking is not under test here; the route's scope checks, including the
// write check on the scope a move leaves, are covered by
// route.scope-admin-authz.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: async () => ({ allowed: true }),
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-move-mid-sync";
const USER = "user-qa-move-mid-sync";
const REPO = "acme/pricing";
const OLD_SCOPE = "org_qa_move.engineering";
const NEW_SCOPE = "org_qa_move.engineering.core";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string; token: string } };
type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a source moved to another scope during a sync leaves nothing at the old one", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let POST: (typeof import("@/app/api/sources/route"))["POST"];
  const sent: SyncEvent[] = [];

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: SyncEvent) => {
      sent.push(event);
      return { ids: [`job-${sent.length}`] };
    }) as never);
    ({ POST } = await import("@/app/api/sources/route"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: USER },
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "owner" } },
    } as never);
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graphiti.reset();
    sent.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.createMany({
      data: [
        { orgId: ORG, path: OLD_SCOPE, name: "engineering" },
        { orgId: ORG, path: NEW_SCOPE, name: "core" },
      ],
    });
  });

  const connect = async (scopePath: string) => {
    const res = await POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "github", repo: REPO, token: "github_pat_test", scopePath }),
      }),
    );
    expect(res.status).toBe(201);
    return res;
  };

  /**
   * Run the real sync job for an event the route sent, as Inngest would.
   * `beforeStep` runs ahead of each named step: the point where Inngest can
   * schedule another run's step, since its concurrency key limits steps, not runs.
   */
  const runSync = (event: SyncEvent, beforeStep?: (name: string) => Promise<void>) => {
    const ctx: StepCtx = {
      event: { data: event.data },
      step: {
        run: async (name, fn) => {
          await beforeStep?.(name);
          return fn();
        },
      },
    };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<Record<string, unknown>> }).fn(ctx);
  };

  /** Move the source to NEW_SCOPE while the ingest of the item containing `text` is in flight. */
  const moveDuringIngestOf = (text: string) => {
    let moved: Response | undefined;
    graphiti.duringIngest(async (content) => {
      if (!moved && content.includes(text)) moved = await connect(NEW_SCOPE);
    });
    return () => moved;
  };

  const source = () => db.source.findFirstOrThrow({ where: { orgId: ORG, type: "github", externalId: REPO } });

  /** Change events at `scopePath` that still carry an item's text. */
  const feedText = (scopePath: string) =>
    db.changeEvent.findMany({
      where: { orgId: ORG, scopePath, recordType: { not: "source" }, summary: { not: "" } },
      select: { summary: true },
    });

  /** Everything a reader of OLD_SCOPE could still learn of the source's content. */
  const expectNothingLeftAtOldScope = async (sourceId: string) => {
    expect(graphiti.retrievable(OLD_SCOPE, sourceId)).toEqual([]);
    expect(await feedText(OLD_SCOPE)).toEqual([]);
    expect(await db.sourceFile.count({ where: { sourceId, episodeScopePath: OLD_SCOPE } })).toBe(0);
  };

  /** The sync the move fired, run to completion: every item lands at NEW_SCOPE. */
  const expectReplacementSyncCoversNewScope = async (sourceId: string) => {
    graphiti.duringIngest(null);
    expect(sent).toHaveLength(2);
    await runSync(sent[1]);
    expect(graphiti.retrievable(NEW_SCOPE, sourceId).sort()).toEqual(ITEMS.map((i) => i.text).sort());
    expect(graphiti.retrievable(OLD_SCOPE, sourceId)).toEqual([]);
    expect(await db.sourceFile.count({ where: { sourceId, episodeScopePath: NEW_SCOPE } })).toBe(ITEMS.length);
  };

  it("retires a write that lands after the move, and the old run writes nothing after it", async () => {
    await connect(OLD_SCOPE);
    const moved = moveDuringIngestOf("55 updates");

    const result = await runSync(sent[0]);

    expect(moved()?.status).toBe(201);
    expect(result).toMatchObject({ superseded: true });
    const { id } = await source();
    await expectNothingLeftAtOldScope(id);
    await expectReplacementSyncCoversNewScope(id);
  });

  it("retires the last write when the move lands past every per-item check", async () => {
    await connect(OLD_SCOPE);
    const moved = moveDuringIngestOf("Deploys run from main");

    const result = await runSync(sent[0]);

    expect(moved()?.status).toBe(201);
    expect(result).toMatchObject({ superseded: true });
    const row = await source();
    expect(row).toMatchObject({ scopePath: NEW_SCOPE, status: "active" });
    // The old run's terminal write did not land over the move's.
    expect((row.meta as { lastSyncAt?: string } | null)?.lastSyncAt).toBeUndefined();
    await expectNothingLeftAtOldScope(row.id);
    await expectReplacementSyncCoversNewScope(row.id);
  });

  it("retires a sync that finishes between the move's purge and its pointer write", async () => {
    // The narrowest window: the route has purged the old scope but not yet moved
    // the pointer, so the whole old run, README write included, still sees its
    // scope as current and completes normally.
    await connect(OLD_SCOPE);
    let syncFinished: Promise<unknown> = Promise.resolve();
    let route: Promise<Response> | undefined;
    graphiti.duringIngest(async (content) => {
      if (route || !content.includes("55 updates")) return;
      let written!: () => void;
      const readmeWritten = new Promise<void>((resolve) => {
        written = resolve;
      });
      graphiti.afterNextPurge(async () => {
        written();
        await syncFinished;
      });
      route = connect(NEW_SCOPE);
      await readmeWritten;
    });

    syncFinished = runSync(sent[0]);
    await syncFinished;
    expect((await route!).status).toBe(201);

    const { id } = await source();
    await expectNothingLeftAtOldScope(id);
    await expectReplacementSyncCoversNewScope(id);
  });

  it("retires a last write that lands after the purge drops sync records but before the pointer moves", async () => {
    // The old run's final write lands after the route's first purge has dropped
    // every sync record, and the run completes before the pointer moves, so it
    // never stops and never retires. Only the route's purge after the move
    // reaches that write's fact, feed text and sync record.
    await connect(OLD_SCOPE);
    const { db: appDb } = await import("@/lib/db");
    const deleteMany = appDb.sourceFile.deleteMany.bind(appDb.sourceFile);
    let syncFinished: Promise<unknown> = Promise.resolve();
    let route: Promise<Response> | undefined;
    let releaseWrite!: () => void;
    const spy = vi.spyOn(appDb.sourceFile, "deleteMany").mockImplementation((async (args: never) => {
      const result = await deleteMany(args);
      if (route && releaseWrite) {
        const release = releaseWrite;
        releaseWrite = undefined as never;
        release();
        await syncFinished;
      }
      return result;
    }) as never);
    graphiti.duringIngest(async (content) => {
      if (route || !content.includes("Deploys run from main")) return;
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      route = connect(NEW_SCOPE);
      await writeReleased;
    });

    try {
      syncFinished = runSync(sent[0]);
      const result = await syncFinished;
      expect((await route!).status).toBe(201);
      // The old run saw its scope as current to the end.
      expect(result).toMatchObject({ superseded: false, disconnected: false });
    } finally {
      spy.mockRestore();
    }

    const { id } = await source();
    await expectNothingLeftAtOldScope(id);
    await expectReplacementSyncCoversNewScope(id);
  });

  it("keeps the replacement sync's content when it runs before the old run retires", async () => {
    // Inngest's concurrency key on `sourceSync` limits concurrent steps, not
    // runs, so the sync the move fired can run its steps between two of the old
    // run's. The old run's retirement must not reach what the new one wrote.
    await connect(OLD_SCOPE);
    const moved = moveDuringIngestOf("55 updates");

    const result = await runSync(sent[0], async (name) => {
      if (name !== "retire-after-move") return;
      graphiti.duringIngest(null);
      expect(sent).toHaveLength(2);
      await runSync(sent[1]);
    });

    expect(moved()?.status).toBe(201);
    expect(result).toMatchObject({ superseded: true });
    const { id } = await source();
    expect(graphiti.retrievable(NEW_SCOPE, id).sort()).toEqual(ITEMS.map((i) => i.text).sort());
    expect(await feedText(NEW_SCOPE)).toHaveLength(ITEMS.length);
    await expectNothingLeftAtOldScope(id);
  });

  /** A sync of unchanged items after everything settles: what it adds, and whether every fact still has a record. */
  const expectSettledAtNewScope = async (sourceId: string) => {
    expect(await db.sourceFile.count({ where: { sourceId, episodeScopePath: NEW_SCOPE } })).toBe(ITEMS.length);
    graphiti.duringIngest(null);
    await runSync(sent[1]);
    const atNew = graphiti.facts.filter((f) => f.group === NEW_SCOPE && f.sourceId === sourceId);
    // One fact per item: a missing record makes the next sync write the item a second time.
    expect(atNew.map((f) => f.text).sort()).toEqual(ITEMS.map((i) => i.text).sort());
    // Every fact is named by a record, so an item deleted upstream can still be retired.
    const recorded = await db.sourceFile.findMany({ where: { sourceId }, select: { episodeId: true } });
    expect(atNew.map((f) => f.episodeId).sort()).toEqual(recorded.map((r) => r.episodeId).sort());
  };

  it("leaves the replacement sync's records in place, so its next run writes nothing twice", async () => {
    await connect(OLD_SCOPE);
    const moved = moveDuringIngestOf("55 updates");

    await runSync(sent[0], async (name) => {
      if (name !== "retire-after-move") return;
      graphiti.duringIngest(null);
      await runSync(sent[1]);
    });

    expect(moved()?.status).toBe(201);
    await expectSettledAtNewScope((await source()).id);
  });

  it("keeps the content at a scope the source moved away from and back to before the old run retires", async () => {
    // Back at its first scope, the source's content there is live again: the
    // sync the return fired wrote it, so the old run's retirement must skip it.
    await connect(OLD_SCOPE);
    const moved = moveDuringIngestOf("55 updates");

    const result = await runSync(sent[0], async (name) => {
      if (name !== "retire-after-move") return;
      graphiti.duringIngest(null);
      await connect(OLD_SCOPE);
      expect(sent).toHaveLength(3);
      await runSync(sent[2]);
    });

    expect(moved()?.status).toBe(201);
    expect(result).toMatchObject({ superseded: true });
    const { id, scopePath } = await source();
    expect(scopePath).toBe(OLD_SCOPE);
    expect(graphiti.retrievable(OLD_SCOPE, id).sort()).toEqual(ITEMS.map((i) => i.text).sort());
    expect(await feedText(OLD_SCOPE)).toHaveLength(ITEMS.length);
    expect(await db.sourceFile.count({ where: { sourceId: id, episodeScopePath: OLD_SCOPE } })).toBe(ITEMS.length);
  });

  it("control: a sync nobody moves keeps its content at its scope", async () => {
    await connect(OLD_SCOPE);

    const result = await runSync(sent[0]);

    expect(result).toMatchObject({ superseded: false, disconnected: false });
    const row = await source();
    expect(graphiti.retrievable(OLD_SCOPE, row.id)).toHaveLength(ITEMS.length);
    expect(await feedText(OLD_SCOPE)).toHaveLength(ITEMS.length);
    expect(row.meta).toMatchObject({ synced: ITEMS.length, failed: 0 });
  });
});
