// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The migration's backfill run once over a
// database holding every kind of erasure at once, one org each, through the real erasure
// paths: finished, failed before the graph, failed after the graph plan, failed in the last
// transaction after its rules step redacted a rule, sent again after a failure, a withdrawn
// correction of an erased version, and one still running while the backfill runs. Checks
// exactly which entries read applied, by kind and request, and that no org whose person is
// still stored reads applied.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphErase = vi.fn();
const graphPlan = vi.fn(async () => [] as string[]);
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
const DIMENSIONS = 384;
const NAME = "Ilsabet Quarrington";
const EMAIL = "ilsabet.q@mixed.example";
const ORGS = [
  "qa_mix_done",
  "qa_mix_nograph",
  "qa_mix_planned",
  "qa_mix_rules",
  "qa_mix_retried",
  "qa_mix_correction",
  "qa_mix_running",
] as const;
type Org = (typeof ORGS)[number];

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

describe.skipIf(!QA_URL)("QA: the backfill over a database with every kind of erasure at once", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];
  let withdrawCorrectionOfErased: (typeof import("./erasure-lineage"))["withdrawCorrectionOfErased"];
  let recordErasedVersions: (typeof import("./erasure-suppression"))["recordErasedVersions"];
  let readableMemoryHolds: (typeof import("./readable-values"))["readableMemoryHolds"];
  let specificValuesIn: (typeof import("./specific-values"))["specificValuesIn"];
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
  const admin = (org: Org): AccessContext => ({
    orgId: org,
    actor: { type: "human", id: `${org}_admin`, role: "admin" },
    origin: "app",
  });
  const sales = (org: Org) => `org_${org}.sales`;

  async function wipe() {
    for (const org of ORGS) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.changeEvent.deleteMany({ where: { orgId: org } });
      await db.convention.deleteMany({ where: { orgId: org } });
      await db.erasureSuppression.deleteMany({ where: { orgId: org } });
      await db.erasureSuppressionApplied.deleteMany({ where: { orgId: org } });
      await db.contact.deleteMany({ where: { orgId: org } });
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.grant.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
    }
    await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_mix_fail_last ON audit_log");
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_mix_fail_last()");
  }

  async function seed(org: Org) {
    await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
    const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
    await db.scope.create({ data: { orgId: org, path: sales(org), name: "sales" } });
    await db.user.create({
      data: { id: `${org}_admin`, orgId: org, email: `admin@${org}.test`, role: "admin", clerkId: `clerk-${org}` },
    });
    await db.grant.create({
      data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: `${org}_admin`, permission: "admin" },
    });
    await db.contact.create({
      data: { id: `${org}_person`, orgId: org, name: NAME, email: EMAIL, createdAt: longAgo },
    });
    await chunk(org, `${org}_c1`, `${NAME} (${EMAIL}) asked for invoice 88417.`);
  }

  async function chunk(org: Org, id: string, content: string) {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
      VALUES (${id}, ${org}, ${content}, 'text', 'extraction', NULL, ${sales(org)}, ${vector}::vector, ${longAgo})
    `;
  }

  const stored = async (org: Org) =>
    (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_chunks WHERE "orgId" = ${org}`)[0]!.n;

  /** Each entry as "kind applied|listed", and its request, sorted. */
  async function entries(org: Org): Promise<string[]> {
    const rows = await db.$queryRaw<{ kind: string; requestId: string; applied: boolean }[]>`
      SELECT s.kind, s."requestId", (a.digest IS NOT NULL) AS applied
      FROM erasure_suppressions s
      LEFT JOIN erasure_suppressions_applied a ON a."orgId" = s."orgId" AND a.kind = s.kind AND a.digest = s.digest
      WHERE s."orgId" = ${org}`;
    return rows.map((r) => `${r.kind} ${r.applied ? "applied" : "unapplied"}`).sort();
  }

  async function failLastTransaction(org: Org) {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_mix_fail_last() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'qa: last transaction fails'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_mix_fail_last BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW."orgId" = '${org}' AND NEW.action = 'person.erased') EXECUTE FUNCTION qa_mix_fail_last()`);
  }
  const unfailLastTransaction = async () => {
    await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_mix_fail_last ON audit_log");
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_mix_fail_last()");
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ erasuresApplied, recordErasedVersions } = await import("./erasure-suppression"));
    ({ withdrawCorrectionOfErased } = await import("./erasure-lineage"));
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: JSON.parse(vector) }), { status: 200 })),
    );
    await wipe();
    for (const org of ORGS) await seed(org);
  });

  /** Every kind of erasure, one org each, then the migration's backfill. Returns the running erasure. */
  async function everyKindThenBackfill(): Promise<{ release: () => void; running: Promise<unknown> }> {
    // Finished.
    await erasePerson(admin("qa_mix_done"), { contactId: "qa_mix_done_person" });

    // Failed before the graph: the person's values listed, nothing removed.
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin("qa_mix_nograph"), { contactId: "qa_mix_nograph_person" })).rejects.toThrow(
      /unavailable/,
    );

    // Failed after the graph plan: the planned episodes listed as version ids, not removed.
    graphPlan.mockResolvedValueOnce(["ep-planned-1", "ep-planned-2"]);
    graphErase.mockRejectedValueOnce(new Error("graph erase timed out"));
    await expect(erasePerson(admin("qa_mix_planned"), { contactId: "qa_mix_planned_person" })).rejects.toThrow(
      /timed out/,
    );

    // Rules step committed (a rule naming the person redacted), then the last transaction failed.
    await db.convention.create({
      data: {
        id: "rule-names-her",
        orgId: "qa_mix_rules",
        scopePath: sales("qa_mix_rules"),
        kind: "decision",
        subject: "Escalations",
        text: `Send escalations to ${NAME}.`,
        actorId: "qa_mix_rules_admin",
        createdAt: longAgo,
      },
    });
    await failLastTransaction("qa_mix_rules");
    try {
      await expect(erasePerson(admin("qa_mix_rules"), { contactId: "qa_mix_rules_person" })).rejects.toThrow(
        /last transaction fails/,
      );
    } finally {
      await unfailLastTransaction();
    }
    expect((await db.convention.findUnique({ where: { id: "rule-names-her" } }))!.text).toBe("");

    // Failed in the last transaction, then sent again and completed.
    await failLastTransaction("qa_mix_retried");
    try {
      await expect(erasePerson(admin("qa_mix_retried"), { contactId: "qa_mix_retried_person" })).rejects.toThrow(
        /last transaction fails/,
      );
    } finally {
      await unfailLastTransaction();
    }
    await erasePerson(admin("qa_mix_retried"), { contactId: "qa_mix_retried_person" });

    // An erasure finished, then a correction of a version it removed arrived and was withdrawn.
    await erasePerson(admin("qa_mix_correction"), { contactId: "qa_mix_correction_person" });
    await db.$transaction((tx) => recordErasedVersions(tx, "qa_mix_correction", "erased-before", ["v-erased"]));
    await chunk("qa_mix_correction", "v-correction", "Invoice 88417 was corrected.");
    await withdrawCorrectionOfErased(
      { groupId: "qa_mix_correction", correctionOf: { factId: "v-erased" } } as never,
      "v-correction",
    );

    // Running while the migration runs: blocked in the graph erase.
    let release!: () => void;
    const callsBefore = graphErase.mock.calls.length;
    graphPlan.mockResolvedValueOnce(["ep-running"]);
    graphErase.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            (release = () => resolve({ episodes: 1, nodes: 0, edges: 0, summaries: 0, episodeIds: ["ep-running"] })),
        ),
    );
    const running = erasePerson(admin("qa_mix_running"), { contactId: "qa_mix_running_person" });
    await vi.waitFor(() => expect(graphErase).toHaveBeenCalledTimes(callsBefore + 1));

    // The migration: no applied markers yet, then the backfill.
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: { in: [...ORGS] } } });
    await db.$executeRawUnsafe(backfillStatement());
    return { release, running };
  }

  it("marks applied exactly the entries carried out, and no org whose person is stored", async () => {
    const { release, running } = await everyKindThenBackfill();

    const all = (list: string[], state: "applied" | "unapplied") =>
      list.length > 0 && list.every((e) => e.endsWith(` ${state}`));
    const done = await entries("qa_mix_done");
    expect(all(done, "applied")).toBe(true);
    expect(done).toEqual(expect.arrayContaining(["contact_id applied", "email applied", "version_id applied"]));
    expect(all(await entries("qa_mix_nograph"), "unapplied")).toBe(true);
    const planned = await entries("qa_mix_planned");
    expect(all(planned, "unapplied")).toBe(true);
    expect(planned.filter((e) => e === "version_id unapplied")).toHaveLength(2);
    // The redacted rule is the only entry carried out; its person and chunk entries are not marked.
    const rules = await entries("qa_mix_rules");
    expect(rules.filter((e) => e.endsWith(" applied"))).toEqual(["rule_id applied"]);
    expect(rules).toContain("contact_id unapplied");
    expect(rules).toContain("version_id unapplied");
    expect(all(await entries("qa_mix_retried"), "applied")).toBe(true);
    // The correction's withdrawal is marked; the version id another request listed is not on its own.
    const correction = await entries("qa_mix_correction");
    // Two applied: the finished erasure's removed chunk and the withdrawn correction.
    expect(correction.filter((e) => e === "version_id applied")).toHaveLength(2);
    expect(correction.filter((e) => e === "version_id unapplied")).toHaveLength(1);
    expect(all(await entries("qa_mix_running"), "unapplied")).toBe(true);

    const applied = Object.fromEntries(await Promise.all(ORGS.map(async (org) => [org, await erasuresApplied(org)])));
    expect(applied).toEqual({
      qa_mix_done: true,
      qa_mix_nograph: false,
      qa_mix_planned: false,
      qa_mix_rules: false,
      qa_mix_retried: true,
      qa_mix_correction: false,
      qa_mix_running: false,
    });
    // Every org still storing the person makes no claim.
    for (const org of ["qa_mix_nograph", "qa_mix_planned", "qa_mix_running"] as const) {
      expect(await stored(org)).toBeGreaterThan(0);
      expect(
        await readableMemoryHolds(
          { orgId: org, scope: sales(org), includeUntagged: false },
          specificValuesIn("Was it invoice 88417?"),
        ),
      ).toBeNull();
    }

    // The running erasure finishes after the migration and marks its own entries.
    release();
    await running;
    expect(await erasuresApplied("qa_mix_running")).toBe(true);
    expect(await stored("qa_mix_running")).toBe(0);
  });

  it("deploy note: the re-apply after the migration leaves every org applied and no person stored", async () => {
    const { reapplyErasures } = await import("./erasure-reapply");
    const { release, running } = await everyKindThenBackfill();
    release();
    await running;
    for (const org of ORGS) {
      if (!(await erasuresApplied(org))) await reapplyErasures({ ...admin(org), origin: "script" });
    }
    for (const org of ORGS) {
      expect(await erasuresApplied(org), org).toBe(true);
      expect(await db.contact.count({ where: { orgId: org } }), org).toBe(0);
      expect(await stored(org), org).toBe(0);
    }
    expect((await db.convention.findUnique({ where: { id: "rule-names-her" } }))!.text).toBe("");
  });
});
