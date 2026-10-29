// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// `recordIngestApplied`'s atomicity, against a real database.
//
// The claim is that an ingest's confirmed-applied audit row and its change event
// commit or roll back together. A transaction double cannot show that: it has no
// rollback to fail. Here the event write is made to fail for real (a scope Postgres
// could never cast to ltree is refused by recordChangeEvent after the audit row has
// already been inserted), and the assertion is that no audit row survives.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-fact-change";

const ingest = (scopePath: string | undefined): IngestInput => ({
  groupId: ORG,
  content: "Staging deploys freeze on Fridays.\nsecond line stays out of the summary",
  actorType: "agent",
  origin: "mcp",
  actorId: "agent-writer",
  scopePath,
});

describe.skipIf(!QA_URL)("recordIngestApplied against a real database", () => {
  let db: PrismaClient;
  let recordIngestApplied: (typeof import("./fact-change-event"))["recordIngestApplied"];
  let orgRootPath: (typeof import("@/services/access"))["orgRootPath"];

  beforeAll(async () => {
    // Before the import, so the `@/lib/db` singleton it writes through is built
    // against the QA database rather than the inherited DATABASE_URL.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ recordIngestApplied } = await import("./fact-change-event"));
    ({ orgRootPath } = await import("@/services/access"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("commits the applied row and one create event for the episode", async () => {
    await recordIngestApplied(ingest("org_1.eng.release"), "episode-1");

    const events = await db.changeEvent.findMany({ where: { orgId: ORG } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      recordType: "fact",
      recordId: "episode-1",
      op: "create",
      scopePath: "org_1.eng.release",
      actorId: "agent-writer",
      summary: "Staging deploys freeze on Fridays.",
    });
    const applied = await db.auditLog.findMany({ where: { orgId: ORG } });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ action: "memory.write.applied", target: "org_1.eng.release" });
  });

  it("announces an unscoped ingest at the org root, where the store wrote it", async () => {
    await recordIngestApplied(ingest(undefined), "episode-2");

    const [event] = await db.changeEvent.findMany({ where: { orgId: ORG } });
    expect(event.scopePath).toBe(orgRootPath(ORG));
  });

  it("leaves no applied row behind when the event cannot be recorded", async () => {
    await expect(recordIngestApplied(ingest("org_1..eng"), "episode-3")).rejects.toThrow("valid ltree scopePath");

    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(0);
  });
});
