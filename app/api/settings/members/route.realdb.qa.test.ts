// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/settings/members returns each user row's identity provider id (clerkId)
// so a caller can match a Clerk membership to the row. The id is per org, like the
// name and email beside it: a caller in one org never sees another org's users,
// a plain member gets the same list as an admin, and no session gets nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG_A = "smclerka";
const ORG_B = "smclerkb";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)(
  "GET /api/settings/members returns clerkId only within the caller's org, real Postgres",
  () => {
    let db: PrismaClient;
    let requireAccessContext: ReturnType<typeof vi.fn>;

    async function clean() {
      await db.user.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
      await db.org.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      requireAccessContext = (
        (await import("@/lib/access-context")) as never as {
          requireAccessContext: ReturnType<typeof vi.fn>;
        }
      ).requireAccessContext;
      await clean();
      for (const org of [ORG_A, ORG_B]) {
        await db.org.create({ data: { id: org, name: org } });
        await db.user.create({
          data: {
            id: `${org}-admin`,
            orgId: org,
            clerkId: `user_${org}_admin`,
            email: `admin@${org}.invalid`,
            role: "admin",
          },
        });
        await db.user.create({
          data: {
            id: `${org}-member`,
            orgId: org,
            clerkId: `user_${org}_member`,
            email: `member@${org}.invalid`,
            role: "member",
          },
        });
      }
    });

    afterAll(async () => {
      if (db) {
        await clean();
        await db.$disconnect();
      }
    });

    async function membersAs(org: string, role: "admin" | "member") {
      const id = `${org}-${role}`;
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      requireAccessContext.mockResolvedValue({
        org: await db.org.findUniqueOrThrow({ where: { id: org } }),
        user,
        ctx: { orgId: org, actor: { type: "human", id, role } },
      });
      const { GET } = await import("@/app/api/settings/members/route");
      return GET(new Request("http://t/api/settings/members"));
    }

    it.each(["admin", "member"] as const)(
      "an org %s gets its own org's users with their clerkId, and none of another org's",
      async (role) => {
        const res = await membersAs(ORG_A, role);
        expect(res.status).toBe(200);
        const { members } = (await res.json()) as { members: Array<Record<string, unknown>> };
        expect(members.map((m) => [m.id, m.clerkId]).sort()).toEqual([
          [`${ORG_A}-admin`, `user_${ORG_A}_admin`],
          [`${ORG_A}-member`, `user_${ORG_A}_member`],
        ]);
        expect(JSON.stringify(members)).not.toContain(ORG_B);
        // The fields the route promises, and nothing more from the row.
        for (const m of members)
          expect(Object.keys(m).sort()).toEqual(["clerkId", "email", "id", "joinedAt", "name", "role"]);
      },
    );

    it("the other org's caller sees only its own clerkIds", async () => {
      const { members } = (await (await membersAs(ORG_B, "member")).json()) as { members: Array<{ clerkId: string }> };
      expect(members.map((m) => m.clerkId).sort()).toEqual([`user_${ORG_B}_admin`, `user_${ORG_B}_member`]);
    });

    it("no session gets 401 and no ids", async () => {
      requireAccessContext.mockResolvedValue(null);
      const { GET } = await import("@/app/api/settings/members/route");
      const res = await GET(new Request("http://t/api/settings/members"));
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain("user_");
    });
  },
);
