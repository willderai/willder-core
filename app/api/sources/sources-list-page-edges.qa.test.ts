// GET /api/sources?page= and GET /api/integrations?provider=&page=: the paging edges the
// builder's realdb suites leave open. Rows created in the same instant still appear on
// exactly one page; a link to one source (`at=`) finds its page inside the search and
// filters asked for, not the unfiltered list; and a source that is the last row of a
// page is answered on that page, not the next one.
//
// Runs the shipping routes against a real Postgres with ltree and the real access
// evaluator. Authentication is mocked. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SOURCE_PAGE_SIZE } from "@/lib/source-lists";
import { ACCOUNT_PAGE_SIZE } from "@/lib/integration-lists";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "sourcespageedges";
const ROOT = `org_${ORG}`;
const ADMIN = "u-src-edges-admin";
/** Rows sharing one sort key: enough that Postgres's bounded sort reorders ties between pages without an id tie-break. */
const TIED = 95;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type SourcePage = { sources: { id: string; name: string }[]; total: number; page: number; found?: boolean };
type AccountPage = { integrations: { id: string }[]; total: number };

describe.skipIf(!QA_URL)("server-paged Integrations lists at their edges", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let sourcesGET: Handler;
  let integrationsGET: Handler;

  async function get<T>(handler: Handler, url: string): Promise<T> {
    const res = await handler(new Request(url));
    expect(res.status, url).toBe(200);
    return (await res.json()) as T;
  }
  const sources = (query: string) => get<SourcePage>(sourcesGET, `http://t/api/sources?${query}`);

  let seq = 0;
  async function source(name: string, createdAt: Date, type = "website") {
    seq += 1;
    return db.source.create({
      data: {
        orgId: ORG,
        type: type as never,
        externalId: `edge-${seq}`,
        name,
        scopePath: `${ROOT}.team`,
        status: "active",
        createdAt,
      },
    });
  }

  async function clear() {
    await db.integration.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    for (const t of ["grant", "scope", "user"] as const) {
      await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    sourcesGET = (await import("@/app/api/sources/route")).GET;
    integrationsGET = (await import("@/app/api/integrations/route")).GET;
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
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("lists sources created in the same instant once each across pages, in every order", async () => {
    const instant = new Date("2026-10-01T00:00:00Z");
    for (let i = 0; i < TIED; i += 1) await source("Same name", instant);

    for (const order of ["desc", "asc"]) {
      for (const sort of ["created", "name"]) {
        const ids: string[] = [];
        for (let page = 1; page <= Math.ceil(TIED / SOURCE_PAGE_SIZE); page += 1) {
          ids.push(...(await sources(`page=${page}&sort=${sort}&order=${order}`)).sources.map((s) => s.id));
        }
        expect(ids, `${sort} ${order}`).toHaveLength(TIED);
        expect(new Set(ids).size, `${sort} ${order}`).toBe(TIED);
      }
    }
  });

  it("lists accounts connected in the same instant once each across pages", async () => {
    const instant = new Date("2026-10-01T00:00:00Z");
    for (let i = 0; i < TIED; i += 1) {
      await db.integration.create({
        data: {
          orgId: ORG,
          provider: "gmail",
          status: "connected",
          externalAccountId: `same-${i}`,
          meta: { email: "same@acme.test" },
          createdAt: instant,
        },
      });
    }
    for (const sort of ["created", "account"]) {
      const ids: string[] = [];
      for (let page = 1; page <= Math.ceil(TIED / ACCOUNT_PAGE_SIZE); page += 1) {
        const res = await get<AccountPage>(
          integrationsGET,
          `http://t/api/integrations?provider=gmail&page=${page}&sort=${sort}`,
        );
        ids.push(...res.integrations.map((r) => r.id));
      }
      expect(new Set(ids).size, sort).toBe(TIED);
    }
  });

  it("finds a linked source's page within the search, not in the unfiltered list", async () => {
    // Newest first: the unfiltered list puts the target on page 2 (behind 12 newer
    // sources), but only 3 sources match "Drive", so in the searched view it is on page 1.
    const target = await source("Drive target", new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < 2; i += 1) await source(`Drive ${i}`, new Date(`2026-02-0${i + 1}T00:00:00Z`));
    for (let i = 0; i < SOURCE_PAGE_SIZE; i += 1) await source(`Other ${i}`, new Date(Date.UTC(2026, 3, i + 1)));

    expect(await sources(`page=1&at=${target.id}`)).toMatchObject({ page: 2, found: true });
    const searched = await sources(`page=2&q=Drive&at=${target.id}`);
    expect(searched).toMatchObject({ page: 1, found: true, total: 3 });
    expect(searched.sources.map((s) => s.id)).toContain(target.id);

    // Filtered out of the view asked for: not found, and the requested page is answered.
    expect(await sources(`page=1&q=Other&at=${target.id}`)).toMatchObject({ page: 1, found: false });
  });

  it("answers the last source of a page on that page", async () => {
    // Oldest first, the tenth source is the last row of page 1.
    const created = [];
    for (let i = 0; i < SOURCE_PAGE_SIZE + 1; i += 1)
      created.push(await source(`Row ${i}`, new Date(Date.UTC(2026, 0, i + 1))));
    const tenth = created[SOURCE_PAGE_SIZE - 1];
    const eleventh = created[SOURCE_PAGE_SIZE];

    const onFirst = await sources(`page=2&order=asc&at=${tenth.id}`);
    expect(onFirst).toMatchObject({ page: 1, found: true });
    expect(onFirst.sources.at(-1)?.id).toBe(tenth.id);
    expect(await sources(`page=1&order=asc&at=${eleventh.id}`)).toMatchObject({ page: 2, found: true });
  });
});
