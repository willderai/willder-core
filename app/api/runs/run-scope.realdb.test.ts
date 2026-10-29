// The run routes (GET /api/runs/:runId, POST answer, edit and reply, the per-agent
// list GET /api/agents/:id/runs and the runs embedded in GET /api/agents/:id) show or steer a run only for a caller who
// can read the run's scope and the scope of the brief it produced. Anyone else in the
// org gets exactly what a run id that was never issued gets, and no response carries
// the QA target's stored credential. The agent list and detail count, and show as the
// last run, only runs the caller can read.
//
// Runs the shipping routes against a real Postgres 16 with ltree and the real access
// evaluator: two tenants, two sibling scopes, a revoked grant. Authentication and the
// run and manager loops are mocked. Set QA_DATABASE_URL to an isolated test database
// (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "runscope"; // ltree-safe, so the org root path is a valid scope
const OTHER_ORG = "runscopeother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ENG = `${ROOT}.eng`;
const ABSENT_RUN = "run-never-issued";
const SECRET_PROMPT = "Renewal floor is $160k";
const CREDENTIAL = "Bearer qa-target-secret";

const SALES_READER = "u-rs-sales";
const ENG_READER = "u-rs-eng";
const ROOT_READER = "u-rs-root";
const REVOKED = "u-rs-revoked"; // held read on sales, expired
const OUTSIDER = "u-rs-outsider"; // member of the other org

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));
// The loop's own answer for an id it cannot find, as the real resumeRun/applyPlanEdit give it.
vi.mock("@/services/agents/run-loop", () => {
  const settle = (result: object) => async (runId: string) =>
    runId === "run-never-issued" ? { status: "invalid", error: "run not found" } : result;
  return {
    resumeRun: vi.fn(settle({ status: "noop" })),
    driveRun: vi.fn(async () => {}),
    applyPlanEdit: vi.fn(settle({ status: "noop", plan: {} })),
    rerunPlanItem: vi.fn(settle({ status: "noop", plan: {} })),
  };
});
vi.mock("@/services/agents/manager", () => ({
  createQaManagerRun: vi.fn(async () => "run-follow-up"),
  createArchManagerRun: vi.fn(async () => "run-follow-up"),
  driveManager: vi.fn(async () => {}),
}));

type RunHandler = (req: Request, ctx: { params: Promise<{ runId: string }> }) => Promise<Response>;
type AgentHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

describe.skipIf(!QA_URL)("run routes only serve a caller who can read the run's scope", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let routes: {
    get: RunHandler;
    answer: RunHandler;
    edit: RunHandler;
    reply: RunHandler;
    list: AgentHandler;
    detail: AgentHandler;
    agents: () => Promise<Response>;
  };
  let agentId: string;

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  const bodies: Record<"get" | "answer" | "edit" | "reply", unknown> = {
    get: undefined,
    answer: { checkpointId: "c1", answers: [] },
    edit: { editId: "e1", baseRevision: 0, ops: [{ op: "skip", itemId: "i1" }] },
    reply: { message: "again" },
  };

  async function call(route: keyof typeof bodies, runId: string) {
    const body = bodies[route];
    const req = new Request(`http://t/api/runs/${runId}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await routes[route](req, { params: Promise.resolve({ runId }) });
    return { status: res.status, body: await res.text() };
  }

  async function list() {
    const res = await routes.list(new Request(`http://t/api/agents/${agentId}/runs`), {
      params: Promise.resolve({ id: agentId }),
    });
    return (await res.json()) as { runs: { id: string }[] };
  }

  async function detail() {
    const res = await routes.detail(new Request(`http://t/api/agents/${agentId}`), {
      params: Promise.resolve({ id: agentId }),
    });
    return (await res.json()) as { agent: { runs: { id: string }[]; _count: { runs: number } } };
  }

  /** This test's agent as GET /api/agents lists it: its run count and last run. */
  async function listedAgent() {
    const res = await routes.agents();
    const { agents } = (await res.json()) as {
      agents: { id: string; _count: { runs: number }; runs: { id: string; status: string }[] }[];
    };
    return agents.find((agent) => agent.id === agentId);
  }

  /** The caller gets a 404 identical to the one for a run id that was never issued. */
  async function expectHidden(route: keyof typeof bodies, runId: string) {
    const hidden = await call(route, runId);
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(await call(route, ABSENT_RUN));
    expect(hidden.body).not.toContain(SECRET_PROMPT);
  }

  /** A finished QA run at `runScope` (scope-less when undefined) whose brief is stored at `briefScope`. */
  async function finishedRun(runScope: string | undefined, briefScope = runScope ?? ROOT) {
    const brief = await db.brief.create({
      data: { orgId: ORG, type: "qa_review", scopePath: briefScope, title: "result", summary: "s", sections: {} },
    });
    const meta = {
      agentRole: "qa",
      prompt: SECRET_PROMPT,
      target: { baseUrl: "https://example.com", authHeader: CREDENTIAL },
      ...(runScope === undefined ? {} : { scopePath: runScope }),
    };
    const run = await db.agentRun.create({
      data: { orgId: ORG, agentId, status: "completed", phase: "done", briefId: brief.id, meta },
    });
    return run.id;
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.agentRunEvent.deleteMany({ where: { run: { orgId: org } } });
      await db.agentRun.deleteMany({ where: { orgId: org } });
      for (const t of ["agent", "auditLog", "brief", "grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    routes = {
      get: (await import("@/app/api/runs/[runId]/route")).GET,
      answer: (await import("@/app/api/runs/[runId]/answer/route")).POST,
      edit: (await import("@/app/api/runs/[runId]/edit/route")).POST,
      reply: (await import("@/app/api/runs/[runId]/reply/route")).POST,
      list: (await import("@/app/api/agents/[id]/runs/route")).GET,
      detail: (await import("@/app/api/agents/[id]/route")).GET,
      agents: (await import("@/app/api/agents/route")).GET,
    };
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    const eng = await db.scope.create({ data: { orgId: ORG, path: ENG, name: "eng" } });
    const grants: [string, string, Date | null][] = [
      [SALES_READER, sales.id, null],
      [ENG_READER, eng.id, null],
      [ROOT_READER, root.id, null],
      [REVOKED, sales.id, new Date(Date.now() - 60_000)],
    ];
    for (const [userId, scopeId, expiresAt] of grants) {
      await db.user.create({
        data: { id: userId, orgId: ORG, email: `${userId}@qa.test`, role: "member", clerkId: `c-${userId}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId, granteeType: "user", granteeId: userId, permission: "read", expiresAt },
      });
    }
    await db.user.create({
      data: { id: OUTSIDER, orgId: OTHER_ORG, email: `${OUTSIDER}@qa.test`, role: "member", clerkId: `c-${OUTSIDER}` },
    });
    agentId = (await db.agent.create({ data: { orgId: ORG, agentKey: "qa", name: "qa", role: "qa" } })).id;
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  const steering = ["get", "answer", "edit", "reply"] as const;

  it.each(steering)("%s: a reader of the run's scope is served", async (route) => {
    const runId = await finishedRun(SALES);
    actAs(ORG, SALES_READER);
    const res = await call(route, runId);
    expect(res.status).toBeLessThan(300);
  });

  it.each(steering)("%s: a sibling-scope reader gets exactly the absent-run answer", async (route) => {
    const runId = await finishedRun(SALES);
    actAs(ORG, ENG_READER);
    await expectHidden(route, runId);
  });

  it.each(steering)("%s: a member whose grant expired gets the absent-run answer", async (route) => {
    const runId = await finishedRun(SALES);
    actAs(ORG, REVOKED);
    await expectHidden(route, runId);
  });

  it.each(steering)("%s: a member of another org gets the absent-run answer", async (route) => {
    const runId = await finishedRun(SALES);
    actAs(OTHER_ORG, OUTSIDER);
    await expectHidden(route, runId);
  });

  it.each(steering)("%s: a scope-less run needs read on the org root", async (route) => {
    const runId = await finishedRun(undefined);
    actAs(ORG, SALES_READER);
    await expectHidden(route, runId);
    actAs(ORG, ROOT_READER);
    expect((await call(route, runId)).status).toBeLessThan(300);
  });

  it.each(steering)("%s: a run whose brief sits above the caller's scope is hidden", async (route) => {
    const runId = await finishedRun(SALES, ROOT);
    actAs(ORG, SALES_READER);
    await expectHidden(route, runId);
  });

  it("reply on a hidden run creates no follow-up run", async () => {
    const { createQaManagerRun } = await import("@/services/agents/manager");
    vi.mocked(createQaManagerRun).mockClear();
    const runId = await finishedRun(undefined);
    actAs(ORG, SALES_READER);
    await call("reply", runId);
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("GET never returns the QA target's credential", async () => {
    const runId = await finishedRun(SALES);
    actAs(ORG, SALES_READER);
    const res = await call("get", runId);
    expect(res.body).toContain("https://example.com");
    expect(res.body).not.toContain(CREDENTIAL);
  });

  it("the agent's run list holds only runs the caller can read, without credentials", async () => {
    const sales = await finishedRun(SALES);
    const eng = await finishedRun(ENG);
    const scopeless = await finishedRun(undefined);

    actAs(ORG, SALES_READER);
    const salesView = await list();
    expect(salesView.runs.map((r) => r.id)).toEqual([sales]);

    actAs(ORG, ROOT_READER);
    const rootView = await list();
    expect(rootView.runs.map((r) => r.id).sort()).toEqual([sales, eng, scopeless].sort());
    expect(JSON.stringify(rootView)).not.toContain(CREDENTIAL);

    actAs(ORG, REVOKED);
    expect((await list()).runs).toEqual([]);
  });

  it("the agent detail embeds only runs the caller can read", async () => {
    const sales = await finishedRun(SALES);
    const eng = await finishedRun(ENG);
    const scopeless = await finishedRun(undefined);

    actAs(ORG, SALES_READER);
    const salesView = await detail();
    expect(salesView.agent.runs.map((r) => r.id)).toEqual([sales]);

    actAs(ORG, ROOT_READER);
    expect((await detail()).agent.runs.map((r) => r.id).sort()).toEqual([sales, eng, scopeless].sort());

    actAs(ORG, REVOKED);
    expect((await detail()).agent.runs).toEqual([]);
  });

  it("the agent detail never returns the QA target's credential", async () => {
    await finishedRun(SALES);
    actAs(ORG, SALES_READER);
    const body = JSON.stringify(await detail());
    expect(body).toContain("https://example.com");
    expect(body).not.toContain(CREDENTIAL);
  });

  it("the agent detail counts only runs the caller can read", async () => {
    await finishedRun(SALES);
    await finishedRun(ENG);
    await finishedRun(undefined);

    actAs(ORG, SALES_READER);
    expect((await detail()).agent._count.runs).toBe(1);
    actAs(ORG, ROOT_READER);
    expect((await detail()).agent._count.runs).toBe(3);
    actAs(ORG, REVOKED);
    expect((await detail()).agent._count.runs).toBe(0);
  });

  it("the agent list counts only runs the caller can read", async () => {
    await finishedRun(SALES);
    await finishedRun(ENG);
    await finishedRun(undefined);

    actAs(ORG, SALES_READER);
    expect((await listedAgent())?._count.runs).toBe(1);
    actAs(ORG, ROOT_READER);
    expect((await listedAgent())?._count.runs).toBe(3);
    actAs(ORG, REVOKED);
    expect((await listedAgent())?._count.runs).toBe(0);
  });

  it("the agent list's last run is the newest run the caller can read", async () => {
    const sales = await finishedRun(SALES);
    await db.agentRun.update({ where: { id: sales }, data: { startedAt: new Date(Date.now() - 60_000) } });
    const eng = await finishedRun(ENG);
    await db.agentRun.update({ where: { id: eng }, data: { status: "failed" } });

    actAs(ORG, SALES_READER);
    expect((await listedAgent())?.runs).toEqual([expect.objectContaining({ id: sales, status: "completed" })]);
    actAs(ORG, ENG_READER);
    expect((await listedAgent())?.runs).toEqual([expect.objectContaining({ id: eng, status: "failed" })]);
    actAs(ORG, REVOKED);
    expect((await listedAgent())?.runs).toEqual([]);
  });

  it("the agent list's last run is the newest when the caller can read several", async () => {
    const older = await finishedRun(SALES);
    await db.agentRun.update({ where: { id: older }, data: { startedAt: new Date(Date.now() - 60_000) } });
    const newer = await finishedRun(ENG);

    actAs(ORG, ROOT_READER);
    expect((await listedAgent())?.runs).toEqual([expect.objectContaining({ id: newer })]);
  });

  it("a run whose stored scope is not a valid path is counted for no one", async () => {
    await db.agentRun.create({
      data: { orgId: ORG, agentId, status: "completed", meta: { scopePath: "not a path!" } },
    });
    actAs(ORG, ROOT_READER);
    expect((await listedAgent())?._count.runs).toBe(0);
    expect((await listedAgent())?.runs).toEqual([]);
  });
});
