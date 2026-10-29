// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A GitHub source keeps its history across syncs, against a real database.
//
// The claims under test: an item leaves memory only when GitHub shows it is gone,
// never because a newer item pushed it off the listing's first page; a sync that
// finds nothing changed writes nothing and draws nothing from the free plan's
// episode cap; a long history arrives over a few bounded syncs; and an item a sync
// could not write (the cap reached) is read again by the next one.
//
// The real `listRepositoryItems` builds every request against a fake GitHub that
// pages, filters by `since`/`until` and answers deletions the way GitHub does
// (services/connectors/fixtures/github.ts). The real `sourceSync` job
// writes `Source`, `SourceFile`, `ChangeEvent` and `Org.episodeCount` in Postgres,
// with the real episode cap. Graphiti is an in-memory double holding facts by group
// and stamped source id, as in `inngest.github-late-listed-issue.realdb.test.ts`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import {
  busyRepository,
  deleteIssues,
  fakeGitHub,
  pushCommits,
  type FakeRepositoryState,
} from "@/services/connectors/fixtures/github";

const graphiti = vi.hoisted(() => {
  const facts: { group: string; sourceId: string | undefined; episodeId: string; text: string }[] = [];
  let nextId = 0;
  return {
    facts,
    ingests: 0,
    reset() {
      facts.length = 0;
      nextId = 0;
      this.ingests = 0;
    },
    retrievable: (group: string, sourceId: string) =>
      facts.filter((f) => f.group === group && f.sourceId === sourceId).map((f) => f.text),
    memory: {
      ingest: async (input: { groupId: string; scopePath?: string; content: string; sourceId?: string }) => {
        graphiti.ingests++;
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
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "github-token" }) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-github-incremental";
const SOURCE_ID = "src-qa-github-incremental";
const SCOPE = "org_qa.engineering";
const HOUR = 60 * 60 * 1000;
/** After every timestamp busyRepository writes, an hour before pushCommits' first. */
const T0 = Date.parse("2026-10-01T23:00:00Z");

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a GitHub source keeps its history across syncs", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let repo: FakeRepositoryState;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    graphiti.reset();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG, plan: "free" } });
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "github",
        externalId: "example-org/busy",
        name: "example-org/busy",
        scopePath: SCOPE,
        encryptedTokens: "sealed",
        connectAuthorizationId: "audit-connect",
      },
    });
  });

  /** Serve `counts` of each kind from now on. */
  const upstream = (counts: { commits?: number; issues?: number }) => {
    repo = busyRepository({ commits: 0, issues: 0, pulls: 0, ...counts });
    vi.stubGlobal("fetch", fakeGitHub(repo).fetch);
  };

  afterEach(() => vi.useRealTimers());

  /** One `sourceSync` run at `at`, and the names of the steps it ran. */
  const syncAt = async (at: number) => {
    vi.setSystemTime(at);
    const steps: string[] = [];
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG } },
      step: {
        run: async (name, fn) => {
          steps.push(name);
          return fn();
        },
      },
    };
    const result = await (
      inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<Record<string, unknown>> }
    ).fn(ctx);
    // The schedule queues only a source that is not mid-sync; a test plays the next run.
    await db.source.update({ where: { id: SOURCE_ID }, data: { status: "active" } });
    return { result, steps };
  };
  const commitsInMemory = () => graphiti.retrievable(SCOPE, SOURCE_ID).filter((t) => t.startsWith("Commit "));
  const deletes = () => db.changeEvent.count({ where: { orgId: ORG, op: "delete" } });
  const episodeCount = async () => (await db.org.findUniqueOrThrow({ where: { id: ORG } })).episodeCount;

  it("keeps a commit that newer commits pushed off the first page", async () => {
    upstream({ commits: 60 });
    await syncAt(T0);
    expect(commitsInMemory()).toHaveLength(60);

    pushCommits(repo, 45, "later", 0);
    const second = await syncAt(T0 + 2 * HOUR);

    expect(second.result).toMatchObject({ synced: 45, failed: 0 });
    expect(commitsInMemory()).toHaveLength(105);
    expect(await deletes()).toBe(0);
    // 105 commits, the README and the file tree (one item: the repository holds only README.md).
    expect(await db.sourceFile.count({ where: { sourceId: SOURCE_ID } })).toBe(107);
  });

  it("reads a busy repository's 900 commits over bounded syncs, and then writes nothing for an unchanged one", async () => {
    upstream({ commits: 900 });
    let at = T0;
    for (let sync = 0; sync < 5; sync++, at += 30 * 60_000) {
      const { steps } = await syncAt(at);
      expect(steps.filter((s) => s.startsWith("process-item-commit-")).length).toBeLessThanOrEqual(200);
    }
    expect(commitsInMemory()).toHaveLength(900);
    expect(new Set(commitsInMemory()).size).toBe(900);
    expect(await deletes()).toBe(0);

    const ingestsBefore = graphiti.ingests;
    const quiet = await syncAt(at);
    expect(quiet.result).toMatchObject({ synced: 0, failed: 0 });
    expect(graphiti.ingests).toBe(ingestsBefore);
    const meta = (await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } })).meta as { fileCount?: number };
    expect(meta.fileCount).toBe(902);
  }, 30_000);

  it("draws on the free plan's cap only for what is new or edited", async () => {
    upstream({ commits: 30 });
    await syncAt(T0);
    // 30 commits, the README and the file tree.
    expect(await episodeCount()).toBe(32);

    await syncAt(T0 + 30 * 60_000);
    await syncAt(T0 + 60 * 60_000);
    expect(await episodeCount()).toBe(32);

    pushCommits(repo, 1, "later", 0);
    await syncAt(T0 + 90 * 60_000);
    expect(await episodeCount()).toBe(33);
    expect(commitsInMemory()).toHaveLength(31);
  });

  it("reads again, once the cap allows, the commits a sync could not write", async () => {
    upstream({ commits: 10 });
    await syncAt(T0);
    await db.org.update({ where: { id: ORG }, data: { episodeCapIncluded: 11 } });

    // Two commits land an hour after that sync. The next one runs four hours
    // after it, so a cursor that moved on would start past them, and the cap
    // stops both writes.
    pushCommits(repo, 2, "capped", 0);
    const capped = await syncAt(T0 + 4 * HOUR);
    expect(capped.result).toMatchObject({ synced: 0, failed: 2 });

    await db.org.update({ where: { id: ORG }, data: { episodeCapIncluded: 1000 } });
    await syncAt(T0 + 4.5 * HOUR);
    expect(commitsInMemory().filter((t) => t.includes("capped"))).toHaveLength(2);
  });

  it("retires an issue deleted on GitHub, and keeps the old ones that merely did not change", async () => {
    upstream({ issues: 2 });
    await syncAt(T0);
    deleteIssues(repo, [2]);
    await syncAt(T0 + 30 * 60_000);

    const issues = graphiti.retrievable(SCOPE, SOURCE_ID).filter((t) => t.startsWith("Issue "));
    expect(issues).toEqual([expect.stringContaining("Issue #1 ")]);
    expect(await deletes()).toBe(1);
  });

  it("brings back what the old windowed sync deleted, on the first sync after this change", async () => {
    // The state a source was left in before this change: only the newest commits
    // stored, the older ones retired, and no cursor on the row.
    upstream({ commits: 60 });
    await syncAt(T0);
    const oldest = repo.commits.slice(-10).map((c) => `commit-${c.sha}`);
    for (const row of await db.sourceFile.findMany({
      where: { sourceId: SOURCE_ID, externalFileId: { in: oldest } },
    })) {
      await graphiti.store.removeEpisode({ groupId: SCOPE, episodeId: row.episodeId! });
    }
    await db.sourceFile.deleteMany({ where: { sourceId: SOURCE_ID, externalFileId: { in: oldest } } });
    await db.source.update({ where: { id: SOURCE_ID }, data: { meta: {} } });
    expect(commitsInMemory()).toHaveLength(50);

    const resync = await syncAt(T0 + 30 * 60_000);

    expect(resync.result).toMatchObject({ synced: 10, failed: 0 });
    expect(commitsInMemory()).toHaveLength(60);
  });
});
