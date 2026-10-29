import { beforeEach, describe, expect, it, vi } from "vitest";

// Leak-scenario tests for the per-run observability panel.
//
// route.test.ts mocks the entries query to a fixed array, so it can only assert
// the SHAPE of the arguments the route builds — it can
// never observe which rows that clause would actually select. These tests use
// a small filtering fake instead: a fixture of audit rows, each tagged with
// the agent that really produced it, and a findMany that honestly applies the
// route's own where-clause to it. The tag is the independent source of truth —
// the route never sees it, so an assertion that no out-of-scope row surfaces
// is a real leak check, not a restatement of the implementation.

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
import { QA_AGENT_ID } from "@/lib/qa-agent";
import { GET } from "./route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const params = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });

const startedAt = new Date("2026-08-31T10:00:00Z");
const finishedAt = new Date("2026-08-31T10:05:00Z");

// The fixture. `producedByAgentId` is the ground truth the route cannot see:
// which agent's run actually generated this audit row. Both rows below are
// stamped actorId COPY_AGENT_ID because services/agents/runner.ts's
// runCopyAgent() hardcodes `actorId: COPY_AGENT_ID` (line ~327) for whatever
// agentRow it is handed — POST /api/agents/:id/run drives EVERY non-research
// agent, builtin or custom, through it.
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

const ROWS: Row[] = [
  {
    id: "al_custom",
    actorType: "agent",
    actorId: COPY_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:contractor-scoped-pricing",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:01:00Z"),
    orgId: "org_1",
    metadata: { triggeredBy: "user_42" },
    producedByAgentId: "agent_custom",
  },
  {
    id: "al_builtin_copy",
    actorType: "agent",
    actorId: COPY_AGENT_ID,
    action: "memory.read",
    target: "org_org_1/query:full-org-deal-notes",
    decision: "allow",
    reason: null,
    at: new Date("2026-08-31T10:02:00Z"),
    orgId: "org_1",
    metadata: { triggeredBy: "user_42" },
    // A DIFFERENT agent's run — the builtin Outreach agent, same org, same
    // human, overlapping window.
    producedByAgentId: "agent_copy_builtin",
  },
];

// Honest application of the route's own where-clause to the fixture.
// The runs fixture, so the route's overlap probe is answered honestly too. A
// stubbed `null` here would make the leak test unsatisfiable even by a correct
// implementation (a widened probe would still see nothing), which would make
// it a broken test rather than a finding.
type RunRow = {
  id: string;
  agentId: string;
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  meta?: { type?: string };
};

const RUNS: RunRow[] = [
  { id: "run_custom", agentId: "agent_custom", triggeredBy: "user_42", startedAt, finishedAt },
  // The concurrent run of a DIFFERENT agent that produced al_builtin_copy.
  { id: "run_copy", agentId: "agent_copy_builtin", triggeredBy: "user_42", startedAt, finishedAt },
  {
    id: "run_qa",
    agentId: "agent_qa",
    triggeredBy: "user_42",
    startedAt,
    finishedAt,
    meta: { type: "test-run" },
  },
];

// Each RUNS entry's real agent identity — what route.ts's crossAgentOverlap
// probe joins in (`select: { agent: { select: { agentKey, role } } }`) to
// judge whether a candidate run could really have produced a COPY_AGENT_ID
// row, instead of trusting any overlapping run in the org.
const AGENTS: Record<string, { agentKey: string; role: string }> = {
  agent_custom: { agentKey: "custom-1719900000000", role: "custom" },
  // The builtin Outreach/copy-role agent — its OWN agentKey already IS
  // COPY_AGENT_ID (lib/tenant.ts AGENT_SEEDS), so a real (non-test) run of it
  // genuinely collides, no role/test-run special-casing needed.
  agent_copy_builtin: { agentKey: COPY_AGENT_ID, role: "copy" },
  agent_qa: { agentKey: QA_AGENT_ID, role: "qa" },
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

// crossAgentOverlap's findMany — same window/id filtering as applyRunWhere,
// but returns every match shaped like route.ts's own `select`, joined
// against each run's real agent identity.
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

describe("leak scenario — one agent's memory trail must not show another agent's reads", () => {
  function stubCustomAgent() {
    vi.mocked(db.agent.findFirst).mockResolvedValue({
      agentKey: "custom-1719900000000",
      role: "custom",
    } as never);
  }

  it("a custom agent's run must not surface the builtin Outreach agent's memory reads", async () => {
    stubCustomAgent();
    const res = await GET(new Request("http://t"), params("agent_custom", "run_custom"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const returnedIds: string[] = body.entries.map((e: { id: string }) => e.id);
    const leaked = returnedIds.filter((id) => ROWS.find((r) => r.id === id)?.producedByAgentId !== "agent_custom");

    // The leak: rows produced by agent_copy_builtin's run come back as part of
    // agent_custom's trail, because both resolve to the same actorId and the
    // entries query never filters by the run's own agent.
    expect(leaked).toEqual([]);
  });

  it("...and when it does, possibleOverlap must not claim the trail is exact", async () => {
    stubCustomAgent();
    const res = await GET(new Request("http://t"), params("agent_custom", "run_custom"));
    const body = await res.json();

    // The honest-caveat flag only probes runs of the SAME agentId, so a
    // cross-agent actorId collision leaves it false and the UI presents the
    // merged list as certain — the exact false confidence the flag exists to
    // prevent.
    expect(body.possibleOverlap).toBe(true);
  });

  it("a builtin QA agent's test run queries the SHARED copy-agent identity, and its trail is withheld rather than filled with two other agents' rows", async () => {
    // POST /api/agents/:id/run has no role branching: it calls runCopyAgent for
    // every non-research agent, which stamps COPY_AGENT_ID. The run row records
    // this origin as meta.type === "test-run". A QA agent's test run therefore
    // produces rows under COPY_AGENT_ID, while the agent record still says
    // QA_AGENT_ID.
    //
    // Asserting only the resolved `where.actorId` is not enough: BOTH rows in
    // ROWS carry actorId COPY_AGENT_ID, and neither was produced by agent_qa,
    // so the where-clause selects both. The only thing standing between this
    // run's panel and two OTHER agents' memory reads is crossAgentOverlap
    // suppression, so that is what this test pins; a regression that removed
    // suppression would leak both rows here.
    vi.mocked(db.agent.findFirst).mockResolvedValue({
      agentKey: QA_AGENT_ID,
      role: "qa",
    } as never);

    const res = await GET(new Request("http://t"), params("agent_qa", "run_qa"));
    const body = await res.json();

    const where = whereFor(vi.mocked(queryRunAuditEntries).mock.calls[0]![0]!) as {
      actorId: string;
    };
    // A test run of the QA agent is audited under COPY_AGENT_ID, so this is the
    // actorId the panel must query to show anything at all.
    expect(where.actorId).toBe(COPY_AGENT_ID);

    // The clause is genuinely satisfiable — rows exist under it. Asserting this
    // from the fixture's own ground-truth tag (which the route never sees)
    // keeps the leak assertion below from being vacuously true.
    const selectable = ROWS.filter((r) => r.actorId === where.actorId);
    expect(selectable.length).toBe(2);
    expect(selectable.every((r) => r.producedByAgentId !== "agent_qa")).toBe(true);

    // Suppression is what empties this trail, and it must say so: withheld, not
    // "this run touched no memory".
    expect(body.entriesSuppressed).toBe(true);
    expect(body.possibleOverlap).toBe(true);
    // The leak check itself — not one foreign row surfaces.
    expect(body.entries).toEqual([]);
    // Nor does its position: a cursor would carry a foreign row's id and time.
    expect(body.endCursor).toBeNull();
    expect(body.hasMore).toBe(false);
  });
});
