// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The account-tier gate for the task-start block's source-moved flags (`fact_provenance`, status
// `potentially_stale`). A flag names the fact it is about by uuid. On a tier that does not
// read the graph, a flag anchored on a graph edge is not served, because the edge it points
// at is not either; a flag anchored on one of the org's raw rows still is. On enterprise,
// the tier every org has today (no `settings.accountTier`), every flag is served as before.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartStaleTier";
const OTHER_ORG = "qa_taskStartStaleTierOther";
const SCOPE = `org_${ORG}.team`;
const READER = "agent-reader";
const RAW_ROW = "qa-stale-tier-chunk";
const GRAPH_EDGE = "4f0c2a8e-0000-4000-8000-00000000e1e1";
/** A raw row with the same id in another org: it must not anchor this org's flag. */
const FOREIGN_ROW = "qa-stale-tier-foreign";

describe.skipIf(!QA_URL)("task-start source-moved flags by account tier, against a real database", () => {
  let db: PrismaClient;
  let readTaskStartUnchecked: (typeof import("./task-start"))["readTaskStartUnchecked"];

  async function cleanup(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.factProvenance.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
  }

  async function reader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: READER,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: READER, capabilityToken: token }, origin: "mcp" };
  }

  async function flag(graphitiFactUuid: string): Promise<void> {
    await db.factProvenance.create({
      data: {
        orgId: ORG,
        scopePath: SCOPE,
        graphitiFactUuid,
        sourceType: "file",
        sourceRef: `src/${graphitiFactUuid}.ts`,
        ownerId: "agent-author",
        status: "potentially_stale",
        flaggedAt: new Date(),
      },
    });
  }

  async function served(): Promise<string[]> {
    const { context } = await readTaskStartUnchecked(await reader(), SCOPE, "");
    return context.stale.map((f) => f.graphitiFactUuid).sort();
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ readTaskStartUnchecked } = await import("./task-start"));
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.$disconnect();
  });

  async function seed(settings: { accountTier: string } | undefined): Promise<void> {
    await db.org.create({ data: { id: ORG, name: ORG, ...(settings ? { settings } : {}) } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    await db.memoryChunk.create({
      data: { id: RAW_ROW, orgId: ORG, scopePath: SCOPE, content: "the importer retries three times" },
    });
    await db.memoryChunk.create({
      data: { id: FOREIGN_ROW, orgId: OTHER_ORG, scopePath: `org_${OTHER_ORG}.team`, content: "elsewhere" },
    });
    await flag(RAW_ROW);
    await flag(GRAPH_EDGE);
    await flag(FOREIGN_ROW);
  }

  it("serves every flag on an org with no tier set, the enterprise default", async () => {
    await seed(undefined);
    expect(await served()).toEqual([GRAPH_EDGE, FOREIGN_ROW, RAW_ROW].sort());
  });

  it("serves every flag on an org set to enterprise", async () => {
    await seed({ accountTier: "enterprise" });
    expect(await served()).toEqual([GRAPH_EDGE, FOREIGN_ROW, RAW_ROW].sort());
  });

  it("serves only the flag anchored on the org's own raw row on team and on starter", async () => {
    await seed({ accountTier: "team" });
    expect(await served()).toEqual([RAW_ROW]);
    await db.org.update({ where: { id: ORG }, data: { settings: { accountTier: "starter" } } });
    expect(await served()).toEqual([RAW_ROW]);
  });
});
