// A run already under way stops once its agent is deactivated.
//
// Starting a run is refused at the route (app/api/agents/[id]/deactivated-agent-runs
// .realdb.test.ts). A run started before the switch, or re-driven later by a
// reconnecting stream, goes through one of three drivers instead: the interactive
// loop, the QA manager and the architecture manager. Each reloads the agent row
// before it plans, and this proves each one fails the run there, naming the cause,
// before it builds an agent or creates a child run. The agents are custom ones,
// whose memory token is the shared system key's, so only their own row can stop them.
//
// Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "deactivateddrive";
const SALES = `org_${ORG}.sales`;
const USER = "u-dad-admin";

describe.skipIf(!QA_URL)("driving a run whose agent was deactivated, against a real database", () => {
  let db: PrismaClient;
  let runLoop: typeof import("./run-loop");
  let manager: typeof import("./manager");
  let managerArch: typeof import("./manager-arch");

  async function clearTenant() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  async function deactivatedAgent(role: "qa" | "architecture") {
    return db.agent.create({
      data: { orgId: ORG, agentKey: `custom-${role}`, name: `Custom ${role}`, role, active: false },
    });
  }

  /** The run's phase, its error events, and how many runs exist in the org. */
  async function outcome(runId: string) {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    const errors = await db.agentRunEvent.findMany({ where: { runId, type: "error" } });
    return {
      phase: run.phase,
      errors: errors.map((e) => (e.payload as { message: string }).message),
      runsInOrg: await db.agentRun.count({ where: { orgId: ORG } }),
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    runLoop = await import("./run-loop");
    manager = await import("./manager");
    managerArch = await import("./manager-arch");
  });

  beforeEach(async () => {
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    await clearTenant();
    await db.$disconnect();
  });

  it("fails an interactive QA run at planning", async () => {
    const agent = await deactivatedAgent("qa");
    const runId = await runLoop.createQaInteractiveRun({
      orgId: ORG,
      agentId: agent.id,
      triggeredBy: USER,
      target: { baseUrl: "https://example.com" },
      scopePath: SALES,
    });

    await runLoop.driveRun(runId, ORG);

    expect(await outcome(runId)).toEqual({
      phase: "failed",
      errors: [expect.stringMatching(/deactivated/)],
      runsInOrg: 1,
    });
  });

  it("fails an interactive architecture run at planning", async () => {
    const agent = await deactivatedAgent("architecture");
    const runId = await runLoop.createArchInteractiveRun({
      orgId: ORG,
      agentId: agent.id,
      triggeredBy: USER,
      scopePath: SALES,
      prompt: "plan it",
    });

    await runLoop.driveRun(runId, ORG);

    expect(await outcome(runId)).toEqual({
      phase: "failed",
      errors: [expect.stringMatching(/deactivated/)],
      runsInOrg: 1,
    });
  });

  it("fails a QA manager run before it plans any child", async () => {
    const agent = await deactivatedAgent("qa");
    const runId = await manager.createQaManagerRun({
      orgId: ORG,
      agentId: agent.id,
      triggeredBy: USER,
      target: { baseUrl: "https://example.com" },
      scopePath: SALES,
    });

    await manager.driveManager(runId);

    expect(await outcome(runId)).toEqual({
      phase: "failed",
      errors: [expect.stringMatching(/deactivated/)],
      runsInOrg: 1,
    });
  });

  it("fails an architecture manager run before it creates any child", async () => {
    const agent = await deactivatedAgent("architecture");
    const runId = await managerArch.createArchManagerRun({
      orgId: ORG,
      agentId: agent.id,
      triggeredBy: USER,
      scopePath: SALES,
      prompt: "plan it",
    });

    await manager.driveManager(runId);

    expect(await outcome(runId)).toEqual({
      phase: "failed",
      errors: [expect.stringMatching(/deactivated/)],
      runsInOrg: 1,
    });
  });
});
