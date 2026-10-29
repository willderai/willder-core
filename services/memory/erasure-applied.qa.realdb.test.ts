// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The backfill in migration
// 20261016070000_erasure_suppressions_applied marks every entry already on a suppression
// list as applied, on the premise that "each erasure removed its person in the request that
// recorded them". An erasure lists its person first and removes them after
// (person-erasure.ts: "A graph failure leaves Postgres with the person's suppression rows
// recorded ... and nothing else changed"), so an erasure that failed, or was still running,
// when the migration ran has entries on the list and the person still stored. The backfill
// must leave those unapplied: an org read as applied makes memory_query's value check read
// past the stored copies, which is the timing the applied state exists to prevent.
//
// Also: a retry marks what an earlier attempt of the same erasure listed and removed before
// it failed, so an erasure sent again after a late failure leaves the org applied.
//
// The migration's own INSERT is run here, scoped by ON CONFLICT so rows other suites left in
// this worker's database cannot fail it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphErase = vi.fn();
const graphPlan = vi.fn(async () => []);
vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...(a as [])),
    erasePerson: (...a: unknown[]) => graphErase(...a),
    removeEpisode: async () => ({ removed: true }),
    removeChunkFacts: async () => {},
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_backfill";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_backfill_admin";
const DIMENSIONS = 384;
const NAME = "Orsola Venkatesan";
const EMAIL = "orsola.v@backfill.example";

/** The migration's backfill statement, as it ships. */
function backfillStatement(): string {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20261016070000_erasure_suppressions_applied/migration.sql"),
    "utf8",
  );
  const start = sql.indexOf('INSERT INTO "erasure_suppressions_applied"');
  if (start < 0) throw new Error("the migration has no backfill INSERT");
  const statement = sql.slice(start, sql.indexOf(";", start)).trim();
  return /ON CONFLICT/i.test(statement) ? statement : `${statement} ON CONFLICT DO NOTHING`;
}

describe.skipIf(!QA_URL)("applied markers for erasures that had not completed", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];
  let readableMemoryHolds: (typeof import("./readable-values"))["readableMemoryHolds"];
  let specificValuesIn: (typeof import("./specific-values"))["specificValuesIn"];
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  /** The database as the migration finds it: no applied markers at all. */
  async function beforeTheMigration() {
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
  }

  const stored = async () =>
    (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_chunks WHERE "orgId" = ${ORG}`)[0]!.n;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ erasuresApplied } = await import("./erasure-suppression"));
    ({ readableMemoryHolds } = await import("./readable-values"));
    ({ specificValuesIn } = await import("./specific-values"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    graphPlan.mockReset();
    graphPlan.mockResolvedValue([]);
    graphErase.mockReset();
    graphErase.mockResolvedValue({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: JSON.parse(vector) }), { status: 200 })),
    );
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@backfill.test", role: "admin", clerkId: "clerk-backfill-admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "orsola", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo } });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
      VALUES ('c-orsola', ${ORG}, ${`${NAME} (${EMAIL}) asked for invoice 88417.`}, 'text', 'extraction', NULL, ${SALES}, ${vector}::vector, ${longAgo})
    `;
  });

  it("leaves unapplied the entries of an erasure that failed before the migration ran", async () => {
    // The erasure lists the person, then the graph store is unavailable: the documented
    // failure that leaves the list recorded and nothing else changed.
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin, { contactId: "orsola" })).rejects.toThrow(/graph store unavailable/);
    expect(await db.erasureSuppression.count({ where: { orgId: ORG } })).toBeGreaterThan(0);
    expect(await stored()).toBe(1);

    await beforeTheMigration();
    await db.$executeRawUnsafe(backfillStatement());

    // The person is still stored, so this org's erasures are not applied.
    expect(await stored()).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
    // So the value check makes no claim, rather than read past the stored copy.
    expect(
      await readableMemoryHolds(
        { orgId: ORG, scope: SALES, includeUntagged: false },
        specificValuesIn("Was it invoice 88417?"),
      ),
    ).toBeNull();

    // A retry completes the erasure, and only then does the org read as applied.
    await erasePerson(admin, { contactId: "orsola" });
    expect(await stored()).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("marks applied the entries of an erasure that completed before the migration ran", async () => {
    await erasePerson(admin, { contactId: "orsola" });
    expect(await stored()).toBe(0);
    await beforeTheMigration();
    expect(await erasuresApplied(ORG)).toBe(false);
    await db.$executeRawUnsafe(backfillStatement());
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("reads as applied after an erasure that failed in its last transaction is sent again and completes", async () => {
    // Every step commits (the chunk is removed and its id listed under this attempt), then the
    // last transaction fails, so the attempt never writes its person.erased row.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_applied_fail_last() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'qa: last transaction fails'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_applied_fail_last BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW."orgId" = '${ORG}' AND NEW.action = 'person.erased') EXECUTE FUNCTION qa_applied_fail_last()`);
    try {
      await expect(erasePerson(admin, { contactId: "orsola" })).rejects.toThrow(/last transaction fails/);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_applied_fail_last ON audit_log");
      await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_applied_fail_last()");
    }
    expect(await stored()).toBe(0);
    expect(await db.erasureSuppression.count({ where: { orgId: ORG, kind: "version_id" } })).toBeGreaterThan(0);
    expect(await erasuresApplied(ORG)).toBe(false);

    await erasePerson(admin, { contactId: "orsola" });
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  // The backfill's other clauses, one test each.
  it("backfill: marks an attempt's entries that a later request of the same erasure completed", async () => {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_applied_fail_last() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'qa: last transaction fails'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_applied_fail_last BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW."orgId" = '${ORG}' AND NEW.action = 'person.erased') EXECUTE FUNCTION qa_applied_fail_last()`);
    try {
      await expect(erasePerson(admin, { contactId: "orsola" })).rejects.toThrow(/last transaction fails/);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_applied_fail_last ON audit_log");
      await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_applied_fail_last()");
    }
    await erasePerson(admin, { contactId: "orsola" });
    // The list's entries carry the first attempt's request id, which wrote no person.erased row
    // of its own: only the second's earlierRequestIds says it completed.
    const [erased] = await db.auditLog.findMany({ where: { orgId: ORG, action: "person.erased" } });
    const metadata = erased!.metadata as { requestId: string; earlierRequestIds: string[] };
    const listedUnder = new Set(
      (await db.erasureSuppression.findMany({ where: { orgId: ORG } })).map((e) => e.requestId),
    );
    expect([...listedUnder].every((id) => metadata.earlierRequestIds.includes(id))).toBe(true);
    expect(listedUnder.has(metadata.requestId)).toBe(false);
    await beforeTheMigration();
    await db.$executeRawUnsafe(backfillStatement());
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("backfill: marks a redacted rule's entry and a withdrawn correction's entry, written with their removals", async () => {
    const { recordErasedRules, recordErasedVersions } = await import("./erasure-suppression");
    await db.$transaction((tx) => recordErasedRules(tx, ORG, "reapply:earlier-run", ["rule-redacted"]));
    await db.$transaction((tx) => recordErasedVersions(tx, ORG, "correction-of-erased:c-old", ["c-correction"]));
    await beforeTheMigration();
    await db.$executeRawUnsafe(backfillStatement());
    expect(await erasuresApplied(ORG)).toBe(true);
    // A version id listed by a request that never completed is not marked on its own.
    await db.$transaction((tx) => recordErasedVersions(tx, ORG, "planned-and-failed", ["ep-planned"]));
    await beforeTheMigration();
    await db.$executeRawUnsafe(backfillStatement());
    expect(await erasuresApplied(ORG)).toBe(false);
  });
});
