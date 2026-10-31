// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A sync stores a listing too large for one Inngest step as a private blob under the
// source's prefix and deletes it once read (lib/inngest/connector-listing-pages.ts). The
// listing is the source's text (here a GitHub repository's issue bodies), so one a dead
// run left behind must not outlive what it belongs to. The claims under test, with the
// real `sourceSync` job, its `onFailure`, the real connect and disconnect handlers, the
// real permanent removal and the real person erasure against Postgres, and an in-memory
// Blob store:
//
//  - a run that finishes stores its listing at `sources/<org>/<source>/listing-<run>/`,
//    reads it back one byte range per page, and leaves nothing;
//  - a run that dies mid-listing leaves its listing until Inngest reports it failed,
//    and then nothing; a run that took the source since keeps its own;
//  - removing the source for good deletes everything under its prefix;
//  - erasing a person deletes every listing in the org but the one a current run reads.
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
// 4 items of ~200 KB: the listing is past the 512 KB a step may return, so it is stored.
const ITEMS = Array.from({ length: 4 }, (_, i) => ({
  id: `item-${i}`,
  text: `Listing fact ${i}. ${"word ".repeat(40_000)}`,
  checksum: `c${i}`,
}));

const blobs = vi.hoisted(() => {
  type Stored = { pathname: string; body: Buffer; uploadedAt: Date };
  const stored = new Map<string, Stored>();
  let n = 0;
  return {
    stored,
    ranges: [] as { pathname: string; start: number; end: number }[],
    /** Every delete throws, as when the Blob service is down. */
    failDeletes: false,
    reset() {
      stored.clear();
      this.ranges.length = 0;
      this.failDeletes = false;
    },
    pathnames: () => [...stored.values()].map((b) => b.pathname).sort(),
    async put(pathname: string, body: Buffer) {
      const url = `https://store.blob.vercel-storage.com/${pathname}-${(n += 1)}`;
      stored.set(url, { pathname, body: Buffer.from(body), uploadedAt: new Date() });
      return { url };
    },
  };
});
vi.mock("@/lib/blob-storage", () => ({
  putPrivateBlob: (pathname: string, body: Buffer) => blobs.put(pathname, body),
  readPrivateBlobRange: async (url: string, start: number, end: number) => {
    const blob = blobs.stored.get(url);
    if (!blob) return null;
    blobs.ranges.push({ pathname: blob.pathname, start, end });
    return blob.body.subarray(start, end);
  },
  readPrivateBlob: async () => null,
  deletePrivateBlob: async (url: string) => {
    if (blobs.failDeletes) throw new Error("Blob delete failed");
    blobs.stored.delete(url);
  },
  listPrivateBlobs: async (prefix: string) =>
    [...blobs.stored.entries()]
      .filter(([, b]) => b.pathname.startsWith(prefix))
      .map(([url, b]) => ({ url, pathname: b.pathname, size: b.body.length, uploadedAt: b.uploadedAt })),
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
      sourceRecords: async () => [],
      groupResidue: async () => ({ facts: 0, episodes: 0 }),
      planPersonErasure: async () => [],
      erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
      removeChunkFacts: async () => undefined,
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

const ORG = "org-qa-listing-blob-cleanup";
const USER = "user-qa-listing-blob-cleanup";
const SCOPE = "org_qa.listing_blob_cleanup";

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

describe.skipIf(!QA_URL)("a stored connector listing does not outlive its run, its source, or an erasure", () => {
  let db: PrismaClient;
  let handler: (ctx: StepCtx) => Promise<SyncResult>;
  let onFailure: ((ctx: FailureCtx) => Promise<unknown>) | undefined;
  let POST: (typeof import("@/app/api/sources/route"))["POST"];
  let DELETE: (typeof import("@/app/api/sources/[id]/route"))["DELETE"];
  const sent: SyncEvent[] = [];
  const ctx = {
    orgId: ORG,
    actor: { type: "human" as const, id: USER, role: "owner" as const },
    origin: "app" as const,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob_test_token");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: Omit<SyncEvent, "ts">) => {
      sent.push({ ...event, ts: Date.now() });
      return { ids: [`job-${sent.length}`] };
    }) as never);
    const fn = inngestModule.sourceSync as unknown as { fn: typeof handler; opts: { onFailure?: typeof onFailure } };
    handler = fn.fn;
    onFailure = fn.opts.onFailure;
    ({ POST } = await import("@/app/api/sources/route"));
    ({ DELETE } = await import("@/app/api/sources/[id]/route"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({ org: { id: ORG }, user: { id: USER }, ctx } as never);
  });

  const wipe = async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.personErasureRequest.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  };

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    graphiti.reset();
    blobs.reset();
    sent.length = 0;
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "listing-cleanup" } });
  });

  const connect = async (repo = "acme/listing-cleanup") => {
    const res = await POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "github", repo, token: TOKEN, scopePath: SCOPE }),
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

  /** Steps run in order; the step `diesAt` names never returns, as when the platform kills it. */
  const runUntilDeath = (runId: string, event: SyncEvent, diesAt: string) => {
    let died!: () => void;
    const dead = new Promise<void>((resolve) => {
      died = resolve;
    });
    void handler({
      event: { data: event.data },
      runId,
      step: {
        run: async (name, fn) => {
          if (name === diesAt) {
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
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const done = handler({
      event: { data: event.data },
      runId,
      step: {
        run: async (name, fn) => {
          if (name === holdAt) {
            reached();
            await gate;
          }
          return fn();
        },
      },
    });
    return { release, done, atGate };
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

  const manualEvent = (id: string): SyncEvent => ({
    name: sent[0]!.name,
    data: { sourceId: id, orgId: ORG },
    ts: Date.now(),
  });
  const listingOf = (id: string, runId: string) => `sources/${ORG}/${id}/listing-${runId}/items.json`;

  it("a run that finishes stores its listing under its own prefix, reads it a byte range a page, and leaves nothing", async () => {
    const id = await connect();
    expect(await runToEnd("run-a", sent[0]!)).toMatchObject({ failed: 0 });

    expect(blobs.ranges.length).toBeGreaterThan(1);
    expect(new Set(blobs.ranges.map((r) => r.pathname))).toEqual(new Set([listingOf(id, "run-a")]));
    const total = blobs.ranges.reduce((sum, r) => sum + r.end - r.start, 0);
    expect(total).toBe(blobs.ranges.at(-1)!.end);
    expect(blobs.pathnames()).toEqual([]);
  });

  it("a run dies mid-listing: its listing is kept until Inngest reports the run failed, then deleted", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0]!, "list-items-page-1");
    expect(blobs.pathnames()).toEqual([listingOf(id, "run-a")]);

    await reportFailed("run-a", sent[0]!);

    expect(blobs.pathnames()).toEqual([]);
    expect((await db.source.findUniqueOrThrow({ where: { id } })).status).toBe("error");
  });

  it("a run dies and its status write throws: the failure report still deletes its listing", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0]!, "list-items-page-1");
    expect(blobs.pathnames()).toEqual([listingOf(id, "run-a")]);
    const { db: appDb } = await import("@/lib/db");
    const findFirst = vi.spyOn(appDb.source, "findFirst").mockRejectedValueOnce(new Error("database went away"));
    try {
      await expect(reportFailed("run-a", sent[0]!)).rejects.toThrow("database went away");
    } finally {
      findFirst.mockRestore();
    }
    expect(blobs.pathnames()).toEqual([]);
  });

  it("a run dies while the next run is mid-listing: only the dead run's listing goes, and the next run finishes", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0]!, "list-items-page-1");
    const next = runHeld("run-b", manualEvent(id), "list-items-page-1");
    await next.atGate;
    expect(blobs.pathnames()).toEqual([listingOf(id, "run-a"), listingOf(id, "run-b")]);

    await reportFailed("run-a", sent[0]!);
    expect(blobs.pathnames()).toEqual([listingOf(id, "run-b")]);

    next.release();
    expect(await next.done).toMatchObject({ superseded: false, failed: 0 });
    expect(blobs.pathnames()).toEqual([]);
  });

  it("a listing step retried after its store succeeded: the finished run deletes both copies", async () => {
    const id = await connect();
    let attempts = 0;
    const result = await handler({
      event: { data: sent[0]!.data },
      runId: "run-r",
      step: {
        run: async (name, fn) => {
          if (name !== "list-items" || attempts++ > 0) return fn();
          await fn(); // stored, then the attempt failed before its output was saved
          return fn();
        },
      },
    });
    expect(result).toMatchObject({ failed: 0 });
    expect(blobs.stored.size).toBe(0);
    expect(await db.source.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({
      status: "active",
    });
  });

  it("removing the source for good deletes everything under its prefix and nothing of another source", async () => {
    const id = await connect();
    const other = await connect("acme/other-repo");
    await runUntilDeath("run-a", sent[0]!, "list-items-page-1");
    await blobs.put(`sources/${ORG}/${id}/drive-file-1-notes.pdf`, Buffer.from("raw"));
    await blobs.put(`sources/${ORG}/${other}/listing-run-x/items.json`, Buffer.from("other"));
    await disconnect(id);

    const { removeDisconnectedSource } = await import("@/services/memory/source-removal");
    expect(await removeDisconnectedSource(ctx, id)).toEqual({ status: "deleted" });

    expect(blobs.pathnames()).toEqual([`sources/${ORG}/${other}/listing-run-x/items.json`]);
  });

  it("erasing a person deletes every listing a dead run left in the org, and keeps the one a current run reads", async () => {
    const id = await connect();
    const other = await connect("acme/other-repo");
    // `other` is idle with a dead run's listing; `id` has a dead run's and a current run's.
    await blobs.put(`sources/${ORG}/${other}/listing-run-x/items.json`, Buffer.from("Dana Whitfield said"));
    await blobs.put(`sources/${ORG}/${other}/drive-file-1-notes.pdf`, Buffer.from("not a listing"));
    await runUntilDeath("run-a", sent[0]!, "list-items-page-1");
    const current = runHeld("run-b", manualEvent(id), "list-items-page-1");
    await current.atGate;

    const { erasePerson } = await import("@/services/memory/person-erasure");
    await erasePerson(ctx, { email: "dana.whitfield@acme.example" });

    expect(blobs.pathnames()).toEqual(
      [`sources/${ORG}/${other}/drive-file-1-notes.pdf`, listingOf(id, "run-b")].sort(),
    );
    current.release();
    expect(await current.done).toMatchObject({ failed: 0 });
    expect(blobs.pathnames()).toEqual([`sources/${ORG}/${other}/drive-file-1-notes.pdf`]);
  });

  it("a run whose page fails after a reconnect replaced its request deletes its listing itself", async () => {
    const id = await connect();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const done = handler({
      event: { data: sent[0]!.data },
      runId: "run-a",
      step: {
        run: async (name, fn) => {
          if (name !== "list-items-page-1") return fn();
          reached();
          await gate;
          throw new Error("Blob service unavailable");
        },
      },
    });
    await atGate;
    expect(await connect()).toBe(id);
    release();
    // the reconnect's request is not this run's: it ends without failing, so no onFailure
    expect(await done).toMatchObject({ superseded: true });
    expect((await db.source.findUniqueOrThrow({ where: { id } })).meta).toMatchObject({ syncRunId: "run-a" });
    expect(blobs.pathnames()).toEqual([]);
  });

  it("a PostHog reconnect replaces the source's meta but keeps the run it names", async () => {
    const posthog = async () => {
      const res = await POST(
        new Request("http://test/api/sources", {
          method: "POST",
          body: JSON.stringify({
            type: "posthog",
            projectId: "7",
            insightId: "42",
            insightName: "Signups",
            apiKey: "phx_scratch",
            scopePath: SCOPE,
          }),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { source: { id: string } }).source.id;
    };
    const id = await posthog();
    const created = (await db.source.findUniqueOrThrow({ where: { id } })).meta as Record<string, unknown>;
    expect(created).toMatchObject({ projectId: "7" });
    expect(created).not.toHaveProperty("syncRunId");

    await db.source.update({
      where: { id },
      data: { status: "syncing", meta: { ...created, syncRunId: "run-p", synced: 3 } },
    });
    expect(await posthog()).toBe(id);

    const meta = (await db.source.findUniqueOrThrow({ where: { id } })).meta as Record<string, unknown>;
    expect(meta).toMatchObject({ projectId: "7", syncRunId: "run-p" });
    expect(meta).not.toHaveProperty("synced");
  });

  it("the failure report keeps the status write's error when the listing delete throws too", async () => {
    const id = await connect();
    await runUntilDeath("run-a", sent[0]!, "list-items-page-1");
    const { db: appDb } = await import("@/lib/db");
    const findFirst = vi.spyOn(appDb.source, "findFirst").mockRejectedValueOnce(new Error("database went away"));
    blobs.failDeletes = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(reportFailed("run-a", sent[0]!)).rejects.toThrow("database went away");
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("run-a"),
        expect.objectContaining({ message: "Blob delete failed" }),
      );
    } finally {
      findFirst.mockRestore();
      logged.mockRestore();
      blobs.failDeletes = false;
    }
    expect(blobs.pathnames()).toEqual([listingOf(id, "run-a")]);
  });

  it("a reconnect while a run is mid-page leaves it named by the source, so an erasure keeps its listing", async () => {
    const id = await connect();
    const current = runHeld("run-a", sent[0]!, "list-items-page-1");
    await current.atGate;
    expect(await connect()).toBe(id);
    expect((await db.source.findUniqueOrThrow({ where: { id } })).status).toBe("active");

    const { erasePerson } = await import("@/services/memory/person-erasure");
    await erasePerson(ctx, { email: "dana.whitfield@acme.example" });

    expect(blobs.pathnames()).toEqual([listingOf(id, "run-a")]);
    current.release();
    await current.done;
    expect(blobs.pathnames()).toEqual([]);
  });
});
