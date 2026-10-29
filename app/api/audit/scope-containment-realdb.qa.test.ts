// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/audit scope containment, against a real database.
//
// The mocked app/api/audit/scope-containment.test.ts asserts on the query the
// route builds. That tests the call shape, not the relation: whether the three
// containment legs actually exclude a sibling scope is decided by Postgres,
// not by the shape of the argument.
//
// It matters specifically here because a containment predicate built on
// Prisma's `startsWith` compiles to SQL `LIKE`. `_` is a LIKE wildcard
// matching ANY single character, and `_` is also an ordinary character in
// every scope path this product mints (ScopePicker creates segments as
// `slug_hexhash`). services/access/check.ts's auditChangesUnderScope() -- the
// SAME containment relation -- does NOT use `startsWith` for exactly this
// reason: it builds `LIKE ... ESCAPE` over escapeLikePrefix().
// app/api/briefs/[id]/staleness/containment-realdb.qa.test.ts pins the
// realistic instance: an org holding both `dept-sales` and `dept_sales`, an
// ordinary naming inconsistency rather than an attack.
//
// So this file drives the REAL GET /api/audit handler against a REAL Postgres 16
// with ltree, through the real access.manage check(), and asserts on the rows
// the database actually returns.
//
// It also covers the untagged group_id namespace (`group:1.dept_sales`), which
// the same scope filter matches as the counterpart of `org_1.dept_sales`.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "1";
const OTHER_ORG = "2";
const SCOPE = "org_1.dept_sales";
const ADMIN = "u-admin-122";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

/** label -> [audit target, visible under ?scope=org_1.dept_sales ?] */
const CASES: Array<[string, string, boolean]> = [
  ["exact scope", SCOPE, true],
  ["dot-descendant", `${SCOPE}.sub`, true],
  ["deep dot-descendant", `${SCOPE}.sub.deeper`, true],
  ["slash-tagged", `${SCOPE}/entity:X`, true],
  // A bare character prefix, no separator.
  ["bare prefix, no separator", `${SCOPE}X`, false],
  ["bare prefix sibling scope", "org_1.dept_salesforce.secret", false],
  // The LIKE-wildcard dimension `startsWith` cannot express. `_` matches any
  // single character, and SCOPE contains two of them.
  ["sibling differing at the _", "org_1.deptXsales.secret", false],
  ["hyphen/underscore sibling", "org_1.dept-sales.secret", false],
  ["underscore at the org label too", "orgX1.dept_sales.secret", false],
  ["unrelated sibling scope", "org_1.engineering", false],
  // The untagged group_id partition at the same place in the tree
  // (services/audit/audit-target.ts), where a write-effect row lands when its
  // caller passed no scope. Matched by the same escaped predicate.
  ["untagged partition, tagged", "group:1.dept_sales/fact:f1", true],
  ["untagged partition, dot-descendant", "group:1.dept_sales.sub/fact:f2", true],
  ["untagged parent partition", "group:1/fact:f3", false],
  ["untagged sibling differing at the _", "group:1.deptXsales/fact:f4", false],
  ["untagged bare prefix, no separator", "group:1.dept_salesX/fact:f5", false],
];

describe.skipIf(!QA_URL)("GET /api/audit scope containment, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    // Also clear by explicit id: an earlier run may have seeded these rows
    // under a different org id, and a delete keyed only on orgId would miss them.
    await db.auditLog.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.grant.deleteMany({ where: { granteeId: ADMIN } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.grant.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.scope.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.user.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });

    await db.org.create({ data: { id: ORG, name: "Case122" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Case122 other" } });
    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@case122.test", role: "admin", clerkId: "clerk-case122" },
    });
    // A real grant so the route's own access.manage check() genuinely ALLOWS,
    // evaluated by the shipping authorization evaluator rather than a mock.
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: "org_1", name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    for (const [, target] of CASES) {
      await db.auditLog.create({
        data: {
          orgId: ORG,
          actorType: "human",
          actorId: ADMIN,
          action: "memory.read",
          target,
          decision: "allow",
          at: new Date("2026-09-01T00:00:00Z"),
        },
      });
    }
    // Cross-tenant control: byte-identical target, different org.
    await db.auditLog.create({
      data: {
        orgId: OTHER_ORG,
        actorType: "human",
        actorId: "u-other",
        action: "memory.read",
        target: SCOPE,
        decision: "allow",
        at: new Date("2026-09-01T00:00:00Z"),
      },
    });
    await db.auditLog.create({
      data: {
        orgId: OTHER_ORG,
        actorType: "human",
        actorId: "u-other",
        action: "memory.read",
        target: "group:1.dept_sales/fact:f1",
        decision: "allow",
        at: new Date("2026-09-01T00:00:00Z"),
      },
    });

    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function targetsUnder(scope: string): Promise<string[]> {
    const res = await GET(new Request(`http://t/api/audit?scope=${encodeURIComponent(scope)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    return (body.entries as Array<{ target: string }>).map((e) => e.target);
  }

  it("the permitted read succeeds at all (the evaluator really allows this admin)", async () => {
    const all = await GET(new Request("http://t/api/audit"));
    expect(all.status).toBe(200);
    const body = await all.json();
    expect(body.entries.length).toBeGreaterThan(0);
  });

  for (const [label, target, visible] of CASES) {
    it(`${visible ? "includes" : "EXCLUDES"} ${label} (${target})`, async () => {
      const got = await targetsUnder(SCOPE);
      expect(got.includes(target)).toBe(visible);
    });
  }

  it("never returns another tenant's row with a byte-identical target", async () => {
    const res = await GET(new Request(`http://t/api/audit?scope=${encodeURIComponent(SCOPE)}`));
    const body = await res.json();
    const ids = (body.entries as Array<{ id: string }>).map((e) => e.id);
    const foreign = await db.auditLog.findMany({ where: { orgId: OTHER_ORG }, select: { id: true } });
    for (const f of foreign) expect(ids).not.toContain(f.id);
  });
});

// ---------------------------------------------------------------------------
// Visibility: the target-aware rule for "access.manage" rows and the scope
// containment above live in one WHERE clause, so the visibility half needs the
// same real-Postgres treatment the containment half gets: its markers are
// matched with LIKE as well, and "fact_dispute:" contains an `_`. Every row
// here is action "access.manage" -- the only action whose visibility depends
// on its target -- where the cases above are all "memory.read".
const ORG3 = "3";
const SCOPE3 = "org_3.dept_sales";
const ADMIN3 = "u-admin-122-vis";

/** label -> [audit target, visible ?] */
const VISIBILITY_CASES: Array<[string, string, boolean]> = [
  ["grant creation", `${SCOPE3}/grants:create:${SCOPE3}.sub`, true],
  ["grant revocation", `${SCOPE3}/grants:revoke:cap_1`, true],
  ["dispute resolution", `${SCOPE3}/fact_dispute:d_1`, true],
  ["grants:list probe read", `${SCOPE3}/grants:list`, false],
  ["fact_disputes probe read", `${SCOPE3}/fact_disputes`, false],
  // The marker's own `_` as a LIKE wildcard: unescaped, this row reads as a
  // dispute resolution and becomes visible. Decided by Postgres, not by a
  // mocked pattern matcher.
  ["wildcard sibling of the dispute marker", `${SCOPE3}/factXdispute:d_1`, false],
];

describe.skipIf(!QA_URL)("GET /api/audit access.manage visibility, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await db.auditLog.deleteMany({ where: { orgId: ORG3 } });
    await db.grant.deleteMany({ where: { granteeId: ADMIN3 } });
    await db.user.deleteMany({ where: { orgId: ORG3 } });
    await db.scope.deleteMany({ where: { orgId: ORG3 } });
    await db.org.deleteMany({ where: { id: ORG3 } });

    await db.org.create({ data: { id: ORG3, name: "Case122 visibility" } });
    const admin = await db.user.create({
      data: { id: ADMIN3, orgId: ORG3, email: "a@case122vis.test", role: "admin", clerkId: "clerk-case122-vis" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG3, path: SCOPE3, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG3, scopeId: scope.id, granteeType: "user", granteeId: ADMIN3, permission: "admin" },
    });
    // Root grant as well, same as the containment suite above: the route's
    // own access.manage check() is unscoped, so a grant on the leaf alone
    // denies the read outright (403) before any row filtering happens.
    const root3 = await db.scope.create({ data: { orgId: ORG3, path: "org_3", name: "root" } });
    await db.grant.create({
      data: { orgId: ORG3, scopeId: root3.id, granteeType: "user", granteeId: ADMIN3, permission: "admin" },
    });

    for (const [, target] of VISIBILITY_CASES) {
      await db.auditLog.create({
        data: {
          orgId: ORG3,
          actorType: "human",
          actorId: ADMIN3,
          action: "access.manage",
          target,
          decision: "allow",
          at: new Date("2026-09-01T00:00:00Z"),
        },
      });
    }

    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG3 } }),
      user: admin,
      ctx: { orgId: ORG3, actor: { type: "human", id: ADMIN3, role: "admin" } },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  for (const [label, target, visible] of VISIBILITY_CASES) {
    it(`${visible ? "shows" : "HIDES"} ${label} (${target})`, async () => {
      const res = await GET(new Request(`http://t/api/audit?scope=${encodeURIComponent(SCOPE3)}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      const targets = (body.entries as Array<{ target: string }>).map((e) => e.target);
      expect(targets.includes(target)).toBe(visible);
    });
  }
});
