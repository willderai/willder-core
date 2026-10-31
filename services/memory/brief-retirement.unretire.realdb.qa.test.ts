// QA probes for DELETE /api/briefs/:id/retirement beyond the builder's suite:
// a brief withdrawn by one source while a second source also left its scope,
// an admin whose grant is on a sibling scope only, and a retirement row written
// before rows were kept per source (legacy) next to a newer per-source row. Same harness as
// brief-retirement.provenance.realdb.test.ts: real Postgres 16 + ltree, the
// real access evaluator, the shipping route handlers; graph store and auth
// faked. Set QA_DATABASE_URL to an isolated test database; skips without it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

// Ids are generated per run: briefs, orgs and users are keyed across the whole
// database, and the sibling brief-retirement suites (or an interrupted earlier run
// of this one) seed briefs and tenants under the same readable names.
const RUN = randomUUID().slice(0, 8);
/** `name` made unique to this run, so no other suite's row can collide with it. */
const fixtureId = (name: string) => `${name}-${RUN}`;

const ORG = fixtureId("org-brief-prov");
const OTHER_ORG = fixtureId("org-brief-prov-other");
const ROOT = "org_bp";
const SALES = "org_bp.sales";
const ENG = "org_bp.eng";
const ADMIN = fixtureId("u-bp-admin");
const READER = fixtureId("u-bp-reader");

vi.mock(import("./store"), async (importOriginal) => {
  const actual = await importOriginal();
  actual.graphitiStore.removeGroupFacts = vi.fn(async () => ({ removedCount: 0 }));
  return actual;
});
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

describe.skipIf(!QA_URL)("brief un-retirement QA probes", () => {
  let db: PrismaClient;
  let retireSourceContent: (typeof import("./source-retirement"))["retireSourceContent"];
  let createBrief: (typeof import("@/services/memory/create-brief"))["createBrief"];
  let unretireRoute: Handler;
  let readRoute: Handler;
  let requireAccessContext: ReturnType<typeof vi.fn>;

  let slackId = "";
  let driveId = "";
  const sourceCreatedAt = new Date("2026-09-01T00:00:00Z");
  const afterSource = new Date("2026-09-10T00:00:00Z");

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const table of ["auditLog", "changeEvent", "brief", "grant", "scope", "source", "user"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  function briefData(id: string, orgId = ORG, scopePath = SALES) {
    return {
      id,
      orgId,
      type: "handoff" as const,
      scopePath,
      title: id,
      summary: "s",
      sections: {},
      createdAt: afterSource,
    };
  }

  async function retired(): Promise<string[]> {
    const rows = await db.briefRetirement.findMany({ where: { brief: { orgId: { in: [ORG, OTHER_ORG] } } } });
    return rows.map((r) => r.briefId).sort();
  }

  function actAs(userId: string, orgId = ORG) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  async function call(handler: Handler, method: string, id: string, query = "") {
    const res = await handler(new Request(`http://t/api/briefs/${id}${query}`, { method }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: await res.json() };
  }

  const unretire = (id: string, sourceId?: string) =>
    call(unretireRoute, "DELETE", id, sourceId ? `?sourceId=${sourceId}` : "");
  const read = (id: string) => call(readRoute, "GET", id);

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ retireSourceContent } = await import("./source-retirement"));
    ({ createBrief } = await import("@/services/memory/create-brief"));
    unretireRoute = (await import("@/app/api/briefs/[id]/retirement/route")).DELETE;
    readRoute = (await import("@/app/api/briefs/[id]/route")).GET;
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });
  });

  beforeEach(async () => {
    await clearTenants();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });

    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    for (const [id, permission] of [
      [ADMIN, "admin"],
      [READER, "read"],
    ] as const) {
      await db.user.create({
        data: { id, orgId: ORG, email: `${id}@qa.test`, role: "member", clerkId: `clerk-${id}` },
      });
      await db.grant.create({ data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: id, permission } });
    }

    const slack = await db.source.create({
      data: {
        orgId: ORG,
        type: "slack",
        externalId: "C-sales",
        name: "sales",
        scopePath: SALES,
        createdAt: sourceCreatedAt,
      },
    });
    const drive = await db.source.create({
      data: {
        orgId: ORG,
        type: "gdrive",
        externalId: "F-sales",
        name: "sales drive",
        scopePath: SALES,
        createdAt: sourceCreatedAt,
      },
    });
    slackId = slack.id;
    driveId = drive.id;

    actAs(ADMIN);
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  const ENG_ADMIN = fixtureId("u-bp-eng-admin");

  beforeEach(async () => {
    await createBrief(briefData(fixtureId("unrecorded")), {
      actorType: "agent",
      actorId: "agent-1",
      origin: "agent-run",
    });
    await createBrief(
      briefData(fixtureId("read-both")),
      { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
      [],
      new Set([slackId, driveId]),
    );
  });

  it("un-retiring a brief withdrawn by one source keeps it withdrawn while a second source it may have read has also left", async () => {
    // Slack moves out of sales: the unrecorded brief is withdrawn by slack.
    await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, ENG);
    expect(await retired()).toContain(fixtureId("unrecorded"));
    // Drive is disconnected while the brief is already withdrawn, so its own
    // retirement pass skips the brief.
    await retireSourceContent({ id: driveId, orgId: ORG, scopePath: SALES }, null);

    // The admin rules slack out. Drive's content has still left sales, and the
    // brief recorded nothing, so it may quote drive: it must not read again.
    await unretire(fixtureId("unrecorded"));

    expect((await read(fixtureId("unrecorded"))).status).toBe(404);
  });

  it("the same holds for a brief whose provenance names the second source but not the first", async () => {
    await createBrief(
      briefData(fixtureId("read-drive-only")),
      { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
      [],
      new Set([driveId]),
    );
    await createBrief(briefData(fixtureId("unrecorded-2")), {
      actorType: "agent",
      actorId: "agent-1",
      origin: "agent-run",
    });
    // Drive leaves first: read-drive-only and both unrecorded briefs are withdrawn by drive.
    await retireSourceContent({ id: driveId, orgId: ORG, scopePath: SALES }, ENG);
    expect(await retired()).toEqual(expect.arrayContaining([fixtureId("read-drive-only"), fixtureId("unrecorded")]));
    // read-drive-only names drive, so un-retiring it is refused.
    expect((await unretire(fixtureId("read-drive-only"))).status).toBe(409);
    expect((await read(fixtureId("read-drive-only"))).status).toBe(404);
  });

  it("an admin of a sibling scope only gets the not-found answer for a retired brief and it stays withdrawn", async () => {
    const eng = await db.scope.create({ data: { orgId: ORG, path: ENG, name: "eng" } });
    await db.user.create({
      data: { id: ENG_ADMIN, orgId: ORG, email: `${ENG_ADMIN}@qa.test`, role: "member", clerkId: `clerk-${ENG_ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: eng.id, granteeType: "user", granteeId: ENG_ADMIN, permission: "admin" },
    });
    await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, ENG);
    actAs(ENG_ADMIN);

    expect(await unretire(fixtureId("unrecorded"))).toEqual({ status: 404, body: { error: "brief not found" } });
    expect(await retired()).toContain(fixtureId("unrecorded"));
    expect(await db.briefRetirementWaiver.count({ where: { briefId: fixtureId("unrecorded") } })).toBe(0);
  });

  it("a legacy row is never waived, and waiving a newer source beside it leaves the brief withdrawn", async () => {
    // The state the migration leaves: slack withdrew the brief before rows were
    // kept per source, so its row is legacy and any other source that left then
    // has no row at all.
    await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, ENG);
    await db.briefRetirement.updateMany({ where: { briefId: fixtureId("unrecorded") }, data: { legacy: true } });
    // Drive leaves after the change and writes its own, non-legacy row.
    await retireSourceContent({ id: driveId, orgId: ORG, scopePath: SALES }, null);
    const rows = await db.briefRetirement.findMany({
      where: { briefId: fixtureId("unrecorded") },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.sourceId, r.legacy])).toEqual([
      [slackId, true],
      [driveId, false],
    ]);

    expect((await unretire(fixtureId("unrecorded"), driveId)).status).toBe(200);
    expect((await read(fixtureId("unrecorded"))).status).toBe(404);

    expect((await unretire(fixtureId("unrecorded"), slackId)).status).toBe(409);
    expect((await unretire(fixtureId("unrecorded"))).status).toBe(409);
    expect((await read(fixtureId("unrecorded"))).status).toBe(404);
    expect(
      await db.briefRetirementWaiver.findMany({
        where: { briefId: fixtureId("unrecorded") },
        select: { sourceId: true },
      }),
    ).toEqual([{ sourceId: driveId }]);
  });
});
