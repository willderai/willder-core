// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A stored fact version is announced once: one `create` event and one applied audit row,
// however many writers or job attempts announce it, and whichever path they come in on.
//
// The database holds the rule: a partial unique index on the fact's `create` events
// (migration 20261007220000_fact_create_event_once), which the event insert defers to
// with ON CONFLICT DO NOTHING. A sequential test cannot show a race between two
// announcers; the first test starts them together on separate connections. Real:
// Postgres, the advisory lock, the unique index, the audit and change-event writes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-announce-once";
const CONCURRENT_JOBS = 8;

const ingest = (actorId: string): IngestInput => ({
  groupId: ORG,
  content: "The release train leaves on Thursday.",
  actorType: "agent",
  origin: "mcp",
  actorId,
  scopePath: "org_announce_once.release",
});

describe.skipIf(!QA_URL)("recordIngestAppliedOnce against a real database", () => {
  let db: PrismaClient;
  let recordIngestAppliedOnce: (typeof import("./fact-change-event"))["recordIngestAppliedOnce"];
  let recordIngestApplied: (typeof import("./fact-change-event"))["recordIngestApplied"];

  /** The create events and applied audit rows written for the org. */
  async function announcements(): Promise<{ events: string[]; appliedRows: number }> {
    const events = await db.changeEvent.findMany({ where: { orgId: ORG, op: "create" }, select: { recordId: true } });
    const appliedRows = await db.auditLog.count({ where: { orgId: ORG, action: "memory.write.applied" } });
    return { events: events.map((event) => event.recordId), appliedRows };
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    // Before the import, so the `@/lib/db` singleton it writes through is built
    // against the QA database rather than the inherited DATABASE_URL.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ recordIngestAppliedOnce, recordIngestApplied } = await import("./fact-change-event"));
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("announces a row once when several jobs that landed on it announce it at the same instant", async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_JOBS }, (_, i) => recordIngestAppliedOnce(ingest(`agent-${i}`), "row-1")),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await announcements()).toEqual({ events: ["row-1"], appliedRows: 1 });
  }, 30_000);

  it("does not announce again when a job is retried after its announcement committed", async () => {
    expect(await recordIngestAppliedOnce(ingest("agent-0"), "row-2")).toBe(true);
    expect(await recordIngestAppliedOnce(ingest("agent-0"), "row-2")).toBe(false);

    expect(await announcements()).toEqual({ events: ["row-2"], appliedRows: 1 });
  });

  it("announces each distinct row, so the check is per version and not per org", async () => {
    await Promise.all([
      recordIngestAppliedOnce(ingest("agent-0"), "row-3"),
      recordIngestAppliedOnce(ingest("agent-1"), "row-4"),
    ]);

    expect((await announcements()).events.sort()).toEqual(["row-3", "row-4"]);
  });

  it("announces a version once when the request path's announcement is replayed", async () => {
    // The request path's call, repeated for a row it already announced.
    await recordIngestApplied(ingest("agent-0"), "row-5");
    await recordIngestApplied(ingest("agent-0"), "row-5");

    expect(await announcements()).toEqual({ events: ["row-5"], appliedRows: 1 });
  });

  it("announces a version once when the request path and a job announce it at the same instant", async () => {
    await Promise.all([
      recordIngestApplied(ingest("agent-0"), "row-6"),
      recordIngestAppliedOnce(ingest("agent-1"), "row-6"),
    ]);

    expect(await announcements()).toEqual({ events: ["row-6"], appliedRows: 1 });
  }, 30_000);

  it("refuses a second create event for one fact version in the database itself", async () => {
    // A writer that skips both functions above still cannot announce a version twice.
    const event = (seq: number) => ({
      orgId: ORG,
      seq: BigInt(seq),
      scopePath: "org_announce_once.release",
      recordType: "fact",
      recordId: "row-7",
      op: "create" as const,
      actorId: "agent-0",
      summary: "",
    });
    await db.changeEvent.create({ data: event(1) });

    await expect(db.changeEvent.create({ data: event(2) })).rejects.toThrow(/Unique constraint/);
  });

  it("leaves other record types and other ops on one record free to repeat", async () => {
    // A source reconnect and a fact's later delete are separate events on one record.
    const event = (seq: number, recordType: string, op: "create" | "delete") => ({
      orgId: ORG,
      seq: BigInt(seq),
      scopePath: "org_announce_once.release",
      recordType,
      recordId: "row-8",
      op,
      actorId: "agent-0",
      summary: "",
    });
    await db.changeEvent.create({ data: event(1, "source", "create") });
    await db.changeEvent.create({ data: event(2, "source", "create") });
    await db.changeEvent.create({ data: event(3, "fact", "create") });
    await db.changeEvent.create({ data: event(4, "fact", "delete") });
    await db.changeEvent.create({ data: event(5, "fact", "delete") });

    expect(await db.changeEvent.count({ where: { orgId: ORG, recordId: "row-8" } })).toBe(5);
  });
});
