// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A sync that began under a rejected credential picks up the one a reconnect
// stored, against a real database.
//
// The claim under test:
// `sourceSync` captures the `Source` row once, in `load-source`, and Inngest
// replays that snapshot on every retry of a later step. When GitHub rejects the
// stored token, the `list-items` step is retried with backoff, and a reconnect
// that replaces the token can land between those attempts. The next attempt
// has to list with the token stored now, not the rejected one in the snapshot:
// otherwise it fails again, and its terminal write puts the old failure back on
// a row the reconnect had just cleared.
//
// The real POST /api/sources handler and the real `sourceSync` job run against
// Postgres, with real sealing (lib/crypto), so the token the retry reads back is
// the one the reconnect stored. GitHub is a double that rejects one token and
// serves the repository to another; Graphiti is an in-memory double. The step
// runner below models Inngest's execution: memoized steps replay, and a step
// that throws ends the attempt without reaching the handler's own catch, which
// Inngest only does once the retries are spent.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
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
// app/api/sources/route.scope-admin-authz.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: async () => ({ allowed: true }),
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-reconnect-stale-credential";
const USER = "user-qa-reconnect-stale-credential";
const REPO = "acme/pricing";
const SCOPE = "org_qa.reconnect_stale_credential";

type SyncEvent = { name: string; data: { sourceId: string; orgId: string; token: string } };
type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};
type SyncResult = Record<string, unknown>;
type SourceMeta = { error?: string; synced?: number };

/** What one Inngest attempt at a run ends with: the handler's result, or the
 *  step that threw and what it threw. */
type Attempt =
  | { result: SyncResult; failure?: undefined }
  | { result?: undefined; failure: { step: string; error: unknown } };

describe.skipIf(!QA_URL)("a sync retried after a reconnect replaced its rejected credential", () => {
  let db: PrismaClient;
  let handler: (ctx: StepCtx) => Promise<SyncResult>;
  let POST: (typeof import("@/app/api/sources/route"))["POST"];
  let unsealSecret: (typeof import("@/lib/crypto"))["unsealSecret"];
  const sent: SyncEvent[] = [];

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
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
    return { status: res.status, body: (await res.json()) as { source: { id: string } } };
  };

  /**
   * One attempt at a run, as Inngest executes it. A step whose result is in
   * `memo` is replayed from there; a step that runs is memoized. A step that
   * throws ends the attempt as a retriable step error: the handler's promise is
   * abandoned, exactly as Inngest abandons it, so the handler's own catch does
   * not run. `executed` lists the steps this attempt ran rather than replayed.
   */
  const attempt = (event: SyncEvent, memo: Map<string, unknown>, executed: string[] = []): Promise<Attempt> => {
    let halt!: (failure: { step: string; error: unknown }) => void;
    const halted = new Promise<Attempt>((resolve) => {
      halt = (failure) => resolve({ failure });
    });
    const ctx: StepCtx = {
      event: { data: event.data },
      step: {
        run: async (name, fn) => {
          if (memo.has(name)) return memo.get(name) as Awaited<ReturnType<typeof fn>>;
          executed.push(name);
          try {
            const out = await fn();
            memo.set(name, out);
            return out;
          } catch (error) {
            halt({ step: name, error });
            return new Promise<never>(() => {});
          }
        },
      },
    };
    return Promise.race([handler(ctx).then((result) => ({ result }) as Attempt), halted]);
  };

  const row = () => db.source.findFirstOrThrow({ where: { orgId: ORG, type: "github", externalId: REPO } });
  const storedToken = async () => (unsealSecret((await row()).encryptedTokens!) as { token: string }).token;

  /** Connect with a token GitHub rejects and run the sync's first attempt,
   *  which fails listing the repository and is left waiting for its retry. */
  const failFirstAttempt = async (memo: Map<string, unknown>) => {
    const first = await connect(BAD_TOKEN);
    expect(first.status).toBe(201);
    const run = await attempt(sent[0], memo);
    expect(run.failure?.step).toBe("list-items");
    expect(run.failure?.error).toMatchObject({ message: expect.stringMatching(/401 Bad credentials/) });
    expect((await row()).status).toBe("syncing");
    return first.body.source.id;
  };

  it("the retry lists with the token the reconnect stored, then leaves the writing to the reconnect's own sync", async () => {
    const memo = new Map<string, unknown>();
    const sourceId = await failFirstAttempt(memo);

    const again = await connect(GOOD_TOKEN);
    expect(again.status).toBe(201);
    expect(again.body.source.id).toBe(sourceId);
    expect(await storedToken()).toBe(GOOD_TOKEN);

    const executed: string[] = [];
    const retry = await attempt(sent[0], memo, executed);

    // The snapshot was replayed, not reloaded: only the listing read the row again.
    expect(executed).not.toContain("load-source");
    expect(retry.failure).toBeUndefined();
    // The reconnect fired its own sync, so this run stands down at its first item
    // instead of running a second full sync beside it, and never writes the old failure back.
    expect(executed).toContain("list-items");
    expect(retry.result).toMatchObject({ synced: 0, failed: 0, superseded: true, disconnected: false });
    expect((await row()).meta as SourceMeta).not.toHaveProperty("error");
    expect(graphiti.facts.filter((f) => f.sourceId === sourceId)).toHaveLength(0);

    const own = await attempt(sent[1], new Map());
    expect(own.result).toMatchObject({ synced: 2, failed: 0, superseded: false });
    const synced = await row();
    expect(synced.status).toBe("active");
    expect((synced.meta as SourceMeta).error).toBeUndefined();
    expect((synced.meta as SourceMeta).synced).toBe(2);
    expect(graphiti.facts.filter((f) => f.sourceId === sourceId)).toHaveLength(2);
  });

  it("the sync the reconnect fired ingests each item once", async () => {
    const memo = new Map<string, unknown>();
    const sourceId = await failFirstAttempt(memo);
    await connect(GOOD_TOKEN);
    await attempt(sent[0], memo);

    // Inngest runs them one at a time per source (sourceSync's concurrency key).
    const own = await attempt(sent[1], new Map());

    expect(own.result).toMatchObject({ synced: 2, skipped: 0, failed: 0 });
    expect(await row()).toMatchObject({ status: "active" });
    expect(graphiti.facts.filter((f) => f.sourceId === sourceId)).toHaveLength(2);
  });

  it("control: a retry with no reconnect in between fails on the same credential", async () => {
    const memo = new Map<string, unknown>();
    await failFirstAttempt(memo);

    const retry = await attempt(sent[0], memo);

    expect(retry.failure?.step).toBe("list-items");
    expect(retry.failure?.error).toMatchObject({ message: expect.stringMatching(/401 Bad credentials/) });
    expect(await storedToken()).toBe(BAD_TOKEN);
    expect(graphiti.facts).toEqual([]);
  });
});
