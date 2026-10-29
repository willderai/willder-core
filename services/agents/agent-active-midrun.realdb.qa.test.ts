// A run that is already executing stops at its next plan step once its agent is
// deactivated.
//
// agent-active.realdb.test.ts proves a driver refuses a run whose agent is already
// off when it reaches planning. This covers the other half of "a run already under
// way stops at its next step" (services/agents/agent-active.ts): the agent is
// switched off while step 1 of an executing run is working. Step 2 must not run,
// because each step can send real requests to the target and read memory.
//
// The model is replaced by a fake whose first act call flips Agent.active to false
// in the real database, the same write PATCH /api/agents/:id makes.
//
// Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "deactivatedmidrun";
const USER = "u-dmr-admin";

const actPrompts: string[] = [];
let onFirstAct: () => Promise<void> = async () => {};

vi.mock("@/services/agents/runner", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/runner")>()),
  buildMastraAgent: () => ({
    generate: async (prompt: string, opts: { maxSteps?: number; output?: unknown }) => {
      if (opts.output === undefined) {
        actPrompts.push(prompt);
        if (actPrompts.length === 1) await onFirstAct();
        return { text: "observed a 200" };
      }
      return { object: { narration: "step ran" }, text: "" };
    },
  }),
}));

describe.skipIf(!QA_URL)("deactivating an agent while its run is executing, against a real database", () => {
  let db: PrismaClient;
  let runLoop: typeof import("./run-loop");

  async function clearTenant() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    runLoop = await import("./run-loop");
  });

  beforeEach(async () => {
    actPrompts.length = 0;
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    await clearTenant();
    await db.$disconnect();
  });

  it("runs no further plan step after the agent is switched off mid-step", async () => {
    const agent = await db.agent.create({
      data: { orgId: ORG, agentKey: "custom-qa", name: "Custom qa", role: "qa", active: true, tools: ["http_request"] },
    });
    onFirstAct = async () => {
      await db.agent.update({ where: { id: agent.id }, data: { active: false } });
    };
    const runId = await runLoop.createQaInteractiveRun({
      orgId: ORG,
      agentId: agent.id,
      triggeredBy: USER,
      target: { baseUrl: "https://example.com" },
    });
    const items = ["first", "second", "third"].map((title, i) => ({
      id: `item-${i}`,
      kind: "endpoint-probe",
      title: `Probe the ${title} endpoint`,
      status: "pending",
      origin: "agent",
    }));
    await db.agentRun.update({
      where: { id: runId },
      data: { phase: "executing", cursor: 0, plan: { runId, agentRole: "qa", items, revision: 0 } },
    });

    await runLoop.driveRun(runId, ORG);

    expect(actPrompts).toHaveLength(1);
    expect(actPrompts[0]).toContain("first");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.phase).toBe("failed");
  });
});
