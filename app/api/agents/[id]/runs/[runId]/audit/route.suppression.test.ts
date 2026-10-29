import { beforeEach, describe, expect, it, vi } from "vitest";

// The response must distinguish "entries were withheld" from "entries are
// genuinely empty"; `possibleOverlap` alone cannot.
//
// The route blanks `entries` to [] ONLY when crossAgentOverlap is true (a
// DIFFERENT agent's run sharing this run's actorId — the real leak risk).
// It never blanks on sameAgentOverlap alone: another run of the SAME agent
// shares this run's actorId, so its rows are legitimately this agent's own
// activity and are deliberately left merged in.
//
// `possibleOverlap: !!sameAgentOverlap || !!crossAgentOverlap` collapses both
// into one boolean. A UI that renders its "Can't show this trail right now …
// This run may not really be empty" copy on `possibleOverlap &&
// entries.length === 0` would report a run that genuinely touched no memory,
// while another run of the same agent merely overlapped its window, as
// SUPPRESSED when nothing was suppressed at all. Overstating ambiguity is the
// same false-confidence defect as understating it, so the response carries a
// separate `entriesSuppressed` field; without it no correct UI can be written.
//
// Same fixture discipline as route.crossagentidentity.test.ts — the fake
// findFirst/findMany apply the route's own where-clause honestly, and the
// fixture's per-run `agent` identity is the ground truth.

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
import { COPY_AGENT_ID } from "@/lib/copy-agent";
import { GET } from "./route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const params = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });

const startedAt = new Date("2026-08-31T10:00:00Z");
const finishedAt = new Date("2026-08-31T10:05:00Z");

// The agent under view is the builtin copy-role agent itself, so its own
// agentKey already IS COPY_AGENT_ID — actorId resolves to COPY_AGENT_ID and
// the crossAgentOverlap probe is therefore live (it only runs in that case).
const AGENT = { id: "agent_copy", agentKey: COPY_AGENT_ID, role: "copy" };

type RunRow = {
  id: string;
  agentId: string;
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  meta?: Record<string, unknown>;
};

// run_1 is the run under view. run_2 is ANOTHER run of the SAME agent whose
// window overlaps it — this is sameAgentOverlap, not a cross-agent collision:
// both are the same agent, so nothing here is a leak risk and the route does
// NOT blank entries for it.
const RUNS: RunRow[] = [
  { id: "run_1", agentId: "agent_copy", triggeredBy: "user_alice", startedAt, finishedAt },
  { id: "run_2", agentId: "agent_copy", triggeredBy: "user_bob", startedAt, finishedAt },
];

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
  vi.mocked(db.agent.findFirst).mockResolvedValue(AGENT as never);
  vi.mocked(db.agentRun.findFirst).mockImplementation(
    (async (args: { where: Record<string, unknown> }) => filterRuns(args.where)[0] ?? null) as never,
  );
  // Every candidate run here belongs to the copy-role agent, whose agentKey
  // IS COPY_AGENT_ID — but the cross-agent probe excludes the run under view
  // by id, and run_2 is the SAME agent, so this is same-agent ambiguity.
  vi.mocked(db.agentRun.findMany).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    filterRuns(args.where).map((r) => ({
      meta: r.meta ?? {},
      agent: { agentKey: AGENT.agentKey, role: AGENT.role },
    }))) as never);
  // The run under view genuinely touched no memory at all.
  vi.mocked(queryRunAuditEntries).mockResolvedValue([]);
});

describe("a genuinely empty trail must not be reported as a suppressed one", () => {
  it("distinguishes 'entries withheld' from 'run really touched no memory'", async () => {
    const res = await GET(new Request("http://t/x"), params("agent_copy", "run_1"));
    const body = await res.json();

    expect(res.status).toBe(200);

    // Ground truth for this fixture: the run under view read nothing, and the
    // only overlapping run is another run of the SAME agent. Nothing was
    // withheld — there was nothing to withhold.
    expect(body.entries).toEqual([]);

    // The route is right to flag ambiguity: another run of this agent
    // overlapped, so a non-empty trail here could have contained its rows.
    expect(body.possibleOverlap).toBe(true);

    // ...but a UI keyed only on `possibleOverlap && entries.length === 0` would
    // render its "Can't show this trail right now … This run may not really be
    // empty" copy on this response, and that claim is false here. The response
    // must say whether entries were actually withheld.
    expect(body.entriesSuppressed).toBe(false);
  });
});
