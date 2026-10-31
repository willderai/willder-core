// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A README deleted at the source while the GitHub connection is kept, against a real database.
//
// The claim under test: once a sync runs after the
// README is deleted, every section the README was ingested as stops being retrievable, the
// repository's other items stay, and the source stays connected. A deleted README is a 404 on
// GitHub's README endpoint, which the connector must read as "no README", not as "the
// repository is gone" and not as a lost permission. What starts that sync on production, with
// no one asking for it, is measured against a deployment; this file
// proves only what the sync does once it runs.
//
// The real `listRepositoryItems` reads the stubbed GitHub (only `fetch` is a double), and the
// real `sourceSync` job writes `Source` and `SourceFile` rows in Postgres. Graphiti is an
// in-memory double holding facts by group and stamped source id, the same shape as
// `inngest.github-permission-loss.realdb.test.ts`.
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

const ORG = "org-qa-github-readme-deleted";
const SOURCE_ID = "src-qa-github-readme-deleted";
const SCOPE = "org_qa.engineering";

/** A README long enough to be ingested as two sections, `readme` and `readme-2`. */
const README = `# Pricing\n\n${"Quotes are computed nightly. ".repeat(60)}\n\n## Seeded test record\n\nThe Kavelmi release ships on day 9 of the cycle.\n`;

/** GitHub as seen by one token; `readme` decides whether the repository still has one. */
function stubGitHub(readme: "present" | "deleted") {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/repos/acme/pricing") return json(200, { full_name: "acme/pricing", default_branch: "main" });
    if (path.endsWith("/readme")) {
      return readme === "present"
        ? json(200, { content: Buffer.from(README).toString("base64"), encoding: "base64" })
        : json(404, { message: "Not Found" });
    }
    if (path.endsWith("/issues"))
      return json(200, [{ number: 9, title: "Quotes drift after midnight", state: "open", body: "issue-body" }]);
    if (path.endsWith("/pulls")) return json(200, []);
    // One item asked for by id, as a sync's deletion probe does: it still exists.
    if (/\/(issues|pulls|commits)\/[^/]+$/.test(path)) return json(200, {});
    if (path.endsWith("/commits")) return json(200, [{ sha: "abcdef1234567", commit: { message: "init" } }]);
    return json(404, { message: "Not Found" });
  });
}

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a README deleted at the source with the connection kept", () => {
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
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
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
  const storedIds = async () =>
    (await db.sourceFile.findMany({ where: { sourceId: SOURCE_ID }, orderBy: { externalFileId: "asc" } })).map(
      (f) => f.externalFileId,
    );
  const retrievable = () => graphiti.retrievable(SCOPE, SOURCE_ID);
  const readmeRetrievable = () => retrievable().filter((t) => t.startsWith("README of acme/pricing"));

  it("retires every README section on the next sync, keeps the other items, and stays connected", async () => {
    stubGitHub("present");
    await runSync();
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "issue-9", "readme", "readme-2"]);
    expect(readmeRetrievable().some((t) => t.includes("Kavelmi release"))).toBe(true);

    stubGitHub("deleted");
    const result = await runSync();

    expect(result).toMatchObject({ failed: 0, disconnected: false });
    expect(readmeRetrievable()).toEqual([]);
    expect(retrievable()).toHaveLength(2);
    expect(await storedIds()).toEqual(["commit-abcdef1234567", "issue-9"]);
    const row = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
    expect(row.status).toBe("active");
    // A deleted README is not a permission the token lost.
    expect(row.meta).toMatchObject({ unreadable: [], failed: 0 });
  });

  it("announces each retired README section as a delete on the change feed", async () => {
    stubGitHub("present");
    await runSync();
    stubGitHub("deleted");
    await runSync();

    const deletes = await db.changeEvent.findMany({ where: { orgId: ORG, op: "delete" } });
    expect(deletes).toHaveLength(2);
  });
});
