// Retiring a source withdraws only the briefs that read it, when the brief
// recorded what it read; an org admin can bring back a brief the scope-and-time
// fallback withdrew, and that ruling holds for that source.
//
// Runs `retireSourceContent`, `createBrief` and the shipping
// DELETE /api/briefs/:id/retirement and GET /api/briefs/:id handlers against a
// real Postgres 16 with ltree and the real access evaluator, two tenants. The
// graph store and authentication are faked. Set QA_DATABASE_URL to an isolated
// test database (never the inherited DATABASE_URL); the suite skips without it.
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

describe.skipIf(!QA_URL)("brief provenance narrows retirement, and an admin can reverse the fallback", () => {
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
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
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
    return [...new Set(rows.map((r) => r.briefId))].sort();
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
    call(unretireRoute, "DELETE", id, sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : "");
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

  describe("retirement", () => {
    beforeEach(async () => {
      await createBrief(
        briefData(fixtureId("read-slack")),
        { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
        [],
        new Set([slackId]),
      );
      await createBrief(
        briefData(fixtureId("read-drive")),
        { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
        [],
        new Set([driveId]),
      );
      await createBrief(
        briefData(fixtureId("read-nothing")),
        { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
        [],
        new Set(),
      );
      await createBrief(briefData(fixtureId("unrecorded")), {
        actorType: "agent",
        actorId: "agent-1",
        origin: "agent-run",
      });
    });

    it("createBrief stores the run's sources with the brief, once each", async () => {
      await createBrief(
        briefData(fixtureId("read-both")),
        { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
        [],
        new Set([slackId, driveId, slackId]),
      );

      const row = await db.briefProvenance.findUniqueOrThrow({ where: { briefId: fixtureId("read-both") } });
      expect(row.sourceIds).toEqual([slackId, driveId].sort());
      expect(await db.briefProvenance.findUnique({ where: { briefId: fixtureId("unrecorded") } })).toBeNull();
    });

    it("a disconnect retires the brief that read the source and the one that recorded nothing", async () => {
      const result = await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, null);

      expect(result.retiredBriefs).toBe(2);
      expect(await retired()).toEqual([fixtureId("read-slack"), fixtureId("unrecorded")]);
    });

    it("a move out of scope retires the same two, and leaves briefs that read only other sources", async () => {
      await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, ENG);

      expect(await retired()).toEqual([fixtureId("read-slack"), fixtureId("unrecorded")]);
      expect((await read(fixtureId("read-drive"))).status).toBe(200);
      expect((await read(fixtureId("read-nothing"))).status).toBe(200);
    });

    it("a brief that read the source in another tenant is not touched by this tenant's source", async () => {
      await db.brief.create({ data: briefData(fixtureId("other-org"), OTHER_ORG) });
      await db.briefProvenance.create({ data: { briefId: fixtureId("other-org"), sourceIds: [slackId] } });

      await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, null);

      expect(await retired()).not.toContain(fixtureId("other-org"));
    });
  });

  describe("DELETE /api/briefs/:id/retirement", () => {
    beforeEach(async () => {
      await createBrief(briefData(fixtureId("unrecorded")), {
        actorType: "agent",
        actorId: "agent-1",
        origin: "agent-run",
      });
      await createBrief(
        briefData(fixtureId("read-slack")),
        { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
        [],
        new Set([slackId]),
      );
      await createBrief(
        briefData(fixtureId("live")),
        { actorType: "agent", actorId: "agent-1", origin: "agent-run" },
        [],
        new Set(),
      );
      await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, ENG);
      expect(await retired()).toEqual([fixtureId("read-slack"), fixtureId("unrecorded")]);
    });

    it("an admin brings back a brief the fallback withdrew, with an audit row naming them and the source", async () => {
      expect((await read(fixtureId("unrecorded"))).status).toBe(404);

      expect(await unretire(fixtureId("unrecorded"))).toEqual({
        status: 200,
        body: { briefId: fixtureId("unrecorded"), retired: false, retiredBy: [] },
      });

      expect((await read(fixtureId("unrecorded"))).status).toBe(200);
      const audit = await db.auditLog.findMany({ where: { orgId: ORG, action: "brief.unretired" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: "human",
        actorId: ADMIN,
        decision: "allow",
        target: `${SALES}/brief:${fixtureId("unrecorded")}`,
        metadata: { sourceId: slackId, reason: "source_moved", stillRetiredBy: [] },
      });
    });

    it("a second source leaving an already-withdrawn brief records its own retirement", async () => {
      const second = await retireSourceContent({ id: driveId, orgId: ORG, scopePath: SALES }, null);

      expect(second.retiredBriefs).toBe(1);
      const rows = await db.briefRetirement.findMany({
        where: { briefId: fixtureId("unrecorded") },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => r.sourceId)).toEqual([slackId, driveId]);
    });

    it("a brief two sources withdrew stays withdrawn until each is waived by name", async () => {
      await retireSourceContent({ id: driveId, orgId: ORG, scopePath: SALES }, null);

      expect(await unretire(fixtureId("unrecorded"))).toEqual({
        status: 409,
        body: { error: "several sources withdrew this brief; name one with ?sourceId=", retiredBy: [slackId, driveId] },
      });
      expect(await db.briefRetirementWaiver.count({ where: { briefId: fixtureId("unrecorded") } })).toBe(0);

      expect(await unretire(fixtureId("unrecorded"), slackId)).toEqual({
        status: 200,
        body: { briefId: fixtureId("unrecorded"), retired: true, retiredBy: [driveId] },
      });
      expect((await read(fixtureId("unrecorded"))).status).toBe(404);

      expect(await unretire(fixtureId("unrecorded"), driveId)).toEqual({
        status: 200,
        body: { briefId: fixtureId("unrecorded"), retired: false, retiredBy: [] },
      });
      expect((await read(fixtureId("unrecorded"))).status).toBe(200);
      const audit = await db.auditLog.findMany({
        where: { orgId: ORG, action: "brief.unretired" },
        orderBy: { at: "asc" },
      });
      expect(audit.map((row) => row.metadata)).toEqual([
        { sourceId: slackId, reason: "source_moved", stillRetiredBy: [driveId] },
        { sourceId: driveId, reason: "source_disconnected", stillRetiredBy: [] },
      ]);
    });

    it("refuses a retirement recorded before per-source rows, so a second source's unrecorded withdrawal stays in force", async () => {
      // The state the migration leaves behind: slack's row marked legacy, and
      // drive's earlier disconnect never recorded because the brief was
      // already withdrawn.
      await db.briefRetirement.updateMany({ where: { briefId: fixtureId("unrecorded") }, data: { legacy: true } });

      expect(await unretire(fixtureId("unrecorded"))).toEqual({
        status: 409,
        body: { error: "withdrawn before per-source tracking; generate a new brief instead" },
      });
      expect(await unretire(fixtureId("unrecorded"), slackId)).toMatchObject({ status: 409 });

      expect((await read(fixtureId("unrecorded"))).status).toBe(404);
      expect(await db.briefRetirementWaiver.count({ where: { briefId: fixtureId("unrecorded") } })).toBe(0);
      expect(await db.auditLog.count({ where: { orgId: ORG, action: "brief.unretired" } })).toBe(0);
    });

    it("a retirement recorded from now on is not legacy", async () => {
      const rows = await db.briefRetirement.findMany({ where: { brief: { orgId: ORG } } });

      expect(rows.map((row) => row.legacy)).toEqual([false, false]);
    });

    it("an empty ?sourceId= reads as omitted", async () => {
      expect((await call(unretireRoute, "DELETE", fixtureId("unrecorded"), "?sourceId=")).status).toBe(200);
    });

    it("409 when the named source did not withdraw the brief, and nothing is waived", async () => {
      expect(await unretire(fixtureId("unrecorded"), driveId)).toEqual({
        status: 409,
        body: { error: "brief is not retired by that source" },
      });
      expect(await retired()).toContain(fixtureId("unrecorded"));
      expect(await db.briefRetirementWaiver.count({ where: { briefId: fixtureId("unrecorded") } })).toBe(0);
    });

    it("the ruling holds for that source: its later disconnect does not withdraw the brief again", async () => {
      await unretire(fixtureId("unrecorded"));

      const again = await retireSourceContent({ id: slackId, orgId: ORG, scopePath: SALES }, null);

      expect(again.retiredBriefs).toBe(0);
      expect(await retired()).toEqual([fixtureId("read-slack")]);
    });

    it("the ruling covers only that source: another source's disconnect still withdraws the brief", async () => {
      await unretire(fixtureId("unrecorded"));

      await retireSourceContent({ id: driveId, orgId: ORG, scopePath: SALES }, null);

      expect(await retired()).toContain(fixtureId("unrecorded"));
    });

    it("refuses a brief whose own provenance shows it read the source, and leaves it withdrawn", async () => {
      const res = await unretire(fixtureId("read-slack"));

      expect(res.status).toBe(409);
      expect(await retired()).toContain(fixtureId("read-slack"));
      expect(await db.auditLog.count({ where: { orgId: ORG, action: "brief.unretired" } })).toBe(0);
    });

    it("409 for a brief that is not retired", async () => {
      expect(await unretire(fixtureId("live"))).toEqual({ status: 409, body: { error: "brief is not retired" } });
    });

    it("a reader without access.manage gets the not-found answer for a retired brief and the brief stays withdrawn", async () => {
      actAs(READER);

      const absent = await unretire("never-issued");
      expect(absent).toEqual({ status: 404, body: { error: "brief not found" } });
      expect(await unretire(fixtureId("unrecorded"))).toEqual(absent);
      expect(await retired()).toContain(fixtureId("unrecorded"));
    });

    it("a reader without access.manage gets 403 for a live brief they can already read", async () => {
      actAs(READER);

      expect((await unretire(fixtureId("live"))).status).toBe(403);
    });

    it("an admin of another org gets the not-found answer, even holding a scope with the same path", async () => {
      const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: ROOT, name: "root" } });
      const otherAdmin = fixtureId("u-bp-other-admin");
      await db.user.create({
        data: {
          id: otherAdmin,
          orgId: OTHER_ORG,
          email: `${otherAdmin}@qa.test`,
          role: "member",
          clerkId: `clerk-${otherAdmin}`,
        },
      });
      await db.grant.create({
        data: {
          orgId: OTHER_ORG,
          scopeId: otherRoot.id,
          granteeType: "user",
          granteeId: otherAdmin,
          permission: "admin",
        },
      });
      actAs(otherAdmin, OTHER_ORG);

      expect(await unretire(fixtureId("unrecorded"))).toEqual({ status: 404, body: { error: "brief not found" } });
      expect(await retired()).toContain(fixtureId("unrecorded"));
    });
  });
});
