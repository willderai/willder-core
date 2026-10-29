// GET /api/settings/org-roles?page= and GET
// /api/settings/aliases?page= at a size a real org reaches:
// more than 1,000 rows in each of two orgs. Every row of the org appears on exactly
// one page even when many rows share a sort value, the other org's rows are never
// listed or counted, one named item is one search away, a filter narrows the count
// it reports, and a member who is not an admin reads nothing. An alias save and
// remove each leave an audit row naming the entry.
//
// Real Postgres with ltree and the real access evaluator; authentication is mocked.
// Set QA_DATABASE_URL to an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SETTINGS_PAGE_SIZE } from "@/lib/settings-lists";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "settingsscaleqa";
const OTHER_ORG = "settingsscaleqaother";
const ADMIN = "u-ssq-admin";
const OTHER_ADMIN = "u-ssq-other-admin";
const MEMBER = "u-ssq-member";
const ALIASES = 1_060; // 42 full pages and a last page of 10
const ROLES = 1_030;
const SAME_INSTANT = new Date("2026-10-01T12:00:00.000Z");

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type Page<K extends string, R> = Record<K, R[]> & { total: number; count: number; page: number; pageSize: number };
type AliasPage = Page<"aliases", { id: string; entityType: string; canonicalName: string }>;
type RolePage = Page<"roles", { id: string; role: string; user: { email: string } }>;

describe.skipIf(!QA_URL)("the Settings role and alias tables at 1,000+ rows in two orgs", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let rolesGET: Handler;
  let aliasesGET: Handler;
  let aliasesPOST: Handler;
  let aliasDELETE: (req: Request, a: { params: Promise<{ id: string }> }) => Promise<Response>;

  function signIn(org: string, id: string, role: "admin" | "member") {
    requireAccessContext.mockResolvedValue({
      org: { id: org, name: org },
      user: { id, role },
      ctx: { orgId: org, actor: { type: "human", id, role } },
    } as never);
  }

  async function getJson<T>(handler: Handler, path: string, query: string): Promise<T> {
    const res = await handler(new Request(`http://t${path}?${query}`));
    expect(res.status, `${path}?${query}`).toBe(200);
    return (await res.json()) as T;
  }
  const aliases = (q: string) => getJson<AliasPage>(aliasesGET, "/api/settings/aliases", q);
  const roles = (q: string) => getJson<RolePage>(rolesGET, "/api/settings/org-roles", q);

  async function seedOrg(org: string, admin: string, tag: string) {
    await db.org.create({ data: { id: org, name: org } });
    const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
    await db.user.create({
      data: { id: admin, orgId: org, email: `${admin}@ssq.test`, role: "admin", clerkId: `c-${admin}` },
    });
    await db.grant.create({
      data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: admin, permission: "admin" },
    });

    const types = ["user", "account", "contact", "org"] as const;
    // Every alias shares one canonical name and one createdAt, so only the id tie-break orders them.
    await db.entityAlias.createMany({
      data: Array.from({ length: ALIASES }, (_, i) => ({
        orgId: org,
        entityType: types[i % 4],
        entityId: `${tag}-e-${i}`,
        canonicalName: "Shared Name",
        aliases: [`${tag}-alias-${i}`, "common"],
        createdAt: SAME_INSTANT,
      })),
    });
    // Every person shares one display name, so the person sort leans on its tie-breaks.
    await db.user.createMany({
      data: Array.from({ length: ROLES }, (_, i) => ({
        id: `${tag}-u-${i}`,
        orgId: org,
        name: "Same Person",
        email: `${tag}-p${i}@ssq.test`,
        role: "member" as const,
        clerkId: `c-${tag}-u-${i}`,
      })),
    });
    await db.orgRole.createMany({
      data: Array.from({ length: ROLES }, (_, i) => ({
        orgId: org,
        role: `${i % 2 ? "head" : "Head"} of sales ${String(i).padStart(4, "0")}`,
        userId: `${tag}-u-${i}`,
        aliases: ["sales lead"],
      })),
    });
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.orgRole.deleteMany({ where: { orgId: org } });
      await db.entityAlias.deleteMany({ where: { orgId: org } });
      for (const t of ["grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    rolesGET = (await import("@/app/api/settings/org-roles/route")).GET;
    const aliasRoute = await import("@/app/api/settings/aliases/route");
    aliasesGET = aliasRoute.GET;
    aliasesPOST = aliasRoute.POST;
    aliasDELETE = (await import("@/app/api/settings/aliases/[id]/route")).DELETE;
    await clear();
    await seedOrg(ORG, ADMIN, "a");
    await seedOrg(OTHER_ORG, OTHER_ADMIN, "b");
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@ssq.test`, role: "member", clerkId: `c-${MEMBER}` },
    });
  }, 120_000);

  beforeEach(() => signIn(ORG, ADMIN, "admin"));

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it.each(["created&order=desc", "created&order=asc", "name&order=asc", "type&order=desc"])(
    "lists each of the org's %s aliases on exactly one page, never the other org's",
    async (sortAndOrder) => {
      const seen: string[] = [];
      const pages = Math.ceil(ALIASES / SETTINGS_PAGE_SIZE);
      for (let page = 1; page <= pages; page += 1) {
        const p = await aliases(`page=${page}&sort=${sortAndOrder}`);
        expect(p).toMatchObject({ total: ALIASES, count: ALIASES, page });
        seen.push(...p.aliases.map((a) => a.id));
      }
      const own = await db.entityAlias.findMany({ where: { orgId: ORG }, select: { id: true } });
      expect(seen).toHaveLength(ALIASES);
      expect(new Set(seen).size).toBe(ALIASES);
      expect(new Set(seen)).toEqual(new Set(own.map((r) => r.id)));
      expect((await aliases(`page=${pages}&sort=${sortAndOrder}`)).aliases).toHaveLength(ALIASES % SETTINGS_PAGE_SIZE);
      const past = await aliases(`page=${pages + 1}&sort=${sortAndOrder}`);
      expect(past).toMatchObject({ aliases: [], total: ALIASES, count: ALIASES });
    },
    120_000,
  );

  it("finds one named alias with one search and narrows the count a type filter reports", async () => {
    const one = await aliases(`page=1&q=${encodeURIComponent("a-alias-1037")}`);
    expect(one.aliases.map((a) => a.id)).toHaveLength(1);
    expect(one).toMatchObject({ total: 1, count: ALIASES });

    const contacts = await aliases("page=1&type=contact");
    expect(contacts).toMatchObject({ total: ALIASES / 4, count: ALIASES });
    expect(contacts.aliases.every((a) => a.entityType === "contact")).toBe(true);
    // The other org's same-named aliases match "common" too, and are not counted.
    expect(await aliases("page=1&q=common")).toMatchObject({ total: ALIASES, count: ALIASES });
  });

  it("lists each of the org's roles on exactly one page when every person shares a name", async () => {
    for (const sort of ["person&order=desc", "role&order=asc"]) {
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(ROLES / SETTINGS_PAGE_SIZE); page += 1) {
        const p = await roles(`page=${page}&sort=${sort}`);
        expect(p).toMatchObject({ total: ROLES, count: ROLES });
        seen.push(...p.roles.map((r) => r.id));
      }
      expect(new Set(seen).size).toBe(ROLES);
      expect(seen).toHaveLength(ROLES);
    }
    const one = await roles(`page=1&q=${encodeURIComponent("a-p777@")}`);
    expect(one.roles.map((r) => r.user.email)).toEqual(["a-p777@ssq.test"]);
    expect(one).toMatchObject({ total: 1, count: ROLES });
  }, 120_000);

  it("shows the other org's admin only that org's rows and counts", async () => {
    signIn(OTHER_ORG, OTHER_ADMIN, "admin");
    const a = await aliases("page=1&q=a-alias");
    expect(a).toMatchObject({ aliases: [], total: 0, count: ALIASES });
    const r = await roles("page=1&q=a-p");
    expect(r).toMatchObject({ roles: [], total: 0, count: ROLES });
  });

  it("refuses a member both lists and alias edits, and leaves the registry as it was", async () => {
    signIn(ORG, MEMBER, "member");
    for (const [handler, path] of [
      [rolesGET, "/api/settings/org-roles"],
      [aliasesGET, "/api/settings/aliases"],
    ] as const) {
      const res = await handler(new Request(`http://t${path}?page=1`));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("alias-");
    }
    const target = await db.entityAlias.findFirstOrThrow({ where: { orgId: ORG, entityId: "a-e-5" } });
    const post = await aliasesPOST(
      new Request("http://t/api/settings/aliases", {
        method: "POST",
        body: JSON.stringify({
          entityId: "a-e-5",
          entityType: target.entityType,
          canonicalName: "Hijacked",
          aliases: ["x"],
        }),
      }),
    );
    expect(post.status).toBe(403);
    const del = await aliasDELETE(new Request("http://t"), { params: Promise.resolve({ id: target.id }) });
    expect(del.status).toBe(403);
    expect(await db.entityAlias.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      canonicalName: "Shared Name",
    });
  });

  it("records an audit row for an admin's alias save and remove, naming the entry", async () => {
    const before = new Date(Date.now() - 1000);
    const post = await aliasesPOST(
      new Request("http://t/api/settings/aliases", {
        method: "POST",
        body: JSON.stringify({
          entityId: "a-new-entity",
          entityType: "account",
          canonicalName: "Audited Co",
          aliases: ["audited"],
        }),
      }),
    );
    expect(post.status).toBeLessThan(300);
    const saved = await db.entityAlias.findFirstOrThrow({ where: { orgId: ORG, entityId: "a-new-entity" } });
    const del = await aliasDELETE(new Request("http://t"), { params: Promise.resolve({ id: saved.id }) });
    expect(del.status).toBe(200);

    const rows = await db.auditLog.findMany({
      where: { orgId: ORG, actorId: ADMIN, at: { gte: before }, action: "memory.write" },
    });
    const targets = rows.map((r) => r.target ?? "");
    expect(targets.some((t) => t.includes("a-new-entity"))).toBe(true);
    expect(targets.some((t) => t.includes(saved.id))).toBe(true);
    expect(rows.every((r) => r.decision === "allow")).toBe(true);
  });
});
