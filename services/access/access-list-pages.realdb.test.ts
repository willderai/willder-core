import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GrantListQuery, TokenListQuery } from "@/lib/access-lists";

// The Grants and Tokens pages on real Postgres: the search, filters, orders and
// paging run in the query, and nothing from another org is listed or counted.
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgAccessListPages";
const OTHER_ORG = "orgAccessListPagesOther";
const ROOT = `org_${ORG}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const grantQuery = (over: Partial<GrantListQuery> = {}): GrantListQuery => ({
  search: "",
  sort: "created",
  order: "desc",
  filters: {},
  page: 1,
  ...over,
});
const tokenQuery = (over: Partial<TokenListQuery> = {}): TokenListQuery => ({
  search: "",
  sort: "created",
  order: "desc",
  filters: {},
  page: 1,
  ...over,
});

describe.skipIf(!QA_URL)("readGrantPage and readTokenPage", { timeout: 30_000 }, () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let readGrantPage: (typeof import("./access-list-pages"))["readGrantPage"];
  let readTokenPage: (typeof import("./access-list-pages"))["readTokenPage"];

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

  const scope = (orgId: string, path: string, name: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1,$2,$3,$4)`,
      `sc_${orgId}_${path}`,
      orgId,
      path,
      name,
    );

  const grant = (
    id: string,
    orgId: string,
    path: string,
    granteeType: string,
    granteeId: string,
    permission: string,
    expiresAt: Date | null,
    createdAt: Date,
  ) =>
    db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission","expiresAt","createdAt")
       VALUES ($1,$2,$3,$4::"GranteeType",$5,$6::"Permission",$7,$8)`,
      id,
      orgId,
      `sc_${orgId}_${path}`,
      granteeType,
      granteeId,
      permission,
      expiresAt,
      createdAt,
    );

  const token = (
    id: string,
    orgId: string,
    agentId: string,
    scopePath: string,
    permission: string,
    expiresAt: Date,
    createdAt: Date,
    revokedAt: Date | null = null,
  ) =>
    db.$executeRawUnsafe(
      `INSERT INTO "capabilities" ("id","orgId","agentId","tokenHash","scopePath","permission","expiresAt","revokedAt","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6::"Permission",$7,$8,$9)`,
      id,
      orgId,
      agentId,
      `hash_${id}`,
      scopePath,
      permission,
      expiresAt,
      revokedAt,
      createdAt,
    );

  async function clean() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const table of ["capabilities", "grants", "agents", "scopes"]) {
        await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, orgId);
      }
    }
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "orgId" = $1 AND "id" LIKE 'u_alp_%'`, ORG);
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ readGrantPage, readTokenPage } = await import("./access-list-pages"));
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
        orgId,
      );
    }
    await clean();

    await scope(ORG, ROOT, "Organization");
    await scope(ORG, `${ROOT}.sales`, "Sales");
    await scope(ORG, `${ROOT}.dept_eng`, "Engineering");
    await scope(OTHER_ORG, `org_${OTHER_ORG}`, "Sales elsewhere");
    await db.$executeRawUnsafe(
      `INSERT INTO "users" ("id","orgId","clerkId","email","name","role","updatedAt") VALUES
       ('u_alp_maya',$1,'clerk_alp_maya','maya@acme.test','Maya Ortiz','member',NOW()),
       ('u_alp_noname',$1,'clerk_alp_noname','zed@acme.test',NULL,'member',NOW())`,
      ORG,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","active","updatedAt") VALUES
       ('ag_alp_scout',$1,'scout','Scout','custom',true,NOW()),
       ('ag_alp_old',$1,'retired','Retired bot','custom',false,NOW())`,
      ORG,
    );

    // Newest first: g1 is the newest grant.
    await grant("g1", ORG, `${ROOT}.sales`, "user", "u_alp_maya", "read", at(3 * DAY), at(-1 * HOUR));
    await grant("g2", ORG, `${ROOT}.dept_eng`, "agent", "scout", "write", null, at(-2 * HOUR));
    await grant("g3", ORG, ROOT, "role", "member", "read", at(-1 * DAY), at(-3 * HOUR));
    await grant("g4", ORG, `${ROOT}.sales`, "user", "u_alp_noname", "admin", at(60 * DAY), at(-4 * HOUR));
    await grant("g5", ORG, `${ROOT}.dept_eng`, "everyone", "*", "read", null, at(-5 * HOUR));
    await grant("gx", OTHER_ORG, `org_${OTHER_ORG}`, "role", "member", "read", null, at(-1 * HOUR));

    await token("t1", ORG, "scout", `${ROOT}.sales`, "read", at(DAY), at(-1 * HOUR));
    await token("t2", ORG, "retired", ROOT, "write", at(DAY), at(-2 * HOUR));
    await token("t3", ORG, "ag_alp_old", ROOT, "read", at(DAY), at(-3 * HOUR)); // named by id, minted before keys
    // Not admin: the admin-window trigger restamps an admin token's issue time.
    await token("t4", ORG, "scout", `${ROOT}.dept_eng`, "write", at(-1 * HOUR), at(-4 * HOUR));
    await token("t5", ORG, "mcp-client", `${ROOT}.gone`, "read", at(DAY), at(-5 * HOUR), at(-1 * HOUR));
    await token("tx", OTHER_ORG, "scout", `org_${OTHER_ORG}`, "read", at(DAY), at(-1 * HOUR));
  });

  afterAll(async () => {
    await clean();
  });

  const grantIds = async (q: Partial<GrantListQuery>) =>
    (await readGrantPage(ORG, grantQuery(q))).rows.map((r) => r.id);
  const tokenIds = async (q: Partial<TokenListQuery>) =>
    (await readTokenPage(ORG, tokenQuery(q))).rows.map((r) => r.id);

  it("lists only this org's grants, newest first, with grantee names and the scope", async () => {
    const page = await readGrantPage(ORG, grantQuery());
    expect(page.rows.map((r) => r.id)).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    expect(page).toMatchObject({ total: 5, count: 5, page: 1, pageSize: 25 });
    const byId = Object.fromEntries(page.rows.map((r) => [r.id, r]));
    expect(byId.g1).toMatchObject({
      granteeName: "Maya Ortiz",
      scope: { path: `${ROOT}.sales`, name: "Sales" },
      permission: "read",
      granteeType: "user",
    });
    expect(byId.g2.granteeName).toBe("Scout");
    expect(byId.g4.granteeName).toBe("zed@acme.test"); // no name: the email
    expect(byId.g3.granteeName).toBeUndefined(); // a role has no display name
    expect(byId.g5.expiresAt).toBeNull();
  });

  it("searches the grantee's name and email, the scope's name and path, case-insensitively", async () => {
    expect(await grantIds({ search: "maya" })).toEqual(["g1"]);
    expect(await grantIds({ search: "ZED@" })).toEqual(["g4"]);
    expect(await grantIds({ search: "scout" })).toEqual(["g2"]);
    expect(await grantIds({ search: "engineering" })).toEqual(["g2", "g5"]);
    expect(await grantIds({ search: "dept_eng" })).toEqual(["g2", "g5"]);
  });

  it("treats % and _ in a search as literal text", async () => {
    expect(await grantIds({ search: "%" })).toEqual([]);
    // Unescaped, `_` matches any one character, and "a_O" would find "Maya Ortiz".
    expect(await grantIds({ search: "a_O" })).toEqual([]);
    expect(await grantIds({ search: "dept_eng" })).toEqual(["g2", "g5"]);
  });

  it("filters by permission, grantee type and expiry, and counts the matches against the org total", async () => {
    expect(await grantIds({ filters: { permission: "read" } })).toEqual(["g1", "g3", "g5"]);
    expect(await grantIds({ filters: { grantee: "user" } })).toEqual(["g1", "g4"]);
    expect(await grantIds({ filters: { expiry: "soon" } })).toEqual(["g1"]);
    expect(await grantIds({ filters: { expiry: "expired" } })).toEqual(["g3"]);
    expect(await grantIds({ filters: { expiry: "permanent" } })).toEqual(["g2", "g5"]);
    const narrowed = await readGrantPage(ORG, grantQuery({ filters: { permission: "read", grantee: "role" } }));
    expect(narrowed.rows.map((r) => r.id)).toEqual(["g3"]);
    expect(narrowed).toMatchObject({ total: 1, count: 5 });
  });

  it("orders by grantee name, by scope path and by expiry with never-expiring grants last", async () => {
    // Names: Maya Ortiz, Scout, member (the role's id), zed@acme.test, * (everyone).
    expect(await grantIds({ sort: "grantee", order: "asc" })).toEqual(["g5", "g1", "g3", "g2", "g4"]);
    expect(await grantIds({ sort: "scope", order: "asc" })).toEqual(["g3", "g2", "g5", "g1", "g4"]);
    expect(await grantIds({ sort: "expires", order: "asc" })).toEqual(["g3", "g1", "g4", "g2", "g5"]);
    expect(await grantIds({ sort: "expires", order: "desc" })).toEqual(["g2", "g5", "g4", "g1", "g3"]);
  });

  it("pages past the first page and returns an empty page beyond the last", async () => {
    for (let i = 0; i < 30; i++) {
      await grant(`gp${String(i).padStart(2, "0")}`, ORG, ROOT, "user", `bulk_${i}`, "read", null, at(-(10 + i) * DAY));
    }
    try {
      const first = await readGrantPage(ORG, grantQuery());
      expect(first.rows).toHaveLength(25);
      expect(first).toMatchObject({ total: 35, count: 35 });
      const second = await readGrantPage(ORG, grantQuery({ page: 2 }));
      expect(second.rows.map((r) => r.id)).toEqual([
        "gp20",
        "gp21",
        "gp22",
        "gp23",
        "gp24",
        "gp25",
        "gp26",
        "gp27",
        "gp28",
        "gp29",
      ]);
      expect((await readGrantPage(ORG, grantQuery({ page: 3 }))).rows).toEqual([]);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "id" LIKE 'gp%' AND "orgId" = $1`, ORG);
    }
  });

  it("lists only this org's tokens, with the scope's name and whether the agent is switched off", async () => {
    const page = await readTokenPage(ORG, tokenQuery());
    expect(page.rows.map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(page).toMatchObject({ total: 5, count: 5 });
    const byId = Object.fromEntries(page.rows.map((r) => [r.id, r]));
    expect(byId.t1).toMatchObject({ scopeName: "Sales", agentDeactivated: false, revokedAt: null });
    expect(byId.t2.agentDeactivated).toBe(true); // by key
    expect(byId.t3.agentDeactivated).toBe(true); // by id
    expect(byId.t5.scopeName).toBeNull(); // a path with no scope row
  });

  it("filters tokens by the status the tab shows: revoked, then expired, then deactivated", async () => {
    expect(await tokenIds({ filters: { status: "active" } })).toEqual(["t1"]);
    expect(await tokenIds({ filters: { status: "deactivated" } })).toEqual(["t2", "t3"]);
    expect(await tokenIds({ filters: { status: "expired" } })).toEqual(["t4"]);
    expect(await tokenIds({ filters: { status: "revoked" } })).toEqual(["t5"]);
    expect(await tokenIds({ filters: { permission: "write" } })).toEqual(["t2", "t4"]);
  });

  it("searches a token's client, id, scope name and status, and orders by client", async () => {
    expect(await tokenIds({ search: "sales" })).toEqual(["t1"]);
    expect(await tokenIds({ search: "MCP" })).toEqual(["t5"]);
    expect(await tokenIds({ search: "t3" })).toEqual(["t3"]);
    expect(await tokenIds({ search: "deactivated" })).toEqual(["t2", "t3"]);
    expect(await tokenIds({ sort: "agent", order: "asc" })).toEqual(["t3", "t5", "t2", "t1", "t4"]);
  });
});
