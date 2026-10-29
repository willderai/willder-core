import { beforeEach, describe, expect, it, vi } from "vitest";

// The cross-agent overlap probe must respect agent identity: an overlapping
// agentRun only counts when that run could plausibly have produced a
// COPY_AGENT_ID-tagged row. A completely unrelated run (a real research-agent
// run, or any builtin agent's real campaign/enrichment run that isn't the
// copy-role agent itself) is stamped under its own dedicated actorId and can
// never show up in `entries` (which only queries actorId === COPY_AGENT_ID
// here) no matter how much its window overlaps, so it must not blank `entries`
// or set possibleOverlap.
//
// Same fixture discipline as route.leakage.test.ts / route.triggeredby.test.ts:
// the fixture's `agent` identity per run is the ground truth the route only
// sees through the same resolveActorId() rule it applies to the run under
// view, and findFirst/findMany fakes apply the route's own where-clause
// honestly.

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

// RESEARCH_AGENT_ID's value ("research-agent") is inlined here: the route never
// imports a research-agent module, it only compares agent.role !== "research" as
// a string literal.
const RESEARCH_AGENT_ID = "research-agent";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const params = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });

const startedAt = new Date("2026-08-31T10:00:00Z");
const finishedAt = new Date("2026-08-31T10:05:00Z");

// The custom agent's own legitimate audit rows for run_custom — nothing else
// in the fixture ever carries actorId COPY_AGENT_ID, so these are the only
// rows `entries` could ever return for this run.
const ROWS = [
  {
    id: "al_custom_1",
    actorType: "agent",
    actorId: COPY_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:contractor-scoped-pricing",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:01:00Z"),
    orgId: "org_1",
  },
];

type RunRow = {
  id: string;
  agentId: string;
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  meta?: { type?: string } | null;
};

const RUNS: RunRow[] = [
  { id: "run_custom", agentId: "agent_custom", triggeredBy: "user_42", startedAt, finishedAt },
  // A genuinely unrelated, real (non-test) research-agent run, overlapping
  // the exact same window. Its own rows are always stamped RESEARCH_AGENT_ID
  // (runResearchAgent, services/agents/runner.ts) — it can never appear in
  // `entries` for a COPY_AGENT_ID-actored run, no matter how much it overlaps.
  { id: "run_research", agentId: "agent_research", triggeredBy: "user_42", startedAt, finishedAt },
  // A real (non-test) campaign run of a builtin, non-copy "dedicated runner"
  // role (Architecture) — also its own dedicated actorId, also never
  // COPY_AGENT_ID.
  { id: "run_arch", agentId: "agent_arch", triggeredBy: "user_42", startedAt, finishedAt },
];

const AGENTS: Record<string, { agentKey: string; role: string }> = {
  agent_custom: { agentKey: "custom-1719900000000", role: "custom" },
  agent_research: { agentKey: RESEARCH_AGENT_ID, role: "research" },
  agent_arch: { agentKey: "architecture-agent", role: "architecture" },
};

function filterRuns(where: Record<string, unknown>): RunRow[] {
  const idFilter = where.id as string | { not?: string } | undefined;
  return RUNS.filter((r) => {
    if (typeof idFilter === "string" && r.id !== idFilter) return false;
    if (idFilter && typeof idFilter === "object" && idFilter.not === r.id) return false;
    if (where.agentId && r.agentId !== where.agentId) return false;
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

function applyWhere(where: Record<string, unknown>) {
  return ROWS.filter((row) => {
    if (where.orgId && row.orgId !== where.orgId) return false;
    if (where.actorType && row.actorType !== where.actorType) return false;
    if (where.actorId && row.actorId !== where.actorId) return false;
    const action = where.action as { in?: string[] } | undefined;
    if (action?.in && !action.in.includes(row.action)) return false;
    const at = where.at as { gte?: Date; lte?: Date } | undefined;
    if (at?.gte && row.at < at.gte) return false;
    if (at?.lte && row.at > at.lte) return false;
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue(AGENTS.agent_custom as never);
  // The entries query lives in services/access/audit-query.ts as raw SQL (the
  // visible-row rule needs a `LIKE ... ESCAPE` clause Prisma's typed `where`
  // cannot emit). The fake below re-expresses its arguments as the where-clause
  // applyWhere() understands, including the `actorType: "agent"` scoping the
  // real function applies internally, so this suite keeps testing what it is
  // about (which actorId and window the route asks for, and the overlap
  // reasoning on top of the result) rather than SQL.
  vi.mocked(queryRunAuditEntries).mockImplementation((async (q: RunAuditEntryQuery) =>
    applyWhere(whereFor(q))) as never);
  vi.mocked(db.agentRun.findFirst).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    applyRunWhere(args.where)) as never);
  vi.mocked(db.agentRun.findMany).mockImplementation((async (args: { where: Record<string, unknown> }) =>
    applyRunWhereMany(args.where)) as never);
});

describe("an overlapping run that could never share this run's actorId must not suppress a legitimate trail", () => {
  it("a real research-agent run and a real Architecture run overlapping the same window do not blank the custom agent's own trail", async () => {
    const res = await GET(new Request("http://t"), params("agent_custom", "run_custom"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Neither run_research nor run_arch can ever produce a COPY_AGENT_ID row
    // (RESEARCH_AGENT_ID / architecture-agent are their real, distinct
    // actorIds), so this run's own legitimate rows must still come through.
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["al_custom_1"]);
  });

  it("...and possibleOverlap stays false — nothing here is genuinely ambiguous", async () => {
    const res = await GET(new Request("http://t"), params("agent_custom", "run_custom"));
    const body = await res.json();
    expect(body.possibleOverlap).toBe(false);
  });
});
