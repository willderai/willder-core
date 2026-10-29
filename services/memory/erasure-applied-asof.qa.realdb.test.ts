// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The markApplied `asOf`
// guard against a second erasure of the same person, at the points the branch's own tests do
// not reach. asOf compares against the time the INSERT ... SELECT reads, and under READ
// COMMITTED that read is the statement's snapshot:
//  1. Erasure against erasure, inside the statement: an erasure's last-transaction markApplied
//     read the list before a second erasure of the same person moved the entry's time. Passes
//     today: the second erasure's check() appends to the org's audit chain and waits for the
//     first erasure's transaction, which holds the chain since its person.erased row. Kept as
//     a guard on that ordering.
//  2. Re-apply against erasure, inside the statement: the re-apply's last transaction writes no
//     audit row, so the erasure is not held. It moves the entry's time and deletes applied rows
//     it can see; the re-apply's uncommitted insert is not one of them, and the re-apply's
//     snapshot still has the old time. The entry ends up applied though the erasure failed.
//  3. The migration's backfill: an entry first listed by a request that completed, listed again
//     (time moved, main's #741) by a second erasure that failed, is marked applied by the
//     first request's completion.
// In 2 and 3 the org reads applied, and stays so (completeRestore skips an applied org), while
// a copy the second erasure covers is still stored.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphPlan = vi.fn(async () => [] as string[]);
vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...(a as [])),
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeEpisode: async () => ({ removed: true }),
    removeChunkFacts: async () => {},
    removeGroupFacts: async () => ({ removedCount: 0 }),
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qaasofrace";
const ROOT = `org_${ORG}`;
const ADMIN = "u-qa-asof-race";
const NAME = "Ottoline Brackenbury";
const EMAIL = "ottoline@asof-race.example";
const DIMENSIONS = 384;
const LONG_AGO = new Date(Date.now() - 24 * 3600 * 1000);
const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
const tick = () => new Promise((r) => setTimeout(r, 5));

function vec(text: string): string {
  const v: number[] = [];
  for (let b = 0; v.length < DIMENSIONS; b++)
    for (const byte of createHash("sha256").update(`${b}:${text}`).digest()) v.push(byte / 255 - 0.5);
  return `[${v.slice(0, DIMENSIONS).join(",")}]`;
}

function backfillStatement(): string {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20261016070000_erasure_suppressions_applied/migration.sql"),
    "utf8",
  );
  const start = sql.indexOf('INSERT INTO "erasure_suppressions_applied"');
  const statement = sql.slice(start, sql.indexOf(";", start)).trim();
  return `${statement} ON CONFLICT DO NOTHING`;
}

describe.skipIf(!QA_URL)("QA: markApplied asOf against a second erasure of the same person", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];

  async function addChunk(id: string, content: string) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion", embedding, "createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', 'agent-1', ${ROOT}, false, ${vec(content)}::vector, ${new Date()})`;
  }
  const stored = (id: string) => db.memoryChunk.count({ where: { orgId: ORG, id } });

  async function dropSleep() {
    await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_asof_sleep ON erasure_suppressions_applied");
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_asof_sleep()");
  }

  async function wipe() {
    await dropSleep();
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ erasuresApplied } = await import("./erasure-suppression"));
  });

  beforeEach(async () => {
    graphPlan.mockReset();
    graphPlan.mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ embedding: JSON.parse(vec("x")) })),
    );
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@asof-race.test", role: "admin", clerkId: "clerk-asof-race" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "otto", orgId: ORG, name: NAME, email: EMAIL, createdAt: LONG_AGO } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("an erasure whose markApplied statement started before a second erasure listed the person again does not leave the entry applied", async () => {
    await erasePerson(admin, { contactId: "otto" });
    expect(await erasuresApplied(ORG)).toBe(true);

    // Hold erasure A inside its markApplied statement, after the INSERT ... SELECT read the list.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_asof_sleep() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_asof_sleep AFTER INSERT ON erasure_suppressions_applied
      FOR EACH ROW WHEN (NEW."orgId" = '${ORG}' AND NEW.kind = 'email' AND NEW."by" LIKE 'person_erasure:%') EXECUTE FUNCTION qa_asof_sleep()`);
    const a = erasePerson(admin, { email: EMAIL });
    await vi.waitFor(
      async () => {
        const [row] = await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%erasure_suppressions_applied%'`;
        expect(row!.n).toBe(1);
      },
      { timeout: 5_000, interval: 20 },
    );

    // Written after A removed her copies; then erasure B lists her address again and fails.
    await addChunk("c-between", `${EMAIL} asked for the April invoice.`);
    await tick();
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin, { email: EMAIL })).rejects.toThrow(/graph store unavailable/);
    await a;
    await dropSleep();

    // B's copy is still stored and B never finished: the org must not read applied.
    expect(await stored("c-between")).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
  }, 20_000);

  it("a re-apply whose markApplied statement started before an erasure listed the person again does not leave the entry applied", async () => {
    const { reapplyErasures } = await import("./erasure-reapply");
    await erasePerson(admin, { contactId: "otto" });
    // A restore of a backup taken before the markers: the list is back, the markers are not.
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
    expect(await erasuresApplied(ORG)).toBe(false);

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_asof_sleep() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_asof_sleep AFTER INSERT ON erasure_suppressions_applied
      FOR EACH ROW WHEN (NEW."orgId" = '${ORG}' AND NEW.kind = 'email' AND NEW."by" LIKE 'reapply:%') EXECUTE FUNCTION qa_asof_sleep()`);
    const r = reapplyErasures({ ...admin, origin: "script" });
    await vi.waitFor(
      async () => {
        const [row] = await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%erasure_suppressions_applied%'`;
        expect(row!.n).toBe(1);
      },
      { timeout: 10_000, interval: 20 },
    );

    // Written after the re-apply's passes; then an erasure lists her address again and fails.
    await addChunk("c-between", `${EMAIL} asked for the June invoice.`);
    await tick();
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin, { email: EMAIL })).rejects.toThrow(/graph store unavailable/);
    await r;
    await dropSleep();

    expect(await stored("c-between")).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
  }, 20_000);

  it("the backfill does not mark an entry a later, failed erasure of the same person listed again", async () => {
    await erasePerson(admin, { contactId: "otto" });
    await tick();
    await addChunk("c-since", `${EMAIL} asked for the May invoice.`);
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin, { email: EMAIL })).rejects.toThrow(/graph store unavailable/);
    expect(await erasuresApplied(ORG)).toBe(false);

    // The migration over this state: no markers yet, then the backfill.
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
    await db.$executeRawUnsafe(backfillStatement());

    expect(await stored("c-since")).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
  });
});
