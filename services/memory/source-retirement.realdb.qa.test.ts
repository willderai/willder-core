// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Which scopes a source's retirement covers, against a real database.
//
// `services/memory/source-retirement.ts` decides WHICH scopes a purge covers,
// which is the whole security property: get the scope set wrong and content
// stays retrievable in a scope the operator thought they had emptied.
// `app/api/sources/route.reconnect-scope-reconcile.test.ts` mocks `@/lib/db`
// and the store wholesale, so neither the `distinct` query that builds the
// scope set nor the three-way `(orgId, scopePath, sourceId)` chunk predicate
// runs against a database there.
//
// Here both run for real, against Postgres 16 with ltree. The graph store is a
// fake — there is no memory service in this environment — but it records the
// `(groupId, sourceId)` pairs it was actually asked to purge, so the assertions
// turn on which partitions the code addressed rather than on a call count.
//
// Two tenants and two scopes throughout, plus a second source sharing a scope,
// because the purge is filtered on `source.id` precisely so one source's
// retirement cannot take another's content with it.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-145";
const OTHER_ORG = "org-qa-145-other";

// Both orgs use the identical scope path strings, so only the tenant filter
// separates their content.
const OLD_SCOPE = "org_1.sales";
const NEWER_SCOPE = "org_1.sales.eu";
const CURRENT_SCOPE = "org_1.engineering";

/** Purges the fake store was asked to perform, in order. */
const purges: Array<{ groupId: string; sourceId?: string }> = [];
/** Group ids the fake store should reject, to exercise the failure path. */
const failingGroups = new Set<string>();

vi.mock("./store", () => ({
  graphitiStore: {
    removeGroupFacts: vi.fn(async ({ groupId, sourceId }: { groupId: string; sourceId?: string }) => {
      purges.push({ groupId, sourceId });
      if (failingGroups.has(groupId)) throw new Error(`memory service unavailable for ${groupId}`);
      return { removedCount: 1 };
    }),
  },
}));

describe.skipIf(!QA_URL)("which scopes a source's retirement covers", () => {
  let db: PrismaClient;
  let listIngestedScopePaths: (typeof import("./source-retirement"))["listIngestedScopePaths"];
  let retireSourceContent: (typeof import("./source-retirement"))["retireSourceContent"];

  let sourceId = "";
  let otherSourceId = "";

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.source.deleteMany({ where: { orgId } });
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  /** `(scopePath, sourceId)` of every surviving chunk in an org. */
  async function survivingChunks(orgId: string) {
    const rows = await db.memoryChunk.findMany({
      where: { orgId },
      select: { scopePath: true, sourceId: true, content: true },
      orderBy: { content: "asc" },
    });
    return rows.map((r) => `${r.scopePath}|${r.sourceId ?? "null"}|${r.content}`);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ listIngestedScopePaths, retireSourceContent } = await import("./source-retirement"));
    await clearTenants();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.create({ data: { id: orgId, name: orgId } });
    }
  });

  beforeEach(async () => {
    purges.length = 0;
    failingGroups.clear();

    await db.memoryChunk.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.source.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });

    // The source under test has been reconnected twice: it wrote under
    // OLD_SCOPE, then NEWER_SCOPE, and now points at CURRENT_SCOPE.
    const source = await db.source.create({
      data: { orgId: ORG, type: "website", externalId: "acme.test", name: "acme", scopePath: CURRENT_SCOPE },
    });
    sourceId = source.id;
    await db.sourceFile.createMany({
      data: [
        { sourceId, externalFileId: "f1", checksum: "c1", episodeId: "ep1", episodeScopePath: OLD_SCOPE },
        { sourceId, externalFileId: "f2", checksum: "c2", episodeId: "ep2", episodeScopePath: OLD_SCOPE },
        { sourceId, externalFileId: "f3", checksum: "c3", episodeId: "ep3", episodeScopePath: NEWER_SCOPE },
        // Legacy row: written before the column existed, no recorded scope.
        { sourceId, externalFileId: "f4", checksum: "c4", episodeId: "ep4", episodeScopePath: null },
      ],
    });

    // A second source in the same org sharing OLD_SCOPE, and its content.
    const other = await db.source.create({
      data: { orgId: ORG, type: "website", externalId: "other.test", name: "other", scopePath: OLD_SCOPE },
    });
    otherSourceId = other.id;

    await db.memoryChunk.createMany({
      data: [
        { orgId: ORG, scopePath: OLD_SCOPE, sourceId, content: "mine-old" },
        { orgId: ORG, scopePath: NEWER_SCOPE, sourceId, content: "mine-newer" },
        { orgId: ORG, scopePath: CURRENT_SCOPE, sourceId, content: "mine-current" },
        { orgId: ORG, scopePath: OLD_SCOPE, sourceId: otherSourceId, content: "other-source-same-scope" },
        // Ingested before the provenance marker existed: no sourceId at all.
        { orgId: ORG, scopePath: OLD_SCOPE, sourceId: null, content: "legacy-unattributed" },
        // Same scope path strings, different tenant.
        { orgId: OTHER_ORG, scopePath: OLD_SCOPE, sourceId, content: "other-org-old" },
        { orgId: OTHER_ORG, scopePath: CURRENT_SCOPE, sourceId, content: "other-org-current" },
      ],
    });
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  describe("listIngestedScopePaths()", () => {
    it("returns the current scope first, then every distinct recorded scope, ignoring rows that recorded none", async () => {
      const paths = await listIngestedScopePaths({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE });
      expect(paths[0]).toBe(CURRENT_SCOPE);
      expect([...paths].sort()).toEqual([CURRENT_SCOPE, NEWER_SCOPE, OLD_SCOPE].sort());
      // OLD_SCOPE is recorded on two rows and must appear once.
      expect(paths).toHaveLength(3);
    });

    it("returns only the current scope for a source whose rows recorded none", async () => {
      await db.sourceFile.updateMany({ where: { sourceId }, data: { episodeScopePath: null } });
      expect(await listIngestedScopePaths({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE })).toEqual([
        CURRENT_SCOPE,
      ]);
    });
  });

  describe("retireSourceContent()", () => {
    it("purges this source's chunks in every scope it wrote to, and nothing else", async () => {
      const result = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE }, null);

      expect(result.retiredChunks).toBe(3);
      expect([...result.scopePaths].sort()).toEqual([CURRENT_SCOPE, NEWER_SCOPE, OLD_SCOPE].sort());

      // Every graph purge was filtered on this source, never on scope alone.
      expect(purges.every((p) => p.sourceId === sourceId)).toBe(true);
      expect(purges.map((p) => p.groupId).sort()).toEqual([CURRENT_SCOPE, NEWER_SCOPE, OLD_SCOPE].sort());

      // The other source's content in the SAME scope survives, and so does the
      // unattributed legacy chunk -- that second one is the documented limit of
      // source-filtered retirement (a chunk with no sourceId cannot be
      // attributed), asserted here so it stays visible.
      expect(await survivingChunks(ORG)).toEqual([
        `${OLD_SCOPE}|null|legacy-unattributed`,
        `${OLD_SCOPE}|${otherSourceId}|other-source-same-scope`,
      ]);
    });

    it("never crosses the tenant boundary, for identical scope path strings and the same source id", async () => {
      await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE }, null);
      expect(await survivingChunks(OTHER_ORG)).toEqual([
        `${CURRENT_SCOPE}|${sourceId}|other-org-current`,
        `${OLD_SCOPE}|${sourceId}|other-org-old`,
      ]);
    });

    it("leaves a scope it did not write to alone even when the org holds content there", async () => {
      const untouched = "org_1.finance";
      await db.memoryChunk.create({ data: { orgId: ORG, scopePath: untouched, sourceId, content: "elsewhere" } });
      await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE }, null);
      expect(purges.map((p) => p.groupId)).not.toContain(untouched);
      expect(await survivingChunks(ORG)).toContain(`${untouched}|${sourceId}|elsewhere`);
    });

    it("propagates a store failure, leaves later scopes untouched, and finishes the job on retry", async () => {
      // The store rejects whichever scope the code reaches second.
      const order = await listIngestedScopePaths({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE });
      const secondScope = order[1];
      failingGroups.add(secondScope);

      await expect(retireSourceContent({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE }, null)).rejects.toThrow(
        /memory service unavailable/,
      );

      // It stopped at the failure: the third scope was never addressed.
      expect(purges.map((p) => p.groupId)).toEqual([order[0], secondScope]);
      // The first scope's chunks are already gone, so a partial run is not a
      // silent no-op either.
      const afterFailure = await survivingChunks(ORG);
      expect(afterFailure.some((c) => c.startsWith(`${order[0]}|${sourceId}|`))).toBe(false);

      // The caller retries; every delete is idempotent, so the retry finishes.
      failingGroups.clear();
      purges.length = 0;
      const result = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: CURRENT_SCOPE }, null);
      expect([...result.scopePaths].sort()).toEqual([CURRENT_SCOPE, NEWER_SCOPE, OLD_SCOPE].sort());
      expect(await survivingChunks(ORG)).toEqual([
        `${OLD_SCOPE}|null|legacy-unattributed`,
        `${OLD_SCOPE}|${otherSourceId}|other-source-same-scope`,
      ]);
    });
  });
});
