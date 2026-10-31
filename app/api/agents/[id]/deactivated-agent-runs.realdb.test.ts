// A deactivated agent does no new work: every route that starts, resumes or
// redirects a run for one refuses with 409, and writes nothing on the way (no run row, no
// capability token). The scheduled sweep already skipped such an agent; these
// routes did not, so switching an agent off stopped only its cron runs.
//
// Each route runs once for an active agent, to show the request reaches its work
// (a run row, or the runner itself), and once for the same agent switched off.
// The agents are custom ones, not the seeded built-ins: custom QA and architecture
// agents read memory under the shared system key, so only their own row can stop
// them (services/agents/agent-active.ts).
//
// Runs the shipping routes against a real Postgres 16 with ltree and the real
// access evaluator. Authentication, the LLM runners and the background drivers
// are mocked. Set QA_DATABASE_URL to an isolated test database (never the
// inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "deactivatedruns"; // ltree-safe, so the org root path is a valid scope
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "u-dar-admin";

/** What every mocked runner throws, so a test can tell "reached the work" from a real failure. */
const REACHED = "runner reached";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/services/agents/run-loop", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/run-loop")>()),
  driveRun: vi.fn(async () => {}),
}));
vi.mock("@/services/agents/manager", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/manager")>()),
  driveManager: vi.fn(async () => {}),
}));
vi.mock("@/services/agents/runner", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/runner")>()),
  runCopyAgent: vi.fn(async () => {
    throw new Error(REACHED);
  }),
  runHandoffAgent: vi.fn(async () => {
    throw new Error(REACHED);
  }),
  runProspectResearch: vi.fn(async () => {
    throw new Error(REACHED);
  }),
}));
vi.mock("@/services/agents/qa-run", () => ({
  runAndPersistQaReview: vi.fn(async () => {
    throw new Error(REACHED);
  }),
}));
vi.mock("@/services/agents/architecture-run", () => ({
  runAndPersistArchitecturePlan: vi.fn(async () => {
    throw new Error(REACHED);
  }),
}));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

type Role = "qa" | "architecture" | "handoff" | "research" | "copy";

/** One start route: the agent role it runs, a valid body, and how to load it. */
interface StartRoute {
  name: string;
  role: Role;
  body: (contactId: string) => unknown;
  load: () => Promise<Handler>;
}

const QA_TARGET = { target: { baseUrl: "https://example.com" } };

const START_ROUTES: StartRoute[] = [
  {
    name: "run",
    role: "copy",
    body: (contactId) => ({ contactId }),
    load: async () => (await import("./run/route")).POST as Handler,
  },
  { name: "qa", role: "qa", body: () => QA_TARGET, load: async () => (await import("./qa/route")).POST as Handler },
  {
    name: "run-interactive",
    role: "qa",
    body: () => QA_TARGET,
    load: async () => (await import("./run-interactive/route")).POST as Handler,
  },
  {
    name: "run-manager",
    role: "qa",
    body: () => QA_TARGET,
    load: async () => (await import("./run-manager/route")).POST as Handler,
  },
  {
    name: "handoff",
    role: "handoff",
    body: () => ({ scopePath: SALES, granteeName: "New hire" }),
    load: async () => (await import("./handoff/route")).POST as Handler,
  },
  {
    name: "architecture",
    role: "architecture",
    body: () => ({ scopePath: SALES }),
    load: async () => (await import("./architecture/route")).POST as Handler,
  },
  {
    name: "plan-interactive",
    role: "architecture",
    body: () => ({ scopePath: SALES, prompt: "plan it" }),
    load: async () => (await import("./plan-interactive/route")).POST as Handler,
  },
  {
    name: "plan-manager",
    role: "architecture",
    body: () => ({ scopePath: SALES, prompt: "plan it" }),
    load: async () => (await import("./plan-manager/route")).POST as Handler,
  },
  {
    name: "prospect",
    role: "research",
    body: () => ({ query: "acme.com" }),
    load: async () => (await import("./prospect/route")).POST as Handler,
  },
];

describe.skipIf(!QA_URL)("a deactivated agent's runs, against a real database", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let contactId = "";

  async function clearTenant() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const table of ["capability", "contact", "agent", "auditLog", "brief", "grant", "scope", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  /** Call a handler, reporting a mocked runner's throw as "reached" instead of failing the test. */
  async function call(handler: Handler, url: string, body: unknown, params: Record<string, string>) {
    try {
      const res = await handler(new Request(url, { method: "POST", body: JSON.stringify(body) }), {
        params: Promise.resolve(params),
      });
      await res.body?.cancel();
      return res.status;
    } catch (e) {
      if (e instanceof Error && e.message === REACHED) return "reached" as const;
      throw e;
    }
  }

  /** Everything a run leaves behind in this org: run rows and capability tokens. */
  async function footprint() {
    const [runs, capabilities] = await Promise.all([
      db.agentRun.count({ where: { orgId: ORG } }),
      db.capability.count({ where: { orgId: ORG } }),
    ]);
    return { runs, capabilities };
  }

  /** How many times any mocked runner was called. */
  async function runnersCalled() {
    const runner = await import("@/services/agents/runner");
    const qaRun = await import("@/services/agents/qa-run");
    const architectureRun = await import("@/services/agents/architecture-run");
    return [
      runner.runCopyAgent,
      runner.runHandoffAgent,
      runner.runProspectResearch,
      qaRun.runAndPersistQaReview,
      architectureRun.runAndPersistArchitecturePlan,
    ].reduce((sum, fn) => sum + vi.mocked(fn).mock.calls.length, 0);
  }

  const createAgent = (role: Role) =>
    db.agent.create({ data: { orgId: ORG, agentKey: `custom-${role}`, name: `Custom ${role}`, role } });

  const deactivate = (agentId: string) => db.agent.update({ where: { id: agentId }, data: { active: false } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("QA_MANAGER", "true");
    vi.stubEnv("ARCH_MANAGER", "true");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = (await import("@/lib/access-context")).requireAccessContext as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const rootScope = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@qa.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: rootScope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    contactId = (await db.contact.create({ data: { orgId: ORG, name: "Ada Prospect" } })).id;
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "api" },
    } as never);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await clearTenant();
    await db.$disconnect();
  });

  describe.each(START_ROUTES)("POST /api/agents/:id/$name", ({ name, role, body, load }) => {
    it("reaches its work while the agent is active", async () => {
      const agent = await createAgent(role);
      const status = await call(await load(), `http://t/api/agents/${agent.id}/${name}`, body(contactId), {
        id: agent.id,
      });

      // The request reached its work: a mocked runner was called, or a run row was
      // created and handed to the mocked background driver.
      expect(status).not.toBe(409);
      expect((await runnersCalled()) > 0 || (await footprint()).runs > 0).toBe(true);
    });

    it("refuses with 409 once the agent is deactivated, and starts nothing", async () => {
      const agent = await createAgent(role);
      await deactivate(agent.id);

      const res = await (
        await load()
      )(
        new Request(`http://t/api/agents/${agent.id}/${name}`, {
          method: "POST",
          body: JSON.stringify(body(contactId)),
        }),
        { params: Promise.resolve({ id: agent.id }) },
      );

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/deactivated.*reactivate/);
      expect(await footprint()).toEqual({ runs: 0, capabilities: 0 });
    });
  });

  describe("resuming or following up a run of a deactivated agent", () => {
    let replyPOST: Handler;
    let answerPOST: Handler;
    let editPOST: Handler;

    beforeAll(async () => {
      replyPOST = (await import("@/app/api/runs/[runId]/reply/route")).POST as Handler;
      answerPOST = (await import("@/app/api/runs/[runId]/answer/route")).POST as Handler;
      editPOST = (await import("@/app/api/runs/[runId]/edit/route")).POST as Handler;
    });

    /** A run of `agentId` in `phase`, scoped to SALES so the admin can read it. */
    const createRun = (agentId: string, phase: string) =>
      db.agentRun.create({
        data: {
          orgId: ORG,
          agentId,
          status: phase === "done" ? "completed" : "running",
          phase,
          triggeredBy: ADMIN,
          meta: {
            type: "qa-interactive",
            agentRole: "qa",
            scopePath: SALES,
            target: { baseUrl: "https://example.com" },
          },
        },
      });

    const reply = (runId: string) =>
      replyPOST(
        new Request(`http://t/api/runs/${runId}/reply`, { method: "POST", body: JSON.stringify({ message: "again" }) }),
        {
          params: Promise.resolve({ runId }),
        },
      );
    const answer = (runId: string) =>
      answerPOST(
        new Request(`http://t/api/runs/${runId}/answer`, {
          method: "POST",
          body: JSON.stringify({ checkpointId: "cp-1", answers: [] }),
        }),
        { params: Promise.resolve({ runId }) },
      );

    it("starts a follow-up run for an active agent, and refuses one for a deactivated agent", async () => {
      const agent = await createAgent("qa");
      const finished = await createRun(agent.id, "done");

      expect((await reply(finished.id)).status).toBe(201);
      expect(await db.agentRun.count({ where: { orgId: ORG } })).toBe(2);

      await deactivate(agent.id);
      const res = await reply(finished.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/deactivated/);
      expect(await db.agentRun.count({ where: { orgId: ORG } })).toBe(2);
    });

    it("refuses to resume a paused run once its agent is deactivated, leaving the run as it was", async () => {
      const agent = await createAgent("qa");
      const paused = await createRun(agent.id, "paused");
      await deactivate(agent.id);

      const res = await answer(paused.id);

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/deactivated/);
      expect((await db.agentRun.findUniqueOrThrow({ where: { id: paused.id } })).phase).toBe("paused");
    });

    it("refuses to rerun a step of a run once its agent is deactivated, reserving no edit", async () => {
      const agent = await createAgent("qa");
      const run = await createRun(agent.id, "executing");
      await deactivate(agent.id);

      const res = await editPOST(
        new Request(`http://t/api/runs/${run.id}/edit`, {
          method: "POST",
          body: JSON.stringify({ editId: "e-1", baseRevision: 0, rerun: { itemId: "i-1", feedback: "again" } }),
        }),
        { params: Promise.resolve({ runId: run.id }) },
      );

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/deactivated/);
      expect((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).appliedEditIds).toEqual([]);
    });

    it("still answers a run whose agent is active, past the gate", async () => {
      const agent = await createAgent("qa");
      const paused = await createRun(agent.id, "paused");

      // No open checkpoint, so resumeRun reports the payload invalid: the request
      // got past the agent gate to the resume itself.
      expect((await answer(paused.id)).status).not.toBe(409);
    });
  });
});
