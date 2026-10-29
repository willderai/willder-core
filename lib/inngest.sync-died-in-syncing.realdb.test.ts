// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A `source-sync` run that dies after `load-source` marked the source "syncing", and
// whose own try/catch never runs, leaves the source "syncing" for good. Nothing else
// moves a source out of "syncing": the run's terminal write is the only one. Inngest
// ends a run that way when the platform kills a step (a function timeout, a deploy that
// drops the request) until the retries run out, or when the catch's own status write
// fails: it reports the run failed without calling the handler again. The source then
// reads as syncing forever, its `lastSyncAt` never moves, and only GitHub sources are
// picked up again, by the schedule, two hours later (source-resync.ts).
//
// The claim under test: when Inngest reports a sync run failed, the source leaves
// "syncing" with an error and a `lastSyncAt`, but only if that run still owns the row:
// a disconnected source stays disconnected, and a run that took the source since
// (a newer connect's (#988), the schedule's, a person's re-sync) is left to finish.
// A run owns the source's "syncing" once its `load-source` stamps its run id.
//
// The real POST and DELETE handlers and the real `sourceSync` job and its `onFailure`
// run against Postgres. "Dies" is modelled as Inngest sees it: a step that never
// returns, after which Inngest calls only `onFailure`.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited DATABASE_URL
// that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const TOKEN = "github_pat_scratch";
const ITEMS = Array.from({ length: 4 }, (_, i) => ({
  id: `item-${i}`,
  text: `Died-sync fact number ${i}.`,
  checksum: `c${i}`,
}));

const graphiti = vi.hoisted(() => {
  let nextId = 0;
  return {
    reset() {
      nextId = 0;
    },
    memory: { ingest: async () => ({ episodeId: `episode-${++nextId}` }) },
    store: {
      removeGroupFacts: async () => ({ removedCount: 0 }),
      removeEpisode: async () => ({ removed: true }),
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

const ORG = "org-qa-sync-died-in-syncing";
const USER = "user-qa-sync-died-in-syncing";
const REPO = "acme/died-sync";
const SCOPE = "org_qa.sync_died_in_syncing";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string; syncRequestId?: string }; ts: number };
type StepCtx = {
  event: { data: unknown };
  runId: string;
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};
type SyncResult = Record<string, unknown>;
type FailureCtx = {
  event: {
    name: string;
    data: { function_id: string; run_id: string; error: { name: string; message: string }; event: SyncEvent };
  };
  error: Error;
};

describe.skipIf(!QA_URL)("a sync run that dies while the source is syncing", () => {
  let db: PrismaClient;
  let handler: (ctx: StepCtx) => Promise<SyncResult>;
  let onFailure: ((ctx: FailureCtx) => Promise<unknown>) | undefined;
  let POST: (typeof import("@/app/api/sources/route"))["POST"];
  let DELETE: (typeof import("@/app/api/sources/[id]/route"))["DELETE"];
  const sent: SyncEvent[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: Omit<SyncEvent, "ts">) => {
      // Inngest stamps `ts` on every event it accepts.
      sent.push({ ...event, ts: Date.now() });
      return { ids: [`job-${sent.length}`] };
    }) as never);
    const fn = inngestModule.sourceSync as unknown as { fn: typeof handler; opts: { onFailure?: typeof onFailure } };
    handler = fn.fn;
    onFailure = fn.opts.onFailure;
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
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "died-sync" } });
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

  /** Steps run in order; once `diesAt` names a step, that step never returns, as when the platform kills it. */
  const runUntilDeath = (runId: string, event: SyncEvent, diesAt: (name: string) => boolean) => {
    let died!: () => void;
    const dead = new Promise<void>((resolve) => {
      died = resolve;
    });
    void handler({
      event: { data: event.data },
      runId,
      step: {
        run: async (name, fn) => {
          if (diesAt(name)) {
            died();
            return new Promise<never>(() => undefined);
          }
          return fn();
        },
      },
    });
    return dead;
  };

  const runToEnd = (runId: string, event: SyncEvent) =>
    handler({ event: { data: event.data }, runId, step: { run: async (_name, fn) => fn() } });

  /** A run that holds at `holdAt` until released: one that is mid-sync. */
  const runHeld = (runId: string, event: SyncEvent, holdAt: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = handler({
      event: { data: event.data },
      runId,
      step: {
        run: async (name, fn) => {
          if (name === holdAt) await gate;
          return fn();
        },
      },
    });
    return { release, done };
  };

  /** What Inngest does once the dead run's retries ran out: call `onFailure`, never the handler. */
  const reportFailed = async (runId: string, event: SyncEvent) => {
    const error = new Error("Function execution timed out");
    await onFailure?.({
      event: {
        name: "inngest/function.failed",
        data: { function_id: "source-sync", run_id: runId, error: { name: error.name, message: error.message }, event },
      },
      error,
    });
  };

  const manualEvent = (id: string, ts = Date.now()): SyncEvent => ({
    name: sent[0].name,
    data: { sourceId: id, orgId: ORG },
    ts,
  });
  const row = (id: string) => db.source.findUniqueOrThrow({ where: { id } });
  const metaOf = async (id: string) =>
    (await row(id)).meta as {
      lastSyncAt?: string;
      error?: string;
      syncRequestId?: string;
      syncRunId?: string;
      note?: string;
    };

  it("the run dies mid-sync: once Inngest reports it failed, the source is no longer syncing and says so", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    expect((await row(id)).status).toBe("syncing");

    const reportedAt = Date.now();
    await reportFailed("run-a", sent[0]);

    expect((await row(id)).status).toBe("error");
    const meta = await metaOf(id);
    expect(Date.parse(meta.lastSyncAt ?? "")).toBeGreaterThanOrEqual(reportedAt - 1000);
    expect(meta.error).toEqual(expect.stringMatching(/sync/i));

    // A person's re-sync then runs to the end.
    expect(await runToEnd("run-b", manualEvent(id))).toMatchObject({ superseded: false, failed: 0 });
    expect((await row(id)).status).toBe("active");
    expect((await metaOf(id)).error).toBeUndefined();
  });

  it("a scheduled or manual run dies: the source is no longer syncing", async () => {
    const id = await connect();
    expect(await runToEnd("run-a", sent[0])).toMatchObject({ failed: 0 });
    const manual = manualEvent(id);
    await runUntilDeath("run-m", manual, (name) => name === "list-items");
    expect((await row(id)).status).toBe("syncing");

    await reportFailed("run-m", manual);
    expect((await row(id)).status).toBe("error");
  });

  it("a manual event older than the latest connect, run after that connect's sync finished, dies: the source is no longer syncing", async () => {
    const id = await connect();
    const asked = manualEvent(id, Date.now() - 60_000);
    expect(await connect()).toBe(id);
    expect(await runToEnd("run-c", sent[1])).toMatchObject({ failed: 0 });
    await runUntilDeath("run-m", asked, (name) => name === "list-items");
    expect((await row(id)).status).toBe("syncing");

    await reportFailed("run-m", asked);
    expect((await row(id)).status).toBe("error");
  });

  it("a manual run dies while the next manual run is already mid-sync: that run is left syncing and finishes", async () => {
    const id = await connect();
    expect(await runToEnd("run-a", sent[0])).toMatchObject({ failed: 0 });
    const first = manualEvent(id);
    await runUntilDeath("run-m1", first, (name) => name === "list-items");
    const next = runHeld("run-m2", manualEvent(id), "list-items");
    await vi.waitFor(async () => expect((await metaOf(id)).syncRunId).toBe("run-m2"));

    await reportFailed("run-m1", first);
    expect((await row(id)).status).toBe("syncing");
    expect((await metaOf(id)).error).toBeUndefined();

    next.release();
    expect(await next.done).toMatchObject({ superseded: false, failed: 0 });
    expect((await row(id)).status).toBe("active");
  });

  it("a connect's run dies while a scheduled run serving the same request is mid-sync: that run is left syncing", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    // Same request id as the dead run: only the run id tells them apart.
    const next = runHeld("run-s", manualEvent(id), "process-item-item-1");
    await vi.waitFor(async () => expect((await metaOf(id)).syncRunId).toBe("run-s"));

    await reportFailed("run-a", sent[0]);
    expect((await row(id)).status).toBe("syncing");

    next.release();
    expect(await next.done).toMatchObject({ superseded: false, failed: 0 });
    expect((await row(id)).status).toBe("active");
  });

  it("a run a newer connect replaced dies: the newer run's row is left alone and it finishes (#988)", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    expect(await connect()).toBe(id);
    // item-0 is already stored by the dead run, so the newer run skips it; it holds at item-1.
    const newer = runHeld("run-b", sent[1], "process-item-item-1");
    await vi.waitFor(async () => expect((await metaOf(id)).syncRunId).toBe("run-b"));

    await reportFailed("run-a", sent[0]);
    expect((await row(id)).status).toBe("syncing");
    expect((await metaOf(id)).error).toBeUndefined();

    newer.release();
    expect(await newer.done).toMatchObject({ superseded: false, failed: 0 });
    expect((await row(id)).status).toBe("active");
  });

  it("a newer connect lands after the run died but before its run starts: the failure report leaves the connected source alone", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    expect(await connect()).toBe(id);

    await reportFailed("run-a", sent[0]);
    expect((await row(id)).status).toBe("active");
  });

  it("the source is disconnected under the run, then the run dies: it stays disconnected", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    await disconnect(id);

    await reportFailed("run-a", sent[0]);
    expect((await row(id)).status).toBe("disconnected");
  });

  it("the run's own catch already wrote its error: the failure report does not write over it", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    await db.source.update({
      where: { id },
      data: {
        status: "error",
        meta: { ...(await metaOf(id)), error: "own line", lastSyncAt: "2026-10-01T00:00:00.000Z" },
      },
    });

    await reportFailed("run-a", sent[0]);
    const meta = await metaOf(id);
    expect((await row(id)).status).toBe("error");
    expect(meta.error).toBe("own line");
    expect(meta.lastSyncAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a write to the row lands between the failure report's read and its write: what it wrote is kept", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0], (name) => name === "process-item-item-1");
    const { db: appDb } = await import("@/lib/db");
    const read = appDb.source.findFirst.bind(appDb.source);
    const spy = vi.spyOn(appDb.source, "findFirst").mockImplementationOnce((async (args: never) => {
      const found = await read(args);
      // Another writer changes the row, still syncing under the same run, after the read.
      const current = await db.source.findUniqueOrThrow({ where: { id } });
      await db.source.update({
        where: { id },
        data: { meta: { ...(current.meta as object), note: "landed between" } },
      });
      return found;
    }) as never);
    try {
      await reportFailed("run-a", sent[0]);
    } finally {
      spy.mockRestore();
    }
    expect((await metaOf(id)).note).toBe("landed between");
  });
});
