// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The org role registry's org-root decision against grant shapes its own suite does not
// seed. The rule under test (services/resolver/org-roles.ts):
// an org admin role is necessary but not sufficient; check() must also allow the action
// at the org root. So each of these admins is refused on all three methods, with the
// member's answer to that method, nothing read or changed, and no memory write started:
//   - an admin whose only grant is on a scope below the root;
//   - an admin whose root grant has expired;
//   - an admin whose only root grant belongs to another org.
// Also: an allowed admin sending a NUL in the id or role is answered 404 (no row has
// that id) or 400 naming the role, not 500 and not the write refusal,
// and another org's admin cannot name this org's member in a save.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Org, PrismaClient, User } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const IMPORT_TIMEOUT_MS = 60_000;

const ORG_A = "org-qa-orshape-a";
const ORG_B = "org-qa-orshape-b";
const ORGS = { in: [ORG_A, ORG_B] };
const ADMIN = "u-qa-orshape-admin";
const CHILD_ADMIN = "u-qa-orshape-child";
const EXPIRED_ADMIN = "u-qa-orshape-expired";
const FOREIGN_GRANT_ADMIN = "u-qa-orshape-foreign";
const MEMBER = "u-qa-orshape-member";
const B_ADMIN = "u-qa-orshape-b-admin";
const USERS = { in: [ADMIN, CHILD_ADMIN, EXPIRED_ADMIN, FOREIGN_GRANT_ADMIN, MEMBER, B_ADMIN] };

const memoryCalls = vi.hoisted(() => ({ ingest: [] as unknown[], transferEntity: [] as unknown[] }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory", () => ({
  memory: {
    ingest: async (input: unknown) => {
      memoryCalls.ingest.push(input);
    },
    transferEntity: async (input: unknown) => {
      memoryCalls.transferEntity.push(input);
    },
  },
}));

describe.skipIf(!QA_URL)(
  "org role registry refuses admins whose grant does not cover the org root (real Postgres)",
  () => {
    let db: PrismaClient;
    let list: typeof import("@/app/api/settings/org-roles/route");
    let byId: typeof import("@/app/api/settings/org-roles/[id]/route");
    let as: (userId: string) => void;
    let aRoleId: string;
    const people = new Map<string, { org: Org; user: User }>();

    async function reset() {
      await db.auditLog.deleteMany({ where: { orgId: ORGS } });
      await db.orgRole.deleteMany({ where: { orgId: ORGS } });
      await db.grant.deleteMany({ where: { orgId: ORGS } });
      await db.scope.deleteMany({ where: { orgId: ORGS } });
      await db.user.deleteMany({ where: { id: USERS } });
      await deleteOrgsWithRetry(db, { where: { id: ORGS } });
    }

    const get = () => list.GET(new Request("http://localhost/api/settings/org-roles?page=1"));
    const save = (role: string, userId: string) =>
      list.POST(
        new Request("http://localhost/api/settings/org-roles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role, userId }),
        }),
      );
    const remove = (id: string) =>
      byId.DELETE(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id }) });
    const seen = async (res: Response) => ({ status: res.status, body: await res.json() });
    const auditCount = (actorId: string) => db.auditLog.count({ where: { orgId: ORGS, actorId } });

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      ({ db } = await import("@/lib/db"));
      const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
        requireAccessContext: ReturnType<typeof vi.fn>;
      };
      list = await import("@/app/api/settings/org-roles/route");
      byId = await import("@/app/api/settings/org-roles/[id]/route");

      await reset();
      const orgA = await db.org.create({ data: { id: ORG_A, clerkOrgId: `clerk_${ORG_A}`, name: ORG_A } });
      const orgB = await db.org.create({ data: { id: ORG_B, clerkOrgId: `clerk_${ORG_B}`, name: ORG_B } });
      const user = (id: string, org: Org, role: "admin" | "member") =>
        db.user.create({
          data: { id, orgId: org.id, clerkId: `clerk_${id}`, email: `${id}@example.test`, name: id, role },
        });
      for (const id of [ADMIN, CHILD_ADMIN, EXPIRED_ADMIN, FOREIGN_GRANT_ADMIN]) {
        people.set(id, { org: orgA, user: await user(id, orgA, "admin") });
      }
      people.set(MEMBER, { org: orgA, user: await user(MEMBER, orgA, "member") });
      people.set(B_ADMIN, { org: orgB, user: await user(B_ADMIN, orgB, "admin") });

      const rootA = await db.scope.create({ data: { orgId: ORG_A, path: `org_${ORG_A}`, name: "root" } });
      const childA = await db.scope.create({ data: { orgId: ORG_A, path: `org_${ORG_A}.eng`, name: "eng" } });
      const rootB = await db.scope.create({ data: { orgId: ORG_B, path: `org_${ORG_B}`, name: "root" } });
      const grant = (orgId: string, scopeId: string, granteeId: string, expiresAt: Date | null = null) =>
        db.grant.create({ data: { orgId, scopeId, granteeType: "user", granteeId, permission: "admin", expiresAt } });
      await grant(ORG_A, rootA.id, ADMIN);
      await grant(ORG_A, childA.id, CHILD_ADMIN);
      await grant(ORG_A, rootA.id, EXPIRED_ADMIN, new Date(Date.now() - 60_000));
      await grant(ORG_B, rootB.id, FOREIGN_GRANT_ADMIN);
      await grant(ORG_B, rootB.id, B_ADMIN);

      as = (userId) => {
        const { org, user: u } = people.get(userId)!;
        requireAccessContext.mockResolvedValue({
          org,
          user: u,
          ctx: { orgId: org.id, actor: { type: "human" as const, id: userId, role: u.role }, origin: "app" as const },
        });
      };
    }, IMPORT_TIMEOUT_MS);

    beforeEach(async () => {
      await db.auditLog.deleteMany({ where: { orgId: ORGS } });
      await db.orgRole.deleteMany({ where: { orgId: ORGS } });
      aRoleId = (await db.orgRole.create({ data: { orgId: ORG_A, role: "CEO", userId: ADMIN, aliases: [] } })).id;
      memoryCalls.ingest.length = 0;
      memoryCalls.transferEntity.length = 0;
    });

    afterAll(async () => {
      if (db) await reset();
    });

    it.each([
      ["a grant only below the root", CHILD_ADMIN],
      ["an expired root grant", EXPIRED_ADMIN],
      ["a root grant in another org only", FOREIGN_GRANT_ADMIN],
    ])("refuses an admin holding %s on GET, POST and DELETE, as it refuses a member", async (_shape, userId) => {
      as(MEMBER);
      const memberAnswer = {
        list: await seen(await get()),
        save: await seen(await save("CFO", MEMBER)),
        remove: await seen(await remove(aRoleId)),
      };
      const memberAuditRows = await auditCount(MEMBER);
      as(userId);

      expect(await seen(await get())).toEqual(memberAnswer.list);
      expect(await seen(await save("CFO", MEMBER))).toEqual(memberAnswer.save);
      expect(await seen(await remove(aRoleId))).toEqual(memberAnswer.remove);
      expect(await seen(await remove("orgrole-missing"))).toEqual(memberAnswer.remove);
      expect(memberAuditRows).toBe(3);

      // One decision row per request, nothing changed, no memory write started.
      expect(await auditCount(userId)).toBe(4);
      expect(await db.orgRole.findMany({ where: { orgId: ORG_A }, select: { role: true } })).toEqual([{ role: "CEO" }]);
      expect(memoryCalls).toEqual({ ingest: [], transferEntity: [] });
    });

    it("starts the memory write only for an allowed save", async () => {
      as(ADMIN);
      expect((await save("CFO", MEMBER)).status).toBe(201);
      expect(memoryCalls.ingest).toHaveLength(1);
      expect(await auditCount(ADMIN)).toBe(1);
    });

    it("answers, not 500s, an allowed admin whose id or role holds a NUL as a missing row and a bad field, and changes nothing", async () => {
      as(ADMIN);
      expect(await seen(await remove(`${aRoleId}\u0000`))).toEqual({ status: 404, body: { error: "not found" } });
      expect(await seen(await save("C\u0000FO", MEMBER))).toEqual({
        status: 400,
        body: { error: "role contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry." },
      });

      expect(await db.orgRole.count({ where: { orgId: ORG_A } })).toBe(1);
      expect(memoryCalls).toEqual({ ingest: [], transferEntity: [] });
      expect(await auditCount(ADMIN)).toBe(2);
    });

    it("does not let another org's admin assign this org's member, and writes nothing in this org", async () => {
      as(B_ADMIN);
      expect(await seen(await save("CFO", MEMBER))).toEqual({ status: 404, body: { error: "user not found in org" } });

      expect(await db.orgRole.count({ where: { orgId: ORGS, role: "CFO" } })).toBe(0);
      expect(await db.auditLog.count({ where: { orgId: ORG_A, actorId: B_ADMIN } })).toBe(0);
      expect(memoryCalls).toEqual({ ingest: [], transferEntity: [] });
    });
  },
);
