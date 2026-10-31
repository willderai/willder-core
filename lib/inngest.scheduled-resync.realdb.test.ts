// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The scheduled re-sync, against a real database.
//
// The claim under test: a README deleted at the source stops being retrievable on
// the schedule alone. Nobody calls POST /api/sources/:id/sync; the half-hourly job
// queues a sync for the connected GitHub source, and that sync retires the README.
// The job queues only the sources it can sync without a caller's credential, never
// a disconnected one, and never one in the middle of a recent sync.
//
// The real `sourceScheduledResync` job selects from Postgres and the real
// `sourceSync` job runs the event it queued; only `fetch` (GitHub) and Graphiti are
// doubles, the same shape as `inngest.github-permission-loss.realdb.test.ts`.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
// Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const graphiti = vi.hoisted(() => {
  const facts: { group: string; sourceId: string | undefined; episodeId: string; text: string }[] = [];
  let nextId = 0;
  return {
    facts,
    reset() {
      facts.length = 0;
      nextId = 0;
    },
    retrievable: (group: string, sourceId: string) =>
      facts.filter((f) => f.group === group && f.sourceId === sourceId).map((f) => f.text),
    memory: {
      ingest: async (input: { groupId: string; scopePath?: string; content: string; sourceId?: string }) => {
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
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "github-token" }) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-scheduled-resync";
const OTHER_ORG = "org-qa-scheduled-resync-other";
const SOURCE_ID = "src-qa-scheduled-resync";
const SCOPE = "org_qa.engineering";
const README = "Seeded test record: the pricing service retries quotes at midnight";

/** GitHub with one README (or none, once it is deleted) and one commit. */
function stubGitHub(readme: "present" | "deleted") {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/repos/acme/pricing") return json(200, { full_name: "acme/pricing", default_branch: "main" });
    if (path.endsWith("/readme")) {
      if (readme === "deleted") return json(404, { message: "Not Found" });
      return json(200, { content: Buffer.from(README).toString("base64"), encoding: "base64" });
    }
    if (path.endsWith("/issues") || path.endsWith("/pulls")) return json(200, []);
    if (path.endsWith("/commits")) return json(200, [{ sha: "abcdef1234567", commit: { message: "init" } }]);
    return json(404, { message: "Not Found" });
  });
}

type SentEvent = { id: string; name: string; data: { sourceId: string; orgId: string; token: string } };
type CronCtx = {
  step: {
    run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
    sendEvent: (name: string, events: SentEvent[]) => Promise<unknown>;
  };
};
type SyncCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("the scheduled re-sync", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let resyncModule: typeof import("./inngest/source-resync");

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
    resyncModule = await import("./inngest/source-resync");
  });

  const cleanup = async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.source.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  };

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanup();
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graphiti.reset();
    await cleanup();
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
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

  /** Runs the schedule once and returns the events it queued. */
  const runSchedule = async (): Promise<SentEvent[]> => {
    const sent: SentEvent[] = [];
    const ctx: CronCtx = {
      step: {
        run: async (_name, fn) => fn(),
        sendEvent: async (_name, events) => {
          sent.push(...events);
          return { ids: events.map((e) => e.id) };
        },
      },
    };
    await (resyncModule.sourceScheduledResync as unknown as { fn: (ctx: CronCtx) => Promise<unknown> }).fn(ctx);
    return sent;
  };
  const runSync = (data: unknown) => {
    const ctx: SyncCtx = { event: { data }, step: { run: async (_name, fn) => fn() } };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: SyncCtx) => Promise<Record<string, unknown>> }).fn(ctx);
  };
  const readmeRetrievable = () =>
    graphiti.retrievable(SCOPE, SOURCE_ID).some((t) => t.includes("retries quotes at midnight"));

  it("retires a README deleted at the source with no sync asked for", async () => {
    stubGitHub("present");
    for (const event of await runSchedule()) await runSync(event.data);
    expect(readmeRetrievable()).toBe(true);

    stubGitHub("deleted");
    const queued = await runSchedule();
    expect(queued.map((e) => e.data.sourceId)).toEqual([SOURCE_ID]);
    for (const event of queued) await runSync(event.data);

    expect(readmeRetrievable()).toBe(false);
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toHaveLength(1);
    const source = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
    expect(source.status).toBe("active");
    expect(await db.sourceFile.findMany({ where: { sourceId: SOURCE_ID }, select: { externalFileId: true } })).toEqual([
      { externalFileId: "commit-abcdef1234567" },
    ]);
  });

  it("queues every connected GitHub source in each org with its own org and no credential", async () => {
    await db.source.create({
      data: {
        id: "src-qa-scheduled-resync-other",
        orgId: OTHER_ORG,
        type: "github",
        externalId: "acme/billing",
        name: "acme/billing",
        scopePath: "org_qa_other.eng",
        encryptedTokens: "sealed",
        status: "error",
      },
    });

    const queued = await runSchedule();

    expect(queued.map((e) => e.data)).toEqual([
      { sourceId: SOURCE_ID, orgId: ORG },
      { sourceId: "src-qa-scheduled-resync-other", orgId: OTHER_ORG },
    ]);
    expect(queued.every((e) => e.name === inngestModule.SOURCE_SYNC_EVENT)).toBe(true);
  });

  it("leaves out disconnected, credential-less, recently syncing, access-lost and non-GitHub sources", async () => {
    await db.source.update({ where: { id: SOURCE_ID }, data: { status: "disconnected" } });
    const base = { orgId: ORG, scopePath: SCOPE, encryptedTokens: "sealed" };
    await db.source.createMany({
      data: [
        {
          ...base,
          id: "src-qa-resync-no-token",
          type: "github",
          externalId: "acme/a",
          name: "a",
          encryptedTokens: null,
        },
        { ...base, id: "src-qa-resync-syncing", type: "github", externalId: "acme/b", name: "b", status: "syncing" },
        {
          ...base,
          id: "src-qa-resync-access-lost",
          type: "github",
          externalId: "acme/c",
          name: "c",
          status: "error",
          meta: { accessLost: true },
        },
        { ...base, id: "src-qa-resync-posthog", type: "posthog", externalId: "1", name: "insight" },
        { ...base, id: "src-qa-resync-slack", type: "slack", externalId: "C1", name: "channel" },
        {
          ...base,
          id: "src-qa-resync-gdrive",
          type: "gdrive",
          externalId: "folder",
          name: "folder",
          encryptedTokens: null,
        },
      ],
    });

    expect(await runSchedule()).toEqual([]);
  });

  it("leaves a source disconnected after its scheduled sync was queued disconnected, with nothing ingested", async () => {
    stubGitHub("present");
    const queued = await runSchedule();
    expect(queued.map((e) => e.data.sourceId)).toEqual([SOURCE_ID]);
    // The disconnect lands between the schedule queueing the run and the run starting.
    await db.source.update({ where: { id: SOURCE_ID }, data: { status: "disconnected", encryptedTokens: null } });

    for (const event of queued) expect(await runSync(event.data)).toMatchObject({ disconnected: true });

    const source = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
    expect(source.status).toBe("disconnected");
    expect(source.encryptedTokens).toBeNull();
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toEqual([]);
    expect(await runSchedule()).toEqual([]);
  });

  // A source that lost access, then had a sync asked for that died in `syncing`.
  it.each([[{}], [{ accessLost: true }]])(
    "picks a source with meta %j back up once it has sat in syncing past the stale bound",
    async (meta) => {
      const stale = new Date(Date.now() - resyncModule.STALE_SYNCING_MS - 60_000);
      await db.source.update({ where: { id: SOURCE_ID }, data: { meta } });
      await db.$executeRaw`UPDATE sources SET status = 'syncing', "updatedAt" = ${stale} WHERE id = ${SOURCE_ID}`;

      expect((await runSchedule()).map((e) => e.data.sourceId)).toEqual([SOURCE_ID]);
    },
  );
});
