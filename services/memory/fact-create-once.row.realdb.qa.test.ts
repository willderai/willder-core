// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A fact's `create` event written by recordFactCreateOnce's hand-written INSERT is the
// same row recordChangeEvent's Prisma create writes for the same input: every column a
// reader uses (scope, actor, actor type, origin, summary, authorization, task) and the
// time it was written.
//
// The INSERT names its columns itself, so a column it leaves out falls to the table's
// default rather than to what Prisma would have sent. `createdAt` is the one that bites:
// Prisma writes UTC, and the column default CURRENT_TIMESTAMP converts through the
// session TimeZone (lib/sql-utc-now.ts). The suite runs on a session on each side of UTC.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const SESSION_TIME_ZONES = ["America/Los_Angeles", "Asia/Tokyo"];
const ORG = "org-qa-fact-create-once-row";
const MINUTE = 60 * 1000;

/** QA_URL with every connection's session TimeZone set to `zone`. */
function inTimeZone(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

const input = {
  orgId: ORG,
  scopePath: "org_qa_fact_create_once_row.release",
  actorId: "agent-qa-row",
  actorType: "agent" as const,
  origin: "api" as const,
  title: "The release train leaves on Thursday.\nsecond line",
  authorizedById: "audit-row-qa",
  task: "task-qa-row",
};

describe.skipIf(!QA_URL).each(SESSION_TIME_ZONES)(
  "recordFactCreateOnce's row on a session in %s, real Postgres",
  (zone) => {
    let db: PrismaClient;
    let events: typeof import("./change-events");

    beforeAll(async () => {
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      // Before the import, so the `@/lib/db` singleton is built against the QA database
      // on a session in `zone`.
      process.env.DATABASE_URL = inTimeZone(QA_URL!, zone);
      // A fresh `@/lib/db` per zone: lib/db.ts keeps its client on globalThis outside production.
      vi.resetModules();
      delete (globalThis as { prisma?: unknown }).prisma;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
      events = await import("./change-events");
    });

    afterAll(async () => {
      const { db: appDb } = await import("@/lib/db");
      await appDb.$disconnect();
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.org.deleteMany({ where: { id: ORG } });
      await db.$disconnect();
    });

    beforeEach(async () => {
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    });

    it("writes the same row recordChangeEvent writes for the same input, createdAt included", async () => {
      const { db: appDb } = await import("@/lib/db");
      const before = Date.now();
      const viaPrisma = await appDb.$transaction((tx) =>
        events.recordChangeEvent(tx, { ...input, recordType: "fact", recordId: "row-prisma", op: "create" }),
      );
      const viaInsert = await appDb.$transaction((tx) =>
        events.recordFactCreateOnce(tx, { ...input, recordId: "row-insert" }),
      );
      const after = Date.now();
      expect(viaInsert).not.toBeNull();

      const read = (id: string) => db.changeEvent.findUniqueOrThrow({ where: { id } });
      const { id: _a, seq: seqA, recordId: _ra, createdAt: createdA, ...prismaRow } = await read(viaPrisma.id);
      const { id: _b, seq: seqB, recordId: _rb, createdAt: createdB, ...insertRow } = await read(viaInsert!.id);

      expect(insertRow).toEqual(prismaRow);
      expect(insertRow).toMatchObject({
        origin: "api",
        actorType: "agent",
        summary: "The release train leaves on Thursday.",
      });
      expect(seqB).toBe(seqA + BigInt(1));
      // Both rows were written inside [before, after]; a session-local default lands hours away.
      for (const createdAt of [createdA, createdB]) {
        expect(createdAt.getTime()).toBeGreaterThanOrEqual(before - MINUTE);
        expect(createdAt.getTime()).toBeLessThanOrEqual(after + MINUTE);
      }
    });
  },
);
