// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A source disconnected while its first sync is still running keeps none of that
// sync's content, against a real database.
//
// The claim under test: once `DELETE /api/sources/:id` has returned for a
// source, nothing that source's in-flight sync ingested is retrievable,
// including writes that land after the route ran. The route keeps the row and
// sets `status: "disconnected"` without moving the scope pointer, so a per-write
// guard that compares scope pointers only would keep ingesting, leave its facts
// live, and let its `complete` step mark the source active again.
//
// The real `sourceSync` job and the real DELETE handler run against Postgres:
// `Source` and `SourceFile` rows, the conditional status writes, the scope lookup
// that decides what to purge and the change feed are all real. Graphiti is an
// in-memory double holding facts by group and stamped source id, which is how the
// real store's `removeGroupFacts` selects them; it is the only store connector
// content reaches (connector ingests are extraction-tier, so no raw chunk is
// written). GitHub is a double because it is a remote service.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

/** Graphiti, reduced to what a GitHub sync and a disconnect use. */
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
    duringIngest(fn: (content: string) => Promise<void>) {
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
        const group = input.scopePath ?? input.groupId;
        facts.push({ group, sourceId: input.sourceId, episodeId, text: input.content });
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

vi.mock("@/services/memory/store", () => ({ memory: graphiti.memory, graphitiStore: graphiti.store }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "github-token" }) }));
vi.mock("@/services/connectors/github", () => ({
  listRepositoryItems: async () => ({
    items: [
      { id: "README.md", text: "The WebSocket server pushes 55 updates per minute.", checksum: "r1" },
      { id: "src/server.ts", text: "Price updates are batched every second.", checksum: "s1" },
      { id: "docs/ops.md", text: "Deploys run from main.", checksum: "o1" },
    ],
    unreadable: [],
    gone: [],
    cursor: { issues: {}, pulls: {}, commits: {}, probeOffset: 0 },
  }),
  parseCursor: () => null,
}));
// Who is asking is not under test here; the route's own scope checks are
// covered by route.scope-admin-authz.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = async () => ({ allowed: true, reason: "" });
  // The real record helper, deciding with the stub above.
  return { ...actual, check, authorizeRecord: actual.recordAuthorizer({ check, can: actual.can }) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-disconnect-mid-sync";
const USER = "user-qa-disconnect-mid-sync";
const SOURCE_ID = "src-qa-disconnect-mid-sync";
const SCOPE = "org_qa.engineering";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a source disconnected during its first sync keeps none of it", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let DELETE: (typeof import("@/app/api/sources/[id]/route"))["DELETE"];

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
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
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "github",
        externalId: "acme/pricing",
        name: "acme/pricing",
        scopePath: SCOPE,
        encryptedTokens: "sealed",
      },
    });
  });

  const runSync = () => {
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG } },
      step: { run: async (_name, fn) => fn() },
    };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<Record<string, unknown>> }).fn(ctx);
  };

  const disconnect = () =>
    DELETE(new Request(`http://test/api/sources/${SOURCE_ID}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });

  /** Disconnect while the ingest of the item containing `text` is in flight. */
  const disconnectDuringIngestOf = (text: string) => {
    let response: Response | undefined;
    graphiti.duringIngest(async (content) => {
      if (!response && content.includes(text)) response = await disconnect();
    });
    return () => response;
  };

  const source = () => db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });

  it("retires a write that lands after the route returned, and writes nothing after it", async () => {
    // The route runs to completion while the README's ingest is in flight, so
    // that fact is written after both of the route's purges.
    const response = disconnectDuringIngestOf("55 updates");

    const result = await runSync();

    expect(response()?.status).toBe(200);
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toEqual([]);
    expect(graphiti.facts).toEqual([]); // the other two items were never written
    expect(result).toMatchObject({ disconnected: true });
    expect(await source()).toMatchObject({ status: "disconnected" });
    expect(await db.sourceFile.count({ where: { sourceId: SOURCE_ID } })).toBe(0);
  });

  it("retires the last write when the disconnect lands past every per-item check", async () => {
    const response = disconnectDuringIngestOf("Deploys run from main");

    await runSync();

    expect(response()?.status).toBe(200);
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toEqual([]);
    const row = await source();
    expect(row.status).toBe("disconnected");
    // The run's terminal write did not land, so the source never read as synced.
    expect((row.meta as { lastSyncAt?: string }).lastSyncAt).toBeUndefined();
    expect(await db.sourceFile.count({ where: { sourceId: SOURCE_ID } })).toBe(0);
  });

  it("retires a sync that finishes between the route's purge and its disconnect", async () => {
    // The narrowest window: the route has purged but not yet marked the row, so
    // the whole sync, README write included, still sees a connected source and
    // completes normally. Only the route's purge after the disconnect sees it.
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
      route = disconnect();
      await readmeWritten;
    });

    syncFinished = runSync();
    await syncFinished;
    const response = await route!;

    expect(response.status).toBe(200);
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toEqual([]);
    expect(await source()).toMatchObject({ status: "disconnected" });
  });

  it("reconnecting afterwards syncs everything again, with no records left to skip it", async () => {
    disconnectDuringIngestOf("Price updates");
    await runSync();
    graphiti.duringIngest(async () => {});

    // What POST /api/sources does on a reconnect to the same scope.
    await db.source.update({ where: { id: SOURCE_ID }, data: { status: "active", encryptedTokens: "sealed" } });
    await runSync();

    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toHaveLength(3);
    expect(await source()).toMatchObject({ status: "active" });
  });

  it("control: a sync nobody disconnects keeps its content and completes", async () => {
    await runSync();

    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toHaveLength(3);
    const row = await source();
    expect(row.status).toBe("active");
    expect(row.meta).toMatchObject({ synced: 3, failed: 0 });
    expect(await db.sourceFile.count({ where: { sourceId: SOURCE_ID } })).toBe(3);
  });
});
