import { beforeEach, describe, expect, it, vi } from "vitest";

// route.suppression.test.ts pins the withheld-vs-genuinely-empty contract, but
// its fixture's agent under view is the builtin copy-role agent, whose own
// agentKey literally IS COPY_AGENT_ID. That is only ONE of the three ways
// `actorId` resolves to COPY_AGENT_ID (see resolveActorId in route.ts):
//
//   1. the builtin copy-role agent itself      — agentKey === COPY_AGENT_ID
//   2. ANY custom agent (role === "custom")    — agentKey === "custom-<ts>"
//   3. any non-research agent's test-run       — agentKey === "handoff-agent", …
//
// The cross-agent probe exists because cases 2 and 3 make DIFFERENT real agents
// share one actorId, so audit rows queried by actorId alone can merge a
// different agent's memory reads into this run's trail. That is the leak.
//
// But two runs of the SAME real agent are not that. `agents` is
// `@@unique([orgId, agentKey])` and the probe's query is org-scoped, so within
// that query agentKey identifies the real agent exactly: a candidate whose
// agentKey equals the run's own agentKey IS this same agent, and sameAgentOverlap
// already reports it honestly as a caveat over entries that stay shown.
//
// Excluding such a candidate only when BOTH sides are literally the copy agent
// covers case 1 alone. In cases 2 and 3 a second run of the very same agent
// would still count as a cross-agent collision, blank `entries`, and set
// `entriesSuppressed`, telling the user their trail is being withheld to protect
// another agent's data when the only overlapping run is the agent's own and the
// run genuinely touched nothing: the same false-confidence defect
// route.suppression.test.ts pins, in the cases its fixture does not reach.
//
// Fixture discipline matches route.crossagentidentity.test.ts: the fake
// findFirst/findMany honour the route's own where-clause, and each run's own
// `agent` row is the ground truth for who really ran it.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({ check: vi.fn() }));
vi.mock("@/services/access/audit-query", () => ({ queryRunAuditEntries: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agentRun: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findFirst: vi.fn() },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { queryRunAuditEntries } from "@/services/access/audit-query";
import { GET } from "./route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const params = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });

const startedAt = new Date("2026-08-31T10:00:00Z");
const finishedAt = new Date("2026-08-31T10:05:00Z");

type AgentRow = { id: string; agentKey: string; role: string };

// Two genuinely different custom agents. Both resolve to COPY_AGENT_ID (every
// custom agent's run goes through runCopyAgent), which is exactly why the
// cross-agent probe has to exist — and exactly why it must not fire on two runs
// of ONE of them.
const CUSTOM_A: AgentRow = { id: "agent_custom_a", agentKey: "custom-1756600000000", role: "custom" };
const CUSTOM_B: AgentRow = { id: "agent_custom_b", agentKey: "custom-1756600009999", role: "custom" };

// A builtin non-research agent. Its own real runs resolve to its own agentKey,
// but a test-run (meta.type === "test-run") goes through runCopyAgent and is
// stamped COPY_AGENT_ID — case 3 above.
const HANDOFF: AgentRow = { id: "agent_handoff", agentKey: "handoff-agent", role: "handoff" };

type RunRow = {
  id: string;
  agentId: string;
  agent: AgentRow;
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  meta?: Record<string, unknown>;
};

let RUNS: RunRow[] = [];
let AGENT_UNDER_VIEW: AgentRow = CUSTOM_A;

function filterRuns(where: Record<string, unknown>): RunRow[] {
  const idFilter = where.id as string | { not?: string } | undefined;
  return RUNS.filter((r) => {
    if (typeof idFilter === "string" && r.id !== idFilter) return false;
    if (idFilter && typeof idFilter === "object" && idFilter.not === r.id) return false;
    if (where.agentId && r.agentId !== where.agentId) return false;
    const startedFilter = where.startedAt as { lte?: Date } | undefined;
    if (startedFilter?.lte && r.startedAt > startedFilter.lte) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) {
      const gte = (
        or.find((c) => c.finishedAt && typeof c.finishedAt === "object") as { finishedAt: { gte: Date } } | undefined
      )?.finishedAt.gte;
      const ok = r.finishedAt === null || (gte ? r.finishedAt >= gte : true);
      if (!ok) return false;
    }
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.agent.findFirst).mockImplementation((async () => AGENT_UNDER_VIEW) as never);
  vi.mocked(db.agentRun.findFirst).mockImplementation(
    (async (args: { where: Record<string, unknown> }) => filterRuns(args.where)[0] ?? null) as never,
  );
  // Each candidate reports its OWN agent identity, not the viewed run's.
  vi.mocked(db.agentRun.findMany).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    filterRuns(args.where).map((r) => ({
      meta: r.meta ?? {},
      agent: { agentKey: r.agent.agentKey, role: r.agent.role },
    }))) as never);
  // Every run under view here genuinely touched no memory at all.
  vi.mocked(queryRunAuditEntries).mockResolvedValue([]);
});

describe("same-agent overlap must not read as suppression for any agent that resolves to COPY_AGENT_ID", () => {
  it("a custom agent overlapped only by ANOTHER RUN OF ITSELF withheld nothing", async () => {
    AGENT_UNDER_VIEW = CUSTOM_A;
    RUNS = [
      { id: "run_1", agentId: CUSTOM_A.id, agent: CUSTOM_A, triggeredBy: "user_alice", startedAt, finishedAt },
      { id: "run_2", agentId: CUSTOM_A.id, agent: CUSTOM_A, triggeredBy: "user_bob", startedAt, finishedAt },
    ];

    const res = await GET(new Request("http://t/x"), params(CUSTOM_A.id, "run_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toEqual([]);

    // The overlap is real, so the caveat is right to be on.
    expect(body.possibleOverlap).toBe(true);

    // But the only overlapping run belongs to this very agent. Nothing was
    // withheld to protect anyone else, and the run really is empty.
    expect(body.entriesSuppressed).toBe(false);
  });

  it("a builtin agent's test-run overlapped only by another run of itself withheld nothing", async () => {
    AGENT_UNDER_VIEW = HANDOFF;
    const testRun = { type: "test-run" };
    RUNS = [
      {
        id: "run_1",
        agentId: HANDOFF.id,
        agent: HANDOFF,
        triggeredBy: "user_alice",
        startedAt,
        finishedAt,
        meta: testRun,
      },
      {
        id: "run_2",
        agentId: HANDOFF.id,
        agent: HANDOFF,
        triggeredBy: "user_bob",
        startedAt,
        finishedAt,
        meta: testRun,
      },
    ];

    const res = await GET(new Request("http://t/x"), params(HANDOFF.id, "run_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.possibleOverlap).toBe(true);
    expect(body.entriesSuppressed).toBe(false);
  });

  // Positive control: the probe must still fire on a genuinely different agent
  // sharing the actorId. Without this, "exclude same-agent candidates" could be
  // over-widened into "never suppress anything" and this file would still pass
  // while the real leak went unguarded.
  it("still suppresses when a DIFFERENT custom agent's run shares the actorId", async () => {
    AGENT_UNDER_VIEW = CUSTOM_A;
    RUNS = [
      { id: "run_1", agentId: CUSTOM_A.id, agent: CUSTOM_A, triggeredBy: "user_alice", startedAt, finishedAt },
      { id: "run_2", agentId: CUSTOM_B.id, agent: CUSTOM_B, triggeredBy: "user_bob", startedAt, finishedAt },
    ];

    const res = await GET(new Request("http://t/x"), params(CUSTOM_A.id, "run_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entriesSuppressed).toBe(true);
    expect(body.possibleOverlap).toBe(true);
    expect(body.entries).toEqual([]);
  });
});
