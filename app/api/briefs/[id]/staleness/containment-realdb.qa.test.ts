// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Staleness scope containment against a real database.
//
// The staleness containment predicate lives in services/access/check.ts's
// auditChangesUnderScope(), a real `LIKE ... ESCAPE` built on
// escapeLikePrefix(), not in Prisma's `startsWith`.
//
// auditChangesUnderScope() filters on `memory.write.applied`, not the bare
// `memory.write` authorization-time action, so these fixture rows are seeded
// with that action string purely to exercise the containment predicate this
// file is about. See recordAppliedChange()'s own tests
// (services/access/check.test.ts) for the timing behavior itself.
//
// The mocked scope-containment.test.ts stubs `db.$queryRaw` and re-applies
// LIKE semantics in JavaScript. That is a simulation of Postgres, not
// Postgres, and a JS re-implementation reading green is exactly how a
// wildcard leak survives a test pass (`String.prototype.startsWith` has no
// wildcards at all). So this file calls the SHIPPING product function against
// a REAL Postgres 16 with ltree, at the real audit_log table, and asserts on
// the rows the database actually returns.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-114";
const OTHER_ORG = "org-qa-114-other";
const SCOPE = "org_1.dept_sales";
const BRIEF_ID = "B-qa-114";
const CREATED_AT = new Date("2026-09-01T00:00:00Z");
const WRITTEN_AT = new Date("2026-09-02T00:00:00Z");
const BEFORE_AT = new Date("2026-08-01T00:00:00Z");

/** label -> [audit target, should the staleness banner surface it?] */
const CASES: Array<[string, string, boolean]> = [
  ["exact scope", SCOPE, true],
  ["dot-descendant", `${SCOPE}.sub`, true],
  ["deep dot-descendant", `${SCOPE}.sub.deeper`, true],
  ["slash-tagged (not self)", `${SCOPE}/entity:X`, true],
  ["self-write (persist/correct)", `${SCOPE}/brief:${BRIEF_ID}`, false],
  // The defect this fix is for: SQL LIKE `_` matches any single character,
  // and isValidLtreePath() permits `_` in an ordinary scope label.
  ["sibling differing at the _", "org_1.deptXsales.secret", false],
  // The realistic instance: `-` and `_` are BOTH valid ltree label chars and
  // SQL `_` matches `-`, so an org holding both `dept-sales` and `dept_sales`
  // -- an ordinary naming inconsistency, not an attack -- leaked one into the
  // other's brief.
  ["hyphen/underscore sibling", "org_1.dept-sales.secret", false],
  ["underscore at org label too", "orgX1.dept_sales.secret", false],
  ["bare prefix, no separator", `${SCOPE}X.secret`, false],
  ["unrelated sibling scope", "org_1.engineering", false],
  // `%` is not an ltree label char, but escapeLikePrefix() escapes it and a
  // target string is not itself constrained to a bare scope path.
  ["percent wildcard sibling", "org_1.dept_sales%.secret", false],
];

describe.skipIf(!QA_URL)("staleness containment against real Postgres", () => {
  let db: PrismaClient;
  let auditChangesUnderScope: (typeof import("@/services/access"))["auditChangesUnderScope"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ auditChangesUnderScope } = await import("@/services/access"));

    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: OTHER_ORG } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.org.create({ data: { id: ORG, name: "QA 114" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "QA 114 other" } });
    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: SCOPE,
        title: "t",
        summary: "s",
        sections: {},
        createdAt: CREATED_AT,
      },
    });
    for (const [label, target] of CASES) {
      await db.auditLog.create({
        data: {
          id: `case114-${label.replace(/\W+/g, "-")}`,
          orgId: ORG,
          actorType: "human",
          actorId: "u1",
          action: "memory.write.applied",
          target,
          decision: "allow",
          at: WRITTEN_AT,
        },
      });
    }
    // Rows that must never surface regardless of containment.
    await db.auditLog.create({
      data: {
        id: "case114-other-org",
        orgId: OTHER_ORG,
        actorType: "human",
        actorId: "u1",
        action: "memory.write.applied",
        target: SCOPE,
        decision: "allow",
        at: WRITTEN_AT,
      },
    });
    await db.auditLog.create({
      data: {
        id: "case114-denied",
        orgId: ORG,
        actorType: "human",
        actorId: "u1",
        action: "memory.write.applied",
        target: SCOPE,
        decision: "deny",
        at: WRITTEN_AT,
      },
    });
    await db.auditLog.create({
      data: {
        id: "case114-read-action",
        orgId: ORG,
        actorType: "human",
        actorId: "u1",
        action: "memory.read",
        target: SCOPE,
        decision: "allow",
        at: WRITTEN_AT,
      },
    });
    await db.auditLog.create({
      data: {
        id: "case114-before-brief",
        orgId: ORG,
        actorType: "human",
        actorId: "u1",
        action: "memory.write.applied",
        target: SCOPE,
        decision: "allow",
        at: BEFORE_AT,
      },
    });
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  async function run() {
    return auditChangesUnderScope({
      orgId: ORG,
      scopePath: SCOPE,
      after: CREATED_AT,
      excludeTarget: `${SCOPE}/brief:${BRIEF_ID}`,
      limit: 50,
    });
  }

  it.each(CASES)("%s (target %s) surfaces=%s", async (_label, target, expected) => {
    const rows = await run();
    expect(rows.some((r) => r.target === target)).toBe(expected);
  });

  it("returns exactly the four contained, non-self, allowed, post-brief writes", async () => {
    const rows = await run();
    expect(new Set(rows.map((r) => r.target))).toEqual(new Set(CASES.filter(([, , yes]) => yes).map(([, t]) => t)));
  });

  it("never crosses the org boundary, the deny decision, the action filter or the timestamp", async () => {
    const rows = await run();
    // All four negative-control rows carry target === SCOPE, which IS
    // contained -- so any of them leaking would show up as a duplicate.
    expect(rows.filter((r) => r.target === SCOPE)).toHaveLength(1);
  });
});
