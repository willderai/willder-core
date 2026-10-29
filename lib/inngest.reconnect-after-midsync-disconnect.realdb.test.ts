// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A source disconnected in the middle of a sync, then connected again at the same
// scope, answers from the new connect's sync, whatever order the old run's cleanup
// lands in. The connector failure measure runs exactly this: case A disconnects a sync
// in flight, and case C reconnects the same repository with a narrower token two
// minutes later. On one measured build, case C's sync
// finished, recorded the parts GitHub refused and counted files, and its README
// never answered.
//
// The claim under test: the disconnected run's own cleanup (`retireAfterDisconnect`)
// retires what that run left behind and nothing the next connect wrote. Inngest's
// per-source concurrency key serializes steps, not runs, and a step that fails is
// retried later, so that cleanup step can run after the reconnect's sync has
// written. A cleanup that retires the whole source and drops every sync record then
// wipes the new connect's content and leaves its sync reporting files it no longer
// holds. And what the old run wrote after the disconnect route had purged, an
// in-flight write's fact and its sync record, must not make the new connect skip
// that item as unchanged.
//
// The real POST and DELETE handlers and the real `sourceSync` job run against
// Postgres, with real sealing, so each sync lists with the token its connect
// stored. GitHub is a double that serves a narrower listing to the narrower token;
// Graphiti is an in-memory double holding facts by group and stamped source id,
// which is how the real store's `removeGroupFacts` selects them.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const FULL_TOKEN = "github_pat_full";
const NARROW_TOKEN = "github_pat_contents_only";
const README_TEXT = "Throwaway repo for connector tests. Safe to delete.";
const ISSUE_TEXT = "Issue #7: the pricing feed drops updates under load.";

const graphiti = vi.hoisted(() => {
  const facts: { group: string; sourceId: string | undefined; episodeId: string; text: string }[] = [];
  let nextId = 0;
  /** Runs inside an ingest, before its fact lands. */
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
    /** What a scope read returns for this source: the facts still stamped with it. */
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
    // The full token reads the README and the issues; the narrow one is refused issues
    // and pull requests, as GitHub refuses a contents-only token.
    listRepositoryItems: async (_repo: string, token: string) =>
      token === FULL_TOKEN
        ? {
            items: [
              { id: "readme", text: README_TEXT, checksum: "r1" },
              { id: "issue-7", text: ISSUE_TEXT, checksum: "i7" },
            ],
            unreadable: ["pulls"],
            gone: [],
          }
        : {
            items: [{ id: "readme", text: README_TEXT, checksum: "r1" }],
            unreadable: ["issues", "pulls"],
            gone: [],
          },
  };
});
// Who is asking is not under test here; the routes' scope checks are covered by
// route.scope-admin-authz.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = async () => ({ allowed: true, reason: "" });
  return { ...actual, check, authorizeRecord: actual.recordAuthorizer({ check, can: actual.can }) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-reconnect-after-midsync";
const USER = "user-qa-reconnect-after-midsync";
const REPO = "acme/scratch";
const SCOPE = "org_qa.reconnect_after_midsync";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string } };
type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a source disconnected mid-sync and connected again at the same scope", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("@/lib/inngest");
  let POST: (typeof import("@/app/api/sources/route"))["POST"];
  let DELETE: (typeof import("@/app/api/sources/[id]/route"))["DELETE"];
  const sent: SyncEvent[] = [];

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: SyncEvent) => {
      sent.push(event);
      return { ids: [`job-${sent.length}`] };
    }) as never);
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
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graphiti.reset();
    sent.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "scratch" } });
  });

  const connect = async (token: string) => {
    const res = await POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "github", repo: REPO, token, scopePath: SCOPE }),
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

  type SyncResult = Record<string, unknown>;
  const syncFn = () => (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<SyncResult> }).fn;

  /** Run the real sync job for an event the route sent, every step at once. */
  const runSync = (event: SyncEvent) =>
    syncFn()({ event: { data: event.data }, step: { run: async (_name, fn) => fn() } });

  /**
   * Run the sync job for `event` up to its step named `held`, and hold that step there
   * until `release` is called: the step Inngest runs later than the steps around it, a
   * retry after it failed once, or one queued behind another run's.
   */
  const runSyncHolding = (event: SyncEvent, held: string) => {
    let reachedHeld!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedHeld = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = syncFn()({
      event: { data: event.data },
      step: {
        run: async (name, fn) => {
          if (name === held) {
            reachedHeld();
            await released;
          }
          return fn();
        },
      },
    });
    return { reached, release, done };
  };

  /** Case A: connect with the full token and disconnect while its README's ingest is in flight. */
  const disconnectMidSync = (id: string) => {
    let disconnected = false;
    graphiti.duringIngest(async (content) => {
      if (!disconnected && content.includes("Throwaway")) {
        disconnected = true;
        await disconnect(id);
      }
    });
  };

  const sourceFiles = (id: string) =>
    db.sourceFile.findMany({ where: { sourceId: id }, select: { externalFileId: true, episodeId: true } });

  it("the disconnected run's late cleanup leaves the reconnect's README answering", async () => {
    const id = await connect(FULL_TOKEN);
    disconnectMidSync(id);
    const first = runSyncHolding(sent[0], "retire-after-disconnect");
    await first.reached;
    graphiti.duringIngest(null);

    // Case C: the same repository again, at the same scope, with the narrow token.
    expect(await connect(NARROW_TOKEN)).toBe(id);
    const second = await runSync(sent[1]);
    expect(second).toMatchObject({ disconnected: false, superseded: false });

    // The first run's cleanup lands last.
    first.release();
    expect(await first.done).toMatchObject({ disconnected: true });

    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
    // The README is the reconnect's own write, and its sync record names that write.
    const files = await sourceFiles(id);
    expect(files.map((f) => f.externalFileId)).toEqual(["readme"]);
    expect(graphiti.facts.find((f) => f.text === README_TEXT)?.episodeId).toBe(files[0].episodeId);
    expect(await db.source.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "active" });
  });

  it("the late cleanup leaves the reconnect's sync alone while that sync is still running", async () => {
    const id = await connect(FULL_TOKEN);
    disconnectMidSync(id);
    const first = runSyncHolding(sent[0], "retire-after-disconnect");
    await first.reached;
    graphiti.duringIngest(null);

    await connect(NARROW_TOKEN);
    const second = runSyncHolding(sent[1], "complete");
    await second.reached;
    expect(await db.source.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "syncing" });

    first.release();
    await first.done;
    second.release();
    await second.done;

    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
    expect((await sourceFiles(id)).map((f) => f.externalFileId)).toEqual(["readme"]);
  });

  it("the reconnect does not skip an item the disconnected run wrote after the route purged", async () => {
    const id = await connect(FULL_TOKEN);
    disconnectMidSync(id);
    const first = runSyncHolding(sent[0], "retire-after-disconnect");
    await first.reached;
    graphiti.duringIngest(null);
    // The in-flight README write landed after both of the route's purges, with its record.
    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
    const late = (await sourceFiles(id)).map((f) => f.episodeId);

    await connect(NARROW_TOKEN);

    // That write was made under the connect that was removed, not under this one.
    expect(graphiti.facts.filter((f) => late.includes(f.episodeId))).toEqual([]);
    await runSync(sent[1]);
    first.release();
    await first.done;

    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
    expect((await sourceFiles(id)).map((f) => f.episodeId)).not.toEqual(late);
  });

  it("control: a cleanup that lands before the reconnect leaves nothing, and the reconnect answers", async () => {
    const id = await connect(FULL_TOKEN);
    disconnectMidSync(id);
    const first = await runSync(sent[0]);
    graphiti.duringIngest(null);
    expect(first).toMatchObject({ disconnected: true });
    expect(graphiti.retrievable(SCOPE, id)).toEqual([]);
    expect(await sourceFiles(id)).toEqual([]);

    await connect(NARROW_TOKEN);
    await runSync(sent[1]);

    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
  });

  it("control: a late cleanup with the source still disconnected retires the late write", async () => {
    const id = await connect(FULL_TOKEN);
    disconnectMidSync(id);
    const first = runSyncHolding(sent[0], "retire-after-disconnect");
    await first.reached;
    graphiti.duringIngest(null);
    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);

    first.release();
    await first.done;

    expect(graphiti.retrievable(SCOPE, id)).toEqual([]);
    expect(await sourceFiles(id)).toEqual([]);
    expect(await db.source.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "disconnected" });
  });
});
