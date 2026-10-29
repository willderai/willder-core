import { beforeEach, describe, expect, it, vi } from "vitest";

// route.leakage.test.ts proves the COPY_AGENT_ID collision is caught when the
// colliding run shares this run's `triggeredBy`. This file probes the case it
// does not cover: the name `triggeredBy` means TWO different fields, and a
// route that filters on one while probing on the other leaks.
//
//   - metadata.triggeredBy  on audit_log is what services/access/check.ts sets
//                           to the CAPABILITY's `createdBy` — whoever
//                           provisioned the agent's token.
//   - agentRun.triggeredBy  is whoever TRIGGERED that run.
//
// Those are equal only when the person who provisioned an agent's capability is
// also the person who started every run of it. In any org with an admin who
// provisions tokens and teammates who run agents, they diverge — and a guard
// that probes on one key cannot see the run whose rows it is meant to catch.
//
// Same fixture discipline as route.leakage.test.ts: `producedByAgentId` is the
// ground truth the route never sees, and both findMany/findFirst fakes apply
// the route's own where-clause honestly, so a correct implementation can pass.

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
import type { RunAuditEntryQuery } from "@/services/access/audit-query";
import { whereFor } from "./run-audit-query.testsupport";
import { COPY_AGENT_ID } from "@/lib/copy-agent";
import { GET } from "./route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_alice", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_alice", role: "admin" } },
};

const params = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });

const startedAt = new Date("2026-08-31T10:00:00Z");
const finishedAt = new Date("2026-08-31T10:05:00Z");

type Row = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string;
  decision: string;
  reason: string | null;
  at: Date;
  orgId: string;
  metadata: { triggeredBy?: string };
  producedByAgentId: string;
};

// Alice (an admin) provisioned the capability token for BOTH custom agents, so
// every audit row either one produces carries metadata.triggeredBy "user_alice".
const ROWS: Row[] = [
  {
    id: "al_alices_agent",
    actorType: "agent",
    actorId: COPY_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:contractor-scoped-pricing",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:01:00Z"),
    orgId: "org_1",
    metadata: { triggeredBy: "user_alice" },
    producedByAgentId: "agent_a",
  },
  {
    id: "al_bobs_run_of_other_agent",
    actorType: "agent",
    actorId: COPY_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:full-org-deal-notes",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:02:00Z"),
    orgId: "org_1",
    // Alice provisioned this agent's token too, so the audit row names her...
    metadata: { triggeredBy: "user_alice" },
    // ...but it was a DIFFERENT agent's run that produced it.
    producedByAgentId: "agent_b",
  },
  // Case 3's row: agent_c's own legitimate read, in its own window, hours away
  // from run_a/run_b so no overlap probe can fire. Alice provisioned the token
  // (so the row names her), Bob started the run.
  {
    id: "al_carols_agent_own_read",
    actorType: "agent",
    actorId: COPY_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:its-own-scoped-read",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T12:01:00Z"),
    orgId: "org_1",
    metadata: { triggeredBy: "user_alice" },
    producedByAgentId: "agent_c",
  },
];

type RunRow = {
  id: string;
  agentId: string;
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  meta?: { type?: string };
};

const RUNS: RunRow[] = [
  // Alice ran her own agent.
  { id: "run_a", agentId: "agent_a", triggeredBy: "user_alice", startedAt, finishedAt },
  // Bob ran a different agent at the same time. Bob TRIGGERED it; Alice
  // PROVISIONED its token. The audit rows name Alice, the run row names Bob.
  { id: "run_b", agentId: "agent_b", triggeredBy: "user_bob", startedAt, finishedAt },
  // Case 3: the only run of agent_c, in a window nothing else touches. Bob
  // started it; Alice provisioned the token its audit rows name.
  {
    id: "run_c",
    agentId: "agent_c",
    triggeredBy: "user_bob",
    startedAt: new Date("2026-08-31T12:00:00Z"),
    finishedAt: new Date("2026-08-31T12:05:00Z"),
  },
];

// Alice provisioned tokens for ALL THREE custom agents (see ROWS above), so all
// really do run through runCopyAgent and collide on COPY_AGENT_ID.
const AGENTS: Record<string, { agentKey: string; role: string }> = {
  agent_a: { agentKey: "custom-a", role: "custom" },
  agent_b: { agentKey: "custom-b", role: "custom" },
  agent_c: { agentKey: "custom-c", role: "custom" },
};

function filterRuns(where: Record<string, unknown>): RunRow[] {
  const idFilter = where.id as string | { not?: string } | undefined;
  return RUNS.filter((r) => {
    if (typeof idFilter === "string" && r.id !== idFilter) return false;
    if (idFilter && typeof idFilter === "object" && idFilter.not === r.id) return false;
    if (where.agentId && r.agentId !== where.agentId) return false;
    if ("triggeredBy" in where && r.triggeredBy !== where.triggeredBy) return false;
    const sa = where.startedAt as { lte?: Date } | undefined;
    if (sa?.lte && r.startedAt > sa.lte) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) {
      const windowStart = (
        or.find((c) => c.finishedAt && typeof c.finishedAt === "object")?.finishedAt as { gte?: Date } | undefined
      )?.gte;
      if (windowStart && r.finishedAt && r.finishedAt < windowStart) return false;
    }
    return true;
  });
}

function applyRunWhere(where: Record<string, unknown>): RunRow | null {
  return filterRuns(where)[0] ?? null;
}

function applyRunWhereMany(where: Record<string, unknown>) {
  return filterRuns(where).map((r) => ({ meta: r.meta ?? {}, agent: AGENTS[r.agentId] }));
}

function applyWhere(where: Record<string, unknown>): Row[] {
  return ROWS.filter((row) => {
    if (where.orgId && row.orgId !== where.orgId) return false;
    if (where.actorType && row.actorType !== where.actorType) return false;
    if (where.actorId && row.actorId !== where.actorId) return false;
    const action = where.action as { in?: string[] } | undefined;
    if (action?.in && !action.in.includes(row.action)) return false;
    const at = where.at as { gte?: Date; lte?: Date } | undefined;
    if (at?.gte && row.at < at.gte) return false;
    if (at?.lte && row.at > at.lte) return false;
    const meta = where.metadata as { path?: string[]; equals?: unknown } | undefined;
    if (meta?.path?.[0] === "triggeredBy" && row.metadata.triggeredBy !== meta.equals) return false;
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({
    agentKey: "custom-1719900000000",
    role: "custom",
  } as never);
  // The entries query lives in services/access/audit-query.ts as raw SQL (the
  // visible-row rule needs a `LIKE ... ESCAPE` clause Prisma's typed `where`
  // cannot emit). The fake below re-expresses its arguments as the where-clause
  // applyWhere() understands, including the `actorType: "agent"` scoping the
  // real function applies internally, so this suite keeps testing what it is
  // about (which actorId and window the route asks for, and the overlap
  // reasoning on top of the result) rather than SQL.
  vi.mocked(queryRunAuditEntries).mockImplementation((async (q: RunAuditEntryQuery) =>
    applyWhere(whereFor(q)).map(({ producedByAgentId: _drop, ...rest }) => rest)) as never);
  vi.mocked(db.agentRun.findFirst).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    applyRunWhere(args.where)) as never);
  vi.mocked(db.agentRun.findMany).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    applyRunWhereMany(args.where)) as never);
});

describe("the run's triggerer and the capability's provisioner are not the same field", () => {
  it("a concurrent run TRIGGERED by someone else must not leak into this run's trail", async () => {
    const res = await GET(new Request("http://t"), params("agent_a", "run_a"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const returnedIds: string[] = body.entries.map((e: { id: string }) => e.id);
    const leaked = returnedIds.filter((id) => ROWS.find((r) => r.id === id)?.producedByAgentId !== "agent_a");

    // agent_b's read passes the entries filter (its audit row names Alice, the
    // provisioner) while the cross-agent probe looks for a run whose OWN
    // triggeredBy is Alice — run_b's is Bob — so the probe reports nothing and
    // the merged list is served as if it were exact.
    expect(leaked).toEqual([]);
  });

  it("...and possibleOverlap must not claim the trail is exact in that case", async () => {
    const res = await GET(new Request("http://t"), params("agent_a", "run_a"));
    const body = await res.json();
    expect(body.possibleOverlap).toBe(true);
  });

  // The two cases above are both real, but neither one actually exercises the
  // `entries` filtering they read as guarding: in both, the cross-agent probe
  // fires, and a fired probe blanks `entries` to [] regardless of how `entries`
  // was filtered — so `leaked` is [] either way (re-adding metadata.triggeredBy
  // narrowing to `entries` alone keeps both green).
  //
  // This case attacks the same root cause from the false-EMPTY symptom instead.
  // run_c is agent_c's only run, in a window nothing else overlaps, so BOTH
  // probes come back empty by construction and the fail-closed safety net
  // cannot mask the result — leaving the `entries` query alone on a run whose
  // triggerer (Bob) is not its token's provisioner (Alice).
  //
  // General lesson for future leak tests: a fail-closed safety net upstream of
  // the thing under test can make a leak assertion vacuous. Assert the net did
  // NOT fire before asserting the leak is absent.
  it("a run whose triggerer is not its provisioner still shows its OWN reads (entries must not be narrowed by triggeredBy)", async () => {
    const res = await GET(new Request("http://t"), params("agent_c", "run_c"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Assert the isolation FIRST, so this fails loudly if it ever stops being
    // isolated rather than silently going vacuous like the two above.
    expect(body.possibleOverlap).toBe(false);

    const returnedIds: string[] = body.entries.map((e: { id: string }) => e.id);
    expect(returnedIds).toEqual(["al_carols_agent_own_read"]);
  });
});
