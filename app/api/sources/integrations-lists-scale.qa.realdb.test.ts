// The Integrations lists at 1,000+ rows in two orgs: GET /api/sources?page= and GET /api/integrations?provider=&page=
// page every row exactly once, count the whole org (never the page), find one named row
// with one search, open a deep link on the page that holds it, and never list or count
// the other org's rows, which share every name. A member without org-wide write is
// refused the source list before any read; any member reads the account list.
//
// Runs the shipping routes against a real Postgres with ltree and the real access
// evaluator. Authentication is mocked. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SOURCE_PAGE_SIZE } from "@/lib/source-lists";
import { ACCOUNT_PAGE_SIZE } from "@/lib/integration-lists";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qascaleintegrations";
const OTHER_ORG = "qascaleintegrationsother";
const ROOT = `org_${ORG}`;
const ADMIN = "u-qascale-admin";
const MEMBER = "u-qascale-member";

/** Rows per org: past 1,000, and not a multiple of the page size, so the last page is short. */
const SOURCES = 1_053;
const ACCOUNTS = 1_047;
/** Many rows share a name, so only the id tie-break keeps a row on one page. */
const NAME_GROUPS = 7;
const TYPES = ["gdrive", "website", "slack", "figma", "posthog", "github"] as const;
const CONNECTOR_TYPES = new Set(["slack", "figma", "posthog", "github"]);

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type Page<K extends string> = Record<K, { id: string; name?: string; meta?: Record<string, unknown> }[]> & {
  total: number;
  count: number;
  page: number;
  pageSize: number;
  found?: boolean;
};

function actor(id: string, role: "admin" | "member") {
  return { org: { id: ORG, name: ORG }, user: { id, role }, ctx: { orgId: ORG, actor: { type: "human", id, role } } };
}

describe.skipIf(!QA_URL)("the Integrations lists at 1,000+ rows in two orgs", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let sourcesGET: Handler;
  let integrationsGET: Handler;
  const base = Date.UTC(2026, 0, 1);

  async function get<K extends string>(handler: Handler, path: string): Promise<Page<K>> {
    const res = await handler(new Request(`http://t${path}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Page<K>;
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.source.deleteMany({ where: { orgId: org } });
      await db.integration.deleteMany({ where: { orgId: org } });
      for (const t of ["grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  /** The same names, types, statuses and timestamps in both orgs. */
  function sourceRows(org: string) {
    return Array.from({ length: SOURCES }, (_, i) => ({
      orgId: org,
      type: TYPES[i % TYPES.length] as never,
      externalId: `ext-${i}`,
      name: i === 777 ? "Needle handbook" : `Site ${i % NAME_GROUPS}`,
      scopePath: `org_${org}.team${i % 3}`,
      status: (i % 10 === 0 ? "error" : "active") as never,
      encryptedTokens: "sealed-secret",
      createdAt: new Date(base + Math.floor(i / 4) * 60_000), // four rows per minute: ties on time too
    }));
  }

  function accountRows(org: string) {
    const connected = Array.from({ length: ACCOUNTS }, (_, i) => ({
      orgId: org,
      provider: "gmail" as never,
      status: "connected" as never,
      externalAccountId: `acct-${i}`,
      encryptedTokens: "sealed-tokens",
      meta: { email: i === 512 ? "needle@acme.test" : `inbox${i % NAME_GROUPS}@acme.test` },
      createdAt: new Date(base + Math.floor(i / 3) * 60_000),
    }));
    // Outlook accounts in the same org never count toward Gmail's card.
    const outlook = Array.from({ length: 30 }, (_, i) => ({
      orgId: org,
      provider: "outlook" as never,
      status: "connected" as never,
      externalAccountId: `ol-${i}`,
      encryptedTokens: "sealed-tokens",
      meta: { email: `ol${i}@acme.test` },
      createdAt: new Date(base),
    }));
    return [...connected, ...outlook];
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    sourcesGET = (await import("@/app/api/sources/route")).GET;
    integrationsGET = (await import("@/app/api/integrations/route")).GET;

    await clear();
    for (const org of [ORG, OTHER_ORG]) {
      await db.org.create({ data: { id: org, name: org } });
      await db.source.createMany({ data: sourceRows(org) });
      await db.integration.createMany({ data: accountRows(org) });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@scale.test`, role: "admin", clerkId: `c-${ADMIN}` },
    });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@scale.test`, role: "member", clerkId: `c-${MEMBER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // The other org's newest Gmail attempts are newer than anything here: never shown here.
    await db.integration.create({
      data: {
        orgId: OTHER_ORG,
        provider: "gmail",
        status: "error",
        encryptedTokens: "sealed-tokens",
        meta: { email: "foreign@x.test" },
        createdAt: new Date(base + 10 ** 10),
      },
    });
    await db.integration.create({
      data: {
        orgId: ORG,
        provider: "gmail",
        status: "error",
        encryptedTokens: "sealed-tokens",
        meta: { email: "mine@acme.test" },
        createdAt: new Date(base + 10 ** 9),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("pages all 1,053 sources once under a name order full of ties, with org-only counts and a short last page", async () => {
    requireAccessContext.mockResolvedValue(actor(ADMIN, "admin") as never);
    const lastPage = Math.ceil(SOURCES / SOURCE_PAGE_SIZE);
    const seen: string[] = [];
    for (let page = 1; page <= lastPage; page += 1) {
      const p = await get<"sources">(sourcesGET, `/api/sources?page=${page}&sort=name&order=asc`);
      expect(p).toMatchObject({ total: SOURCES, count: SOURCES, page, pageSize: SOURCE_PAGE_SIZE });
      expect(p.sources.length).toBe(page === lastPage ? SOURCES % SOURCE_PAGE_SIZE : SOURCE_PAGE_SIZE);
      for (const s of p.sources) expect(s).not.toHaveProperty("encryptedTokens");
      seen.push(...p.sources.map((s) => s.id));
    }
    expect(new Set(seen).size).toBe(SOURCES);
    const mine = await db.source.findMany({ where: { orgId: ORG }, select: { id: true } });
    expect(new Set(seen)).toEqual(new Set(mine.map((s) => s.id)));
    expect((await get<"sources">(sourcesGET, `/api/sources?page=${lastPage + 1}`)).sources).toEqual([]);
  }, 120_000);

  it("finds one named source with one search, and a filtered count reproduces from the data", async () => {
    requireAccessContext.mockResolvedValue(actor(ADMIN, "admin") as never);
    const hit = await get<"sources">(sourcesGET, "/api/sources?page=1&q=needle");
    expect(hit.sources.map((s) => s.name)).toEqual(["Needle handbook"]);
    expect(hit).toMatchObject({ total: 1, count: SOURCES });

    const errors = sourceRows(ORG).filter(
      (s) => (s.status as string) === "error" && CONNECTOR_TYPES.has(s.type as string),
    ).length;
    const connectors = sourceRows(ORG).filter((s) => CONNECTOR_TYPES.has(s.type as string)).length;
    const p = await get<"sources">(sourcesGET, "/api/sources?page=1&kind=connector&status=error");
    expect(p).toMatchObject({ total: errors, count: connectors });
  });

  it("opens a deep link on the page that holds the source, deep in the list, and says found:false for the other org's", async () => {
    requireAccessContext.mockResolvedValue(actor(ADMIN, "admin") as never);
    const all: string[] = [];
    for (let page = 1; page <= Math.ceil(SOURCES / SOURCE_PAGE_SIZE); page += 1) {
      all.push(
        ...(await get<"sources">(sourcesGET, `/api/sources?page=${page}&sort=name&order=desc`)).sources.map(
          (s) => s.id,
        ),
      );
    }
    for (const index of [0, 9, 10, 500, 1_049, SOURCES - 1]) {
      const p = await get<"sources">(sourcesGET, `/api/sources?page=1&sort=name&order=desc&at=${all[index]}`);
      expect(p.found).toBe(true);
      expect(p.page).toBe(Math.floor(index / SOURCE_PAGE_SIZE) + 1);
      expect(p.sources.map((s) => s.id)).toContain(all[index]);
    }
    const foreign = await db.source.findFirstOrThrow({ where: { orgId: OTHER_ORG, name: "Needle handbook" } });
    const p = await get<"sources">(sourcesGET, `/api/sources?page=3&at=${foreign.id}`);
    expect(p).toMatchObject({ found: false, page: 3, total: SOURCES });
    expect(p.sources.map((s) => s.id)).not.toContain(foreign.id);
  }, 120_000);

  it("refuses the source list to a member without org-wide write", async () => {
    requireAccessContext.mockResolvedValue(actor(MEMBER, "member") as never);
    const res = await sourcesGET(new Request("http://t/api/sources?page=1"));
    expect(res.status).toBe(403);
  });

  it("pages all 1,047 Gmail accounts once under an address order full of ties, never counting Outlook or the other org", async () => {
    for (const who of [actor(ADMIN, "admin"), actor(MEMBER, "member")]) {
      requireAccessContext.mockResolvedValue(who as never);
      const lastPage = Math.ceil(ACCOUNTS / ACCOUNT_PAGE_SIZE);
      const seen: string[] = [];
      for (let page = 1; page <= lastPage; page += 1) {
        const p = await get<"integrations">(
          integrationsGET,
          `/api/integrations?provider=gmail&page=${page}&sort=account&order=asc`,
        );
        expect(p).toMatchObject({ total: ACCOUNTS, count: ACCOUNTS, page });
        expect(p.integrations.length).toBe(page === lastPage ? ACCOUNTS % ACCOUNT_PAGE_SIZE : ACCOUNT_PAGE_SIZE);
        for (const row of p.integrations) expect(row).not.toHaveProperty("encryptedTokens");
        seen.push(...p.integrations.map((r) => r.id));
      }
      expect(new Set(seen).size).toBe(ACCOUNTS);
    }
  }, 120_000);

  it("finds one mailbox with one search and shows this org's newest attempt, not the other org's newer one", async () => {
    requireAccessContext.mockResolvedValue(actor(MEMBER, "member") as never);
    const p = (await get<"integrations">(
      integrationsGET,
      "/api/integrations?provider=gmail&page=1&q=needle",
    )) as Page<"integrations"> & {
      attempts: Record<string, { meta: Record<string, unknown> } | null>;
    };
    expect(p.integrations.map((r) => r.meta?.email)).toEqual(["needle@acme.test"]);
    expect(p).toMatchObject({ total: 1, count: ACCOUNTS });
    expect(p.attempts.error?.meta.email).toBe("mine@acme.test");
    expect(JSON.stringify(p)).not.toContain("sealed-tokens");
  });

  it("answers a page of 1,000+ rows in bounded time", async () => {
    requireAccessContext.mockResolvedValue(actor(ADMIN, "admin") as never);
    const started = performance.now();
    await get<"sources">(sourcesGET, "/api/sources?page=50&sort=scope&order=asc&q=site");
    await get<"integrations">(integrationsGET, "/api/integrations?provider=gmail&page=50&q=inbox");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
