// The cron and fan-out jobs that are not an ingest: the Neo4j keep-alive, the
// nightly architecture sweep, the abandoned-run sweep, the owed graph extractions, the
// task-start log's retention, and one QA manager child run. Each imports its
// agent code dynamically inside the handler, on purpose — a top-level import
// would deepen the known runner/tools/lib-inngest module-load cycle.
import { inngest } from "./client";

// --- Neo4j Aura keep-alive (free tier pauses after 3 days of inactivity) ----------
// Runs a trivial RETURN 1 query every day so AuraDB never pauses.

export const neo4jKeepAlive = inngest.createFunction(
  {
    id: "neo4j-keep-alive",
    name: "Neo4j: keep-alive ping",
    triggers: [{ cron: "0 10 * * *" }], // 10:00 UTC daily
  },
  async ({ step }) => {
    return await step.run("ping", async () => {
      const neo4j = await import("neo4j-driver");
      const driver = neo4j.default.driver(
        process.env.NEO4J_URI!,
        neo4j.default.auth.basic(process.env.NEO4J_USERNAME ?? "neo4j", process.env.NEO4J_PASSWORD!),
      );
      try {
        const session = driver.session();
        const result = await session.run("RETURN 1 AS alive");
        await session.close();
        return { alive: result.records[0]?.get("alive") === 1 };
      } finally {
        await driver.close();
      }
    });
  },
);

// --- UC10: Architecture agent nightly contradiction sweep ---------------------
// Proactive-agent trigger. Each night, every architecture agent whose owner opted in
// (Agent.settings.cron.enabled + a watch scope, set via PATCH /api/agents/:id — no new
// endpoint, per docs/willder_api.md) runs over its configured scope and files disputes
// for any new contradictions among the confirmed facts there. Runs detached, so it
// reads memory as the ARCHITECTURE AGENT via a system-provisioned capability scoped to
// exactly the configured watch scope (never wider) — same access boundary as its manual runs. One
// agent's failure is logged and skipped, never sinks the batch.

export const architectureNightly = inngest.createFunction(
  {
    id: "architecture-nightly",
    name: "Architecture: nightly contradiction sweep",
    triggers: [{ cron: "0 8 * * *" }], // 08:00 UTC daily (before the Neo4j keep-alive)
  },
  async ({ step }) => {
    // Dynamic imports: these modules pull in services/agents/runner, which participates
    // in a module-load cycle with services/agents/tools ↔ lib/inngest. Importing them at
    // runtime (not top-level) keeps this file out of that cycle so route bundles that
    // transitively import lib/inngest don't trip it. Same reason the keep-alive imports
    // neo4j-driver lazily.
    const { selectCronArchitectureAgents } = await import("@/services/agents/cron");
    const { provisionArchitectureAgentCapability } = await import("@/lib/architecture-agent");
    const { runAndPersistArchitecturePlan } = await import("@/services/agents/architecture-run");

    const agents = await step.run("select-cron-agents", () => selectCronArchitectureAgents());

    const results: { agentId: string; ok: boolean; briefId?: string; disputes?: number; error?: string }[] = [];
    for (const a of agents) {
      results.push(
        await step.run(`run-${a.id}`, async () => {
          try {
            // No person starts a scheduled sweep, so the token says it was issued by the
            // system rather than naming one (services/access/capabilities.ts).
            const token = await provisionArchitectureAgentCapability(a.orgId, a.scope, "system:cron");
            const { brief, disputeIds } = await runAndPersistArchitecturePlan({
              agentRow: a.agentRow,
              agentId: a.id,
              orgId: a.orgId,
              scopePath: a.scope,
              capabilityToken: token,
              title: "Nightly contradiction sweep",
            });
            return { agentId: a.id, ok: true, briefId: brief.id, disputes: disputeIds.length };
          } catch (e) {
            return { agentId: a.id, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
    }
    return { swept: results.length, results };
  },
);

// --- QA supervisor/manager: child run ------------------------------------------
// The manager (services/agents/manager.ts, flag-gated QA_MANAGER) decomposes a QA task
// and dispatches depth-1 CHILD runs. A child is a normal QA AgentRun row (meta.parentRunId
// set) that runs the ordinary interactive QA loop in autopilot. This job just drives one
// child to completion; run-loop's driveRun records the child's own RunEvents. The manager
// polls the child AgentRun.status and aggregates once it's terminal. Children never spawn
// grandchildren (depth capped at 1 — only the manager ever creates child rows).
//
// driveRun is imported DYNAMICALLY inside the function body on purpose: services/agents/
// run-loop → runner participates in the known runner↔tools↔lib/inngest module-load cycle,
// so a top-level import here would deepen it. Same defensive
// pattern as architectureNightly + the neo4j keep-alive.

export const QA_MANAGER_CHILD_EVENT = "qa/manager.child.requested";

export interface QaManagerChildInput {
  /** The child AgentRun id the manager already created (meta.parentRunId points back). */
  childRunId: string;
  /** The parent run's org; the child is created in the same org and driven only there. */
  orgId: string;
}

export const qaManagerChildRun = inngest.createFunction(
  {
    id: "qa-manager-child-run",
    name: "QA manager: drive one child run",
    retries: 1,
    triggers: [{ event: QA_MANAGER_CHILD_EVENT }],
    concurrency: { limit: 5 },
  },
  async ({ event, step }) => {
    const input = event.data as QaManagerChildInput;
    await step.run("drive-child", async () => {
      const { driveRun } = await import("@/services/agents/run-loop");
      await driveRun(input.childRunId, input.orgId);
      return { childRunId: input.childRunId };
    });
    return { childRunId: input.childRunId };
  },
);

// --- Abandoned agent runs ------------------------------------------------------------
// A run whose driver died between steps stays `running` until something ends it. This
// sweep fails every run services/agents/abandoned-runs.ts calls abandoned, so the run
// list and the run itself say what happened. The nav badge already leaves such runs
// out, so the sweep's cadence decides only how soon a run's own status catches up.

export const abandonedRunSweep = inngest.createFunction(
  {
    id: "abandoned-run-sweep",
    name: "Agents: fail abandoned runs",
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const failed = await step.run("fail-abandoned-runs", async () => {
      const { failAbandonedRuns } = await import("@/services/agents/abandoned-runs");
      return failAbandonedRuns();
    });
    return { failed: failed.length };
  },
);

// --- Owed graph extractions ------------------------------------------------------------
// A version stored on the request path whose graph extraction failed after the reply has a
// row in graph_extraction_retries (services/memory/graph-extraction-retry.ts). This pass
// attempts the ones that are due, every ten minutes, so a provider outage delays the
// graph instead of losing it.

export const graphExtractionRetry = inngest.createFunction(
  {
    id: "graph-extraction-retry",
    name: "Memory: retry owed graph extractions",
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async ({ step }) =>
    step.run("retry-due-extractions", async () => {
      const { retryDeferredGraphExtractions } = await import("@/services/memory/graph-extraction-retry");
      const { runMemoryIngest } = await import("./memory-ingest");
      return retryDeferredGraphExtractions(runMemoryIngest);
    }),
);

// --- Task-start served-vs-used log retention ------------------------------------------
// The log of what each task-start block served and which items a session then used is kept
// TASK_START_LOG_RETENTION_DAYS days (services/memory/task-start-served.ts). This deletes
// what is older, in every org, once a day, and with it the delivery rows of sessions idle
// for a day, except each agent's newest, which still says when it last called
// (services/memory/task-start.ts).

export const taskStartLogRetention = inngest.createFunction(
  {
    id: "task-start-log-retention",
    name: "Task start: prune the served-vs-used log and idle deliveries",
    triggers: [{ cron: "30 9 * * *" }], // 09:30 UTC daily
  },
  async ({ step }) => {
    const log = await step.run("prune", async () => {
      const { pruneTaskStartLog } = await import("@/services/memory/task-start-served");
      return pruneTaskStartLog();
    });
    const idleDeliveries = await step.run("prune-idle-deliveries", async () => {
      const { pruneIdleTaskStartDeliveries } = await import("@/services/memory/task-start");
      return pruneIdleTaskStartDeliveries();
    });
    return { ...log, idleDeliveries };
  },
);
