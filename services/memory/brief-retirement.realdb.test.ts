// A brief built from a source's content must stop being readable at its scope
// once that content leaves it.
//
// A brief is a copy of what it retrieved. A reconnect that moves a source out of
// a scope, or a disconnect, retires the source's chunks and facts, but used to
// leave every brief drawn from them readable at the old scope with full content.
//
// Runs `retireSourceContent` (the step both the reconnect and the disconnect run)
// and then the shipping /api/briefs/:id handlers, against a real Postgres 16 with
// ltree and the real access evaluator, two tenants. The graph store and
// authentication are faked. Set QA_DATABASE_URL to an isolated test database
// (never the inherited DATABASE_URL); the suite skips without it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

// Ids are generated per run: briefs, orgs and users are keyed across the whole
// database, and the sibling brief-retirement suites (or an interrupted earlier run
// of this one) seed briefs and tenants under the same readable names.
const RUN = randomUUID().slice(0, 8);
/** `name` made unique to this run, so no other suite's row can collide with it. */
const fixtureId = (name: string) => `${name}-${RUN}`;

const ORG = fixtureId("org-brief-retire");
const OTHER_ORG = fixtureId("org-brief-retire-other");
const ROOT = "org_br";
const SALES = "org_br.sales";
const LEADS = "org_br.sales.leads";
const ENG = "org_br.eng";
const ADMIN = fixtureId("u-br-admin");

vi.mock(import("./store"), async (importOriginal) => {
  const actual = await importOriginal();
  actual.graphitiStore.removeGroupFacts = vi.fn(async () => ({ removedCount: 0 }));
  return actual;
});
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

describe.skipIf(!QA_URL)("retiring a source withdraws the briefs it could have fed", () => {
  let db: PrismaClient;
  let retireSourceContent: (typeof import("./source-retirement"))["retireSourceContent"];
  const routes: Record<string, { handler: Handler; body?: unknown }> = {};

  let sourceId = "";
  const sourceCreatedAt = new Date("2026-09-01T00:00:00Z");
  const afterSource = new Date("2026-09-10T00:00:00Z");

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const table of ["auditLog", "brief", "grant", "scope", "source", "user"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  function brief(id: string, orgId: string, scopePath: string, createdAt = afterSource) {
    return db.brief.create({
      data: { id, orgId, type: "handoff", scopePath, title: id, summary: "s", sections: {}, createdAt },
    });
  }

  async function retiredReasons(): Promise<Record<string, string>> {
    const rows = await db.briefRetirement.findMany({ where: { brief: { orgId: { in: [ORG, OTHER_ORG] } } } });
    return Object.fromEntries(rows.map((r) => [r.briefId, r.reason]));
  }

  async function call(name: string, id: string) {
    const { handler, body } = routes[name];
    const req = new Request(`http://t/api/briefs/${id}/${name}`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handler(req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ retireSourceContent } = await import("./source-retirement"));

    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "member" } },
    } as never);

    routes.read = { handler: (await import("@/app/api/briefs/[id]/route")).GET };
    routes.staleness = { handler: (await import("@/app/api/briefs/[id]/staleness/route")).GET };
    routes.acknowledge = { handler: (await import("@/app/api/briefs/[id]/acknowledge/route")).POST };
    routes["export-doc"] = {
      handler: (await import("@/app/api/briefs/[id]/export-doc/route")).POST,
      body: { token: "t" },
    };
    routes.persist = { handler: (await import("@/app/api/briefs/[id]/persist/route")).POST };
    routes.correct = { handler: (await import("@/app/api/briefs/[id]/correct/route")).POST, body: { correction: "c" } };
  });

  beforeEach(async () => {
    await clearTenants();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });

    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@qa.test`, role: "member", clerkId: `clerk-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    const source = await db.source.create({
      data: {
        orgId: ORG,
        type: "slack",
        externalId: "C-sales",
        name: "sales",
        scopePath: SALES,
        createdAt: sourceCreatedAt,
      },
    });
    sourceId = source.id;

    // Briefs that could hold the source's content: created after it, at a scope
    // covering the one it wrote to.
    await brief(fixtureId("at-root"), ORG, ROOT);
    await brief(fixtureId("at-sales"), ORG, SALES);
    // Briefs that could not: narrower than the source's scope, a sibling, older
    // than the source, and another tenant's brief at the same path.
    await brief(fixtureId("at-leads"), ORG, LEADS);
    await brief(fixtureId("at-eng"), ORG, ENG);
    await brief(fixtureId("before-source"), ORG, SALES, new Date("2026-08-01T00:00:00Z"));
    await brief(fixtureId("other-org"), OTHER_ORG, SALES);
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  it("a move out of a brief's scope retires it; a brief whose scope still covers the destination stays", async () => {
    const result = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, ENG);

    expect(result.retiredBriefs).toBe(1);
    expect(await retiredReasons()).toEqual({ [fixtureId("at-sales")]: "source_moved" });
  });

  it("a narrowing move inside the brief's scope retires nothing: its readers can still read the content", async () => {
    const result = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, LEADS);

    expect(result.retiredBriefs).toBe(0);
    expect(await retiredReasons()).toEqual({});
  });

  it("a disconnect retires every brief that could have drawn from the source, and only those", async () => {
    const result = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, null);

    expect(result.retiredBriefs).toBe(2);
    expect(await retiredReasons()).toEqual({
      [fixtureId("at-root")]: "source_disconnected",
      [fixtureId("at-sales")]: "source_disconnected",
    });
  });

  it("covers a scope the source wrote to before an earlier move, not only the one it points at", async () => {
    await db.source.update({ where: { id: sourceId }, data: { scopePath: ENG } });
    await db.sourceFile.create({
      data: { sourceId, externalFileId: "f1", checksum: "c", episodeScopePath: SALES },
    });

    await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: ENG }, null);

    expect(Object.keys(await retiredReasons()).sort()).toEqual([
      fixtureId("at-eng"),
      fixtureId("at-root"),
      fixtureId("at-sales"),
    ]);
  });

  it("is idempotent: the disconnect route's second sweep retires nothing new", async () => {
    await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, null);
    const again = await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, null);

    expect(again.retiredBriefs).toBe(0);
  });

  it("retires nothing when the caller names a source id under another tenant's org", async () => {
    const { retireBriefsFedBySource } = await import("./brief-retirement");

    const count = await retireBriefsFedBySource({ id: sourceId, orgId: OTHER_ORG }, [SALES], null);

    expect(count).toBe(0);
    expect(await retiredReasons()).toEqual({});
  });

  const allRoutes = ["read", "staleness", "acknowledge", "export-doc", "persist", "correct"];

  it.each(allRoutes)(
    "%s: a retired brief answers exactly like an id never issued, even to an org admin",
    async (name) => {
      expect((await call("read", fixtureId("at-sales"))).status).toBe(200);

      await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, ENG);

      const absent = await call(name, "never-issued");
      expect(absent).toEqual({ status: 404, body: { error: "brief not found" } });
      expect(await call(name, fixtureId("at-sales"))).toEqual(absent);
      // The brief the move left in reach is untouched.
      expect((await call("read", fixtureId("at-root"))).status).toBe(200);
    },
  );
});
