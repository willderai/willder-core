// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The org role registry routes ask check() at the org root before reading or
// changing a row, as the alias registry does: an org admin role is necessary but
// not sufficient. Real routes, real check(), real audit rows. The cases:
//   - an admin holding the org-root grant lists their own org's roles only;
//   - a member, and an admin whose org-root grant is gone, get the same 403 body
//     on each method and read nothing;
//   - a refused save or remove says what the change needs (write access to the
//     organization), the text the panel shows, so an admin who may only read the
//     root is not told "admin required";
//   - the Settings page mounts the lists for exactly the people the GETs allow;
//   - each request writes exactly one audit row for its decision; a list query is
//     read only after the decision, so a refused caller's malformed query is
//     answered as any other refusal (a malformed save body is still answered 400
//     before the decision, as since #797; it names nothing about the org);
//   - concurrent first saves of one role each answer 201 and store one row, and
//     concurrent saves naming two people each answer with the person they named;
//   - an allowed save whose person id or alias holds a NUL, or whose alias holds
//     half of a surrogate pair, is answered 400 naming the field, a refused one as
//     any refusal;
//   - a refused save or delete answers the same whether the person or the row
//     exists, so the refusal reveals nothing about the org.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Org, PrismaClient, User } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const IMPORT_TIMEOUT_MS = 60_000;

const ORG_A = "org-qa-oracc-a";
const ORG_B = "org-qa-oracc-b";
const ORGS = { in: [ORG_A, ORG_B] };
const ROOT_A = `org_${ORG_A}`;
const ROOT_B = `org_${ORG_B}`;
const ADMIN = "u-qa-oracc-admin";
const NO_GRANT_ADMIN = "u-qa-oracc-nogrant";
const MEMBER = "u-qa-oracc-member";
const ROOT_READER = "u-qa-oracc-reader";
const READ_ONLY_ADMIN = "u-qa-oracc-read-admin";
const B_ADMIN = "u-qa-oracc-b-admin";
const USERS = { in: [ADMIN, NO_GRANT_ADMIN, READ_ONLY_ADMIN, MEMBER, ROOT_READER, B_ADMIN] };
const WRITE_REFUSED = {
  status: 403,
  body: { error: "only an admin with write access to the organization can change roles" },
};

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory", () => ({
  memory: { ingest: async () => undefined, transferEntity: async () => undefined },
}));

type Routes = {
  list: typeof import("@/app/api/settings/org-roles/route");
  remove: typeof import("@/app/api/settings/org-roles/[id]/route");
};

describe.skipIf(!QA_URL)("org role registry: an org admin role and an org-root decision (real Postgres)", () => {
  let db: PrismaClient;
  let routes: Routes;
  let as: (userId: string) => void;
  let aRoleId: string;
  let bRoleId: string;
  const people = new Map<string, { org: Org; user: User }>();

  async function reset() {
    await db.auditLog.deleteMany({ where: { orgId: ORGS } });
    await db.orgRole.deleteMany({ where: { orgId: ORGS } });
    await db.grant.deleteMany({ where: { orgId: ORGS } });
    await db.scope.deleteMany({ where: { orgId: ORGS } });
    await db.user.deleteMany({ where: { id: USERS } });
    await db.org.deleteMany({ where: { id: ORGS } });
  }

  /** The audit rows `actorId` has written in `orgId`, oldest first. */
  const auditRows = (orgId: string, actorId: string) =>
    db.auditLog.findMany({
      where: { orgId, actorId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, target: true, decision: true },
    });

  const list = (query = "page=1") => routes.list.GET(new Request(`http://localhost/api/settings/org-roles?${query}`));
  const save = (role: string, userId: string, aliases: string[] = []) =>
    routes.list.POST(
      new Request("http://localhost/api/settings/org-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role, userId, aliases }),
      }),
    );
  const remove = (id: string) =>
    routes.remove.DELETE(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id }) });

  /** The signed-in request context of `userId`, as lib/access-context.ts builds it. */
  const requestContext = (userId: string) => {
    const { org, user } = people.get(userId)!;
    return {
      org,
      user,
      ctx: { orgId: org.id, actor: { type: "human" as const, id: userId, role: user.role }, origin: "app" as const },
    };
  };

  /** Status and body together, so "looks identical" compares everything a caller sees. */
  const seen = async (res: Response) => ({ status: res.status, body: await res.json() });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    ({ db } = await import("@/lib/db"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    routes = {
      list: await import("@/app/api/settings/org-roles/route"),
      remove: await import("@/app/api/settings/org-roles/[id]/route"),
    };

    await reset();
    const orgA = await db.org.create({ data: { id: ORG_A, clerkOrgId: `clerk_${ORG_A}`, name: ORG_A } });
    const orgB = await db.org.create({ data: { id: ORG_B, clerkOrgId: `clerk_${ORG_B}`, name: ORG_B } });
    const user = (id: string, org: Org, role: "admin" | "member") =>
      db.user.create({
        data: { id, orgId: org.id, clerkId: `clerk_${id}`, email: `${id}@example.test`, name: id, role },
      });
    people.set(ADMIN, { org: orgA, user: await user(ADMIN, orgA, "admin") });
    people.set(NO_GRANT_ADMIN, { org: orgA, user: await user(NO_GRANT_ADMIN, orgA, "admin") });
    people.set(MEMBER, { org: orgA, user: await user(MEMBER, orgA, "member") });
    people.set(READ_ONLY_ADMIN, { org: orgA, user: await user(READ_ONLY_ADMIN, orgA, "admin") });
    people.set(ROOT_READER, { org: orgA, user: await user(ROOT_READER, orgA, "member") });
    people.set(B_ADMIN, { org: orgB, user: await user(B_ADMIN, orgB, "admin") });

    // Per-person grants on each root, so one admin of org A can hold none, and a member can
    // read the root without the admin role.
    const roots = new Map<string, string>();
    for (const orgId of [ORG_A, ORG_B]) {
      roots.set(orgId, (await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } })).id);
    }
    for (const [orgId, userId, permission] of [
      [ORG_A, ADMIN, "admin"],
      [ORG_A, ROOT_READER, "read"],
      [ORG_A, READ_ONLY_ADMIN, "read"],
      [ORG_B, B_ADMIN, "admin"],
    ] as const) {
      await db.grant.create({
        data: { orgId, scopeId: roots.get(orgId)!, granteeType: "user", granteeId: userId, permission },
      });
    }

    as = (userId) => requireAccessContext.mockResolvedValue(requestContext(userId));
  }, IMPORT_TIMEOUT_MS);

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORGS } });
    await db.orgRole.deleteMany({ where: { orgId: ORGS } });
    aRoleId = (await db.orgRole.create({ data: { orgId: ORG_A, role: "CEO", userId: ADMIN, aliases: ["the boss"] } }))
      .id;
    bRoleId = (await db.orgRole.create({ data: { orgId: ORG_B, role: "CTO", userId: B_ADMIN, aliases: [] } })).id;
  });

  afterAll(async () => {
    if (db) await reset();
  });

  describe("GET", () => {
    it("lists the org's roles to an admin holding the org-root grant, with one allow row", async () => {
      as(ADMIN);
      const res = await list();

      expect(res.status).toBe(200);
      const { roles } = (await res.json()) as { roles: { id: string; role: string }[] };
      expect(roles.map((r) => [r.id, r.role])).toEqual([[aRoleId, "CEO"]]);
      expect(await auditRows(ORG_A, ADMIN)).toEqual([
        { action: "memory.read", target: `${ROOT_A}/org_roles`, decision: "allow" },
      ]);
    });

    it("shows another org's admin their own org's roles, never this org's", async () => {
      as(B_ADMIN);
      const { roles } = (await (await list()).json()) as { roles: { id: string }[] };

      expect(roles.map((r) => r.id)).toEqual([bRoleId]);
      expect(await auditRows(ORG_B, B_ADMIN)).toEqual([
        { action: "memory.read", target: `${ROOT_B}/org_roles`, decision: "allow" },
      ]);
      expect(await auditRows(ORG_A, B_ADMIN)).toEqual([]);
    });

    it("refuses an admin whose org-root grant is gone with one deny row, answering as it answers a member", async () => {
      as(NO_GRANT_ADMIN);
      const noGrant = await seen(await list());
      as(MEMBER);
      const member = await seen(await list());

      expect(noGrant).toEqual({ status: 403, body: { error: "admin required" } });
      expect(member).toEqual(noGrant);
      expect(await auditRows(ORG_A, NO_GRANT_ADMIN)).toEqual([
        { action: "memory.read", target: `${ROOT_A}/org_roles`, decision: "deny" },
      ]);
      // A member is refused by the role gate, before check() is asked.
      expect(await auditRows(ORG_A, MEMBER)).toEqual([
        { action: "access.refused", target: `${ROOT_A}/settings:org-roles:list`, decision: "deny" },
      ]);
    });

    it("decides before reading the query, so a refused admin's malformed query answers as a member's", async () => {
      for (const query of ["", "page=abc", "page=1&sort=name"]) {
        as(NO_GRANT_ADMIN);
        const noGrant = await seen(await list(query));
        as(MEMBER);
        expect(await seen(await list(query))).toEqual(noGrant);
        expect(noGrant).toEqual({ status: 403, body: { error: "admin required" } });
      }
      expect((await auditRows(ORG_A, NO_GRANT_ADMIN)).map((r) => r.decision)).toEqual(["deny", "deny", "deny"]);

      as(ADMIN);
      expect(await seen(await list("page=abc"))).toEqual({
        status: 400,
        body: { error: "page must be a whole number from 1 to 100000" },
      });
    });

    it("refuses the same way whether or not the org has any roles", async () => {
      as(NO_GRANT_ADMIN);
      const withRoles = await seen(await list());
      await db.orgRole.deleteMany({ where: { orgId: ORG_A } });
      const empty = await seen(await list());

      expect(empty).toEqual(withRoles);
    });
  });

  describe("the Settings page probe (lib/page-permissions.ts)", () => {
    it.each([ADMIN, READ_ONLY_ADMIN, NO_GRANT_ADMIN, MEMBER, ROOT_READER])(
      "mounts the role and alias lists for %s exactly when both GETs answer 200, writing no audit row itself",
      async (userId) => {
        const { pagePermissions } = await import("@/lib/page-permissions");
        const { GET: listAliases } = await import("@/app/api/settings/aliases/route");
        const { orgAdmin } = await pagePermissions(requestContext(userId) as never);
        expect(await auditRows(ORG_A, userId)).toEqual([]);

        as(userId);
        expect((await list()).status === 200).toBe(orgAdmin);
        expect((await listAliases(new Request("http://localhost/api/settings/aliases?page=1"))).status === 200).toBe(
          orgAdmin,
        );
        expect(orgAdmin).toBe(userId === ADMIN || userId === READ_ONLY_ADMIN);
      },
    );
  });

  it("lets an admin who may only read the org root list the roles, and says a save or remove needs write access", async () => {
    as(READ_ONLY_ADMIN);
    expect((await list()).status).toBe(200);
    expect(await seen(await save("CFO", MEMBER))).toEqual(WRITE_REFUSED);
    expect(await seen(await remove(aRoleId))).toEqual(WRITE_REFUSED);
    expect(await seen(await remove("orgrole-missing"))).toEqual(WRITE_REFUSED);
    expect(await db.orgRole.count({ where: { orgId: ORG_A } })).toBe(1);
    expect(await auditRows(ORG_A, READ_ONLY_ADMIN)).toEqual([
      { action: "memory.read", target: `${ROOT_A}/org_roles`, decision: "allow" },
      { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "deny" },
      { action: "memory.write", target: `${ROOT_A}/org_role:${aRoleId}`, decision: "deny" },
      { action: "memory.write", target: `${ROOT_A}/org_role:orgrole-missing`, decision: "deny" },
    ]);
  });

  it("answers a member's save and remove as it answers a refused admin's, one role-gate row each", async () => {
    as(MEMBER);
    const member = [await seen(await save("CFO", MEMBER)), await seen(await remove(aRoleId))];
    as(NO_GRANT_ADMIN);
    const noGrant = [await seen(await save("CFO", MEMBER)), await seen(await remove(aRoleId))];

    expect(member).toEqual([WRITE_REFUSED, WRITE_REFUSED]);
    expect(noGrant).toEqual(member);
    expect(await auditRows(ORG_A, MEMBER)).toEqual([
      { action: "access.refused", target: `${ROOT_A}/settings:org-roles:save`, decision: "deny" },
      { action: "access.refused", target: `${ROOT_A}/settings:org-roles:delete`, decision: "deny" },
    ]);
    expect(await db.orgRole.count({ where: { orgId: ORG_A } })).toBe(1);
  });

  describe("POST", () => {
    it("saves a role for an admin holding the org-root grant, with one allow row", async () => {
      as(ADMIN);
      expect((await save("CFO", MEMBER)).status).toBe(201);

      expect(await db.orgRole.count({ where: { orgId: ORG_A, role: "CFO", userId: MEMBER } })).toBe(1);
      expect(await auditRows(ORG_A, ADMIN)).toEqual([
        { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "allow" },
      ]);
    });

    it("refuses an admin without the grant before looking up the person, so a member and a stranger answer alike", async () => {
      as(NO_GRANT_ADMIN);
      const forMember = await seen(await save("CFO", MEMBER));
      const forStranger = await seen(await save("CFO", "u-qa-oracc-nobody"));

      expect(forMember).toEqual(WRITE_REFUSED);
      expect(forStranger).toEqual(forMember);
      expect(await db.orgRole.count({ where: { orgId: ORG_A, role: "CFO" } })).toBe(0);
      expect(await auditRows(ORG_A, NO_GRANT_ADMIN)).toEqual([
        { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "deny" },
        { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "deny" },
      ]);
    });
  });

  it("stores one row and answers every one of sixteen concurrent first saves of a role with 201", async () => {
    as(ADMIN);
    const saves = await Promise.all(Array.from({ length: 16 }, (_, i) => save("CFO", i % 2 ? MEMBER : ADMIN)));

    expect(saves.map((r) => r.status)).toEqual(Array(16).fill(201));
    expect(await db.orgRole.count({ where: { orgId: ORG_A, role: "CFO" } })).toBe(1);
  });

  it("answers each of sixteen concurrent saves of one role to two people with the person and aliases that save sent", async () => {
    as(ADMIN);
    const holderOf = (i: number) => (i % 2 ? MEMBER : ADMIN);
    const saves = await Promise.all(Array.from({ length: 16 }, (_, i) => save("CEO", holderOf(i), [`alias ${i}`])));
    const answered = await Promise.all(saves.map(async (r) => (await r.json()).role));

    expect(answered.map((r) => [r.id, r.user.id, r.aliases])).toEqual(
      Array.from({ length: 16 }, (_, i) => [aRoleId, holderOf(i), [`alias ${i}`]]),
    );
    const stored = await db.orgRole.findMany({
      where: { orgId: ORG_A, role: "CEO" },
      select: { userId: true, aliases: true },
    });
    expect(stored).toHaveLength(1);
    expect(answered.map((r) => ({ userId: r.user.id, aliases: r.aliases }))).toContainEqual(stored[0]);
  });

  it("answers an allowed save whose person id or alias Postgres cannot take with 400 naming it, and a refused one as any refusal", async () => {
    const nul = (field: string) => ({
      status: 400,
      body: { error: `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.` },
    });
    as(ADMIN);
    expect(await seen(await save("CFO", `${MEMBER}\u0000`))).toEqual(nul("userId"));
    expect(await seen(await save("CFO", MEMBER, ["chief", "b\u0000ss"]))).toEqual(nul("aliases"));
    expect(await seen(await save("CFO", MEMBER, ["b\udc00ss"]))).toEqual({
      status: 400,
      body: { error: "aliases contains half of a surrogate pair, which cannot be stored. Remove it and retry." },
    });
    as(NO_GRANT_ADMIN);
    expect(await seen(await save("CFO", `${MEMBER}\u0000`))).toEqual(WRITE_REFUSED);

    expect(await db.orgRole.count({ where: { orgId: ORG_A, role: "CFO" } })).toBe(0);
    expect([...(await auditRows(ORG_A, ADMIN)), ...(await auditRows(ORG_A, NO_GRANT_ADMIN))]).toEqual([
      { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "allow" },
      { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "allow" },
      { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "allow" },
      { action: "memory.write", target: `${ROOT_A}/org_role:CFO`, decision: "deny" },
    ]);
  });

  describe("DELETE", () => {
    it("deletes for an admin holding the org-root grant, with one allow row", async () => {
      as(ADMIN);
      expect((await remove(aRoleId)).status).toBe(200);

      expect(await db.orgRole.count({ where: { id: aRoleId } })).toBe(0);
      expect(await auditRows(ORG_A, ADMIN)).toEqual([
        { action: "memory.write", target: `${ROOT_A}/org_role:${aRoleId}`, decision: "allow" },
      ]);
    });

    it("answers a second delete of the same role 404, not an error", async () => {
      as(ADMIN);
      const [first, second] = await Promise.all([remove(aRoleId), remove(aRoleId)]);

      expect([first.status, second.status].sort()).toEqual([200, 404]);
    });

    it("answers an admin 404 alike for another org's role and for no role, and deletes neither", async () => {
      as(ADMIN);
      const otherOrgs = await seen(await remove(bRoleId));
      const missing = await seen(await remove("orgrole-missing"));

      expect(otherOrgs).toEqual({ status: 404, body: { error: "not found" } });
      expect(missing).toEqual(otherOrgs);
      expect(await db.orgRole.count({ where: { id: bRoleId } })).toBe(1);
    });

    it("refuses an admin without the grant before the lookup, so an existing and a missing id answer alike", async () => {
      as(NO_GRANT_ADMIN);
      const existing = await seen(await remove(aRoleId));
      const missing = await seen(await remove("orgrole-missing"));

      expect(existing).toEqual(WRITE_REFUSED);
      expect(missing).toEqual(existing);
      expect(await db.orgRole.count({ where: { id: aRoleId } })).toBe(1);
      expect(await auditRows(ORG_A, NO_GRANT_ADMIN)).toEqual([
        { action: "memory.write", target: `${ROOT_A}/org_role:${aRoleId}`, decision: "deny" },
        { action: "memory.write", target: `${ROOT_A}/org_role:orgrole-missing`, decision: "deny" },
      ]);
    });
  });
});
