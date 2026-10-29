// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An issue GitHub's listing did not return yet, against a real database.
//
// GitHub's list endpoints are eventually consistent: an issue opened a few seconds
// before a sync can be missing from that sync's `GET /repos/:repo/issues`, even though
// creating it already returned 201. The claim under test: the connector never treats
// a missed item as seen. Each sync reads back an hour past the start of the one
// before it, and a reconnect starts the listing over from the whole history, so the
// first sync whose listing includes the issue ingests it, even when the issue's
// `updated_at` is older than the sync that missed it.
//
// The real `listRepositoryItems` builds the requests (only `fetch` is a double, and it
// honours GitHub's `since` parameter, so a listing that asked for "changed since the
// last sync" would really lose the issue), and the real `sourceSync` job writes
// `Source` and `SourceFile` rows in Postgres. Graphiti is an in-memory double holding
// facts by group and stamped source id, as in `inngest.github-permission-loss.realdb.test.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

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

const ORG = "org-qa-github-late-listed-issue";
const SOURCE_ID = "src-qa-github-late-listed-issue";
const SCOPE = "org_qa.scratch";

interface UpstreamIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  updated_at: string;
  /** False while GitHub's listing does not return the issue yet. */
  listed: boolean;
}

/** A repository with nineteen closed issues, the scratch repository's shape after a day of measures. */
function scratchRepository(): UpstreamIssue[] {
  return Array.from({ length: 19 }, (_, i) => ({
    number: i + 1,
    title: `Seeded test record ${i + 1}`,
    body: `Seeded test record, closed by the suite that opened it (${i + 1}).`,
    state: "closed" as const,
    updated_at: `2026-10-08T${String(10 + Math.floor(i / 2)).padStart(2, "0")}:00:00Z`,
    listed: true,
  }));
}

/** GitHub as one token sees it: the issues listing returns only `listed` issues, newest first, filtered by `since`. */
function stubGitHub(issues: UpstreamIssue[]) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/repos/acme/scratch") return json(200, { full_name: "acme/scratch", default_branch: "main" });
    if (pathname.endsWith("/readme")) {
      return json(200, {
        content: Buffer.from("Scratch repository for measures.").toString("base64"),
        encoding: "base64",
      });
    }
    if (pathname.endsWith("/issues")) {
      const since = searchParams.get("since");
      const page = issues
        .filter((issue) => issue.listed && (!since || issue.updated_at >= since))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, Number(searchParams.get("per_page") ?? 30))
        .map(({ listed: _listed, ...issue }) => issue);
      return json(200, page);
    }
    if (pathname.endsWith("/pulls")) return json(200, []);
    // One issue asked for by number, as a sync's deletion probe does: GitHub has
    // it whether or not its listing returns it yet.
    const one = /\/issues\/(\d+)$/.exec(pathname);
    if (one) {
      const issue = issues.find((i) => i.number === Number(one[1]));
      return issue ? json(200, { number: issue.number }) : json(404, { message: "Not Found" });
    }
    if (/\/commits\/[^/]+$/.test(pathname)) return json(200, {});
    if (pathname.endsWith("/commits"))
      return json(200, [{ sha: "c86e1f5aaaaaaa", commit: { message: "Initial commit" } }]);
    return json(404, { message: "Not Found" });
  });
}

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("an issue GitHub's listing did not return yet", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");

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
    graphiti.reset();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "github",
        externalId: "acme/scratch",
        name: "acme/scratch",
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
  const ingested = (needle: string) => graphiti.retrievable(SCOPE, SOURCE_ID).filter((t) => t.includes(needle));
  const lastSyncAt = async () =>
    ((await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } })).meta as { lastSyncAt?: string }).lastSyncAt;

  it("is ingested by the next sync, though it was opened before the sync that missed it", async () => {
    const issues = scratchRepository();
    const opened: UpstreamIssue = {
      number: 20,
      title: "Seeded test record (derived-stale probe)",
      body: "The release train leaves on Tuesdays.",
      state: "open",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      listed: false,
    };
    issues.push(opened);

    stubGitHub(issues);
    const first = await runSync();
    expect(first).toMatchObject({ files: 21, failed: 0, disconnected: false });
    expect(ingested("release train")).toEqual([]);
    const missedAt = await lastSyncAt();
    expect(missedAt! > opened.updated_at).toBe(true);

    opened.listed = true;
    const second = await runSync();

    expect(ingested("release train")).toHaveLength(1);
    // The README, the issue and the commit: the nineteen issues unchanged since
    // the morning are not read again, and none of them is retired for that.
    expect(second).toMatchObject({ files: 3, synced: 1, skipped: 2, failed: 0 });
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toHaveLength(22);
  });

  it("is ingested by the first sync after a reconnect, whatever the row recorded for earlier connects", async () => {
    // The row as an earlier connect of the same repository left it: every item it
    // listed recorded, and a cursor newer than the issue opened since. A reconnect
    // writes its own authorization onto the row (app/api/sources/route.ts).
    const issues = scratchRepository();
    stubGitHub(issues);
    await runSync();
    await db.source.update({
      where: { id: SOURCE_ID },
      data: { status: "active", connectAuthorizationId: "audit-reconnect" },
    });

    issues.push({
      number: 20,
      title: "Seeded test record (re-sync probe)",
      body: "Lofalqui Tabexlo asked for a quote.",
      state: "open",
      updated_at: "2026-10-08T00:00:00Z",
      listed: true,
    });
    await runSync();

    expect(ingested("Lofalqui Tabexlo")).toHaveLength(1);
  });
});
