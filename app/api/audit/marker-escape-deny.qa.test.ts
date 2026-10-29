// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The forbidden half of the audit-visibility boundary, against a real database.
//
// marker-escape-realdb.qa.test.ts drives both migrated routes
// through the real access.manage evaluator, but only ever as an admin the
// evaluator allows. That proves the permitted operation succeeds; it does not
// prove the gate still refuses anyone. Moving a query from Prisma's typed
// `where` to raw SQL in services/access/audit-query.ts is exactly the change
// that can quietly relocate a filter out from behind its gate, so the deny
// path gets its own real-Postgres assertions here: a member holding only a
// `read` grant (access.manage needs `admin`, services/access/check.ts's
// REQUIRED) must get 403 from both routes, and no audit row may appear in
// either body.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon (item
// routine-sandbox-prod-db-url).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "escdeny1";
const SCOPE = "org_escdeny1.dept_sales";
const ADMIN = "u-deny-admin";
const MEMBER = "u-deny-member";
const READER_AGENT = "qa-agent-deny";

const RUN_START = new Date("2026-09-21T10:00:00Z");
const RUN_END = new Date("2026-09-21T10:05:00Z");
const IN_WINDOW = new Date("2026-09-21T10:02:00Z");

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("the access.manage gate still denies, real Postgres", () => {
  let db: PrismaClient;
  let actorsGET: (typeof import("./actors/route"))["GET"];
  let runAuditGET: (typeof import("@/app/api/agents/[id]/runs/[runId]/audit/route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let agentRowId: string;
  let runId: string;
  let org: { id: string };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET: actorsGET } = await import("./actors/route"));
    ({ GET: runAuditGET } = await import("@/app/api/agents/[id]/runs/[runId]/audit/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });

    org = await db.org.create({ data: { id: ORG, name: "QA deny" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@qa-deny.test", role: "admin", clerkId: "clerk-qa-deny-admin" },
    });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: "member@qa-deny.test", role: "member", clerkId: "clerk-qa-deny-member" },
    });

    const root = await db.scope.create({ data: { orgId: ORG, path: "org_escdeny1", name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    // The member holds a REAL grant, just not an admin one: this is a
    // permission-level denial, not an ungranted-actor denial, so a gate that
    // merely checked "has any grant" would pass it.
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });

    const agent = await db.agent.create({
      data: { orgId: ORG, agentKey: READER_AGENT, name: "QA Deny Reader", role: "qa" },
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

    await db.auditLog.createMany({
      data: [
        {
          orgId: ORG,
          actorType: "human",
          actorId: ADMIN,
          action: "access.manage",
          target: `${SCOPE}/fact_dispute:d_1`,
          decision: "allow",
          at: new Date("2026-09-21T09:00:00Z"),
        },
        {
          orgId: ORG,
          actorType: "agent",
          actorId: READER_AGENT,
          action: "memory.read",
          target: `${SCOPE}/query:pricing`,
          decision: "allow",
          at: IN_WINDOW,
        },
      ],
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  function actAs(userId: string, role: string) {
    requireAccessContext.mockResolvedValue({
      org,
      user: { id: userId, orgId: ORG, role },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role } },
    });
  }

  it("the admin control still passes, so a 403 below is the gate and not a broken fixture", async () => {
    actAs(ADMIN, "admin");
    const actors = await actorsGET();
    expect(actors.status).toBe(200);
    const run = await runAuditGET(new Request("http://t"), {
      params: Promise.resolve({ id: agentRowId, runId }),
    });
    expect(run.status).toBe(200);
  });

  it("GET /api/audit/actors: a read-only member is refused by the real evaluator", async () => {
    actAs(MEMBER, "member");
    const res = await actorsGET();
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("actors");
  });

  it("GET /api/agents/:id/runs/:runId/audit: a read-only member is refused by the real evaluator", async () => {
    actAs(MEMBER, "member");
    const res = await runAuditGET(new Request("http://t"), {
      params: Promise.resolve({ id: agentRowId, runId }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("entries");
  });
});
