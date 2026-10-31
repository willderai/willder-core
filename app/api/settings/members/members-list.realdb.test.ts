// GET /api/settings/members with a search, a role filter, an order and pages,
// against a real Postgres.
//
// The list, its `total` and its `memberCount` hold only live memberships of the
// caller's org: never a removed member, never a person whose `users.orgId` still
// names the org after they left it, and never another org's people, whatever the
// search says. Pages are exact at their edges, and `%` and `_` are literal.
//
// Authentication is mocked; the membership rows are real. Set QA_DATABASE_URL to an
// isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "mlist";
const OTHER_ORG = "mlistother";

const ADA = "u-ml-ada";
const MO = "u-ml-mo";
const PAT = "u-ml-pat";
const ILKAY = "u-ml-ilkay";
const LEFT = "u-ml-left";
const MOVED = "u-ml-moved";
const OTHER = "u-ml-other";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Listed = {
  members: { id: string; name: string | null; email: string; role: string; joinedAt: string }[];
  total: number;
  memberCount: number;
  page?: number;
  pageSize?: number;
};

describe.skipIf(!QA_URL)("the members list holds only live members of the caller's org", { timeout: 30_000 }, () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let GET: (typeof import("./route"))["GET"];
  let joined = 0;

  function actAs(orgId: string, userId: string, role: "admin" | "member") {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role } },
    } as never);
  }

  async function list(query = ""): Promise<Listed> {
    const res = await GET(new Request(`http://t/api/settings/members?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Listed;
  }

  const ids = (listed: Listed) => listed.members.map((m) => m.id);

  /** A person joining `orgId`, each later than the last. */
  async function person(
    id: string,
    orgId: string,
    name: string | null,
    email: string,
    role: "owner" | "admin" | "member" = "member",
  ) {
    await db.user.create({ data: { id, orgId, name, email, role, clerkId: `c-${id}` } });
    joined += 1;
    await db.orgMembership.update({
      where: { orgId_userId: { orgId, userId: id } },
      data: { createdAt: new Date(Date.UTC(2026, 0, 1, 0, joined)) },
    });
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.orgMembership.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    ({ GET } = await import("./route"));
  });

  beforeEach(async () => {
    await clear();
    joined = 0;
    for (const org of [ORG, OTHER_ORG]) await db.org.create({ data: { id: org, name: org } });
    await person(ADA, ORG, "Ada Admin", "ada@ml.test", "admin");
    await person(MO, ORG, "Mo Member", "mo@ml.test");
    await person(PAT, ORG, "Pat_Percent", "pat+100%@ml.test");
    await person(ILKAY, ORG, "İlkay Şahin", "ilkay@ml.test");
    // Left the org: the membership is removed, the user row is kept.
    await person(LEFT, ORG, "Lee Left", "lee@ml.test", "admin");
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: ORG, userId: LEFT } },
      data: { removedAt: new Date() },
    });
    // Last had this org open but now belongs only to the other one.
    await person(MOVED, ORG, "Mira Moved", "mira@ml.test");
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: ORG, userId: MOVED } },
      data: { removedAt: new Date() },
    });
    await db.orgMembership.create({
      data: { orgId: OTHER_ORG, userId: MOVED, role: "member", assertedAt: new Date() },
    });
    await person(OTHER, OTHER_ORG, "Dana Other", "dana@other.test", "admin");
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("a member and an admin get the same live members of their own org, and counts that agree", async () => {
    for (const [user, role] of [
      [MO, "member"],
      [ADA, "admin"],
    ] as const) {
      actAs(ORG, user, role);
      const listed = await list("sort=name");
      expect(ids(listed)).toEqual([ADA, ILKAY, MO, PAT]);
      expect(listed.total).toBe(4);
      expect(listed.memberCount).toBe(4);
    }
  });

  it("a search finds neither a removed member, a person who moved away, nor another org's people, and counts none of them", async () => {
    actAs(ORG, MO, "member");
    for (const q of ["lee", "lee@ml", "mira", "dana", "other.test"]) {
      expect(await list(`q=${encodeURIComponent(q)}&page=1`)).toEqual({
        members: [],
        total: 0,
        memberCount: 4,
        page: 1,
        pageSize: 25,
      });
    }
    const found = await list("q=ML.TEST&sort=name");
    expect(ids(found)).toEqual([ADA, ILKAY, MO, PAT]);
    expect((await list("q=mo%20member")).members.map((m) => m.email)).toEqual(["mo@ml.test"]);
  });

  it("filters by role among live members only", async () => {
    actAs(ORG, MO, "member");
    const admins = await list("role=admin");
    expect(ids(admins)).toEqual([ADA]);
    expect(admins.total).toBe(1);
    expect(await list("role=owner")).toMatchObject({ members: [], total: 0, memberCount: 4 });
  });

  it("another org's member sees only their own org, including the person who moved there", async () => {
    actAs(OTHER_ORG, OTHER, "admin");
    const listed = await list("sort=name");
    expect(ids(listed)).toEqual([OTHER, MOVED]);
    expect(listed.memberCount).toBe(2);
    expect(await list("q=ada")).toMatchObject({ members: [], total: 0 });
  });

  it("treats % and _ as literal characters, and matches a dotted capital I as written", async () => {
    actAs(ORG, MO, "member");
    expect(ids(await list("q=_"))).toEqual([PAT]);
    expect(ids(await list("q=100%25"))).toEqual([PAT]);
    expect(await list("q=%25%25")).toMatchObject({ members: [], total: 0 });
    // A backslash is literal too, never an escape that turns the next character into a wildcard.
    expect(await list("q=%5C")).toMatchObject({ members: [], total: 0 });
    expect(await list("q=%5C_")).toMatchObject({ members: [], total: 0 });
    expect(ids(await list(`q=${encodeURIComponent("İlkay")}`))).toEqual([ILKAY]);
    expect(ids(await list(`q=${encodeURIComponent("şahin")}`))).toEqual([ILKAY]);
  });

  it("pages exactly at the edges: a full page, the remainder, then nothing", async () => {
    for (let i = 0; i < 22; i += 1)
      await person(`u-ml-bulk-${i}`, ORG, `Bulk ${String(i).padStart(2, "0")}`, `bulk${i}@ml.test`);
    actAs(ORG, MO, "member");
    // 4 seeded members plus 22: 26 in all, one past a full page of 25.
    const first = await list("sort=joined&page=1");
    expect(first.members).toHaveLength(25);
    expect(first).toMatchObject({ total: 26, memberCount: 26, page: 1, pageSize: 25 });
    const second = await list("sort=joined&page=2");
    expect(ids(second)).toEqual(["u-ml-bulk-21"]);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(26);
    expect(await list("sort=joined&page=3")).toMatchObject({ members: [], total: 26 });

    const bulk = await list("q=bulk&sort=name&order=desc&page=1");
    expect(bulk.members[0]?.name).toBe("Bulk 21");
    expect(bulk.total).toBe(22);
  });

  it("pages people who joined in the same instant without repeating or skipping one", async () => {
    for (let i = 0; i < 27; i += 1) await person(`u-ml-tie-${i}`, ORG, "Same Name", `tie${i}@ml.test`);
    await db.orgMembership.updateMany({ where: { orgId: ORG }, data: { createdAt: new Date("2026-10-01T00:00:00Z") } });
    actAs(ORG, MO, "member");
    for (const query of ["sort=joined", "sort=joined&order=desc", "sort=name", "sort=role&order=desc"]) {
      const first = await list(`${query}&page=1`);
      const second = await list(`${query}&page=2`);
      expect(new Set([...ids(first), ...ids(second)]).size).toBe(31);
    }
  });

  it("orders by when people joined, newest first on request", async () => {
    actAs(ORG, MO, "member");
    expect(ids(await list("sort=joined&order=desc"))).toEqual([ILKAY, PAT, MO, ADA]);
  });

  it("without page returns every match, as the member pickers read it", async () => {
    actAs(ORG, MO, "member");
    const all = await list();
    expect(all.members).toHaveLength(4);
    expect(all).not.toHaveProperty("page");
  });

  it("refuses a value it does not offer with a message naming the fix, and a missing session with 401", async () => {
    actAs(ORG, MO, "member");
    for (const [query, message] of [
      ["role=guest", "role must be one of owner, admin, member"],
      ["sort=email", "sort must be one of name, role, joined"],
      ["order=up", "order must be asc or desc"],
      ["page=0", "page must be a whole number from 1 to 100000"],
      ["page=2.5", "page must be a whole number from 1 to 100000"],
      [`q=${"x".repeat(101)}`, "q must be at most 100 characters"],
      ["q=a%00", "q must not contain a NUL character"],
    ] as const) {
      const res = await GET(new Request(`http://t/api/settings/members?${query}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(message);
    }
    requireAccessContext.mockResolvedValue(null);
    expect((await GET(new Request("http://t/api/settings/members?q=ada"))).status).toBe(401);
  });
});
