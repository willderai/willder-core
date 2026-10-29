// GET /api/sources' gate against real Postgres grants.
//
// Why this file exists: route.list-gate.test.ts pins that GET /api/sources asks
// check() and refuses on a denial, but its check() is a mock, so it can only
// show what the fixture is told to return. It cannot show WHO that question
// actually admits. check()'s answer comes from a real
// `granted_path::ltree @> target::ltree` containment query against real grant
// rows, so only real grants, real ltree and the real check() can prove that an
// org-wide writer is genuinely let in and that a scope admin, a read-only
// member and a caller from another tenant are genuinely refused.
//
// The gate asks about the org root: check() with no `scope` defaults there
// (services/access/check.ts), and grants match ancestor-or-self, so the org
// root is the STRICTEST question available — a grant on a child scope is not an
// ancestor of the root and does not pass. That is deliberate for a list
// endpoint, which returns every source in the org regardless of scope, and the
// cases below lock it in rather than assume it.
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

const ORG = "orgListGate";
const OTHER_ORG = "orgListGateOther";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

/** A source in this org's scope A, and one belonging to the other tenant. */
const SRC_MINE = "srcListGateMine";
const SRC_THEIRS = "srcListGateTheirs";

describe.skipIf(!QA_URL)("sources-list-gate-coverage-20260922: real SQL, real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, GET: any, requireAccessContext: any;

  /** A human actor with no org-wide role, so every decision comes from grants. */
  const member = (id: string, orgId = ORG) => ({
    orgId,
    actor: { type: "human", id, role: "member" },
  });

  /** Run the real route as `userId` acting inside `orgId`. */
  const list = async (userId: string, orgId = ORG) => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: member(userId, orgId),
    } as never);
    return GET(new Request("http://localhost/api/sources?page=1"));
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
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ GET } = await import("./route"));
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
      ["sc_lg_root", ORG, ROOT],
      ["sc_lg_a", ORG, SCOPE_A],
      ["sc_lg_other_root", OTHER_ORG, OTHER_ROOT],
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

    const sources: [string, string, string, string][] = [
      [SRC_MINE, ORG, "C_mine", SCOPE_A],
      [SRC_THEIRS, OTHER_ORG, "C_theirs", OTHER_ROOT],
    ];
    for (const [id, orgId, externalId, scopePath] of sources) {
      await db.$executeRawUnsafe(
        `INSERT INTO "sources" ("id","orgId","type","externalId","name","scopePath","updatedAt")
         VALUES ($1,$2,'slack',$3,$4,$5,NOW())`,
        id,
        orgId,
        externalId,
        id,
        scopePath,
      );
    }
  });

  afterAll(async () => {
    await db?.$disconnect?.();
  });

  const idsIn = async (res: any) => ((await res.json()).sources ?? []).map((s: any) => s.id);

  describe("a member the org root grants write to", () => {
    beforeEach(() => grant("g_lg_writer", "sc_lg_root", "user_writer", "write"));

    it("may list the org's sources", async () => {
      const res = await list("user_writer");
      expect(res.status).toBe(200);
      await expect(idsIn(res)).resolves.toEqual([SRC_MINE]);
    });

    it("sees nothing belonging to another tenant", async () => {
      await expect(idsIn(await list("user_writer"))).resolves.not.toContain(SRC_THEIRS);
    });
  });

  it("admits a member the org root grants admin to, since admin covers write", async () => {
    await grant("g_lg_admin", "sc_lg_root", "user_admin", "admin");
    expect((await list("user_admin")).status).toBe(200);
  });

  describe("callers the gate must refuse", () => {
    // Each of these is a 403 only because the gate is there. Delete the
    // check() and its 403 from GET and every one of them returns 200 with the
    // org's source list -- which is exactly the exposure this file measures.

    it("refuses a member with no grant at all", async () => {
      const res = await list("user_nobody");
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.not.toHaveProperty("sources");
    });

    it("refuses a member granted only read at the org root", async () => {
      await grant("g_lg_reader", "sc_lg_root", "user_reader", "read");
      expect((await list("user_reader")).status).toBe(403);
    });

    // A list endpoint returns every source in the org, including ones outside
    // the subtree this admin governs, so a child-scope grant is correctly not
    // enough. Locking this in: it is the behavior, not an accident.
    it("refuses an admin of a child scope, whose grant does not cover the org root", async () => {
      await grant("g_lg_scope_admin", "sc_lg_a", "user_a_admin", "admin");
      expect((await list("user_a_admin")).status).toBe(403);
    });

    // The cross-tenant case. This user really does hold an org-root write
    // grant -- in their OWN org. Grants are org-scoped, so it buys them
    // nothing here, and without the gate they would read the other tenant's
    // entire source list.
    it("refuses a caller whose only grant is in a different org", async () => {
      await grant("g_lg_foreign", "sc_lg_root", "user_writer", "write");
      const res = await list("user_writer", OTHER_ORG);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.not.toHaveProperty("sources");
    });
  });

  it("gives each tenant only its own sources", async () => {
    await grant("g_lg_other", "sc_lg_other_root", "user_other", "write", OTHER_ORG);
    await expect(idsIn(await list("user_other", OTHER_ORG))).resolves.toEqual([SRC_THEIRS]);
  });
});
