// GET /api/settings/org-roles?page= and GET /api/settings/aliases?page=
// against a real Postgres: the org condition bounds the rows, the matching count and the
// org total even when another org holds more, and better-matching, rows; a search for
// `%`, `_` or `\` matches that character inside one alias and never spans two; rows
// that tie on the sort key still appear on exactly one page; and a non-admin or a
// malformed request gets a refusal with no rows in it.
//
// Authentication is mocked; the access evaluator and SQL are real. Set QA_DATABASE_URL
// to an isolated test database (never the inherited DATABASE_URL); skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SETTINGS_PAGE_SIZE } from "@/lib/settings-lists";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "slpqa";
const OTHER_ORG = "slpqaother";
const ADMIN = "u-slpqa-admin";
const MEMBER = "u-slpqa-member";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type AliasPage = { aliases: { id: string; canonicalName: string }[]; total: number; count: number; page: number };
type RolePage = { roles: { id: string; role: string }[]; total: number; count: number; page: number };

describe.skipIf(!QA_URL)("Settings role and alias pages stay inside the org and match literally", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let rolesGET: Handler;
  let aliasesGET: Handler;

  const call = (handler: Handler, path: string, query: string) => handler(new Request(`http://t${path}?${query}`));
  async function ok<T>(res: Response): Promise<T> {
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }
  const aliases = async (query: string) => ok<AliasPage>(await call(aliasesGET, "/api/settings/aliases", query));
  const roles = async (query: string) => ok<RolePage>(await call(rolesGET, "/api/settings/org-roles", query));
  const aliasNames = async (query: string) => (await aliases(query)).aliases.map((a) => a.canonicalName);

  function signIn(userId: string, role: "admin" | "member") {
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: userId, role },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role } },
    } as never);
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.orgRole.deleteMany({ where: { orgId: org } });
      await db.entityAlias.deleteMany({ where: { orgId: org } });
      for (const t of ["grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    rolesGET = (await import("@/app/api/settings/org-roles/route")).GET;
    aliasesGET = (await import("@/app/api/settings/aliases/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    for (const org of [ORG, OTHER_ORG]) {
      await db.org.create({ data: { id: org, name: org } });
      await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
    }
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@q.test`, role: "admin", clerkId: `c-${ADMIN}` },
    });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@q.test`, role: "member", clerkId: `c-${MEMBER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    signIn(ADMIN, "admin");
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("matches %, _ and \\ inside one entity alias, as themselves, and never across two aliases", async () => {
    const add = (canonicalName: string, list: string[]) =>
      db.entityAlias.create({
        data: { orgId: ORG, entityType: "account", entityId: `e-${canonicalName}`, canonicalName, aliases: list },
      });
    await add("Percent", ["50% off"]);
    await add("Underscore", ["snake_case"]);
    await add("Backslash", ["dom\\user"]);
    await add("Plain", ["50 off", "snakeXcase", "domuser"]);
    await add("Split", ["half", "way"]);

    expect(await aliasNames("q=0%25&page=1")).toEqual(["Percent"]);
    expect(await aliasNames("q=%25&page=1")).toEqual(["Percent"]);
    expect(await aliasNames("q=e_c&page=1")).toEqual(["Underscore"]);
    expect(await aliasNames("q=_&page=1")).toEqual(["Underscore"]);
    expect(await aliasNames("q=m%5Cu&page=1")).toEqual(["Backslash"]);
    expect(await aliasNames("q=%5C&page=1")).toEqual(["Backslash"]);
    // "half" and "way" are two aliases: neither the space-joined nor the run-together text matches.
    expect(await aliasNames("q=half%20way&page=1")).toEqual([]);
    expect(await aliasNames("q=halfway&page=1")).toEqual([]);
    expect(await aliasNames("q=f%20w&page=1")).toEqual([]);
  });

  it("searches an alias entry's canonical name and type text, not only its aliases", async () => {
    await db.entityAlias.create({
      data: { orgId: ORG, entityType: "contact", entityId: "e1", canonicalName: "Zelda Quill", aliases: [] },
    });
    await db.entityAlias.create({
      data: { orgId: ORG, entityType: "org", entityId: "e2", canonicalName: "Other", aliases: [] },
    });
    expect(await aliasNames("q=QUILL&page=1")).toEqual(["Zelda Quill"]);
    expect(await aliasNames("q=ontac&page=1")).toEqual(["Zelda Quill"]);
  });

  it("bounds rows, matching count and org total to the org when another org has more, better-matching rows", async () => {
    // This org: 3 accounts named "Shared n". The other org: 40 accounts with the same names and aliases.
    for (let i = 0; i < 3; i += 1) {
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "account",
          entityId: `mine-${i}`,
          canonicalName: `Shared ${i}`,
          aliases: ["shared.io"],
        },
      });
    }
    for (let i = 0; i < 40; i += 1) {
      await db.entityAlias.create({
        data: {
          orgId: OTHER_ORG,
          entityType: "account",
          entityId: `theirs-${i}`,
          canonicalName: `Shared ${i}`,
          aliases: ["shared.io"],
        },
      });
    }
    const mine = new Set((await db.entityAlias.findMany({ where: { orgId: ORG } })).map((a) => a.id));

    for (const query of [
      "page=1",
      "page=1&type=account",
      "page=1&q=shared.io",
      "page=1&q=shared&type=account&sort=created&order=desc",
    ]) {
      const page = await aliases(query);
      expect(page, query).toMatchObject({ total: 3, count: 3 });
      expect(
        page.aliases.every((a) => mine.has(a.id)),
        query,
      ).toBe(true);
    }
    // A page past this org's last: nothing listed, and still only this org counted.
    expect(await aliases("page=2&q=shared")).toMatchObject({ aliases: [], total: 3, count: 3, page: 2 });

    // Org roles: the other org holds more matching roles, through its own users.
    const pat = await db.user.create({
      data: { id: "u-slpqa-pat", orgId: ORG, name: "Pat", email: "pat@q.test", role: "member", clerkId: "c-pat" },
    });
    await db.orgRole.create({ data: { orgId: ORG, role: "Head of Ops", userId: pat.id, aliases: ["ops lead"] } });
    for (let i = 0; i < 30; i += 1) {
      const u = await db.user.create({
        data: {
          id: `u-slpqa-x${i}`,
          orgId: OTHER_ORG,
          name: "Pat",
          email: `pat${i}@other.test`,
          role: "member",
          clerkId: `c-x${i}`,
        },
      });
      await db.orgRole.create({
        data: { orgId: OTHER_ORG, role: `Head of Ops ${i}`, userId: u.id, aliases: ["ops lead"] },
      });
    }
    for (const query of ["page=1", "page=1&q=ops%20lead", "page=1&q=pat", "page=1&sort=person&order=desc"]) {
      const page = await roles(query);
      expect(page, query).toMatchObject({ total: 1, count: 1 });
      expect(
        page.roles.map((r) => r.role),
        query,
      ).toEqual(["Head of Ops"]);
    }
  });

  it("lists every alias exactly once across pages when they all share a date and a type", async () => {
    const at = new Date(Date.UTC(2026, 9, 1));
    const rows = 2 * SETTINGS_PAGE_SIZE + 7;
    for (let i = 0; i < rows; i += 1) {
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "contact",
          entityId: `t-${i}`,
          canonicalName: "Same",
          aliases: [],
          createdAt: at,
        },
      });
    }
    for (const view of ["sort=created&order=desc", "sort=created&order=asc", "sort=type", "sort=name&order=desc"]) {
      const ids: string[] = [];
      for (const page of [1, 2, 3]) ids.push(...(await aliases(`page=${page}&${view}`)).aliases.map((a) => a.id));
      expect(ids, view).toHaveLength(rows);
      expect(new Set(ids).size, view).toBe(rows);
    }
  });

  it("refuses a signed-in member on both tables, with no rows or counts in the answer", async () => {
    // The member may read the org root, so check() alone would let the alias page through:
    // only the admin-role gate stands between a member and either table.
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    await db.entityAlias.create({
      data: { orgId: ORG, entityType: "user", entityId: "e", canonicalName: "Secret", aliases: [] },
    });
    await db.orgRole.create({ data: { orgId: ORG, role: "CEO", userId: ADMIN, aliases: [] } });
    signIn(MEMBER, "member");
    for (const [handler, path] of [
      [rolesGET, "/api/settings/org-roles"],
      [aliasesGET, "/api/settings/aliases"],
    ] as const) {
      const res = await call(handler, path, "page=1");
      expect(res.status, path).toBe(403);
      const body = await res.json();
      expect(Object.keys(body), path).toEqual(["error"]);
    }
  });

  it("answers 400 to a missing or out-of-range page and to a value the list does not offer", async () => {
    for (const [handler, path] of [
      [rolesGET, "/api/settings/org-roles"],
      [aliasesGET, "/api/settings/aliases"],
    ] as const) {
      for (const query of [
        "",
        "page=0",
        "page=abc",
        "page=1.5",
        "page=100001",
        "page=1&order=up",
        "page=1&sort=createdAt",
      ]) {
        expect((await call(handler, path, query)).status, `${path}?${query}`).toBe(400);
      }
    }
    expect((await call(aliasesGET, "/api/settings/aliases", "page=1&type=person")).status).toBe(400);
    expect((await call(rolesGET, "/api/settings/org-roles", "page=1&sort=name")).status).toBe(400);
  });
});
