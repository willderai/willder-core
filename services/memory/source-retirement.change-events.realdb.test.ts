// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A source's retirement has to take its text out of the change feed too.
//
// A connector sync announces every item it ingests as a change event whose
// summary is the first 200 characters of the item's text, stored at the scope
// the item was written to. A reconnect that narrows the source's scope retires
// the chunks and facts there, but used to leave those summaries behind, so the
// feed kept serving the text at the scope the source was pulled out of. That
// includes readers granted the old scope after the move, who never saw it.
//
// Runs `retireSourceContent` (the step the reconnect route runs before moving
// the source) and then reads the feed through `readChanges` with a capability on
// the old scope, against a real Postgres 16 with ltree. The graph store is faked:
// there is no memory service here. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-retire-feed";
const OTHER_ORG = "org-retire-feed-other";
const OLD_SCOPE = "org_rf.sales";
const NEW_SCOPE = "org_rf.sales.leads";
const READER_AGENT = "agent-old-scope-reader";

const SECRET = "Q4 pricing floor for Acme is 41 dollars a seat";

vi.mock("./store", () => ({
  graphitiStore: { removeGroupFacts: vi.fn(async () => ({ removedCount: 0 })) },
}));

describe.skipIf(!QA_URL)("retiring a source redacts its change-event summaries", () => {
  let db: PrismaClient;
  let retireSourceContent: (typeof import("./source-retirement"))["retireSourceContent"];
  let readChanges: (typeof import("./change-feed"))["readChanges"];
  let recordChangeEvent: (typeof import("./change-events"))["recordChangeEvent"];

  let sourceId = "";
  let otherSourceId = "";

  function writeEvent(orgId: string, scopePath: string, recordId: string, actorId: string, title: string) {
    return db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId,
        scopePath,
        recordType: "fact",
        recordId,
        op: "create",
        actorId,
        actorType: "agent",
        origin: "mcp",
        title,
      }),
    );
  }

  /** A fresh capability on `scopePath`, minted after the move, and its context. */
  async function readerOn(scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: READER_AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: READER_AGENT, capabilityToken: token }, origin: "mcp" };
  }

  async function summaries(orgId: string) {
    const rows = await db.changeEvent.findMany({ where: { orgId }, orderBy: { seq: "asc" } });
    return Object.fromEntries(rows.map((r) => [r.recordId, r.summary]));
  }

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const table of ["auditLog", "changeEvent", "agentCursor", "capability", "source"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ retireSourceContent } = await import("./source-retirement"));
    ({ readChanges } = await import("./change-feed"));
    ({ recordChangeEvent } = await import("./change-events"));
  });

  beforeEach(async () => {
    await clearTenants();
    for (const orgId of [ORG, OTHER_ORG]) await db.org.create({ data: { id: orgId, name: orgId } });

    const source = await db.source.create({
      data: { orgId: ORG, type: "slack", externalId: "C-sales", name: "sales", scopePath: OLD_SCOPE },
    });
    sourceId = source.id;
    const other = await db.source.create({
      data: { orgId: ORG, type: "slack", externalId: "C-other", name: "other", scopePath: OLD_SCOPE },
    });
    otherSourceId = other.id;

    await writeEvent(ORG, OLD_SCOPE, "ep-mine", `slack-sync:${sourceId}`, SECRET);
    // Same source, different connector type name: only an exact actor match counts.
    await writeEvent(ORG, OLD_SCOPE, "ep-lookalike", `slackbot-sync:${sourceId}`, "not this source's sync");
    await writeEvent(ORG, OLD_SCOPE, "ep-other-source", `slack-sync:${otherSourceId}`, "another source's item");
    await writeEvent(ORG, OLD_SCOPE, "fact-by-a-person", "user-1", "a fact a person wrote here");
    // The identical actor string in another tenant.
    await writeEvent(OTHER_ORG, OLD_SCOPE, "ep-other-org", `slack-sync:${sourceId}`, "other org's item");
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  it("serves the item text at the old scope before retirement, so the probe below can see a leak", async () => {
    const page = await readChanges(await readerOn(OLD_SCOPE), OLD_SCOPE);
    expect(page.changes.map((c) => c.summary)).toContain(SECRET);
  });

  it("stops serving the item text at the old scope once the source is retired from it", async () => {
    await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: OLD_SCOPE }, NEW_SCOPE);
    await db.source.update({ where: { id: sourceId }, data: { scopePath: NEW_SCOPE } });

    const page = await readChanges(await readerOn(OLD_SCOPE), OLD_SCOPE);
    const served = page.changes.map((c) => c.summary).join("\n");
    expect(served).not.toContain("pricing");
    // The event itself stays, so a cursor an agent already holds still resolves.
    expect(page.changes.map((c) => c.recordId)).toContain("ep-mine");
  });

  it("redacts only this source's own sync events, in this org", async () => {
    const result = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: OLD_SCOPE }, NEW_SCOPE);

    expect(result.redactedChangeEvents).toBe(1);
    expect(await summaries(ORG)).toEqual({
      "ep-mine": "",
      "ep-lookalike": "not this source's sync",
      "ep-other-source": "another source's item",
      "fact-by-a-person": "a fact a person wrote here",
    });
    expect(await summaries(OTHER_ORG)).toEqual({ "ep-other-org": "other org's item" });
  });

  it("is idempotent, so a failed reconnect can be retried", async () => {
    await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: OLD_SCOPE }, NEW_SCOPE);
    const again = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: OLD_SCOPE }, NEW_SCOPE);
    expect(again.redactedChangeEvents).toBe(0);
  });
});
