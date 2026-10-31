import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// A run whose driver died between steps (a timeout, a crash, a redeploy) keeps
// `status = running` for good unless something else ends it. Production had four
// such runs, started months earlier, still counted on the nav badge as work in
// progress. This suite seeds runs of every shape that matters, with real
// timestamps on real rows, and checks the two halves of the rule in
// abandoned-runs.ts: the badge count leaves abandoned runs out, and the sweep
// fails exactly those runs and nothing else.
//
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgAbandonedRuns";
const ROOT = `org_${ORG}`;
const AGENT = "agentAbandonedRuns";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One seeded run: its phase and status, when it started, and when its events were written. */
interface RunCase {
  phase: string | null;
  status?: "running" | "completed" | "failed";
  startedAgo: number;
  eventsAgo?: number[];
  parent?: string;
}

const CASES: Record<string, RunCase> = {
  // The production shape: a one-shot run started long ago that never finished.
  oneshot_dead: { phase: null, startedAgo: 80 * DAY },
  working_dead: { phase: "executing", startedAgo: 3 * HOUR, eventsAgo: [3 * HOUR, 2 * HOUR] },
  working_recent_event: { phase: "executing", startedAgo: 3 * HOUR, eventsAgo: [3 * HOUR, 10 * MINUTE] },
  working_just_started: { phase: "planning", startedAgo: 5 * MINUTE },
  paused_two_days: { phase: "paused", startedAgo: 2 * DAY, eventsAgo: [2 * DAY] },
  paused_eight_days: { phase: "paused", startedAgo: 8 * DAY, eventsAgo: [8 * DAY] },
  // A manager parent writes nothing itself while its children work.
  parent_busy_child: { phase: "executing", startedAgo: 3 * HOUR, eventsAgo: [3 * HOUR] },
  child_busy: { phase: "executing", startedAgo: 2 * HOUR, eventsAgo: [5 * MINUTE], parent: "parent_busy_child" },
  // A parent waits as long as a child of it waits on a person.
  parent_waiting_child: { phase: "executing", startedAgo: 3 * DAY, eventsAgo: [3 * DAY] },
  child_waiting: { phase: "paused", startedAgo: 2 * DAY, eventsAgo: [2 * DAY], parent: "parent_waiting_child" },
  // Finished runs are never touched, however old.
  completed_old: { phase: "done", status: "completed", startedAgo: 90 * DAY },
};

const ABANDONED = ["oneshot_dead", "paused_eight_days", "working_dead"];
const LIVE = [
  "child_busy",
  "child_waiting",
  "parent_busy_child",
  "parent_waiting_child",
  "paused_two_days",
  "working_just_started",
  "working_recent_event",
];

describe.skipIf(!QA_URL)("abandoned agent runs", { timeout: 30_000 }, () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let countVisibleRunningRuns: (typeof import("./run-visibility"))["countVisibleRunningRuns"];
  let failAbandonedRuns: (typeof import("./abandoned-runs"))["failAbandonedRuns"];

  const statusOf = async () => {
    const rows = await db.agentRun.findMany({
      where: { orgId: ORG },
      select: { id: true, status: true, phase: true, finishedAt: true },
    });
    return Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]));
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ countVisibleRunningRuns } = await import("./run-visibility"));
    ({ failAbandonedRuns } = await import("./abandoned-runs"));
    await db.$executeRawUnsafe(
      `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
      ORG,
    );
  }, 60_000);

  beforeEach(async () => {
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.agent.create({ data: { id: AGENT, orgId: ORG, agentKey: "qa-agent", name: "QA", role: "qa" } });
    const now = Date.now();
    for (const [id, run] of Object.entries(CASES)) {
      await db.agentRun.create({
        data: {
          id,
          orgId: ORG,
          agentId: AGENT,
          status: run.status ?? "running",
          phase: run.phase,
          meta: run.parent ? { parentRunId: run.parent } : {},
          startedAt: new Date(now - run.startedAgo),
          ...(run.status ? { finishedAt: new Date(now - run.startedAgo + MINUTE) } : {}),
        },
      });
      for (const [seq, ago] of (run.eventsAgo ?? []).entries()) {
        await db.agentRunEvent.create({
          data: { runId: id, seq, type: "phase", payload: { type: "phase" }, createdAt: new Date(now - ago) },
        });
      }
    }
  });

  afterAll(async () => {
    await db?.agentRun.deleteMany({ where: { orgId: ORG } });
    await db?.agent.deleteMany({ where: { orgId: ORG } });
    if (db) await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db?.$disconnect?.();
  });

  it("the nav badge counts live runs and leaves abandoned ones out", async () => {
    expect(await countVisibleRunningRuns(ORG, [ROOT])).toBe(LIVE.length);
  });

  it("the sweep fails exactly the abandoned runs and says why on each one", async () => {
    const before = Date.now();
    const failed = await failAbandonedRuns();

    expect(
      failed
        .filter((r) => r.orgId === ORG)
        .map((r) => r.runId)
        .sort(),
    ).toEqual(ABANDONED);
    const rows = await statusOf();
    for (const id of ABANDONED) {
      expect(rows[id]).toMatchObject({ status: "failed", phase: "failed" });
      expect(rows[id].finishedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const events = await db.agentRunEvent.findMany({ where: { runId: id }, orderBy: { seq: "asc" } });
      expect(events.slice(-2).map((e: { payload: unknown }) => e.payload)).toEqual([
        expect.objectContaining({ type: "error", message: expect.stringContaining("stopped responding") }),
        expect.objectContaining({ type: "phase", phase: "failed" }),
      ]);
    }
    for (const id of LIVE) expect(rows[id].status).toBe("running");
    expect(rows.completed_old).toMatchObject({ status: "completed", phase: "done" });

    // Nothing left to fail: a second sweep changes nothing, and the badge is unchanged.
    expect((await failAbandonedRuns()).filter((r) => r.orgId === ORG)).toEqual([]);
    expect(await countVisibleRunningRuns(ORG, [ROOT])).toBe(LIVE.length);
  });
});
