// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A source whose last sync failed on its credential recovers when it is
// reconnected with a working one, against a real database.
//
// The claim under test:
// connecting a GitHub repository that already has a Source row in `error`,
// because its stored token was rejected, replaces the stored token, asks for a
// new sync, and that sync ingests the repository and clears the old error. The
// previous status gates none of it. Until the new sync finishes, the row says a
// sync was requested after the failed one instead of still reporting the failure.
//
// The real POST /api/sources handler and the real `sourceSync` job run against
// Postgres, with real sealing (lib/crypto) so the token the sync reads back is
// the one the connect stored. GitHub is a double that rejects one token and
// serves the repository to another; Graphiti is an in-memory double. The
// Inngest client is spied so the test runs the exact event the route sent.
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

const BAD_TOKEN = "github_pat_revoked";
const GOOD_TOKEN = "github_pat_working";

const graphiti = vi.hoisted(() => {
  const facts: { group: string; sourceId: string | undefined; text: string }[] = [];
  let nextId = 0;
  return {
    facts,
    reset() {
      facts.length = 0;
      nextId = 0;
    },
    memory: {
      ingest: async (input: { groupId: string; scopePath?: string; content: string; sourceId?: string }) => {
        facts.push({ group: input.scopePath ?? input.groupId, sourceId: input.sourceId, text: input.content });
        return { episodeId: `episode-${++nextId}` };
      },
    },
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
    listRepositoryItems: async (_repo: string, token: string) => {
      if (token !== GOOD_TOKEN)
        throw new actual.GitHubConnectorError("GitHub /repos/acme/pricing failed: 401 Bad credentials");
      return {
        items: [
          { id: "README.md", text: "The WebSocket server pushes 55 updates per minute.", checksum: "r1" },
          { id: "docs/ops.md", text: "Deploys run from main.", checksum: "o1" },
        ],
        unreadable: [],
      };
    },
  };
});
// Who is asking is not under test here; the route's scope checks are covered by
// route.scope-admin-authz.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: async () => ({ allowed: true }),
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-reconnect-after-failed-sync";
const USER = "user-qa-reconnect-after-failed-sync";
const REPO = "acme/pricing";
const SCOPE = "org_qa.reconnect_after_failed_sync";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string; token: string } };
type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};
type SourceMeta = { error?: string; lastSyncAt?: string; syncRequestedAt?: string; synced?: number };

describe.skipIf(!QA_URL)("reconnecting a source whose last sync failed on its credential", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("@/lib/inngest");
  let POST: (typeof import("./route"))["POST"];
  let unsealSecret: (typeof import("@/lib/crypto"))["unsealSecret"];
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
    ({ POST } = await import("./route"));
    ({ unsealSecret } = await import("@/lib/crypto"));
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
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "pricing" } });
  });

  const connect = async (token: string) => {
    const res = await POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "github", repo: REPO, token, scopePath: SCOPE }),
      }),
    );
    return { status: res.status, body: (await res.json()) as { source: { id: string }; jobId?: string } };
  };

  /** Run the real sync job for an event the route sent, as Inngest would. */
  const runSync = (event: SyncEvent) => {
    const ctx: StepCtx = { event: { data: event.data }, step: { run: async (_name, fn) => fn() } };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<Record<string, unknown>> }).fn(ctx);
  };

  const row = () => db.source.findFirstOrThrow({ where: { orgId: ORG, type: "github", externalId: REPO } });
  const storedToken = async () => (unsealSecret((await row()).encryptedTokens!) as { token: string }).token;

  /** Connect with a token GitHub rejects and let that sync fail. */
  const failFirstSync = async () => {
    const first = await connect(BAD_TOKEN);
    expect(first.status).toBe(201);
    await expect(runSync(sent[0])).rejects.toThrow(/401 Bad credentials/);
    const failed = await row();
    expect(failed.status).toBe("error");
    expect((failed.meta as SourceMeta).error).toMatch(/GitHub rejected this repository.s token\..*reconnect it/);
    return failed;
  };

  it("stores the new token, fires a new sync, and that sync ingests the repository", async () => {
    const failed = await failFirstSync();

    const again = await connect(GOOD_TOKEN);

    expect(again.status).toBe(201);
    expect(again.body.source.id).toBe(failed.id);
    expect(again.body.jobId).toBe("job-2");
    expect(await storedToken()).toBe(GOOD_TOKEN);
    expect(sent).toHaveLength(2);
    expect(sent[1].data).toEqual({ sourceId: failed.id, orgId: ORG, syncRequestId: expect.any(String) });

    const result = await runSync(sent[1]);

    expect(result).toMatchObject({ synced: 2, failed: 0, disconnected: false });
    const synced = await row();
    expect(synced.status).toBe("active");
    const meta = synced.meta as SourceMeta;
    expect(meta.error).toBeUndefined();
    expect(meta.synced).toBe(2);
    expect(Date.parse(meta.lastSyncAt!)).toBeGreaterThan(Date.parse((failed.meta as SourceMeta).lastSyncAt!));
    expect(graphiti.facts.filter((f) => f.sourceId === failed.id)).toHaveLength(2);
  });

  it("stops reporting the old failure, or lost access, as soon as the new sync is requested", async () => {
    const failed = await failFirstSync();
    const failedAt = (failed.meta as SourceMeta).lastSyncAt!;
    // As a sync that met a repository the token could not read leaves it.
    await db.source.update({
      where: { id: failed.id },
      data: { meta: { ...(failed.meta as object), accessLost: true } },
    });

    await connect(GOOD_TOKEN);

    const pending = (await row()).meta as SourceMeta & { accessLost?: unknown };
    expect(pending.error).toBeUndefined();
    expect(pending.accessLost).toBeUndefined();
    // The failed run's own record stays, so a reader sees the order: it failed,
    // then a new sync was asked for and has not finished yet.
    expect(pending.lastSyncAt).toBe(failedAt);
    expect(Date.parse(pending.syncRequestedAt!)).toBeGreaterThanOrEqual(Date.parse(failedAt));
  });

  it("a retried connect while the first is pending dedupes to one row, and only the newer sync runs", async () => {
    const failed = await failFirstSync();

    await connect(GOOD_TOKEN);
    await connect(GOOD_TOKEN);

    expect(await db.source.count({ where: { orgId: ORG, type: "github", externalId: REPO } })).toBe(1);
    expect(sent.slice(1).map((e) => e.data.sourceId)).toEqual([failed.id, failed.id]);
    // The first connect's sync was replaced while queued, so it starts nothing; the
    // retry's sync does the work once (lib/inngest.retried-connect-one-sync.realdb.test.ts).
    const first = await runSync(sent[1]);
    const second = await runSync(sent[2]);

    expect(first).toMatchObject({ synced: 0, superseded: true });
    expect(second).toMatchObject({ synced: 2, failed: 0, superseded: false });
    expect(await row()).toMatchObject({ status: "active" });
    expect(graphiti.facts.filter((f) => f.sourceId === failed.id)).toHaveLength(2);
  });

  it("control: reconnecting with the same rejected token fails again and records the new failure", async () => {
    await failFirstSync();

    await connect(BAD_TOKEN);
    await expect(runSync(sent[1])).rejects.toThrow(/401 Bad credentials/);

    const again = await row();
    expect(again.status).toBe("error");
    expect((again.meta as SourceMeta).error).toMatch(/GitHub rejected this repository.s token\..*reconnect it/);
    expect(graphiti.facts).toEqual([]);
  });
});
