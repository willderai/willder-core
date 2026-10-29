// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// `createBrief`'s atomicity, against a real database.
//
// The claim is that a Brief and its change event commit or roll back together. A
// transaction double cannot show that: it has no rollback to fail. Here the event
// write is made to fail for real (a scope Postgres could never cast to ltree is
// refused by recordChangeEvent after the Brief insert has already run), and the
// assertion is that no Brief row survives.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-create-brief";

const brief = (scopePath: string) => ({
  orgId: ORG,
  type: "handoff" as const,
  scopePath,
  title: "Handoff: EU renewals\nsecond line stays out of the summary",
  summary: "What the new owner needs",
  sections: [],
});

describe.skipIf(!QA_URL)("createBrief against a real database", () => {
  let db: PrismaClient;
  let createBrief: (typeof import("./create-brief"))["createBrief"];

  beforeAll(async () => {
    // Before the import, so the `@/lib/db` singleton createBrief writes through is
    // built against the QA database rather than the inherited DATABASE_URL.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ createBrief } = await import("./create-brief"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("commits the brief and one create event describing it", async () => {
    const written = await createBrief(brief("org_1.sales.eu"), {
      actorType: "agent",
      actorId: "agent-handoff",
      origin: "agent-run",
    });

    const events = await db.changeEvent.findMany({ where: { orgId: ORG } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      recordType: "brief",
      recordId: written.id,
      op: "create",
      scopePath: "org_1.sales.eu",
      actorId: "agent-handoff",
      summary: "Handoff: EU renewals",
    });
  });

  it("leaves no brief behind when its event cannot be recorded", async () => {
    await expect(
      createBrief(brief("org_1..sales"), { actorType: "agent", actorId: "agent-handoff", origin: "agent-run" }),
    ).rejects.toThrow("valid ltree scopePath");

    expect(await db.brief.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(0);
  });
});
