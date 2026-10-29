// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The two settings routes that ask "who is in this org":
// GET /api/settings/members and POST /api/settings/org-roles. Both read the
// live membership of the request's org (org_memberships), so a person removed
// from the org, or a person who only belongs to another org, is neither listed
// nor assignable. Each case is a real user row, so a route that read `users`
// by id alone would find them.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const IMPORT_TIMEOUT_MS = 60_000;

const ORG_A = "org-qa-sm-a";
const ORG_B = "org-qa-sm-b";
const ORGS = { in: [ORG_A, ORG_B] };
const ADMIN = "u-qa-sm-admin";
const LIVE = "u-qa-sm-live";
const REMOVED = "u-qa-sm-removed";
const OTHER_ORG = "u-qa-sm-other";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory", () => ({
  memory: { ingest: async () => undefined, transferEntity: async () => undefined },
}));

describe.skipIf(!QA_URL)(
  "settings routes list and assign live members of the request's org only (real Postgres)",
  () => {
    let db: PrismaClient;
    let members: typeof import("@/app/api/settings/members/route");
    let orgRoles: typeof import("@/app/api/settings/org-roles/route");

    async function reset() {
      await db.orgRole.deleteMany({ where: { orgId: ORGS } });
      await db.grant.deleteMany({ where: { orgId: ORGS } });
      await db.scope.deleteMany({ where: { orgId: ORGS } });
      await db.user.deleteMany({ where: { id: { in: [ADMIN, LIVE, REMOVED, OTHER_ORG] } } });
      await db.org.deleteMany({ where: { id: ORGS } });
    }

    async function createUser(id: string, orgId: string, role: "admin" | "member") {
      // The users_join_org trigger records the membership of the org the row names.
      return db.user.create({
        data: { id, orgId, clerkId: `clerk_${id}`, email: `${id}@example.test`, name: id, role },
      });
    }

    function assign(userId: string) {
      return orgRoles.POST(
        new Request("http://localhost/api/settings/org-roles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: `Role for ${userId}`, userId }),
        }),
      );
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      ({ db } = await import("@/lib/db"));
      const { recordMembership, recordMembershipRemoved } = await import("@/services/access/membership");
      const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
        requireAccessContext: ReturnType<typeof vi.fn>;
      };
      members = await import("@/app/api/settings/members/route");
      orgRoles = await import("@/app/api/settings/org-roles/route");

      await reset();
      const orgA = await db.org.create({ data: { id: ORG_A, clerkOrgId: `clerk_${ORG_A}`, name: ORG_A } });
      await db.org.create({ data: { id: ORG_B, clerkOrgId: `clerk_${ORG_B}`, name: ORG_B } });

      const admin = await createUser(ADMIN, ORG_A, "admin");
      // The tenant's default policy (lib/tenant.ts): admins hold admin on the root, which
      // saving an org role asks check() for.
      const root = await db.scope.create({ data: { orgId: ORG_A, path: `org_${ORG_A}`, name: "root" } });
      await db.grant.create({
        data: { orgId: ORG_A, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
      await createUser(LIVE, ORG_A, "member");
      await createUser(OTHER_ORG, ORG_B, "admin");
      // Removed from A, still in B: the user row survives, pointed at B.
      await createUser(REMOVED, ORG_B, "member");
      await recordMembership({
        orgId: ORG_A,
        userId: REMOVED,
        role: "admin",
        assertedAt: new Date(Date.now() - 60_000),
      });
      await recordMembershipRemoved({ orgId: ORG_A, userId: REMOVED, removedAt: new Date() });

      requireAccessContext.mockResolvedValue({
        org: orgA,
        user: admin,
        ctx: { orgId: ORG_A, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
      });
    }, IMPORT_TIMEOUT_MS);

    afterAll(async () => {
      if (db) await reset();
    });

    it("lists the org's live members, not a removed member or a person from another org", async () => {
      const res = await members.GET(new Request("http://t/api/settings/members"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { id: string; role: string }[] };

      expect(body.members.map((m) => m.id).sort()).toEqual([ADMIN, LIVE].sort());
    });

    it("assigns an org role to a live member", async () => {
      const res = await assign(LIVE);
      expect(res.status).toBe(201);
    });

    it("refuses to assign an org role to a person removed from the org", async () => {
      const res = await assign(REMOVED);

      expect(res.status).toBe(404);
      expect(await db.orgRole.count({ where: { orgId: ORG_A, userId: REMOVED } })).toBe(0);
    });

    it("refuses to assign an org role to a person who belongs only to another org", async () => {
      const res = await assign(OTHER_ORG);

      expect(res.status).toBe(404);
      expect(await db.orgRole.count({ where: { orgId: ORG_A, userId: OTHER_ORG } })).toBe(0);
    });
  },
);
