// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Marker escaping in the audit visibility rule, against a real database.
//
// The mocked companion (audit-visibility-escape.test.ts) decodes the patterns
// these routes bind with a LIKE interpreter. That is fast and it cannot echo
// the encoder's bugs, but it is still this repo deciding what a pattern means.
// Whether `%fact\_dispute:%` ESCAPE '\' really excludes `factXdispute:` is
// decided by Postgres, so this file drives the REAL handlers against a REAL
// Postgres 16 with ltree, through the real access.manage check(), and asserts
// on the rows the database actually returns -- the same standard
// scope-containment-realdb.qa.test.ts sets.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "esc1";
const OTHER_ORG = "esc2";
const SCOPE = "org_esc1.dept_sales";
const ADMIN = "u-admin-escape";
// NB: ORG/OTHER_ORG must be ltree-label-safe ([A-Za-z0-9_]): the org root scope
// is orgRootPath(orgId) = `org_${orgId}`, so a hyphen in the id makes that path
// unparseable as an ltree and every access.manage check() denies with 403.

const RESOLVER = "u-real-resolver";
const IMPOSTOR = "u-wildcard-impostor";
const PROBER = "u-probe-only";
const READER_AGENT = "qa-agent-escape";

const RUN_START = new Date("2026-09-21T10:00:00Z");
const RUN_END = new Date("2026-09-21T10:05:00Z");
const IN_WINDOW = new Date("2026-09-21T10:02:00Z");

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("audit visibility marker escaping, real Postgres", () => {
  let db: PrismaClient;
  let actorsGET: (typeof import("./actors/route"))["GET"];
  let runAuditGET: (typeof import("@/app/api/agents/[id]/runs/[runId]/audit/route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let agentRowId: string;
  let runId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET: actorsGET } = await import("./actors/route"));
    ({ GET: runAuditGET } = await import("@/app/api/agents/[id]/runs/[runId]/audit/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    // Also clear by explicit id: an earlier run may have seeded these rows
    // under a different org id, and a delete keyed only on orgId would miss
    // them, then fail on the unique id (see the same note in
    // scope-containment-realdb.qa.test.ts).
    await db.user.deleteMany({ where: { id: { in: [ADMIN, RESOLVER, IMPOSTOR, PROBER] } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.grant.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.scope.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.agentRun.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.agent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.user.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });

    await db.org.create({ data: { id: ORG, name: "QA escape" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "QA escape other" } });

    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@qa-escape.test", role: "admin", clerkId: "clerk-qa-escape" },
    });
    // Real grants, so the routes' own access.manage check() genuinely ALLOWS
    // via the shipping authorization evaluator rather than a mock.
    const root = await db.scope.create({ data: { orgId: ORG, path: "org_esc1", name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    // The named actors, so the picker can resolve display names for real.
    for (const [id, email] of [
      [RESOLVER, "resolver@qa-escape.test"],
      [IMPOSTOR, "impostor@qa-escape.test"],
      [PROBER, "prober@qa-escape.test"],
    ] as const) {
      await db.user.create({
        data: { id, orgId: ORG, email, role: "member", clerkId: `clerk-${id}` },
      });
    }

    const agent = await db.agent.create({
      data: { orgId: ORG, agentKey: READER_AGENT, name: "QA Reader", role: "qa" },
    });
    agentRowId = agent.id;
    const run = await db.agentRun.create({
      data: {
        orgId: ORG,
        agentId: agent.id,
        status: "completed",
        triggeredBy: ADMIN,
        startedAt: RUN_START,
        finishedAt: RUN_END,
      },
    });
    runId = run.id;

    const at = new Date("2026-09-21T09:00:00Z");
    await db.auditLog.createMany({
      data: [
        // A real dispute resolution: visible, so this actor belongs in the picker.
        {
          orgId: ORG,
          actorType: "human",
          actorId: RESOLVER,
          action: "access.manage",
          target: `${SCOPE}/fact_dispute:d_9`,
          decision: "allow",
          at,
        },
        // THE DEFECT'S INSTANCE: differs from the marker only at the `_`, which
        // is a LIKE wildcard. Under an unescaped pattern Postgres reads this as
        // a dispute resolution.
        {
          orgId: ORG,
          actorType: "human",
          actorId: IMPOSTOR,
          action: "access.manage",
          target: `${SCOPE}/factXdispute:d_9`,
          decision: "allow",
          at,
        },
        // A probe/list read: the noise the visibility rule exists to hide.
        {
          orgId: ORG,
          actorType: "human",
          actorId: PROBER,
          action: "access.manage",
          target: `${SCOPE}/fact_disputes`,
          decision: "allow",
          at,
        },
        // Cross-tenant control: byte-identical to the visible row above.
        {
          orgId: OTHER_ORG,
          actorType: "human",
          actorId: "u-other-org",
          action: "access.manage",
          target: `${SCOPE}/fact_dispute:d_9`,
          decision: "allow",
          at,
        },

        // The run's own trail. memory.* is always visible.
        {
          orgId: ORG,
          actorType: "agent",
          actorId: READER_AGENT,
          action: "memory.read",
          target: `${SCOPE}/query:pricing`,
          decision: "allow",
          at: IN_WINDOW,
        },
        // Agent-written access.manage rows. No shipping call site produces these
        // -- every access.manage check runs under a human session, so this
        // route's `actorType = 'agent'` filter already excludes the marker
        // question. Seeded directly so the predicate itself is still exercised
        // end to end: the escape has to be correct on its own, not because a
        // different filter happens to cover for it.
        {
          orgId: ORG,
          actorType: "agent",
          actorId: READER_AGENT,
          action: "access.manage",
          target: `${SCOPE}/fact_dispute:d_11`,
          decision: "allow",
          at: IN_WINDOW,
        },
        {
          orgId: ORG,
          actorType: "agent",
          actorId: READER_AGENT,
          action: "access.manage",
          target: `${SCOPE}/factXdispute:d_11`,
          decision: "allow",
          at: IN_WINDOW,
        },
        {
          orgId: ORG,
          actorType: "agent",
          actorId: READER_AGENT,
          action: "access.manage",
          target: `${SCOPE}/fact_disputes`,
          decision: "allow",
          at: IN_WINDOW,
        },
      ],
    });

    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe("GET /api/audit/actors", () => {
    async function actorIds(): Promise<string[]> {
      const res = await actorsGET();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { actors: { actorId: string }[] };
      return body.actors.map((a) => a.actorId);
    }

    it("the permitted read succeeds at all (the evaluator really allows this admin)", async () => {
      expect((await actorIds()).length).toBeGreaterThan(0);
    });

    it("lists an actor whose visible activity is a real dispute resolution", async () => {
      expect(await actorIds()).toContain(RESOLVER);
    });

    it("lists an actor seen through an always-visible memory action", async () => {
      expect(await actorIds()).toContain(READER_AGENT);
    });

    it("EXCLUDES an actor seen only through access.manage probe/list reads", async () => {
      expect(await actorIds()).not.toContain(PROBER);
    });

    it("EXCLUDES another tenant's actor with a byte-identical target", async () => {
      expect(await actorIds()).not.toContain("u-other-org");
    });

    // THE GUARD. Dropping escapeLikePrefix()/ESCAPE from visibleAuditRowSql(),
    // or putting this route back on Prisma's typed `contains`, discloses this
    // actor in the admin identity picker as though they had resolved a dispute.
    it("EXCLUDES an actor whose marker is only a LIKE-wildcard sibling of a real one", async () => {
      expect(await actorIds()).not.toContain(IMPOSTOR);
    });
  });

  describe("GET /api/agents/:id/runs/:runId/audit", () => {
    async function runTargets(): Promise<string[]> {
      const res = await runAuditGET(new Request("http://t"), {
        params: Promise.resolve({ id: agentRowId, runId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: { target: string }[] };
      return body.entries.map((e) => e.target);
    }

    it("returns the run's own always-visible memory activity", async () => {
      expect(await runTargets()).toContain(`${SCOPE}/query:pricing`);
    });

    it("shows a real mutation marker on an agent-written access.manage row", async () => {
      expect(await runTargets()).toContain(`${SCOPE}/fact_dispute:d_11`);
    });

    it("EXCLUDES an agent-written access.manage probe/list read", async () => {
      expect(await runTargets()).not.toContain(`${SCOPE}/fact_disputes`);
    });

    // THE GUARD, on the second consumer.
    it("EXCLUDES an agent-written marker that is only a LIKE-wildcard sibling of a real one", async () => {
      expect(await runTargets()).not.toContain(`${SCOPE}/factXdispute:d_11`);
    });
  });
});
