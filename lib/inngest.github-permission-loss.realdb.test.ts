// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A GitHub token that loses one permission between syncs, against a real database.
//
// The claim under test:
// when the stored token can still read the repository but GitHub answers one kind's
// listing with a permission-denied 403, the sync completes with what it can read,
// names the skipped kind on `Source.meta.unreadable`, and retires what that kind
// ingested earlier, so it stops being retrievable. A rate-limit 403 is not a lost
// permission: that sync fails and retires nothing. Restoring the permission brings
// the kind back and clears the note. A failed sync stores a line naming the fix, never
// GitHub's raw answer, and a sync that lost access keeps no earlier run's counts.
//
// The real `listRepositoryItems` classifies the 403s (only `fetch` is a double), and
// the real `sourceSync` job writes `Source` and `SourceFile` rows in Postgres. Graphiti
// is an in-memory double holding facts by group and stamped source id, the same
// shape as `inngest.disconnect-mid-sync.realdb.test.ts`.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
// Skips cleanly without it.
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

const ORG = "org-qa-github-permission-loss";
const SOURCE_ID = "src-qa-github-permission-loss";
const SCOPE = "org_qa.engineering";

const PERMISSION_DENIED = { message: "Resource not accessible by personal access token" };
const RATE_LIMITED = { message: "API rate limit exceeded for user ID 1." };
const BAD_CREDENTIALS = { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" };
const RATE_LIMIT_LINE = "GitHub's rate limit stopped this sync. Nothing needs changing: sync again in an hour.";

/**
 * GitHub as seen by one token; `issues` decides how the issues listing answers.
 * `repo` "not-found" is GitHub's answer to a token that cannot see a private
 * repository (or to a deleted one), and then every path under it answers 404 too.
 */
function stubGitHub(
  issues: "ok" | "denied" | "rate-limited" | "expired" | "probe-expired",
  repo: "ok" | "not-found" | "denied" | "expired" = "ok",
) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (repo === "not-found") return json(404, { message: "Not Found" });
    if (repo === "expired") return json(401, BAD_CREDENTIALS);
    if (path === "/repos/acme/pricing" && repo === "denied") return json(403, PERMISSION_DENIED);
    if (path === "/repos/acme/pricing") return json(200, { full_name: "acme/pricing", default_branch: "main" });
    if (path.endsWith("/readme")) {
      return json(200, { content: Buffer.from("Pricing service readme").toString("base64"), encoding: "base64" });
    }
    if (path.endsWith("/issues")) {
      if (issues === "denied") return json(403, PERMISSION_DENIED);
      if (issues === "rate-limited") return json(403, RATE_LIMITED);
      if (issues === "expired") return json(401, BAD_CREDENTIALS);
      if (issues === "probe-expired") return json(200, []);
      return json(200, [{ number: 9, title: "Quotes drift after midnight", state: "open", body: "secret-issue-body" }]);
    }
    if (path.endsWith("/pulls")) return json(200, []);
    if (path.endsWith("/issues/comments")) return json(200, []);
    // One item asked for by id, as a sync's deletion probe does: it still exists.
    if (/\/(issues|pulls|commits)\/[^/]+$/.test(path))
      return issues === "probe-expired" ? json(401, BAD_CREDENTIALS) : json(200, {});
    // The stored commit no longer listed, so the sync asks GitHub for it by sha.
    if (path.endsWith("/commits"))
      return issues === "probe-expired"
        ? json(200, [])
        : json(200, [{ sha: "abcdef1234567", commit: { message: "init" } }]);
    return json(404, { message: "Not Found" });
  });
}

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a GitHub token that loses one permission, or the whole repository, between syncs", () => {
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
  const source = () => db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
  const storedIds = async () =>
    (await db.sourceFile.findMany({ where: { sourceId: SOURCE_ID }, orderBy: { externalFileId: "asc" } })).map(
      (f) => f.externalFileId,
    );
  const issueRetrievable = () => graphiti.retrievable(SCOPE, SOURCE_ID).some((t) => t.includes("secret-issue-body"));

  it("retires the issues a token can no longer read, keeps the rest, and names the kind", async () => {
    stubGitHub("ok");
    await runSync();
    expect(issueRetrievable()).toBe(true);
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "issue-9", "readme"]);

    stubGitHub("denied");
    const result = await runSync();

    expect(result).toMatchObject({ failed: 0, disconnected: false });
    expect(issueRetrievable()).toBe(false);
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toHaveLength(2);
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "readme"]);
    const row = await source();
    expect(row.status).toBe("active");
    expect(row.meta).toMatchObject({ unreadable: ["issues"], failed: 0 });
  });

  it("brings the issues back and clears the note once the permission returns", async () => {
    stubGitHub("denied");
    await runSync();
    expect((await source()).meta).toMatchObject({ unreadable: ["issues"] });

    stubGitHub("ok");
    await runSync();

    expect(issueRetrievable()).toBe(true);
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "issue-9", "readme"]);
    expect((await source()).meta).toMatchObject({ unreadable: [] });
  });

  it("a first sync with no Issues read still ingests the README as this source's fact", async () => {
    stubGitHub("denied");
    const result = await runSync();

    expect(result).toMatchObject({ synced: 2, failed: 0, disconnected: false });
    expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toEqual(
      expect.arrayContaining([expect.stringContaining("Pricing service readme")]),
    );
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "readme"]);
    const row = await source();
    expect(row.status).toBe("active");
    expect(row.meta).toMatchObject({ unreadable: ["issues"], failed: 0 });
  });

  it("a successful sync clears the error an earlier failed sync left on the source", async () => {
    stubGitHub("rate-limited");
    await runSync().catch(() => undefined);
    expect((await source()).meta).toMatchObject({ error: RATE_LIMIT_LINE });

    stubGitHub("denied");
    await runSync();

    const row = await source();
    expect(row.status).toBe("active");
    expect(row.meta).not.toHaveProperty("error");
  });

  it.each([["not-found"], ["denied"]] as const)(
    "a repository the token can no longer read (%s) keeps everything stored and marks the source access lost",
    async (repo) => {
      stubGitHub("ok");
      await runSync();
      const before = await source();

      stubGitHub("ok", repo);
      // Resolves: a retry would get the same answer, so the run ends here.
      const result = await runSync();

      expect(result).toMatchObject({ accessLost: true, synced: 0, disconnected: false });
      expect(issueRetrievable()).toBe(true);
      expect(graphiti.retrievable(SCOPE, SOURCE_ID)).toHaveLength(3);
      expect(await storedIds()).toEqual(["commit-abcdef1234567", "issue-9", "readme"]);
      const row = await source();
      expect(row.status).toBe("error");
      expect(row.meta).toMatchObject({
        accessLost: true,
        error: expect.stringMatching(/can't read acme\/pricing.*Grant the token access to acme\/pricing/),
        fileCount: 3,
        syncCursor: (before.meta as { syncCursor: unknown }).syncCursor,
      });
    },
  );

  it("a sync that lost access keeps no earlier run's counts or unreadable parts", async () => {
    stubGitHub("denied");
    await runSync();
    expect((await source()).meta).toMatchObject({ unreadable: ["issues"], synced: 2 });

    stubGitHub("ok", "not-found");
    await runSync();

    const meta = (await source()).meta as Record<string, unknown>;
    expect(meta).toMatchObject({ accessLost: true, fileCount: 2 });
    for (const key of ["unreadable", "synced", "skipped", "failed"]) expect(meta).not.toHaveProperty(key);
  });

  // A 401 is GitHub rejecting the token itself, the most common way access ends.
  // Read on the repository, on a listing and on a stored item's probe: every
  // GitHub request of a sync is made in its listing step, so each ends the run.
  it.each([
    ["the repository", "ok", "expired"],
    ["the issues listing", "expired", "ok"],
    ["a stored item it probes", "probe-expired", "ok"],
  ] as const)(
    "a token GitHub rejects on %s stores the fix, not GitHub's answer, and retires nothing",
    async (_where, issues, repo) => {
      stubGitHub("denied");
      await runSync();

      stubGitHub(issues, repo);
      await expect(runSync()).rejects.toThrow(/401 .*Bad credentials/);

      expect(await storedIds()).toEqual(["commit-abcdef1234567", "readme"]);
      const row = await source();
      expect(row.status).toBe("error");
      // The earlier run's skipped issues are not this failed run's finding.
      expect(row.meta).not.toHaveProperty("unreadable");
      expect((row.meta as { error: string }).error).toBe(
        "GitHub rejected this repository's token. It may have expired or been revoked. Create a new token with read access to the repository and reconnect it.",
      );
    },
  );

  it("a source that lost access syncs normally, and stops reporting it, once access is back", async () => {
    stubGitHub("ok");
    await runSync();
    stubGitHub("ok", "not-found");
    await runSync();

    stubGitHub("ok");
    await runSync();

    const row = await source();
    expect(row.status).toBe("active");
    expect(row.meta).not.toHaveProperty("accessLost");
    expect(row.meta).not.toHaveProperty("error");
    expect(issueRetrievable()).toBe(true);
  });

  it("a later failure of another kind replaces the lost-access mark, since it says nothing about access", async () => {
    stubGitHub("ok", "not-found");
    await runSync();

    stubGitHub("rate-limited");
    await runSync().catch(() => undefined);

    const row = await source();
    expect(row.status).toBe("error");
    expect(row.meta).toMatchObject({ error: RATE_LIMIT_LINE });
    expect(row.meta).not.toHaveProperty("accessLost");
  });

  it("a rate-limited listing fails the sync and retires nothing", async () => {
    stubGitHub("ok");
    await runSync();

    stubGitHub("rate-limited");
    await runSync().catch(() => undefined);

    expect(issueRetrievable()).toBe(true);
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "issue-9", "readme"]);
    const row = await source();
    expect(row.status).not.toBe("active");
    expect(row.meta).not.toHaveProperty("unreadable");
  });
});
