// An architecture run that is already executing stops at its next plan step once
// its agent is deactivated.
//
// agent-active-midrun.realdb.qa.test.ts proves this for the QA executor. The
// architecture executor walks its plan in its own loop (doArchExecuting), so it
// carries its own per-step check and needs its own proof: each of its steps reads
// memory under the shared system key, which a switched-off agent must stop doing.
//
// The model is replaced by a fake whose first reasoning call flips Agent.active to
// false in the real database, the same write PATCH /api/agents/:id makes.
//
// Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "deactivatedmidrunarch";
const SALES = `org_${ORG}.sales`;
const USER = "u-dmra-admin";

const reasonPrompts: string[] = [];
let onFirstReason: () => Promise<void> = async () => {};

vi.mock("@/services/agents/runner", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/runner")>()),
  buildMastraAgent: () => ({
    generate: async (prompt: string, opts: { maxSteps?: number; output?: unknown }) => {
      if (opts.output === undefined) {
        reasonPrompts.push(prompt);
        if (reasonPrompts.length === 1) await onFirstReason();
        return { text: "reasoned over the retrieved decisions" };
      }
      return { object: { narration: "step ran" }, text: "" };
    },
  }),
}));

describe.skipIf(!QA_URL)(
  "deactivating an architecture agent while its run is executing, against a real database",
  () => {
    let db: PrismaClient;
    let runLoop: typeof import("./run-loop");

    async function clearTenant() {
      await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
      await db.agentRun.deleteMany({ where: { orgId: ORG } });
      await db.capability.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { id: USER } });
      await db.agent.deleteMany({ where: { orgId: ORG } });
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      runLoop = await import("./run-loop");
    });

    beforeEach(async () => {
      reasonPrompts.length = 0;
      await clearTenant();
      await db.org.create({ data: { id: ORG, name: ORG } });
      // The run's token is issued by USER and is never wider than them, so USER
      // administers the org.
      await db.user.create({
        data: { id: USER, orgId: ORG, email: `${USER}@dmra.test`, role: "admin", clerkId: `clerk-${USER}` },
      });
      const root = await db.scope.create({ data: { orgId: ORG, path: `org_${ORG}`, name: "root" } });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: USER, permission: "admin" },
      });
    });

    afterAll(async () => {
      await clearTenant();
      await db.$disconnect();
    });

    it("runs no further plan step after the agent is switched off mid-step", async () => {
      const agent = await db.agent.create({
        data: {
          orgId: ORG,
          agentKey: "custom-architecture",
          name: "Custom architecture",
          role: "architecture",
          active: true,
          tools: ["memory_read"],
        },
      });
      onFirstReason = async () => {
        await db.agent.update({ where: { id: agent.id }, data: { active: false } });
      };
      const runId = await runLoop.createArchInteractiveRun({
        orgId: ORG,
        agentId: agent.id,
        triggeredBy: USER,
        scopePath: SALES,
        prompt: "plan the billing service",
      });
      const items = ["first", "second", "third"].map((title, i) => ({
        id: `item-${i}`,
        kind: "decision",
        title: `Reason about the ${title} domain`,
        status: "pending",
        origin: "agent",
      }));
      await db.agentRun.update({
        where: { id: runId },
        data: { phase: "executing", cursor: 0, plan: { runId, agentRole: "architecture", items, revision: 0 } },
      });

      await runLoop.driveRun(runId, ORG);

      expect(reasonPrompts).toHaveLength(1);
      expect(reasonPrompts[0]).toContain("first");
      const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.phase).toBe("failed");
      const errors = await db.agentRunEvent.findMany({ where: { runId, type: "error" } });
      expect(errors.map((e) => (e.payload as { message: string }).message)).toEqual([
        expect.stringMatching(/deactivated/),
      ]);
    });
  },
);
