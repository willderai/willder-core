// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A GitHub issue deleted upstream leaves memory even while a sync keeps failing.
//
// The sync stores its cursor only when nothing failed, so a free org held at its
// episode cap never stores one. The deletion probe's offset lives on that same
// cursor; if it is held too, every sync probes the same first slice of stored items
// and a deleted issue past that slice stays retrievable for as long as the cap holds.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const ORG = "org-qa-github-held-probe";
const SOURCE_ID = "src-qa-github-held-probe";
const SCOPE = "org_qa.engineering";
const T0 = Date.parse("2026-10-01T23:00:00Z");

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a deletion probe keeps moving while a sync keeps failing", () => {
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
    vi.useRealTimers();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  const syncAt = async (at: number) => {
    vi.setSystemTime(at);
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG } },
      step: { run: async (_name, fn) => fn() },
    };
    const result = await (
      inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<Record<string, unknown>> }
    ).fn(ctx);
    await db.source.update({ where: { id: SOURCE_ID }, data: { status: "active" } });
    return result;
  };

  it("retires an issue past the first probe slice while the cap stops a new commit", async () => {
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
    repo = busyRepository({ commits: 0, issues: 30, pulls: 0 });
    vi.stubGlobal("fetch", fakeGitHub(repo).fetch);

    await syncAt(T0);
    const held = (await db.org.findUniqueOrThrow({ where: { id: ORG } })).episodeCount;
    await db.org.update({ where: { id: ORG }, data: { episodeCapIncluded: held } });

    // Sorted by id, issue-9 is the last of 30, past the first 20 probes.
    deleteIssues(repo, [9]);
    pushCommits(repo, 1, "capped", 0);

    // pushCommits dates its commits an hour after T0.
    let at = T0 + 90 * 60_000;
    for (let sync = 0; sync < 4; sync++) {
      at += 30 * 60_000;
      expect(await syncAt(at)).toMatchObject({ failed: 1 });
    }

    const issues = graphiti.retrievable(SCOPE, SOURCE_ID).filter((t) => t.startsWith("Issue "));
    expect(issues.some((t) => t.startsWith("Issue #9 "))).toBe(false);
    expect(issues).toHaveLength(29);
  });
});
