// A retired brief must not surface on the Explore page either.
//
// brief-retirement.ts promises that a retired brief "reads as absent everywhere,
// the same as an id that was never issued". The /api/briefs/:id handlers keep
// that promise; GET /api/memory/stores (services/memory/store-overview.ts) counts
// and lists briefs by raw SQL, id and title included, without going through them.
//
// Real Postgres 16 with ltree; the graph store and authentication are faked.
// Set QA_DATABASE_URL to an isolated test database; the suite skips without it.
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

const ORG = fixtureId("org-brief-overview");
const ROOT = "org_bc";
const SALES = "org_bc.sales";
const ENG = "org_bc.eng";
const ADMIN = fixtureId("u-bc-admin");
const SECRET = "Floor is $160k";

vi.mock(import("./store"), async (importOriginal) => {
  const actual = await importOriginal();
  actual.graphitiStore.removeGroupFacts = vi.fn(async () => ({ removedCount: 0 }));
  return actual;
});
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("the Explore store overview after a brief is retired", () => {
  let db: PrismaClient;
  let retireSourceContent: (typeof import("./source-retirement"))["retireSourceContent"];
  let readStoreOverview: (typeof import("./store-overview"))["readStoreOverview"];
  let sourceId = "";

  async function clear() {
    for (const table of ["brief", "grant", "scope", "source", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ retireSourceContent } = await import("./source-retirement"));
    ({ readStoreOverview } = await import("./store-overview"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "member" } },
    } as never);
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
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
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    sourceId = source.id;
    await db.brief.create({
      data: {
        id: fixtureId("bc-sales"),
        orgId: ORG,
        type: "handoff",
        scopePath: SALES,
        title: `Deal: ${SECRET}`,
        summary: SECRET,
        sections: {},
        createdAt: new Date("2026-09-10T00:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("the Explore store overview neither counts nor lists a retired brief", async () => {
    const before = await readStoreOverview(ORG, SALES);
    expect(JSON.stringify(before)).toContain(fixtureId("bc-sales"));

    await retireSourceContent({ id: sourceId, orgId: ORG, scopePath: SALES }, ENG);
    expect(await db.briefRetirement.count({ where: { briefId: fixtureId("bc-sales") } })).toBe(1);

    const after = await readStoreOverview(ORG, SALES);
    expect(JSON.stringify(after)).not.toContain(fixtureId("bc-sales"));
    expect(JSON.stringify(after)).not.toContain(SECRET);
    // The count drops with the list: a retired brief is not a phantom brief.
    expect(after.counts.briefs).toBe(before.counts.briefs - 1);
  });
});
