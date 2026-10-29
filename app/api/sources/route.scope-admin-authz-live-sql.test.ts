// POST /api/sources scope authorization, against real SQL.
//
// Why this file exists: the question is entirely which ltree path
// `POST /api/sources` asks check() about, and check()'s answer comes from a
// real `s."path"::ltree @> $target::ltree` containment query against real
// grant rows. A mocked check() can only ever return what the fixture is told
// to return, so it can pin the route's wiring (route.scope-admin-authz.test.ts
// does exactly that) but it cannot prove that a scope admin is actually
// admitted inside their own subtree and actually refused outside it. Only real
// grants, real ltree and the real check() can.
//
// check() with no `scope` defaults to the org root (services/access/check.ts).
// The org root is the top of the tree, so an ancestor-or-self match against
// it is the STRICTEST question available: passing it requires an org-root
// grant. Asking about the root would make the route owner/admin-only and
// refuse an explicit admin of scope A even for a connect into A, while
// app/api/access/scopes/route.ts lets that same admin create child scopes
// under A. The route asks about the scope the source actually lands in.
//
// Set QA_DATABASE_URL to an ISOLATED test database. It is assigned to
// DATABASE_URL below because lib/db.ts reads that at import time -- never
// point this at an inherited DATABASE_URL that is a live database. Skips
// cleanly when unset.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgScopeAdmin";
const OTHER_ORG = "orgScopeAdminOther";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;
const SCOPE_A_CHILD = `${SCOPE_A}.project_one`;
const SCOPE_B = `${ROOT}.team_b`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

/** The permission POST /api/sources requires on the scope a source lands in. */
const CONNECT = "memory.write" as const;

describe.skipIf(!QA_URL)("POST /api/sources scope-admin authorization: real SQL, real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, check: any, orgRootPath: any;

  /** A human actor with no org-wide role, so every decision comes from grants. */
  const member = (id: string, orgId = ORG) => ({
    orgId,
    actor: { type: "human", id, role: "member" },
  });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ check, orgRootPath } = await import("@/services/access/check"));
    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$2,NOW())
           ON CONFLICT ("id") DO NOTHING`,
        org,
        org,
      );
    }
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    await db.$executeRawUnsafe(`DELETE FROM "scopes" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    const scopes: [string, string, string][] = [
      ["sc_root", ORG, ROOT],
      ["sc_a", ORG, SCOPE_A],
      ["sc_a_child", ORG, SCOPE_A_CHILD],
      ["sc_b", ORG, SCOPE_B],
      ["sc_other_root", OTHER_ORG, OTHER_ROOT],
    ];
    for (const [id, orgId, path] of scopes) {
      await db.$executeRawUnsafe(
        `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1,$2,$3,$4)`,
        id,
        orgId,
        path,
        id,
      );
    }
  });

  afterAll(async () => {
    await db?.$disconnect?.();
  });

  const grant = async (id: string, scopeId: string, userId: string, permission: string, orgId = ORG) => {
    await seedMember(db, { orgId, userId });
    return db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission")
         VALUES ($1,$2,$3,'user',$4,$5)`,
      id,
      orgId,
      scopeId,
      userId,
      permission,
    );
  };

  // The fix: what the route asks about now is the scope the source lands in.
  describe("a scope admin, on the scope they administer", () => {
    beforeEach(() => grant("g_admin_a", "sc_a", "user_a_admin", "admin"));

    it("may connect a source into that scope", async () => {
      const d = await check(member("user_a_admin"), { action: CONNECT, scope: SCOPE_A });
      expect(d.allowed).toBe(true);
    });

    it("may connect a source into a descendant of that scope", async () => {
      const d = await check(member("user_a_admin"), { action: CONNECT, scope: SCOPE_A_CHILD });
      expect(d.allowed).toBe(true);
    });

    // Guard-removal differential, direction 1 (the defect itself). Reverting
    // the fix means dropping `scope` from the check(), which defaults it back
    // to the org root -- and that is exactly the call this asserts is denied.
    // So the two assertions above pass only because the route now names the
    // resolved scope; restore the old call and they fail.
    it("is refused by the pre-fix org-root check, which is what made this a defect", async () => {
      const preFix = await check(member("user_a_admin"), { action: CONNECT });
      expect(preFix.allowed).toBe(false);
      expect(await check(member("user_a_admin"), { action: CONNECT, scope: orgRootPath(ORG) })).toMatchObject({
        allowed: false,
      });
    });
  });

  // The fix is additive on the caller's own subtree and nothing else. These
  // are the cases that must stay denied, and they are guard-removal
  // differential direction 2: they fail if the resolved scope is ever widened
  // back to the org root, or if the check is dropped altogether.
  describe("a scope admin, outside the subtree they administer", () => {
    beforeEach(() => grant("g_admin_a", "sc_a", "user_a_admin", "admin"));

    it("may not connect a source into a sibling scope", async () => {
      const d = await check(member("user_a_admin"), { action: CONNECT, scope: SCOPE_B });
      expect(d.allowed).toBe(false);
      // The scope it refused is the operator's half; the caller's copy never names it.
      expect(d.auditReason).toContain(SCOPE_B);
      expect(d.reason).not.toContain(SCOPE_B);
    });

    it("may not connect a source into the org root", async () => {
      const d = await check(member("user_a_admin"), { action: CONNECT, scope: ROOT });
      expect(d.allowed).toBe(false);
    });

    // A first connect with no scopePath mints `<org root>.<label>`, a fresh
    // child of the root. Scope A is not an ancestor of that, so a scope admin
    // still cannot take this branch -- the fix does not quietly hand them
    // scope creation at the top of the tree.
    it("may not mint a new source scope under the org root", async () => {
      const minted = `${ROOT}.some_new_source_a1b2c3`;
      const d = await check(member("user_a_admin"), { action: CONNECT, scope: minted });
      expect(d.allowed).toBe(false);
    });

    it("may not connect a source into another org's scope", async () => {
      const d = await check(member("user_a_admin"), { action: CONNECT, scope: OTHER_ROOT });
      expect(d.allowed).toBe(false);
    });
  });

  // The callers who could already connect must keep being able to. An
  // org-root grant is an ancestor of every path in the org, so naming the
  // resolved scope cannot take anything away from them.
  describe("an org-wide writer keeps every path they had", () => {
    beforeEach(() => grant("g_root_w", "sc_root", "user_root", "write"));

    it.each([
      ["the org root", () => ROOT],
      ["a named scope", () => SCOPE_A],
      ["a nested scope", () => SCOPE_A_CHILD],
      ["a scope they were never granted directly", () => SCOPE_B],
      ["a newly minted source scope", () => `${ROOT}.fresh_source_ff00aa`],
    ])("may connect a source into %s", async (_label, path) => {
      const d = await check(member("user_root"), { action: CONNECT, scope: path() });
      expect(d.allowed).toBe(true);
    });

    it("still may not reach another org's scope", async () => {
      const d = await check(member("user_root"), { action: CONNECT, scope: OTHER_ROOT });
      expect(d.allowed).toBe(false);
    });
  });

  // memory.write needs `write` or better (services/access/check.ts REQUIRED).
  // Read on A is not enough to connect into A, before or after this change.
  it("a read-only grant on a scope does not let its holder connect a source there", async () => {
    await grant("g_read_a", "sc_a", "user_a_reader", "read");
    const d = await check(member("user_a_reader"), { action: CONNECT, scope: SCOPE_A });
    expect(d.allowed).toBe(false);
  });

  // Cross-tenant, from the other side: an admin at the OTHER org's root holds
  // admin at the top of their own tree and still reaches nothing here.
  it("another org's root admin cannot connect a source into this org", async () => {
    await grant("g_other_root", "sc_other_root", "user_other", "admin", OTHER_ORG);
    for (const path of [ROOT, SCOPE_A, SCOPE_B]) {
      const d = await check(member("user_other", OTHER_ORG), { action: CONNECT, scope: path });
      expect(d.allowed).toBe(false);
    }
  });
});
