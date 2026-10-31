// GET /api/runs/:runId/stream replays a run's persisted events to any member of
// the run's org. It checks the org and nothing else, and the `done` event carries
// the full brief the run produced. So a member whose grant does not reach the
// run's scope reads the brief through the stream that GET /api/briefs/:id would
// refuse them, and a retired brief stays readable here too.
//
// Real Postgres 16 with ltree; authentication and the live run loop are faked.
// Set QA_DATABASE_URL to an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-run-stream";
const ROOT = "org_rs";
const SALES = "org_rs.sales";
const ENG = "org_rs.eng";
const ENG_MEMBER = "u-rs-eng";
const SECRET = "Floor is $160k";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/agents/run-loop", () => ({
  driveRun: vi.fn(async () => {}),
  subscribeRun: vi.fn(() => () => {}),
  isTerminalPhase: (phase: string | null | undefined) => phase === "done" || phase === "failed",
}));

describe.skipIf(!QA_URL)("the run stream and the run's scope", () => {
  let db: PrismaClient;
  let streamGET: (req: Request, ctx: { params: Promise<{ runId: string }> }) => Promise<Response>;

  async function clear() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    for (const table of ["brief", "grant", "scope", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    streamGET = (await import("@/app/api/runs/[runId]/stream/route")).GET;
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ENG_MEMBER },
      ctx: { orgId: ORG, actor: { type: "human", id: ENG_MEMBER, role: "member" } },
    } as never);
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    const eng = await db.scope.create({ data: { orgId: ORG, path: ENG, name: "eng" } });
    await db.user.create({
      data: {
        id: ENG_MEMBER,
        orgId: ORG,
        email: `${ENG_MEMBER}@qa.test`,
        role: "member",
        clerkId: `clerk-${ENG_MEMBER}`,
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: eng.id, granteeType: "user", granteeId: ENG_MEMBER, permission: "read" },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("does not replay a brief at a scope the caller cannot read", async () => {
    await db.brief.create({
      data: {
        id: "rs-sales",
        orgId: ORG,
        type: "handoff",
        scopePath: SALES,
        title: "deal",
        summary: SECRET,
        sections: {},
      },
    });
    const agent = await db.agent.create({ data: { orgId: ORG, agentKey: "handoff", name: "h", role: "handoff" } });
    const run = await db.agentRun.create({
      data: {
        orgId: ORG,
        agentId: agent.id,
        status: "completed",
        phase: "done",
        briefId: "rs-sales",
        meta: { agentRole: "handoff", scopePath: SALES },
      },
    });
    await db.agentRunEvent.create({
      data: {
        runId: run.id,
        seq: 1,
        type: "done",
        payload: { seq: 1, type: "done", briefId: "rs-sales", brief: { summary: SECRET } },
      },
    });

    const briefRead = await (
      await import("@/app/api/briefs/[id]/route")
    ).GET(new Request("http://t"), {
      params: Promise.resolve({ id: "rs-sales" }),
    });
    expect(briefRead.status).not.toBe(200);

    const res = await streamGET(new Request(`http://t/api/runs/${run.id}/stream`), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(await res.text()).not.toContain(SECRET);
  });
});
