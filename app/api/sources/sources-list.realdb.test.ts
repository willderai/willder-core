// GET /api/sources?page=: the Integrations page's Knowledge sources and Connectors
// lists, paged, searched, filtered and ordered in the query. Each page holds at most
// one page of rows, every row appears on exactly one page, a search is literal, a link
// to one source finds its page, and another org's sources are never listed or counted.
//
// Runs the shipping route against a real Postgres with ltree and the real access
// evaluator. Authentication is mocked. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SOURCE_PAGE_SIZE } from "@/lib/source-lists";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "sourceslistpage";
const OTHER_ORG = "sourceslistpageother";
const ROOT = `org_${ORG}`;
const ADMIN = "u-src-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type SourcePage = {
  sources: ({ id: string; type: string; name: string; scopePath: string } & Record<string, unknown>)[];
  total: number;
  count: number;
  page: number;
  pageSize: number;
  found?: boolean;
};

describe.skipIf(!QA_URL)("the Integrations source lists are paged and narrowed on the server", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let GET: Handler;

  async function list(query: string): Promise<SourcePage> {
    const res = await GET(new Request(`http://t/api/sources?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as SourcePage;
  }
  const names = (page: SourcePage) => page.sources.map((s) => s.name);

  let seq = 0;
  /** A source in `org`, created `minutesAgo` before now so the default order is known. */
  async function source(
    name: string,
    type = "website",
    { org = ORG, scope = `${ROOT}.team`, status = "active", minutesAgo = 0 } = {},
  ) {
    seq += 1;
    return db.source.create({
      data: {
        orgId: org,
        type: type as never,
        externalId: `ext-${seq}`,
        name,
        scopePath: scope,
        status: status as never,
        encryptedTokens: "sealed-secret",
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.source.deleteMany({ where: { orgId: org } });
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
    GET = (await import("@/app/api/sources/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@src.test`, role: "admin", clerkId: `c-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: ADMIN, role: "admin" },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    } as never);

    // Another tenant's sources, matching every search below: never listed or counted here.
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    for (const name of ["Foreign 100% drive", "Foreign slack_room", "acme foreign"]) {
      await source(name, "slack", { org: OTHER_ORG, scope: `org_${OTHER_ORG}.team` });
    }
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("pages every source once, newest first, with the matching and org counts", async () => {
    const created: string[] = [];
    for (let i = 0; i < SOURCE_PAGE_SIZE + 3; i += 1) {
      await source(`Site ${String(i).padStart(2, "0")}`, "website", { minutesAgo: i });
      created.push(`Site ${String(i).padStart(2, "0")}`);
    }

    const first = await list("page=1");
    const second = await list("page=2");
    expect(first).toMatchObject({ total: 13, count: 13, page: 1, pageSize: SOURCE_PAGE_SIZE });
    expect(first.sources).toHaveLength(SOURCE_PAGE_SIZE);
    expect(second.sources).toHaveLength(3);
    expect([...names(first), ...names(second)]).toEqual(created);
    expect((await list("page=3")).sources).toEqual([]);
  });

  it("never returns the sealed credential, paged or not", async () => {
    await source("Repo", "github");
    for (const query of ["page=1", ""]) {
      const page = await list(query);
      expect(page.sources).toHaveLength(1);
      expect(Object.keys(page.sources[0]).sort()).toEqual([
        "_count",
        "createdAt",
        "externalId",
        "id",
        "meta",
        "name",
        "scopePath",
        "status",
        "type",
        "updatedAt",
      ]);
    }
  });

  it("without a page, lists every source of the org, newest first, for API clients", async () => {
    for (let i = 0; i < SOURCE_PAGE_SIZE + 2; i += 1) await source(`Site ${i}`, "website", { minutesAgo: i });
    const all = await list("");
    expect(names(all)).toEqual(Array.from({ length: SOURCE_PAGE_SIZE + 2 }, (_, i) => `Site ${i}`));
  });

  it("orders by name regardless of case, and by destination scope", async () => {
    await source("beta");
    await source("Alpha", "website", { scope: `${ROOT}.zeta` });
    await source("Gamma", "website", { scope: `${ROOT}.alpha` });

    expect(names(await list("page=1&sort=name&order=asc"))).toEqual(["Alpha", "beta", "Gamma"]);
    expect(names(await list("page=1&sort=name&order=desc"))).toEqual(["Gamma", "beta", "Alpha"]);
    expect(names(await list("page=1&sort=scope&order=asc"))).toEqual(["Gamma", "beta", "Alpha"]);
  });

  it("searches name, destination scope and type name literally", async () => {
    await source("100% coverage");
    await source("1000 coverage");
    await source("ops_room", "slack");
    await source("opsXroom", "slack");
    await source("back\\slash");
    await source("Shared folder", "gdrive", { scope: `${ROOT}.finance` });

    expect(names(await list("page=1&q=100%25"))).toEqual(["100% coverage"]);
    expect(names(await list("page=1&q=ops_"))).toEqual(["ops_room"]);
    expect(names(await list("page=1&q=k%5Cs"))).toEqual(["back\\slash"]);
    expect(names(await list("page=1&q=FINANCE"))).toEqual(["Shared folder"]);
    // "Drive" is the type's name on screen, not a word in the row.
    const byType = await list("page=1&q=google%20drive");
    expect(names(byType)).toEqual(["Shared folder"]);
    expect(byType).toMatchObject({ total: 1, count: 6 });
  });

  it("filters by type and status, and kind=connector counts only connectors", async () => {
    await source("Drive", "gdrive");
    await source("Site", "website");
    await source("#deals", "slack", { status: "error" });
    await source("acme/web", "github");

    const connectors = await list("page=1&kind=connector");
    expect(names(connectors).sort()).toEqual(["#deals", "acme/web"]);
    expect(connectors).toMatchObject({ total: 2, count: 2 });
    const errored = await list("page=1&kind=connector&status=error");
    expect(names(errored)).toEqual(["#deals"]);
    expect(errored).toMatchObject({ total: 1, count: 2 });
    expect(names(await list("page=1&type=gdrive"))).toEqual(["Drive"]);
  });

  it("answers the page that holds a linked source, in the view asked for", async () => {
    const created = [];
    for (let i = 0; i < SOURCE_PAGE_SIZE + 2; i += 1)
      created.push(await source(`Site ${i}`, "website", { minutesAgo: i }));
    const oldest = created.at(-1)!;

    const linked = await list(`page=1&at=${oldest.id}`);
    expect(linked).toMatchObject({ page: 2, found: true });
    expect(names(linked)).toContain(oldest.name);

    const reversed = await list(`page=1&order=asc&at=${oldest.id}`);
    expect(reversed).toMatchObject({ page: 1, found: true });

    const foreign = await db.source.findFirstOrThrow({ where: { orgId: OTHER_ORG } });
    const missing = await list(`page=1&at=${foreign.id}`);
    expect(missing).toMatchObject({ page: 1, found: false });
    expect(missing.sources.every((s) => !s.name.startsWith("Foreign"))).toBe(true);
  });

  it("refuses a request without a page, or with a value the list does not offer", async () => {
    for (const query of ["page=0", "page=1&sort=status", "page=1&kind=all", "page=1&type=dropbox", "page=1&at=a%00b"]) {
      const res = await GET(new Request(`http://t/api/sources?${query}`));
      expect(res.status, query).toBe(400);
    }
  });

  it("refuses a member without org-wide write before reading any source", async () => {
    await source("Secret site");
    await db.user.create({
      data: { id: "u-src-member", orgId: ORG, email: "m@src.test", role: "member", clerkId: "c-m" },
    });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: "u-src-member", role: "member" },
      ctx: { orgId: ORG, actor: { type: "human", id: "u-src-member", role: "member" } },
    } as never);
    const res = await GET(new Request("http://t/api/sources?page=1"));
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("sources");
  });
});
