// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/memory/scopes's candidate query, on grant shapes and path shapes the route's
// other tests do not exercise.
//
// The claim under test: the listing holds exactly the scopes can() allows inside the
// caller's live grants in this org (to them, their role, or everyone), nothing about
// a scope outside those grants reaches the response, and an owner or admin gets the
// same answer the route gave before candidates were narrowed to grants.
//
// Only the caller's identity is stubbed. Membership, grants and ltree containment
// run against Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "case653scopesorg";
const OTHER_ORG = "case653scopesother";
const MEMBER = "case653-scopes-member";
const ADMIN = "case653-scopes-admin";
const OWNER = "case653-scopes-owner";
const ROOT = `org_${ORG}`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const A = `${ROOT}.a`;
const A_CHILD = `${A}.x`;
const AB = `${ROOT}.ab`;
const UNDERSCORED = `${ROOT}.dept_sales`;
const LOOKALIKE = `${ROOT}.deptXsales`;
const HIDDEN = `${ROOT}.finance`;
const OTHER_TEAM = `${OTHER_ROOT}.a`;

describe.skipIf(!QA_URL)("GET /api/memory/scopes candidates, grant and path edge cases", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let can: (typeof import("@/services/access"))["can"];
  let MAX: number;
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];
  const scopes: Record<string, string> = {};

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ can, MAX_DESCENDANT_SCOPES: MAX } = await import("@/services/access"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
  });

  const cleanup = async () => {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.orgMembership.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN, OWNER] } } });
    await db.org.deleteMany({ where: { id: orgs } });
  };

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    await db.org.create({ data: { id: ORG, name: "Scopes QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Scopes QA other" } });
    await seedMember(db, { orgId: ORG, userId: MEMBER, role: "member" });
    await seedMember(db, { orgId: ORG, userId: ADMIN, role: "admin" });
    await seedMember(db, { orgId: ORG, userId: OWNER, role: "owner" });
    await seedMember(db, { orgId: OTHER_ORG, userId: MEMBER, role: "member" });
    for (const path of [
      ROOT,
      A,
      A_CHILD,
      AB,
      `${AB}.y`,
      UNDERSCORED,
      `${UNDERSCORED}.y`,
      LOOKALIKE,
      `${LOOKALIKE}.y`,
      HIDDEN,
    ]) {
      scopes[path] = (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id;
    }
    for (const path of [OTHER_ROOT, OTHER_TEAM]) {
      scopes[path] = (await db.scope.create({ data: { orgId: OTHER_ORG, path, name: path } })).id;
    }
    // As lib/tenant.ts seeds every org: owner and admin roles hold admin on the root.
    for (const role of ["owner", "admin"]) {
      await db.grant.create({
        data: { orgId: ORG, scopeId: scopes[ROOT], granteeType: "role", granteeId: role, permission: "admin" },
      });
    }
  });

  const grant = (
    scopePath: string,
    granteeType: "user" | "role" | "everyone",
    granteeId: string,
    extra: { permission?: "read" | "write" | "admin"; expiresAt?: Date; orgId?: string } = {},
  ) =>
    db.grant.create({
      data: {
        orgId: extra.orgId ?? ORG,
        scopeId: scopes[scopePath],
        granteeType,
        granteeId,
        permission: extra.permission ?? "read",
        expiresAt: extra.expiresAt,
      },
    });

  const asCaller = (userId: string, role: "member" | "admin" | "owner") => {
    const rc = {
      org: { id: ORG },
      user: { id: userId, role },
      ctx: { orgId: ORG, origin: "app" as const, actor: { type: "human" as const, id: userId, role } },
    };
    vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
    return rc;
  };
  const callAs = async (userId: string, role: "member" | "admin" | "owner") => {
    asCaller(userId, role);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: { path: string }[]; truncated: boolean };
    return { paths: body.scopes.map((s) => s.path), truncated: body.truncated };
  };

  it("a grant on a scope never lists a sibling sharing its text prefix (org.a vs org.ab)", async () => {
    await grant(A, "user", MEMBER);

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [A, A_CHILD], truncated: false });
  });

  it("an underscore in the granted path matches only itself", async () => {
    await grant(UNDERSCORED, "user", MEMBER);

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [UNDERSCORED, `${UNDERSCORED}.y`], truncated: false });
  });

  it("a grant to the member's role lists its subtree, one to another role does not", async () => {
    await grant(A, "role", "member");
    await grant(HIDDEN, "role", "viewer");

    expect((await callAs(MEMBER, "member")).paths).toEqual([A, A_CHILD]);
  });

  it("a grant to everyone lists its subtree for a member", async () => {
    await grant(HIDDEN, "everyone", "*");

    expect((await callAs(MEMBER, "member")).paths).toEqual([HIDDEN]);
  });

  it("a revoked (deleted) grant lists nothing", async () => {
    const g = await grant(A, "user", MEMBER);
    expect((await callAs(MEMBER, "member")).paths).toEqual([A, A_CHILD]);
    await db.grant.delete({ where: { id: g.id } });

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [], truncated: false });
  });

  it("a removed member lists nothing, though their grant still exists", async () => {
    await grant(A, "user", MEMBER);
    await db.orgMembership.updateMany({ where: { orgId: ORG, userId: MEMBER }, data: { removedAt: new Date() } });

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [], truncated: false });
  });

  it("a grant row in this org pointing at another org's scope lists nothing from either org", async () => {
    await grant(OTHER_TEAM, "user", MEMBER, { orgId: ORG });

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [], truncated: false });
  });

  it("another org's scope is never listed, even one whose path sits under a scope the member reads here", async () => {
    // The database ties a scope's path to nothing but (orgId, path) uniqueness, so
    // only the query's orgId filter keeps this row out: can() would allow its path.
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `${A}.foreign`, name: "other org's scope" } });
    await grant(A, "user", MEMBER);

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [A, A_CHILD], truncated: false });
  });

  it("a grant row filed under another org, pointing at this org's scope, lists nothing", async () => {
    await grant(A, "user", MEMBER, { orgId: OTHER_ORG });

    expect(await callAs(MEMBER, "member")).toEqual({ paths: [], truncated: false });
  });

  it("owners and admins get the answer the route gave before: the org's first MAX+1 scopes by path, each decided by can()", async () => {
    // Enough scopes that the old org-wide query and the bound both matter.
    for (let i = 0; i < MAX; i++) {
      const path = `${ROOT}.z_${String(i).padStart(3, "0")}`;
      scopes[path] = (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id;
    }
    for (const [userId, role] of [
      [ADMIN, "admin"],
      [OWNER, "owner"],
    ] as const) {
      const rc = asCaller(userId, role);
      const rows = await db.scope.findMany({
        where: { orgId: ORG },
        select: { path: true },
        orderBy: { path: "asc" },
        take: MAX + 1,
      });
      const candidates = rows.slice(0, MAX);
      const allowed = await Promise.all(candidates.map((s) => can(rc.ctx, { action: "memory.read", scope: s.path })));
      const before = {
        paths: candidates.filter((_, i) => allowed[i].allowed).map((s) => s.path),
        truncated: rows.length > MAX,
      };

      expect(await callAs(userId, role)).toEqual(before);
    }
  });
});
