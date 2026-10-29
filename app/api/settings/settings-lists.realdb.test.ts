// GET /api/settings/org-roles?page= and GET /api/settings/aliases?page=: the Settings
// tables of organization roles and entity aliases, paged, searched, filtered and
// ordered in the query. Each page holds at most one page of rows, every row appears
// on exactly one page, a search matches inside any one alias, and another org's rows
// are never listed or counted.
//
// Runs the shipping routes against a real Postgres with ltree and the real access
// evaluator. Authentication is mocked. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SETTINGS_PAGE_SIZE } from "@/lib/settings-lists";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "settingslistspage";
const OTHER_ORG = "settingslistspageother";
const ROOT = `org_${ORG}`;
const ADMIN = "u-slp-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type RolePage = {
  roles: { id: string; role: string; aliases: string[]; user: { name: string | null; email: string } }[];
  total: number;
  count: number;
  page: number;
  pageSize: number;
};
type AliasPage = {
  aliases: { id: string; entityType: string; canonicalName: string; aliases: string[]; createdAt: string }[];
  total: number;
  count: number;
  page: number;
  pageSize: number;
};

describe.skipIf(!QA_URL)("the Settings role and alias tables are paged and narrowed on the server", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let rolesGET: Handler;
  let aliasesGET: Handler;

  async function get<T>(handler: Handler, path: string, query: string): Promise<T> {
    const res = await handler(new Request(`http://t${path}?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }
  const roles = (query: string) => get<RolePage>(rolesGET, "/api/settings/org-roles", query);
  const aliases = (query: string) => get<AliasPage>(aliasesGET, "/api/settings/aliases", query);

  async function member(id: string, name: string | null, org = ORG) {
    return db.user.create({
      data: { id, orgId: org, name, email: `${id}@slp.test`, role: "member", clerkId: `c-${id}` },
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
    aliasesGET = (await import("@/app/api/settings/aliases/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@slp.test`, role: "admin", clerkId: `c-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: ADMIN, role: "admin" },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    } as never);

    // Another tenant's role and alias, matching every search below: never listed or counted here.
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const foreigner = await member("u-slp-foreign", "Sales Foreigner", OTHER_ORG);
    await db.orgRole.create({
      data: { orgId: OTHER_ORG, role: "Head of Sales", userId: foreigner.id, aliases: ["sales lead"] },
    });
    await db.entityAlias.create({
      data: {
        orgId: OTHER_ORG,
        entityType: "account",
        entityId: "acct-x",
        canonicalName: "Acme",
        aliases: ["acme.com"],
      },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("pages every role once, by title regardless of case, with the matching and org counts", async () => {
    const person = await member("u-slp-p", "Pat");
    const created: string[] = [];
    for (let i = 0; i < SETTINGS_PAGE_SIZE + 1; i += 1) {
      const title = `${i % 2 ? "r" : "R"}ole ${String(i).padStart(2, "0")}`;
      await db.orgRole.create({ data: { orgId: ORG, role: title, userId: person.id, aliases: [] } });
      created.push(title);
    }

    const first = await roles("page=1");
    const second = await roles("page=2");
    expect(first).toMatchObject({ total: 26, count: 26, page: 1, pageSize: SETTINGS_PAGE_SIZE });
    expect(first.roles).toHaveLength(SETTINGS_PAGE_SIZE);
    expect(second.roles).toHaveLength(1);
    const titles = [...first.roles, ...second.roles].map((r) => r.role);
    expect(titles).toEqual([...created].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));

    const reversed = await roles("page=1&order=desc");
    expect(reversed.roles[0].role).toBe(titles.at(-1));
  });

  it("finds a role by part of one alias, the person's email, or a literal % without matching every row", async () => {
    const maya = await member("u-slp-maya", "Maya");
    const ben = await member("u-slp-ben", "Ben");
    await db.orgRole.create({
      data: { orgId: ORG, role: "Head of Sales", userId: maya.id, aliases: ["our sales lead", "VP"] },
    });
    await db.orgRole.create({ data: { orgId: ORG, role: "CTO", userId: ben.id, aliases: ["100% engineering"] } });
    await db.orgRole.create({ data: { orgId: ORG, role: "ops_lead", userId: ben.id, aliases: ["a\\b"] } });

    const bySalesLead = await roles("page=1&q=SALES%20LEAD");
    expect(bySalesLead.roles.map((r) => r.role)).toEqual(["Head of Sales"]);
    expect(bySalesLead).toMatchObject({ total: 1, count: 3 });
    // Two aliases are separate texts: a search spanning them matches neither.
    expect((await roles("page=1&q=lead%20VP")).roles).toEqual([]);
    expect((await roles("page=1&q=u-slp-ben%40")).roles.map((r) => r.role)).toEqual(["CTO", "ops_lead"]);
    // The person's name, which their email does not contain.
    await db.orgRole.create({
      data: { orgId: ORG, role: "Founder", userId: (await member("u-slp-q", "Quincy Jones")).id, aliases: [] },
    });
    expect((await roles("page=1&q=QUINCY")).roles.map((r) => r.role)).toEqual(["Founder"]);
    expect((await roles("page=1&q=0%25")).roles.map((r) => r.role)).toEqual(["CTO"]);
    expect((await roles("page=1&q=%25")).roles.map((r) => r.role)).toEqual(["CTO"]);
    // `_` and `\` match themselves, not any one character or an escape.
    expect((await roles("page=1&q=d_o")).roles).toEqual([]);
    expect((await roles("page=1&q=_")).roles.map((r) => r.role)).toEqual(["ops_lead"]);
    expect((await roles("page=1&q=a%5Cb")).roles.map((r) => r.role)).toEqual(["ops_lead"]);
  });

  it("orders by person, reading the email where a person has no name", async () => {
    await db.orgRole.create({
      data: { orgId: ORG, role: "Designer", userId: (await member("u-slp-ana", null)).id, aliases: [] },
    });
    await db.orgRole.create({
      data: { orgId: ORG, role: "CTO", userId: (await member("u-slp-zed", "zed")).id, aliases: [] },
    });
    await db.orgRole.create({
      data: { orgId: ORG, role: "CEO", userId: (await member("u-slp-bo", "Bo")).id, aliases: [] },
    });

    const byPerson = await roles("page=1&sort=person");
    // "u-slp-ana@slp.test" sorts after "Bo" and before "zed".
    expect(byPerson.roles.map((r) => r.role)).toEqual(["CEO", "Designer", "CTO"]);
    expect(byPerson.roles[1].user).toEqual({ id: "u-slp-ana", name: null, email: "u-slp-ana@slp.test" });
  });

  it("pages, filters, searches and orders aliases, and counts only this org's", async () => {
    const at = (day: number) => new Date(Date.UTC(2026, 9, day));
    for (let i = 0; i < SETTINGS_PAGE_SIZE + 1; i += 1) {
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "contact",
          entityId: `c-${i}`,
          canonicalName: `Contact ${String(i).padStart(2, "0")}`,
          aliases: [],
          createdAt: at(1),
        },
      });
    }
    await db.entityAlias.create({
      data: {
        orgId: ORG,
        entityType: "account",
        entityId: "acct-1",
        canonicalName: "acme corp",
        aliases: ["ACME", "acme.com"],
        createdAt: at(3),
      },
    });
    await db.entityAlias.create({
      data: {
        orgId: ORG,
        entityType: "user",
        entityId: "u-1",
        canonicalName: "Dana",
        aliases: ["DR"],
        createdAt: at(2),
      },
    });

    const first = await aliases("page=1");
    const second = await aliases("page=2");
    expect(first).toMatchObject({ total: 28, count: 28, pageSize: SETTINGS_PAGE_SIZE });
    expect(new Set([...first.aliases, ...second.aliases].map((a) => a.id)).size).toBe(28);
    expect(first.aliases[0].canonicalName).toBe("acme corp");

    const accounts = await aliases("page=1&type=account");
    expect(accounts).toMatchObject({ total: 1, count: 28 });
    expect(accounts.aliases[0]).toMatchObject({
      canonicalName: "acme corp",
      aliases: ["ACME", "acme.com"],
      createdAt: at(3).toISOString(),
    });
    expect((await aliases("page=1&q=.COM")).aliases.map((a) => a.canonicalName)).toEqual(["acme corp"]);
    expect((await aliases("page=1&q=dr&type=user")).aliases.map((a) => a.canonicalName)).toEqual(["Dana"]);
    expect((await aliases("page=1&q=dr&type=account")).aliases).toEqual([]);

    const newest = await aliases("page=1&sort=created&order=desc");
    expect(newest.aliases.slice(0, 2).map((a) => a.canonicalName)).toEqual(["acme corp", "Dana"]);
    const byType = await aliases("page=1&sort=type");
    expect(byType.aliases[0].entityType).toBe("account");
  });

  // Each fixture is created against the order the query must produce, so a dropped
  // tie-break or case fold shows up as the table's own storage order.
  it("orders role titles case-folded, and equal titles by id in the asked direction", async () => {
    const pat = await member("u-slp-p", "Pat");
    for (const [id, role] of [
      ["r-b", "ceo"],
      ["r-a", "CEO"],
      ["r-c", "Beta"],
      ["r-d", "alpha"],
    ]) {
      await db.orgRole.create({ data: { id, orgId: ORG, role, userId: pat.id, aliases: [] } });
    }
    expect((await roles("page=1")).roles.map((r) => r.id)).toEqual(["r-d", "r-c", "r-a", "r-b"]);
    expect((await roles("page=1&order=desc")).roles.map((r) => r.id)).toEqual(["r-b", "r-a", "r-c", "r-d"]);
  });

  it("orders one person's roles by title, then id, whichever way the people run", async () => {
    const pat = await member("u-slp-p", "Pat");
    const zoe = await member("u-slp-z", "Zoe");
    for (const [id, role] of [
      ["r-9", "beta"],
      ["r-8", "Alpha"],
    ]) {
      await db.orgRole.create({ data: { id, orgId: ORG, role, userId: pat.id, aliases: [] } });
    }
    // Six spellings of one title, stored out of id order: only the id tie-break orders them.
    for (const [id, role] of [
      ["r-4", "oPs"],
      ["r-6", "OpS"],
      ["r-1", "ops"],
      ["r-5", "opS"],
      ["r-3", "Ops"],
      ["r-2", "OPS"],
    ]) {
      await db.orgRole.create({ data: { id, orgId: ORG, role, userId: zoe.id, aliases: [] } });
    }
    const zoes = ["r-1", "r-2", "r-3", "r-4", "r-5", "r-6"];
    expect((await roles("page=1&sort=person")).roles.map((r) => r.id)).toEqual(["r-8", "r-9", ...zoes]);
    expect((await roles("page=1&sort=person&order=desc")).roles.map((r) => r.id)).toEqual([...zoes, "r-8", "r-9"]);
  });

  it("orders alias names case-folded with an id tie-break, and types either way with names ascending inside", async () => {
    const alias = (id: string, entityType: string, canonicalName: string) =>
      db.entityAlias.create({ data: { id, orgId: ORG, entityType, entityId: `x-${id}`, canonicalName, aliases: [] } });
    await alias("e-1", "contact", "Beta");
    await alias("e-2", "account", "alpha");
    await alias("e-4", "contact", "abc");
    await alias("e-3", "account", "ABC");
    await alias("e-5", "user", "zed");
    await alias("e-6", "user", "Amy");

    expect((await aliases("page=1&sort=name")).aliases.map((a) => a.id)).toEqual([
      "e-3",
      "e-4",
      "e-2",
      "e-6",
      "e-1",
      "e-5",
    ]);
    expect((await aliases("page=1&sort=name&order=desc")).aliases.map((a) => a.id)).toEqual([
      "e-5",
      "e-1",
      "e-6",
      "e-2",
      "e-4",
      "e-3",
    ]);
    expect((await aliases("page=1&sort=type&order=desc")).aliases.map((a) => a.id)).toEqual([
      "e-6",
      "e-5",
      "e-4",
      "e-1",
      "e-3",
      "e-2",
    ]);
    expect((await aliases("page=1&sort=type")).aliases.map((a) => a.id)).toEqual([
      "e-3",
      "e-2",
      "e-4",
      "e-1",
      "e-6",
      "e-5",
    ]);
  });

  it("refuses an admin whose org-root grant is gone before reading aliases", async () => {
    await db.grant.deleteMany({ where: { orgId: ORG, granteeId: ADMIN } });
    const res = await aliasesGET(new Request("http://t/api/settings/aliases?page=1"));
    expect(res.status).toBe(403);
  });
});
