import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GrantListQuery, TokenListQuery } from "@/lib/access-lists";

// The Grants and Tokens pages: another org's rows that share a
// name, an agent key or a scope path with this org's never reach this org's rows,
// matching count, org total, grantee names, scope names or token status; a
// backslash in a search is literal; and an org past a thousand grants pages to
// its last row. Set QA_DATABASE_URL to an ISOLATED test database; skips when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgAlpIsolation";
const OTHER = "orgAlpIsolationOther";
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

describe.skipIf(!QA_URL)("access list pages across orgs", { timeout: 60_000 }, () => {
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
  const grant = (id: string, orgId: string, path: string, granteeType: string, granteeId: string, createdAt: Date) =>
    db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission","expiresAt","createdAt")
       VALUES ($1,$2,$3,$4::"GranteeType",$5,'read'::"Permission",NULL,$6)`,
      id,
      orgId,
      `sc_${orgId}_${path}`,
      granteeType,
      granteeId,
      createdAt,
    );
  const token = (id: string, orgId: string, agentId: string, scopePath: string, createdAt: Date) =>
    db.$executeRawUnsafe(
      `INSERT INTO "capabilities" ("id","orgId","agentId","tokenHash","scopePath","permission","expiresAt","createdAt")
       VALUES ($1,$2,$3,$4,$5,'read'::"Permission",$6,$7)`,
      id,
      orgId,
      agentId,
      `hash_${id}`,
      scopePath,
      at(DAY),
      createdAt,
    );

  async function clean() {
    for (const orgId of [ORG, OTHER]) {
      for (const table of ["capabilities", "grants", "agents", "scopes"]) {
        await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, orgId);
      }
    }
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ readGrantPage, readTokenPage } = await import("./access-list-pages"));
    for (const orgId of [ORG, OTHER]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
        orgId,
      );
    }
    await clean();
    await scope(ORG, ROOT, "Organization");
    await scope(ORG, `${ROOT}.sales`, "Sales");
    await scope(ORG, `${ROOT}.ops`, "Back\\slash ops");
    // The other org holds a scope at this org's exact path, under another name.
    await scope(OTHER, `org_${OTHER}`, "Elsewhere root");
    await scope(OTHER, `${ROOT}.sales`, "Foreign sales");
    // Same agent key in both orgs: active here, switched off and renamed there.
    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","active","updatedAt") VALUES
       ('ag_alpi_here',$1,'scout','Scout','custom',true,NOW()),
       ('ag_alpi_there',$2,'scout','Foreign Scout','custom',false,NOW())`,
      ORG,
      OTHER,
    );
    await grant("gi1", ORG, `${ROOT}.sales`, "agent", "scout", at(-1 * HOUR));
    await grant("gi2", ORG, `${ROOT}.ops`, "role", "member", at(-2 * HOUR));
    await grant("gix1", OTHER, `org_${OTHER}`, "agent", "scout", at(-1 * HOUR));
    await grant("gix2", OTHER, `${ROOT}.sales`, "role", "member", at(-2 * HOUR));
    await grant("gix3", OTHER, `${ROOT}.sales`, "everyone", "*", at(-3 * HOUR));
    await token("ti1", ORG, "scout", `${ROOT}.sales`, at(-1 * HOUR));
    await token("tix1", OTHER, "scout", `${ROOT}.sales`, at(-1 * HOUR));
    await token("tix2", OTHER, "scout", `org_${OTHER}`, at(-2 * HOUR));
  });

  afterAll(async () => {
    await clean();
  });

  it("lists and counts only this org's grants, with this org's agent name and no duplicate rows", async () => {
    const page = await readGrantPage(ORG, grantQuery());
    expect(page.rows.map((r) => r.id)).toEqual(["gi1", "gi2"]);
    expect(page).toMatchObject({ total: 2, count: 2 });
    expect(page.rows[0].granteeName).toBe("Scout");
  });

  it("never matches a search on another org's agent name or scope name, and keeps the org total", async () => {
    for (const search of ["Foreign", "Elsewhere"]) {
      const page = await readGrantPage(ORG, grantQuery({ search }));
      expect(page.rows).toEqual([]);
      expect(page).toMatchObject({ total: 0, count: 2 });
    }
  });

  it("shows this org's scope name and agent status on a token, never the other org's", async () => {
    const page = await readTokenPage(ORG, tokenQuery());
    expect(page.rows.map((r) => r.id)).toEqual(["ti1"]);
    expect(page).toMatchObject({ total: 1, count: 1 });
    expect(page.rows[0]).toMatchObject({ scopeName: "Sales", agentDeactivated: false });
    expect((await readTokenPage(ORG, tokenQuery({ search: "Foreign" }))).rows).toEqual([]);
    expect((await readTokenPage(ORG, tokenQuery({ filters: { status: "deactivated" } }))).rows).toEqual([]);
    expect((await readTokenPage(ORG, tokenQuery({ filters: { status: "active" } }))).rows.map((r) => r.id)).toEqual([
      "ti1",
    ]);
  });

  it("shows a token that is both revoked and expired as revoked, the status the tab decides first", async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "capabilities" ("id","orgId","agentId","tokenHash","scopePath","permission","expiresAt","revokedAt","createdAt")
       VALUES ('ti2',$1,'scout','hash_ti2',$2,'read'::"Permission",$3,$4,$5)`,
      ORG,
      `${ROOT}.sales`,
      at(-1 * HOUR),
      at(-2 * HOUR),
      at(-3 * HOUR),
    );
    try {
      expect((await readTokenPage(ORG, tokenQuery({ filters: { status: "revoked" } }))).rows.map((r) => r.id)).toEqual([
        "ti2",
      ]);
      expect((await readTokenPage(ORG, tokenQuery({ filters: { status: "expired" } }))).rows).toEqual([]);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "capabilities" WHERE "id" = 'ti2' AND "orgId" = $1`, ORG);
    }
  });

  it("treats a backslash in a search as literal text", async () => {
    expect((await readGrantPage(ORG, grantQuery({ search: "k\\s" }))).rows.map((r) => r.id)).toEqual(["gi2"]);
    expect((await readGrantPage(ORG, grantQuery({ search: "\\" }))).rows.map((r) => r.id)).toEqual(["gi2"]);
  });

  it("pages an org past a thousand grants to its last row, and nothing past it", async () => {
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < 1200; i++) {
      const n = params.length;
      values.push(
        `($${n + 1},$${n + 2},$${n + 3},'user'::"GranteeType",$${n + 4},'read'::"Permission",NULL,$${n + 5})`,
      );
      params.push(`gb${String(i).padStart(4, "0")}`, ORG, `sc_${ORG}_${ROOT}`, `bulk_${i}`, at(-(10 + i) * DAY));
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission","expiresAt","createdAt") VALUES ${values.join(",")}`,
      ...params,
    );
    const first = await readGrantPage(ORG, grantQuery());
    expect(first).toMatchObject({ total: 1202, count: 1202 });
    const last = await readGrantPage(ORG, grantQuery({ page: 49 }));
    expect(last.rows.map((r) => r.id)).toEqual(["gb1198", "gb1199"]);
    expect((await readGrantPage(ORG, grantQuery({ page: 50 }))).rows).toEqual([]);
    const searched = await readGrantPage(ORG, grantQuery({ search: "bulk_11", page: 5 }));
    // bulk_11 and bulk_110..bulk_119 and bulk_1100..bulk_1199: 111 rows, five pages.
    expect(searched).toMatchObject({ total: 111, count: 1202 });
    expect(searched.rows).toHaveLength(11);
  });
});
