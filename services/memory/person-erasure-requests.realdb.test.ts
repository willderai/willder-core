// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An erasure asked for over HTTP (services/memory/person-erasure-requests.ts): recorded,
// run by its job at most once, and forgotten once it is done or failed.
//
// Real: Postgres, check() against live grants, the audit log, the erasure itself. Stand-in:
// the graph store, a spy whose failure can be injected; what the erasure removes is proven
// in person-erasure.realdb.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphErase = vi.fn();
const graphPlan = vi.fn();
vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...a),
    erasePerson: (...a: unknown[]) => graphErase(...a),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_erasure_requests";
const OTHER_ORG = "qa_erasure_requests_other";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_requests_admin";
const MEMBER = "qa_erasure_requests_member";
const OTHER_ADMIN = "qa_erasure_requests_other_admin";
const EMAIL = "rhea.okafor@acme.example";
const NAME = "Rhea Okafor";

describe.skipIf(!QA_URL)("person erasure requests: accepted at once, finished at most once, then forgotten", () => {
  let db: PrismaClient;
  let svc: typeof import("./person-erasure-requests");

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const member: AccessContext = { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" }, origin: "app" };
  const otherAdmin: AccessContext = {
    orgId: OTHER_ORG,
    actor: { type: "human", id: OTHER_ADMIN, role: "admin" },
    origin: "app",
  };
  const queued: string[] = [];
  const queue = async (id: string) => void queued.push(id);
  const erasedRows = (requestId: string) =>
    db.auditLog.findMany({
      where: { orgId: ORG, action: "person.erased", target: { endsWith: `/person_erasure:${requestId}` } },
    });
  const failedRows = (requestId: string) =>
    db.auditLog.findMany({
      where: { orgId: ORG, action: "person.erasure_failed", target: { endsWith: `/person_erasure:${requestId}` } },
    });

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.personErasureRequest.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.contact.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    svc = await import("./person-erasure-requests");
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    queued.length = 0;
    graphPlan.mockReset().mockResolvedValue([]);
    graphErase.mockReset().mockResolvedValue({ episodes: 1, nodes: 2, edges: 3, summaries: 1, episodeIds: [] });
    await wipe();
    for (const [orgId, adminId] of [
      [ORG, ADMIN],
      [OTHER_ORG, OTHER_ADMIN],
    ] as const) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
      const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
      await db.user.create({
        data: { id: adminId, orgId, email: `${adminId}@erasure.test`, role: "admin", clerkId: `clerk-${adminId}` },
      });
      await db.grant.create({
        data: { orgId, scopeId: root.id, granteeType: "user", granteeId: adminId, permission: "admin" },
      });
    }
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    await db.user.create({
      data: {
        id: MEMBER,
        orgId: ORG,
        email: "member@erasure.test",
        role: "member",
        clerkId: "clerk-erasure-requests-member",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: MEMBER, permission: "write" },
    });
    await db.contact.create({ data: { id: "rhea", orgId: ORG, name: NAME, email: EMAIL } });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath")
      VALUES ('rhea-note', ${ORG}, ${`${NAME} (${EMAIL}) wants the annual plan.`}, 'text', 'agent', ${ROOT})`;
  });

  it("records the request, runs it once, reports the person.erased row's counts and forgets the person", async () => {
    const accepted = await svc.requestPersonErasure(admin, { email: EMAIL.toUpperCase() }, queue);
    expect(accepted.status).toBe("running");
    expect(queued).toEqual([accepted.requestId]);
    // Nothing is erased until the job runs, and the row holds the person only so it can.
    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(1);
    expect(await db.personErasureRequest.findUniqueOrThrow({ where: { id: accepted.requestId } })).toMatchObject({
      status: "running",
      identifierKind: "email",
      identifierValue: EMAIL,
      requestedBy: ADMIN,
    });
    expect(await svc.personErasureStatus(admin, accepted.requestId)).toEqual({
      requestId: accepted.requestId,
      status: "running",
    });

    const done = await svc.runPersonErasureRequest(accepted.requestId);

    expect(done).toMatchObject({ status: "done", requestId: accepted.requestId, contactsRemoved: 1, chunksRemoved: 1 });
    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(0);
    const row = await db.personErasureRequest.findUniqueOrThrow({ where: { id: accepted.requestId } });
    expect(row).toMatchObject({ status: "done", identifierKind: null, identifierValue: null, error: null });
    expect(JSON.stringify(row).toLowerCase()).not.toContain("rhea");
    const audit = await erasedRows(accepted.requestId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(ADMIN);
    expect(await svc.personErasureStatus(admin, accepted.requestId)).toEqual(done);

    // The job delivered again finds it done: no second erasure, no second row.
    expect(await svc.runPersonErasureRequest(accepted.requestId)).toBeNull();
    expect(graphErase).toHaveBeenCalledOnce();
    expect(await erasedRows(accepted.requestId)).toHaveLength(1);
  });

  it("two runs of one request at once end in one person.erased row", async () => {
    const { requestId } = await svc.requestPersonErasure(admin, { contactId: "rhea" }, queue);

    const runs = await Promise.allSettled([
      svc.runPersonErasureRequest(requestId),
      svc.runPersonErasureRequest(requestId),
    ]);

    expect(runs.filter((r) => r.status === "fulfilled" && r.value?.status === "done")).toHaveLength(1);
    expect(await erasedRows(requestId)).toHaveLength(1);
    expect((await db.personErasureRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("done");
  });

  it("a graph failure leaves the request running and retryable; failing it forgets the person", async () => {
    const { requestId } = await svc.requestPersonErasure(admin, { contactId: "rhea" }, queue);
    graphErase.mockRejectedValueOnce(new Error("graph down"));

    await expect(svc.runPersonErasureRequest(requestId)).rejects.toThrow("graph down");
    expect(await db.personErasureRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: "running",
      identifierKind: "contactId",
      identifierValue: "rhea",
    });

    expect(await svc.failPersonErasureRequest(requestId, "The erasure did not finish.")).toBe(true);
    expect(await svc.failPersonErasureRequest(requestId, "again")).toBe(false);

    expect(await db.personErasureRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: "failed",
      identifierKind: null,
      identifierValue: null,
      error: "The erasure did not finish.",
    });
    // One audit row per failed request, as the requester, naming the request and never the person.
    const failed = await failedRows(requestId);
    expect(failed.map((r) => ({ actorId: r.actorId, metadata: r.metadata }))).toEqual([
      { actorId: ADMIN, metadata: { requestId, error: "The erasure did not finish.", origin: "app" } },
    ]);
    expect(await svc.personErasureStatus(admin, requestId)).toEqual({
      requestId,
      status: "failed",
      error: "The erasure did not finish.",
    });
    expect(await svc.runPersonErasureRequest(requestId)).toBeNull();
    // A failure never overwrites a finished request.
    const second = await svc.requestPersonErasure(admin, { contactId: "rhea" }, queue);
    await svc.runPersonErasureRequest(second.requestId);
    expect(await svc.failPersonErasureRequest(second.requestId, "late")).toBe(false);
    expect((await db.personErasureRequest.findUniqueOrThrow({ where: { id: second.requestId } })).status).toBe("done");
    expect(await failedRows(second.requestId)).toEqual([]);
  });

  it("a retry of a request for a person with no contact row still counts what the dying attempt removed", async () => {
    await db.contact.deleteMany({ where: { orgId: ORG } });
    const { requestId } = await svc.requestPersonErasure(admin, { email: EMAIL }, queue);
    const { runPersonErasure } = await import("./person-erasure");
    // Attempt 1 removes the chunk, then dies in its last transaction.
    await expect(
      runPersonErasure(admin, { requestId, identifier: { email: EMAIL } }, async () => {
        throw new Error("killed in the last transaction");
      }),
    ).rejects.toThrow("killed");

    const retried = await svc.runPersonErasureRequest(requestId);

    expect(retried).toMatchObject({ status: "done", chunksRemoved: 1 });
    expect(await erasedRows(requestId)).toHaveLength(1);
  });

  it("a job that cannot be queued fails the request at once and keeps nothing of the person", async () => {
    await expect(
      svc.requestPersonErasure(admin, { contactId: "rhea" }, async () => {
        throw new Error("queue down");
      }),
    ).rejects.toBeInstanceOf(svc.ErasureNotQueuedError);

    const [row] = await db.personErasureRequest.findMany({ where: { orgId: ORG } });
    expect(row).toMatchObject({ status: "failed", identifierKind: null, identifierValue: null });
    expect(await failedRows(row!.id)).toHaveLength(1);
    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(1);
  });

  describe("the sweep of requests whose job never finished", () => {
    const NOW = new Date("2026-10-18T12:00:00.000Z");
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    const STUCK = () => svc.STUCK_AFTER_MS;
    // Each row as the sweep finds it, and what one pass leaves of it.
    const rows = () =>
      [
        {
          id: "11111111-1111-4111-8111-000000000001",
          label: "running, just asked",
          status: "running",
          createdAt: ago(STUCK() - 1000),
          retriedAt: null,
          after: "running",
        },
        {
          id: "11111111-1111-4111-8111-000000000002",
          label: "running past the bound, never retried",
          status: "running",
          createdAt: ago(STUCK()),
          retriedAt: null,
          after: "retried",
        },
        {
          id: "11111111-1111-4111-8111-000000000003",
          label: "retried, past the bound again",
          status: "running",
          createdAt: ago(3 * STUCK()),
          retriedAt: ago(STUCK()),
          after: "failed",
        },
        {
          id: "11111111-1111-4111-8111-000000000004",
          label: "retried, within the bound",
          status: "running",
          createdAt: ago(3 * STUCK()),
          retriedAt: ago(STUCK() - 1000),
          after: "running",
        },
        {
          id: "11111111-1111-4111-8111-000000000005",
          label: "done long ago",
          status: "done",
          createdAt: ago(9 * STUCK()),
          retriedAt: null,
          after: "done",
        },
        {
          id: "11111111-1111-4111-8111-000000000006",
          label: "failed long ago",
          status: "failed",
          createdAt: ago(9 * STUCK()),
          retriedAt: ago(8 * STUCK()),
          after: "failed-before",
        },
      ] as const;

    async function seed() {
      for (const r of rows()) {
        const running = r.status === "running";
        await db.personErasureRequest.create({
          data: {
            id: r.id,
            orgId: ORG,
            requestedBy: ADMIN,
            requesterRole: "admin",
            origin: "app",
            status: r.status,
            identifierKind: running ? "email" : null,
            identifierValue: running ? EMAIL : null,
            createdAt: r.createdAt,
            retriedAt: r.retriedAt,
          },
        });
      }
    }

    it("retries a request once past the bound, fails it past the bound again, and leaves every other row as it was", async () => {
      await seed();
      vi.spyOn(console, "error").mockImplementation(() => {});

      const pass = await svc.sweepStuckPersonErasures(queue, NOW);

      const expected = rows();
      expect(pass).toEqual({
        retried: expected.filter((r) => r.after === "retried").map((r) => r.id),
        failed: expected.filter((r) => r.after === "failed").map((r) => r.id),
      });
      expect(queued).toEqual(pass.retried);
      for (const r of expected) {
        const row = await db.personErasureRequest.findUniqueOrThrow({ where: { id: r.id } });
        const keeps = r.after === "running" || r.after === "retried";
        expect({
          label: r.label,
          status: row.status,
          identifier: row.identifierValue,
          failedRows: (await failedRows(r.id)).length,
        }).toEqual({
          label: r.label,
          status: keeps ? "running" : r.after === "done" ? "done" : "failed",
          identifier: keeps ? EMAIL : null,
          failedRows: r.after === "failed" ? 1 : 0,
        });
        if (r.after === "failed") expect(row.error).toMatch(/Send the same request again/);
      }

      // The next pass at the same time queues nothing again; one a bound later fails the retried row.
      expect(await svc.sweepStuckPersonErasures(queue, NOW)).toEqual({ retried: [], failed: [] });
      const later = await svc.sweepStuckPersonErasures(queue, new Date(NOW.getTime() + STUCK()));
      expect(later.failed).toContain(expected[1].id);
      expect(queued).toEqual(pass.retried.concat(expected[0].id));
    });

    it("fails a request at once when its retry cannot be queued", async () => {
      await seed();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const stuck = rows()[1].id;

      const pass = await svc.sweepStuckPersonErasures(async () => {
        throw new Error("queue down");
      }, NOW);

      expect(pass.retried).toEqual([]);
      expect(pass.failed).toContain(stuck);
      expect(await db.personErasureRequest.findUniqueOrThrow({ where: { id: stuck } })).toMatchObject({
        status: "failed",
        identifierValue: null,
        retriedAt: null,
      });
    });
  });

  it.each([
    ["a member without access.manage", member, { contactId: "rhea" }, "AccessDeniedError"],
    [
      "an agent",
      { orgId: ORG, actor: { type: "agent", id: "a1", capabilityToken: "wcap_x" }, origin: "mcp" } as AccessContext,
      { contactId: "rhea" },
      "PersonErasureError",
    ],
    ["a malformed identifier", admin, { email: "not an address" }, "PersonErasureError"],
  ])("refuses %s before recording anything", async (_label, ctx, identifier, errorName) => {
    await expect(svc.requestPersonErasure(ctx, identifier, queue)).rejects.toMatchObject({ name: errorName });
    expect(await db.personErasureRequest.count({ where: { orgId: ORG } })).toBe(0);
    expect(queued).toEqual([]);
  });

  it("another org's request, an unknown id and a malformed one read the same, and a member may not read one", async () => {
    const { requestId } = await svc.requestPersonErasure(admin, { contactId: "rhea" }, queue);

    expect(await svc.personErasureStatus(otherAdmin, requestId)).toBeNull();
    expect(await svc.personErasureStatus(admin, "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f")).toBeNull();
    expect(await svc.personErasureStatus(admin, "../../etc")).toBeNull();
    await expect(svc.personErasureStatus(member, requestId)).rejects.toMatchObject({ name: "AccessDeniedError" });
  });
});
