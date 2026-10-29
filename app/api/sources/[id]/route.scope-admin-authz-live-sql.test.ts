// The builder, real-Postgres QA for source-disconnect-scope-admin-overrestriction-20260922.
//
// Why this file exists: the defect and its fix are both entirely about which
// ltree paths `DELETE /api/sources/:id` asks check() about, and check()'s answer
// comes from a real `s."path"::ltree @> $target::ltree` containment query
// against real grant rows. A mocked check() can only return what the fixture is
// told to return, so it can pin the route's wiring
// (route.scope-admin-authz.test.ts does exactly that) but it cannot prove that a
// scope admin is actually admitted on the scope they administer and actually
// refused outside it. Only real grants, real ltree and the real check() can.
//
// So this file runs the real route: real db, real check(), real
// `listIngestedScopePaths`, with only the Graphiti HTTP store and the auth
// context replaced. The scopes it authorizes come out of real `source_files`
// rows, which is the half the connect-side companion
// (app/api/sources/route.scope-admin-authz-live-sql.test.ts) has no equivalent
// of: a disconnect destroys content in every scope the source ever wrote to,
// not just the one it points at now.
//
// Before the fix, the route called check() with no `scope`, which defaults to
// the org root (services/access/check.ts). The org root is the top of the tree,
// so an ancestor-or-self match against it is the STRICTEST question available:
// passing it requires an org-root grant. That made disconnect owner/admin-only
// and refused an explicit admin of the scope a source lives in — while POST
// /api/sources now lets that same admin connect a source there.
//
// Set QA_DATABASE_URL to an ISOLATED test database. It is assigned to
// DATABASE_URL below because lib/db.ts reads that at import time -- never point
// this at the sandbox's inherited DATABASE_URL, which is live Neon (item
// routine-sandbox-prod-db-url). Skips cleanly when unset.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The only real remote in this route. Everything the fix is about — the scope
// derivation and the permission check — stays real.
vi.mock("@/services/memory/store", () => ({
  graphitiStore: { removeGroupFacts: vi.fn(async () => ({ removedCount: 0 })) },
}));

const ORG = "orgDisconnectAdmin";
const OTHER_ORG = "orgDisconnectAdminOther";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;
const SCOPE_B = `${ROOT}.team_b`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

/** A source that has only ever lived in scope A. */
const SRC_A = "srcDisconnectA";
/** A source in scope A whose sync records still carry episodes written under B. */
const SRC_MOVED = "srcDisconnectMoved";

describe.skipIf(!QA_URL)("source-disconnect-scope-admin-overrestriction-20260922: real SQL, real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, check: any, orgRootPath: any, DELETE: any, requireAccessContext: any;

  /** A human actor with no org-wide role, so every decision comes from grants. */
  const member = (id: string, orgId = ORG) => ({
    orgId,
    actor: { type: "human", id, role: "member" },
  });

  /** Run the route as `userId`, with no org-wide role. */
  const disconnect = async (userId: string, sourceId: string, orgId = ORG) => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: member(userId, orgId),
    } as never);
    return DELETE(new Request(`http://test/api/sources/${sourceId}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: sourceId }),
    });
  };

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

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ check, orgRootPath } = await import("@/services/access/check"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ DELETE } = await import("./route"));
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
    vi.clearAllMocks();
    await db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    await db.$executeRawUnsafe(`DELETE FROM "sources" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    await db.$executeRawUnsafe(`DELETE FROM "scopes" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);

    const scopes: [string, string, string][] = [
      ["sc_d_root", ORG, ROOT],
      ["sc_d_a", ORG, SCOPE_A],
      ["sc_d_b", ORG, SCOPE_B],
      ["sc_d_other_root", OTHER_ORG, OTHER_ROOT],
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

    for (const [id, externalId] of [
      [SRC_A, "C_a"],
      [SRC_MOVED, "C_moved"],
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "sources" ("id","orgId","type","externalId","name","scopePath","updatedAt")
           VALUES ($1,$2,'slack',$3,$4,$5,NOW())`,
        id,
        ORG,
        externalId,
        id,
        SCOPE_A,
      );
    }
    // SRC_MOVED was reconnected out of scope B, so its own sync records still
    // name B as a scope this disconnect would purge.
    await db.$executeRawUnsafe(
      `INSERT INTO "source_files" ("id","sourceId","externalFileId","checksum","episodeId","episodeScopePath")
         VALUES ($1,$2,$3,$4,$5,$6)`,
      "sf_moved_1",
      SRC_MOVED,
      "file_1",
      "sum_1",
      "ep_1",
      SCOPE_B,
    );
  });

  afterAll(async () => {
    await db?.$disconnect?.();
  });

  // The fix: what the route asks about now is the scope the source lives in.
  describe("a scope admin, on the scope their source lives in", () => {
    beforeEach(() => grant("g_d_admin_a", "sc_d_a", "user_a_admin", "admin"));

    it("may disconnect a source in that scope", async () => {
      const res = await disconnect("user_a_admin", SRC_A);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ disconnected: SRC_A });
    });

    it("actually disconnects it, rather than reporting success on a live source", async () => {
      await disconnect("user_a_admin", SRC_A);
      const [row] = await db.$queryRawUnsafe(`SELECT "status" FROM "sources" WHERE "id" = $1`, SRC_A);
      expect(row.status).toBe("disconnected");
    });

    // Guard-removal differential, direction 1 (the defect itself). Reverting
    // the fix means dropping `scope` from the check(), which defaults it back
    // to the org root -- and that is exactly the call this asserts is denied.
    // So the case above passes only because the route now names the source's
    // own scope; restore the old call and it 403s.
    it("is refused by the pre-fix org-root check, which is what made this a defect", async () => {
      const action = "memory.write" as const;
      expect(await check(member("user_a_admin"), { action })).toMatchObject({ allowed: false });
      expect(await check(member("user_a_admin"), { action, scope: orgRootPath(ORG) })).toMatchObject({
        allowed: false,
      });
    });
  });

  // Guard-removal differential, direction 2: the cases that must stay denied.
  // They fail if the resolved scope is ever widened back to the org root, or
  // if the per-scope loop is dropped altogether.
  describe("a scope admin, outside the subtree they administer", () => {
    it("may not disconnect a source whose content also lives in a sibling scope", async () => {
      await grant("g_d_admin_a", "sc_d_a", "user_a_admin", "admin");

      const res = await disconnect("user_a_admin", SRC_MOVED);

      // Admin on A is not enough: this disconnect purges B as well, and a
      // grant on A is not an ancestor of B. The caller can see the source
      // (it lives in A), so the refusal is a 403, but one that does not name
      // B: they hold no grant there (lib/hidden-record.ts).
      expect(res.status).toBe(403);
      expect((await res.json()).error).not.toContain(SCOPE_B);
    });

    it("destroys nothing in either scope when it refuses", async () => {
      await grant("g_d_admin_a", "sc_d_a", "user_a_admin", "admin");
      const { graphitiStore } = await import("@/services/memory/store");

      await disconnect("user_a_admin", SRC_MOVED);

      expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
      const [row] = await db.$queryRawUnsafe(`SELECT "status" FROM "sources" WHERE "id" = $1`, SRC_MOVED);
      expect(row.status).toBe("active");
      const files = await db.$queryRawUnsafe(`SELECT "id" FROM "source_files" WHERE "sourceId" = $1`, SRC_MOVED);
      expect(files).toHaveLength(1);
    });

    it("may not disconnect a source living in a sibling scope", async () => {
      await grant("g_d_admin_b", "sc_d_b", "user_b_admin", "admin");
      const res = await disconnect("user_b_admin", SRC_A);
      // A source the caller cannot read answers like an absent one.
      expect(res.status).toBe(404);
    });

    it("may not disconnect a source in another org", async () => {
      await grant("g_d_other_root", "sc_d_other_root", "user_other", "admin", OTHER_ORG);
      // Cross-tenant is refused before authorization even runs: the source
      // lookup is filtered on the caller's own org.
      const res = await disconnect("user_other", SRC_A, OTHER_ORG);
      expect(res.status).toBe(404);
    });
  });

  // The callers who could already disconnect must keep being able to. An
  // org-root grant is an ancestor of every path in the org, so naming the
  // resolved scopes cannot take anything away from them.
  describe("an org-wide writer keeps every source they had", () => {
    beforeEach(() => grant("g_d_root_w", "sc_d_root", "user_root", "write"));

    it.each([
      ["a source that never moved", () => SRC_A],
      ["a source whose content spans two scopes", () => SRC_MOVED],
    ])("may disconnect %s", async (_label, sourceId) => {
      const res = await disconnect("user_root", sourceId());
      expect(res.status).toBe(200);
    });
  });

  // memory.write needs `write` or better (services/access/check.ts REQUIRED).
  // Read on A is not enough to disconnect a source there, before or after.
  it("a read-only grant on a scope does not let its holder disconnect a source there", async () => {
    await grant("g_d_read_a", "sc_d_a", "user_a_reader", "read");
    const res = await disconnect("user_a_reader", SRC_A);
    expect(res.status).toBe(403);
  });

  it("refuses a caller with no grant at all", async () => {
    const res = await disconnect("user_nobody", SRC_A);
    // Not even read on the source's scope, so it answers like an absent one.
    expect(res.status).toBe(404);
  });
});
