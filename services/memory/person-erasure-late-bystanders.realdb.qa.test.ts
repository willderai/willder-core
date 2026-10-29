// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The erasure's last-transaction pass over late writes
// (services/memory/person-erasure.ts, removeLateWrites). That pass matches rows written
// while the request ran by the same predicates as the scans, so it must keep every
// bystander the scans keep, and stay inside the erasing org. Over-erasure cannot be
// undone, so the cases here are bystanders that read like the person: a cc list that
// names her surname first across two people, a hyphenated surname, an entity whose name
// only contains hers, and the same text in another org.
//
// Real: Postgres, check() against live grants, the audit log and the change feed's own
// writer. Faked: the graph store, which this pass never reaches.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure_late_by";
const OTHER_ORG = "qa_erasure_late_by_other";
const ADMIN = "qa_erasure_late_by_admin";
const NAME = "Dana Whitfield";
const DIMENSIONS = 384;

describe.skipIf(!QA_URL)("the erasure's late-write pass keeps every bystander the scans keep", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let recordChangeEvent: (typeof import("./change-events"))["recordChangeEvent"];
  let appDb: (typeof import("@/lib/db"))["db"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function wipe() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.changeEvent.deleteMany({ where: { orgId: org } });
      await db.brief.deleteMany({ where: { orgId: org } });
      await db.erasureSuppression.deleteMany({ where: { orgId: org } });
      await db.contact.deleteMany({ where: { orgId: org } });
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.grant.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
    }
  }

  async function chunk(org: string, id: string, content: string, entityName: string | null = null) {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","entityName","embedding","createdAt")
      VALUES (${id}, ${org}, ${content}, 'text', 'extraction', ${`org_${org}`}, ${entityName},
              ${`[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`}::vector, (now() AT TIME ZONE 'UTC'))
    `;
  }
  async function changeEvent(org: string, recordId: string, title: string) {
    await db.$transaction((tx) =>
      recordChangeEvent(tx as never, {
        orgId: org,
        scopePath: `org_${org}`,
        recordType: "fact",
        recordId,
        op: "create",
        actorId: "agent-1",
        actorType: "agent",
        origin: "app",
        title,
      }),
    );
  }
  async function brief(org: string, id: string, title: string, citation?: string) {
    await db.brief.create({
      data: {
        id,
        orgId: org,
        type: "handoff",
        scopePath: `org_${org}`,
        title,
        summary: "Handoff.",
        sections: [],
        ...(citation ? { citations: { create: [{ sectionIndex: 0, factId: `${id}-fact`, factText: citation }] } } : {}),
      },
    });
  }

  /** Rows the late pass must keep, written while the erasure runs. */
  async function writeLateRows() {
    await chunk(ORG, "c-late-cc-list", "Cc: Tom Whitfield, Dana Cole on the renewal.");
    await chunk(ORG, "c-late-hyphen", "Dana Whitfield-Barnes signed the order.");
    await chunk(ORG, "c-late-foundation", "Grant approved for next year.", "Dana Whitfield Foundation");
    await chunk(OTHER_ORG, "c-late-other-org", `${NAME} renewed today.`, NAME);
    await changeEvent(ORG, "f-late-cc-list", "Attendees: Wei Whitfield, Dana Cole");
    await changeEvent(OTHER_ORG, "f-late-other-org", `${NAME} renewed`);
    await brief(ORG, "b-late-cc-list", "Notes: Tom Whitfield, Dana Cole", "Ann Whitfield, Dana Cole agreed.");
    await brief(OTHER_ORG, "b-late-other-org", `Renewal notes for ${NAME}`);
    // And the rows that are hers, so the pass is shown to run at all.
    await chunk(ORG, "c-late-filed-under-her", "She renewed today.", "Whitfield, Dana");
    await changeEvent(ORG, "f-late-hers", "Dana   Whitfield renewed");
    await brief(ORG, "b-late-cites-her", "Renewal handoff", `${NAME} asked for annual billing.`);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ recordChangeEvent } = await import("./change-events"));
    ({ db: appDb } = await import("@/lib/db"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    for (const org of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: `org_${ORG}`, name: "root" } });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@late-by.test", role: "admin", clerkId: "clerk-late-by-admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "late-by-dana", orgId: ORG, name: NAME, email: "dana_w@late.example" } });
    await chunk(ORG, "c-dana", `${NAME} wants the annual plan.`);
    await brief(ORG, "b-dana", `Handoff for ${NAME}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps late bystanders and the other org's rows, and removes only her late rows", async () => {
    // Write once the scans are done: the brief step has removed her brief, so the next
    // transaction the erasure opens is its last one.
    const original = appDb.$transaction.bind(appDb);
    let wrote = false;
    vi.spyOn(appDb, "$transaction").mockImplementation((async (...args: unknown[]) => {
      if (!wrote && (await db.brief.count({ where: { id: "b-dana" } })) === 0) {
        wrote = true;
        await writeLateRows();
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as never);

    const result = await erasePerson(admin, { contactId: "late-by-dana" });

    expect(wrote).toBe(true);
    const chunks = await db.memoryChunk.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(chunks.map((c) => c.id)).toEqual([
      "c-late-cc-list",
      "c-late-foundation",
      "c-late-hyphen",
      "c-late-other-org",
    ]);

    const events = await db.changeEvent.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] }, recordType: "fact" },
      orderBy: { seq: "asc" },
    });
    expect(Object.fromEntries(events.map((e) => [e.recordId, e.summary]))).toEqual({
      "f-late-cc-list": "Attendees: Wei Whitfield, Dana Cole",
      "f-late-other-org": `${NAME} renewed`,
      "f-late-hers": "",
    });

    const briefs = await db.brief.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(briefs.map((b) => b.id)).toEqual(["b-late-cc-list", "b-late-other-org"]);

    expect(result).toMatchObject({
      chunksRemoved: 2,
      changeSummariesScrubbed: 1,
      briefsRemoved: 2,
      contactsRemoved: 1,
    });
    // The other org's audit log and suppression list are untouched.
    expect(await db.auditLog.count({ where: { orgId: OTHER_ORG } })).toBe(0);
    expect(await db.erasureSuppression.count({ where: { orgId: OTHER_ORG } })).toBe(0);
  });
});
