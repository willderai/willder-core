import { beforeEach, describe, expect, it, vi } from "vitest";

// The same-agent overlap probe must not narrow by triggeredBy.
//
// Comparing agentRun.triggeredBy to agentRun.triggeredBy is coherent (the same
// field on both sides, not the provisioner/runner mismatch), but not correct:
// `entries` is not isolated by triggeredBy, so an overlapping run by a
// DIFFERENT user is still ambiguous. For a run whose actorId is NOT the shared
// COPY_AGENT_ID (a real campaign/enrichment-triggered run of a builtin agent,
// which goes through its own dedicated runner and so skips the cross-agent
// probe entirely), narrowing would merge two concurrent runs of that SAME
// agent triggered by two DIFFERENT people into one trail while possibleOverlap
// reports false, i.e. the route would assert the list is certainly only this
// run's activity. The route's own contract says possibleOverlap is "True when
// another run — of this same agent ... — could genuinely overlap this trail."
//
// Same fixture discipline as route.leakage.test.ts and route.triggeredby.test.ts:
// `producedByRunId` is the ground truth the route never sees, and the findMany /
// findFirst fakes apply the route's own where-clause honestly, so a correct
// implementation can pass.

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
import { QA_AGENT_ID } from "@/lib/qa-agent";
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
  producedByRunId: string;
};

// Both rows carry the QA agent's own dedicated actorId — this is a real
// campaign-triggered run, not a test run, so runCopyAgent (and COPY_AGENT_ID)
// is never involved and the cross-agent probe does not fire.
const ROWS: Row[] = [
  {
    id: "al_alices_run",
    actorType: "agent",
    actorId: QA_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:deal-a-scoped-notes",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:01:00Z"),
    orgId: "org_1",
    metadata: { triggeredBy: "user_alice" },
    producedByRunId: "run_a",
  },
  {
    id: "al_bobs_run",
    actorType: "agent",
    actorId: QA_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:deal-b-scoped-notes",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:02:00Z"),
    orgId: "org_1",
    metadata: { triggeredBy: "user_bob" },
    // A DIFFERENT run of the same agent produced this row.
    producedByRunId: "run_b",
  },
];

type RunRow = {
  id: string;
  agentId: string;
  orgId: string;
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  meta?: { type?: string } | null;
};

const RUNS: RunRow[] = [
  // Alice triggered a QA run over Deal A.
  {
    id: "run_a",
    agentId: "agent_a",
    orgId: "org_1",
    triggeredBy: "user_alice",
    startedAt,
    finishedAt,
    meta: null,
  },
  // Bob triggered the SAME agent over Deal B, at the same time.
  {
    id: "run_b",
    agentId: "agent_a",
    orgId: "org_1",
    triggeredBy: "user_bob",
    startedAt,
    finishedAt,
    meta: null,
  },
];

function applyRunWhere(where: Record<string, unknown>): RunRow | null {
  const idFilter = where.id as string | { not?: string } | undefined;
  const found = RUNS.filter((r) => {
    if (where.orgId && r.orgId !== where.orgId) return false;
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
  return found[0] ?? null;
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
  // A seeded builtin QA agent, whose agentKey IS the actorId its runner stamps.
  vi.mocked(db.agent.findFirst).mockResolvedValue({
    agentKey: QA_AGENT_ID,
    role: "qa",
  } as never);
  // The entries query lives in services/access/audit-query.ts as raw SQL (the
  // visible-row rule needs a `LIKE ... ESCAPE` clause Prisma's typed `where`
  // cannot emit). The fake below re-expresses its arguments as the where-clause
  // applyWhere() understands, including the `actorType: "agent"` scoping the
  // real function applies internally, so this suite keeps testing what it is
  // about (which actorId and window the route asks for, and the overlap
  // reasoning on top of the result) rather than SQL.
  vi.mocked(queryRunAuditEntries).mockImplementation((async (q: RunAuditEntryQuery) =>
    applyWhere(whereFor(q)).map(({ producedByRunId: _drop, ...rest }) => rest)) as never);
  vi.mocked(db.agentRun.findFirst).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    applyRunWhere(args.where)) as never);
  // This file's runs all resolve to the QA agent's own actorId (not
  // COPY_AGENT_ID), so route.ts's crossAgentOverlap never queries findMany —
  // stubbed only so an unexpected call fails loudly instead of throwing.
  vi.mocked(db.agentRun.findMany).mockResolvedValue([] as never);
});

describe("same agent, two triggerers, no shared copy-agent identity", () => {
  it("serves a trail that really does contain another run's rows", async () => {
    const res = await GET(new Request("http://t"), params("agent_a", "run_a"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const returnedIds: string[] = body.entries.map((e: { id: string }) => e.id);
    const foreign = returnedIds.filter((id) => ROWS.find((r) => r.id === id)?.producedByRunId !== "run_a");

    // Documents the merge itself. This is not the defect being asserted — a
    // merged same-agent trail is the acknowledged residual ambiguity that
    // `possibleOverlap` exists to disclose. The defect is the next test.
    expect(foreign).toEqual(["al_bobs_run"]);
  });

  it("must not report the trail as exact when another run of the same agent overlaps it", async () => {
    const res = await GET(new Request("http://t"), params("agent_a", "run_a"));
    const body = await res.json();

    // run_b is another run of THIS SAME agent, overlapping this run's window,
    // and its rows are in the list above. possibleOverlap's own contract says
    // it is true when that happens — regardless of who triggered run_b.
    expect(body.possibleOverlap).toBe(true);
  });
});
