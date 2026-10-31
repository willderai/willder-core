// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Every /api/briefs/:id route must answer a caller who cannot read a brief
// exactly as it answers an id that does not exist: same status, same body. A
// 403 for "exists but hidden" next to a 404 for "absent" lets any member probe
// which brief ids are real at scopes they hold no grant on.
//
// Runs the shipping route handlers against a real Postgres 16 with ltree and
// the real access evaluator, two tenants and two scopes. Only authentication is
// mocked. Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-brief-oracle";
const OTHER_ORG = "org-brief-oracle-other";
const BRIEF_SCOPE = "org_bo.sales";
const SIBLING_SCOPE = "org_bo.engineering";
const BRIEF_ID = "brief-oracle-1";
const ABSENT_ID = "brief-oracle-never-issued";

const READER = "u-bo-reader"; // read on the brief's scope
const SIBLING = "u-bo-sibling"; // read on a sibling scope only
const OUTSIDER = "u-bo-outsider"; // member of the other org

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

describe.skipIf(!QA_URL)("brief routes do not disclose whether a hidden brief exists", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  const routes: Record<string, { handler: Handler; body?: unknown }> = {};

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
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

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const table of ["auditLog", "brief", "grant", "scope", "source", "user"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    routes.read = { handler: (await import("./route")).GET };
    routes.staleness = { handler: (await import("./staleness/route")).GET };
    routes.acknowledge = { handler: (await import("./acknowledge/route")).POST };
    routes["export-doc"] = { handler: (await import("./export-doc/route")).POST, body: { token: "t" } };
    routes.persist = { handler: (await import("./persist/route")).POST };
    routes.correct = { handler: (await import("./correct/route")).POST, body: { correction: "c" } };

    await clearTenants();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });

    const briefScope = await db.scope.create({ data: { orgId: ORG, path: BRIEF_SCOPE, name: "sales" } });
    const siblingScope = await db.scope.create({ data: { orgId: ORG, path: SIBLING_SCOPE, name: "engineering" } });
    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: BRIEF_SCOPE,
        title: "t",
        summary: "s",
        sections: {},
      },
    });
    // A connected Drive source, so export-doc's own 400 for "no Drive
    // integration" cannot stand in for the gate.
    await db.source.create({
      data: { orgId: ORG, type: "gdrive", externalId: "folder-1", name: "drive", scopePath: BRIEF_SCOPE },
    });

    for (const [id, orgId] of [
      [READER, ORG],
      [SIBLING, ORG],
      [OUTSIDER, OTHER_ORG],
    ] as const) {
      await db.user.create({ data: { id, orgId, email: `${id}@qa.test`, role: "member", clerkId: `clerk-${id}` } });
    }
    await db.grant.create({
      data: { orgId: ORG, scopeId: briefScope.id, granteeType: "user", granteeId: READER, permission: "read" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: siblingScope.id, granteeType: "user", granteeId: SIBLING, permission: "read" },
    });
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  it("serves the brief to a reader holding a grant on its scope", async () => {
    actAs(ORG, READER);
    const res = await call("read", BRIEF_ID);
    expect(res.status).toBe(200);
    expect(res.body.brief.id).toBe(BRIEF_ID);
  });

  const allRoutes = ["read", "staleness", "acknowledge", "export-doc", "persist", "correct"];

  it.each(allRoutes)("%s: a hidden brief answers exactly like an absent id", async (name) => {
    actAs(ORG, SIBLING);
    const absent = await call(name, ABSENT_ID);
    const hidden = await call(name, BRIEF_ID);

    expect(absent).toEqual({ status: 404, body: { error: "brief not found" } });
    expect(hidden).toEqual(absent);
  });

  it.each(allRoutes)("%s: another org's brief answers exactly like an absent id", async (name) => {
    actAs(OTHER_ORG, OUTSIDER);
    expect(await call(name, BRIEF_ID)).toEqual({ status: 404, body: { error: "brief not found" } });
  });

  it.each(["persist", "correct"])(
    "%s: a reader who can see the brief but not write it gets 403, which discloses nothing new",
    async (name) => {
      actAs(ORG, READER);
      const res = await call(name, BRIEF_ID);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/^access denied: /);
    },
  );

  it("export-doc writes nothing back to a brief the caller cannot read", async () => {
    actAs(ORG, SIBLING);
    await call("export-doc", BRIEF_ID);
    const brief = await db.brief.findUniqueOrThrow({ where: { id: BRIEF_ID } });
    expect(brief.googleDocUrl).toBeNull();
  });
});
