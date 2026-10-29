// QA probes for the reconnect fix. The first test pins the reconnect's purge after the upsert (red
// with it removed); the RESIDUAL test pins the residual the write guard fixed (red without its write guard).
//
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

const ORG = "org-qa-982-probe";
const USER = "user-qa-982-probe";
const REPO = "acme/scratch";
const SCOPE = "org_qa.qa_982_probe";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string } };
type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("QA: wider-token content after a narrower reconnect", () => {
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

  const issueLeft = async (id: string) => ({
    facts: graphiti.retrievable(SCOPE, id).filter((t) => t === ISSUE_TEXT),
    files: (await sourceFiles(id)).map((f) => f.externalFileId).filter((x) => x === "issue-7"),
    events: (
      await db.changeEvent.findMany({
        where: { orgId: ORG, summary: { contains: "pricing feed" } },
        select: { id: true },
      })
    ).length,
  });

  it("a late write of the old connect landing between the reconnect's first purge and its upsert does not survive the narrow reconnect", async () => {
    const id = await connect(FULL_TOKEN);
    const { db: appDb } = await import("@/lib/db");
    let lateWriteDone!: () => void;
    const lateWritten = new Promise<void>((r) => {
      lateWriteDone = r;
    });
    let upsertReached!: () => void;
    const atUpsert = new Promise<void>((r) => {
      upsertReached = r;
    });
    let armed = false;
    const realTx = appDb.$transaction.bind(appDb);
    const spy = vi.spyOn(appDb, "$transaction").mockImplementation((async (...args: unknown[]) => {
      if (armed) {
        armed = false;
        upsertReached();
        await lateWritten;
      }
      return (realTx as (...a: unknown[]) => unknown)(...args);
    }) as never);
    let reconnect: Promise<string> | null = null;
    // The issue's ingest is in flight across the disconnect AND the reconnect's first purge;
    // it lands just before the reconnect's upsert.
    graphiti.duringIngest(async (content) => {
      if (content.includes("pricing feed") && !reconnect) {
        await disconnect(id);
        armed = true;
        reconnect = connect(NARROW_TOKEN);
        await atUpsert;
      }
    });
    const first = syncFn()({
      event: { data: sent[0].data },
      step: {
        run: async (name, fn) => {
          // The old run's next step comes after the reconnect has finished: Inngest runs it
          // later (a retry, or queued behind another run's step).
          if (name !== "process-item-issue-7" && reconnect) await reconnect;
          const out = await fn();
          if (name === "process-item-issue-7") lateWriteDone();
          return out;
        },
      },
    });
    await first;
    expect(await reconnect).toBe(id);
    spy.mockRestore();
    graphiti.duringIngest(null);
    await runSync(sent[sent.length - 1]);
    expect(await issueLeft(id)).toEqual({ facts: [], files: [], events: 0 });
    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
  });

  // The residual the reconnect fix left (it predates that fix): an old run's later step wrote from the
  // wide listing after a narrow reconnect. The per-connect write guard closes it.
  it("RESIDUAL (fixed by the per-connect write guard): old run's next step starting after a narrow reconnect writes from the wide listing", async () => {
    const id = await connect(FULL_TOKEN);
    const first = runSyncHolding(sent[0], "process-item-issue-7");
    await first.reached;
    await disconnect(id);
    await connect(NARROW_TOKEN);
    await runSync(sent[1]);
    first.release();
    await first.done;
    const left = await issueLeft(id);
    expect(left).toEqual({ facts: [], files: [], events: 0 });
  });

  it("two reconnects of a disconnected source racing each other leave the README answering once", async () => {
    const id = await connect(FULL_TOKEN);
    await runSync(sent[0]);
    await disconnect(id);
    const [a, b] = await Promise.all([connect(NARROW_TOKEN), connect(NARROW_TOKEN)]);
    expect([a, b]).toEqual([id, id]);
    const s1 = runSyncHolding(sent[1], "complete");
    await Promise.race([s1.reached, s1.done]);
    const r2 = await runSync(sent[2]);
    s1.release();
    const r1 = await s1.done;
    // The write guard: exactly one of the two racing connects' syncs serves the request the row names.
    const stored = ((await db.source.findUniqueOrThrow({ where: { id } })).meta as { syncRequestId?: string })
      .syncRequestId;
    const winner = [sent[1], sent[2]].findIndex((e) => (e.data as { syncRequestId?: string }).syncRequestId === stored);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect([r1, r2].map((r) => r.superseded)).toEqual(winner === 0 ? [false, true] : [true, false]);
    expect((await db.source.findUniqueOrThrow({ where: { id } })).status).toBe("active");
    expect(graphiti.retrievable(SCOPE, id)).toEqual([README_TEXT]);
    expect((await sourceFiles(id)).map((f) => f.externalFileId)).toEqual(["readme"]);
    expect(await issueLeft(id)).toEqual({ facts: [], files: [], events: 0 });
  });

  it("disconnect again after the reconnect: the old run's late cleanup then retires everything", async () => {
    const id = await connect(FULL_TOKEN);
    disconnectMidSync(id);
    const first = runSyncHolding(sent[0], "retire-after-disconnect");
    await first.reached;
    graphiti.duringIngest(null);
    await connect(NARROW_TOKEN);
    await runSync(sent[1]);
    await disconnect(id);
    first.release();
    await first.done;
    expect(graphiti.facts.filter((f) => f.sourceId === id)).toEqual([]);
    expect(await sourceFiles(id)).toEqual([]);
  });
});
