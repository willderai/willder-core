import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// run-visibility.ts states one rule about who may see a run, in two forms:
// runVisibleUnder() filters rows already in memory, and runVisibleUnderSql()
// is the same rule as a SQL predicate, for the counts and the per-agent latest
// row that must not read every run in the organisation to discard most of them.
//
// Two forms of one rule can drift, and a drift here is a leak: the SQL form is
// what produces the numbers on the nav badge and the agent cards, so a predicate
// looser than the filter would publish the existence of runs the list hides.
// This file runs both over the same persisted rows — including the awkward
// `meta` values a run can really carry — and asserts they select the same runs.
//
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgRunParity";
const ROOT = `org_${ORG}`;
/** The granted scope. Its `_` is what an unescaped LIKE pattern reads as a wildcard. */
const GRANTED = `${ROOT}.dept_sales`;
const AGENT = "agentRunParity";

/** Every `meta` a run is asked about here, by the run id it is stored under. */
const META_CASES: Record<string, unknown> = {
  at_granted: { scopePath: GRANTED },
  at_descendant: { scopePath: `${GRANTED}.west` },
  at_sibling: { scopePath: `${ROOT}.deptXsales` },
  under_sibling: { scopePath: `${ROOT}.deptXsales.west` },
  at_other: { scopePath: `${ROOT}.eng` },
  at_root: { scopePath: ROOT },
  no_scope_key: { campaign: "spring" },
  empty_meta: {},
  json_null_scope: { scopePath: null },
  empty_string_scope: { scopePath: "" },
  invalid_label_scope: { scopePath: `${GRANTED}.west coast` },
  non_string_scope: { scopePath: 7 },
  prefix_no_separator: { scopePath: `${GRANTED}west` },
};

describe.skipIf(!QA_URL)("runVisibleUnderSql agrees with runVisibleUnder", { timeout: 30_000 }, () => {
  // Explicit bounds sized for a loaded CI runner, not Vitest's 10 s hook and 5 s test
  // defaults: importing the route and database modules alone can take several seconds
  // when every core is busy, and a timeout there fails the suite without testing anything.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let runVisibleUnder: (typeof import("./run-visibility"))["runVisibleUnder"];
  let runVisibleUnderSql: (typeof import("./run-visibility"))["runVisibleUnderSql"];
  let Prisma: any, flattenSql: any;

  /** Run ids the SQL predicate admits for `readable`. */
  const sqlVisible = async (readable: string[]) => {
    const rows = await db.$queryRaw(
      ...flattenSql(
        Prisma.sql`SELECT "id" FROM "agent_runs"
          WHERE "orgId" = ${ORG} AND ${runVisibleUnderSql(ORG, readable)} ORDER BY "id"`,
      ),
    );
    return rows.map((r: { id: string }) => r.id);
  };

  /** Run ids the in-memory filter admits for `readable`. */
  const filterVisible = async (readable: string[]) => {
    const rows = await db.agentRun.findMany({
      where: { orgId: ORG },
      select: { id: true, meta: true },
      orderBy: { id: "asc" },
    });
    return rows
      .filter((r: { meta: unknown }) => runVisibleUnder(readable, ORG, r.meta))
      .map((r: { id: string }) => r.id);
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ runVisibleUnder, runVisibleUnderSql } = await import("./run-visibility"));
    ({ Prisma } = await import("@/lib/generated/prisma/client"));
    ({ flattenSql } = await import("@/services/access"));
    await db.$executeRawUnsafe(
      `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
      ORG,
    );
  }, 60_000);

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "agent_runs" WHERE "orgId" = $1`, ORG);
    await db.$executeRawUnsafe(`DELETE FROM "agents" WHERE "orgId" = $1`, ORG);
    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","updatedAt")
       VALUES ($1,$2,'research-agent','Research','research',NOW())`,
      AGENT,
      ORG,
    );
    for (const [id, meta] of Object.entries(META_CASES)) {
      await db.$executeRawUnsafe(
        `INSERT INTO "agent_runs" ("id","orgId","agentId","status","meta","startedAt")
         VALUES ($1,$2,$3,'running'::"AgentRunStatus",$4::jsonb,NOW())`,
        id,
        ORG,
        AGENT,
        JSON.stringify(meta),
      );
    }
  });

  afterAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "agent_runs" WHERE "orgId" = $1`, ORG);
    await db.$executeRawUnsafe(`DELETE FROM "agents" WHERE "orgId" = $1`, ORG);
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db?.$disconnect?.();
  });

  const READERS: Record<string, string[]> = {
    "no grant at all": [],
    "one narrow scope": [GRANTED],
    "the org root": [ROOT],
    "two unrelated scopes": [GRANTED, `${ROOT}.eng`],
    "a scope and its own ancestor": [ROOT, GRANTED],
    "the same scope twice": [GRANTED, GRANTED],
  };

  it.each(Object.keys(READERS))("selects the same runs as the filter for a reader with %s", async (reader) => {
    const readable = READERS[reader];
    expect(await sqlVisible(readable)).toEqual(await filterVisible(readable));
  });

  // Named separately from the parity cases: agreement would also be satisfied by
  // two predicates that are wrong in the same way, so these pin the answers.
  it("admits the granted scope and its descendant, and no sibling", async () => {
    expect(await sqlVisible([GRANTED])).toEqual(["at_descendant", "at_granted"]);
  });

  it("admits a run started without a scope only through a grant on the org root", async () => {
    expect(await sqlVisible([ROOT])).toContain("empty_meta");
    expect(await sqlVisible([ROOT])).toContain("json_null_scope");
    expect(await sqlVisible([GRANTED])).not.toContain("empty_meta");
  });

  it("admits nothing at all to a reader with no grant", async () => {
    expect(await sqlVisible([])).toEqual([]);
  });
});
