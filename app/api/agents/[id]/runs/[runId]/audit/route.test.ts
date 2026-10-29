import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for GET /api/agents/:id/runs/:runId/audit — the per-run memory
// observability panel. Verifies: auth gating (same admin gate as /api/audit),
// 404s stay scoped to this org/agent (never leak another tenant's or another
// agent's run), and the audit_log query is filtered to exactly this run's
// actor + time window — the leak-scenario standard every screen touching
// access-control data needs.
//
// Two rules on top. (1) actorId + time window alone can't isolate overlapping
// runs of the SAME agent, so the route reports an honest `possibleOverlap`
// flag for the residual ambiguity instead of pretending the list is exact.
// (2) custom agents run through runCopyAgent, which always stamps
// COPY_AGENT_ID, not the custom agent's own agentKey, so the route resolves
// the actorId to query by per role, not by agentKey alone.
//
// The `entries` query and the cross-agent overlap probe never narrow on
// metadata.triggeredBy — see route.ts's comment above `entries` for why (it
// names the token's provisioner, not the run's actual triggerer, and the two
// diverge whenever an admin provisions for teammates who run the agent).
// route.triggeredby.test.ts covers the leak that narrowing causes.
//
// The entries query lives in services/access/audit-query.ts's
// queryRunAuditEntries(), which issues it as raw SQL -- the visible-row rule
// matches an access.manage target against markers containing `_`, a LIKE
// wildcard, so it needs a `LIKE ... ESCAPE` clause Prisma's typed `where` API
// cannot emit. This suite mocks that function rather than the database: what it
// is about is which actorId, window and org the route asks for, and the overlap
// reasoning on top. The query's own content -- the visible-row rule, the marker
// escaping and the actorType scoping -- is owned by
// audit-visibility-escape.test.ts, against the real function.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({
  check: vi.fn(),
}));
vi.mock("@/services/access/audit-query", () => ({ queryRunAuditEntries: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agentRun: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findFirst: vi.fn() },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { queryRunAuditEntries } from "@/services/access/audit-query";
import { RUN_TRAIL_PAGE_SIZE } from "@/lib/agent-lists";
import { db } from "@/lib/db";
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

const run = {
  id: "run_1",
  agentId: "agent_1",
  triggeredBy: "user_42",
  startedAt,
  finishedAt,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  // First call = the run lookup; every call after (the overlap check, and any
  // re-lookup in a test) defaults to "no overlapping run found".
  vi.mocked(db.agentRun.findFirst)
    .mockResolvedValueOnce(run as never)
    .mockResolvedValue(null as never);
  vi.mocked(db.agentRun.findMany).mockResolvedValue([] as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({ agentKey: "qa-agent", role: "qa" } as never);
  vi.mocked(queryRunAuditEntries).mockResolvedValue([]);
});

describe("GET /api/agents/:id/runs/:runId/audit", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(res.status).toBe(401);
  });

  it("403 when access.manage is denied", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false } as never);
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(res.status).toBe(403);
    expect(db.agentRun.findFirst).not.toHaveBeenCalled();
  });

  it("404 when the run doesn't belong to this org (never leaks another tenant's run)", async () => {
    // .mockReset() clears the "Once" real-run value beforeEach queued — otherwise
    // it would still fire first and this 404 case would never actually happen.
    vi.mocked(db.agentRun.findFirst).mockReset().mockResolvedValue(null);
    const res = await GET(new Request("http://t"), params("agent_1", "run_from_other_org"));
    expect(res.status).toBe(404);
    // orgId scoping is passed straight to the query, not applied after the fact.
    expect(db.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run_from_other_org", agentId: "agent_1", orgId: "org_1" } }),
    );
  });

  it("404 when the run belongs to a different agent than :id names", async () => {
    vi.mocked(db.agentRun.findFirst).mockReset().mockResolvedValue(null);
    const res = await GET(new Request("http://t"), params("agent_2", "run_1"));
    expect(res.status).toBe(404);
  });

  it("404 when the agent record itself can't be resolved in this org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(res.status).toBe(404);
    expect(queryRunAuditEntries).not.toHaveBeenCalled();
  });

  it("asks for exactly this org, this run's agent actorId and the run's own window — nothing more (not narrowed by triggeredBy — see route.ts comment / route.triggeredby.test.ts)", async () => {
    await GET(new Request("http://t"), params("agent_1", "run_1"));
    // toEqual, not objectContaining: an extra narrowing key silently added
    // here is exactly the triggeredBy defect, so the argument is pinned
    // exhaustively rather than loosely.
    expect(queryRunAuditEntries).toHaveBeenCalledWith({
      orgId: "org_1",
      actorId: "qa-agent",
      from: startedAt,
      to: finishedAt,
      limit: RUN_TRAIL_PAGE_SIZE + 1,
    });
  });

  it("returns one page, says whether more follow, and continues from its last row", async () => {
    const rows = Array.from({ length: RUN_TRAIL_PAGE_SIZE + 1 }, (_, i) => ({
      id: `log_${i}`,
      action: "memory.read",
      target: "org_1.sales:q",
      decision: "allow",
      reason: null,
      at: new Date(startedAt.getTime() + i),
    }));
    vi.mocked(queryRunAuditEntries).mockResolvedValue(rows as never);
    const body = await (await GET(new Request("http://t"), params("agent_1", "run_1"))).json();
    expect(body.entries).toHaveLength(RUN_TRAIL_PAGE_SIZE);
    expect(body.hasMore).toBe(true);
    const last = rows[RUN_TRAIL_PAGE_SIZE - 1]!;
    expect(body.endCursor).toBe(`${last.at.toISOString()}_${last.id}`);

    vi.mocked(db.agentRun.findFirst)
      .mockReset()
      .mockResolvedValueOnce(run as never)
      .mockResolvedValue(null as never);
    vi.mocked(queryRunAuditEntries).mockResolvedValue(rows.slice(0, 3) as never);
    const next = await (
      await GET(new Request(`http://t?cursor=${encodeURIComponent(body.endCursor)}`), params("agent_1", "run_1"))
    ).json();
    expect(queryRunAuditEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { at: last.at, id: last.id }, limit: RUN_TRAIL_PAGE_SIZE + 1 }),
    );
    expect(next).toMatchObject({ hasMore: false, endCursor: `${rows[2]!.at.toISOString()}_log_2` });
  });

  it("refuses a cursor it did not issue, before reading any audit row", async () => {
    const res = await GET(new Request("http://t?cursor=yesterday"), params("agent_1", "run_1"));
    expect(res.status).toBe(400);
    expect(queryRunAuditEntries).not.toHaveBeenCalled();
  });

  // Allow-case: memory.delete is part of the canonical visibility rule, matching
  // the org-wide audit list.
  it("allow-case: a memory.delete row for this run's agent is included", async () => {
    vi.mocked(queryRunAuditEntries).mockResolvedValue([
      { id: "al1", action: "memory.delete", target: "org_1/fact_1", decision: "allow", reason: null, at: new Date() },
    ]);
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    const body = (await res.json()) as { entries: { id: string; action: string }[] };
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["al1"]);
    expect(body.entries[0]!.action).toBe("memory.delete");
  });

  // Allow-case: memory.entity is part of the canonical rule, so an agent's
  // entity lookups appear in its own run trail. Pinned at the consumer, so a
  // regression that drops memory.entity from the canonical rule fails here and
  // not only in services/audit/visibility.test.ts.
  it("allow-case: a memory.entity row for this run's agent is included", async () => {
    vi.mocked(queryRunAuditEntries).mockResolvedValue([
      { id: "al2", action: "memory.entity", target: "org_1/entity_1", decision: "allow", reason: null, at: new Date() },
    ]);
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    const body = (await res.json()) as { entries: { id: string; action: string }[] };
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["al2"]);
    expect(body.entries[0]!.action).toBe("memory.entity");
  });

  // The companion deny-case (access.manage never reaches this agent-scoped
  // trail, via the `actorType: "agent"` filter) lives inside
  // queryRunAuditEntries, so asserting it on a mocked call argument here would
  // only restate the mock. It is pinned against the real emitted SQL in
  // app/api/audit/audit-visibility-escape.test.ts ("scopes the trail to
  // agent-written rows").

  it("a still-running run (no finishedAt) windows up to now, not an empty range", async () => {
    vi.mocked(db.agentRun.findFirst)
      .mockReset()
      .mockResolvedValueOnce({ ...run, finishedAt: null } as never)
      .mockResolvedValue(null as never);
    const before = Date.now();
    await GET(new Request("http://t"), params("agent_1", "run_1"));
    const windowEnd = vi.mocked(queryRunAuditEntries).mock.calls[0]![0]!.to;
    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("200 returns the run's window, the raw entries, and possibleOverlap: false when nothing else overlaps", async () => {
    vi.mocked(queryRunAuditEntries).mockResolvedValue([
      {
        id: "al1",
        action: "memory.read",
        target: "org_org_1/query:pricing",
        decision: "allow",
        reason: null,
        at: new Date(),
      },
    ]);
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.startedAt).toBeTruthy();
    expect(body.possibleOverlap).toBe(false);
  });

  it("resolves a custom agent's actorId to the copy-agent identity, not its own agentKey", async () => {
    // Custom agents always run through runCopyAgent (POST /api/agents/:id/run),
    // which stamps every audit row under COPY_AGENT_ID — never the custom
    // agent's own "custom-<ts>" agentKey. Filtering by agentKey could never
    // match a single row for a custom agent.
    vi.mocked(db.agent.findFirst).mockResolvedValue({ agentKey: "custom-1719900000000", role: "custom" } as never);
    await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(queryRunAuditEntries).toHaveBeenCalledWith(expect.objectContaining({ actorId: COPY_AGENT_ID }));
  });

  it("a builtin agent's actorId resolves to its own agentKey", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue({ agentKey: "architecture-agent", role: "architecture" } as never);
    await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(queryRunAuditEntries).toHaveBeenCalledWith(expect.objectContaining({ actorId: "architecture-agent" }));
  });

  it("a research agent's own test run resolves to its own agentKey, not COPY_AGENT_ID", async () => {
    // POST /api/agents/:id/research sets meta.type "test-run" identically to
    // POST /api/agents/:id/run, but always calls runResearchAgent, which
    // stamps RESEARCH_AGENT_ID regardless — unlike every OTHER role's
    // test-run, which really does go through runCopyAgent (COPY_AGENT_ID).
    vi.mocked(db.agent.findFirst).mockResolvedValue({ agentKey: RESEARCH_AGENT_ID, role: "research" } as never);
    vi.mocked(db.agentRun.findFirst)
      .mockReset()
      .mockResolvedValueOnce({ ...run, meta: { type: "test-run" } } as never)
      .mockResolvedValue(null as never);
    await GET(new Request("http://t"), params("agent_1", "run_1"));
    expect(queryRunAuditEntries).toHaveBeenCalledWith(expect.objectContaining({ actorId: RESEARCH_AGENT_ID }));
  });

  it("possibleOverlap: true when another run of the same agent, same triggeredBy, overlaps this run's window", async () => {
    vi.mocked(db.agentRun.findFirst)
      .mockReset()
      .mockResolvedValueOnce(run as never) // the run itself
      .mockResolvedValueOnce({ id: "run_2" } as never); // the overlap check finds a sibling run
    const res = await GET(new Request("http://t"), params("agent_1", "run_1"));
    const body = await res.json();
    expect(body.possibleOverlap).toBe(true);
    // The same-agent overlap check must exclude this run itself, but never
    // narrows by triggeredBy (route.sameagent.test.ts: `entries` is not
    // isolated by triggeredBy, so a different triggerer of the same agent must
    // still count).
    expect(db.agentRun.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentId: "agent_1",
          id: { not: "run_1" },
        }),
      }),
    );
    expect(db.agentRun.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ triggeredBy: expect.anything() }),
      }),
    );
  });

  it("a system-triggered run (no triggeredBy) can't be narrowed by user, so the entries query drops the triggeredBy filter and the overlap check widens to any run of the agent", async () => {
    vi.mocked(db.agentRun.findFirst)
      .mockReset()
      .mockResolvedValueOnce({ ...run, triggeredBy: null } as never)
      .mockResolvedValue(null as never);
    await GET(new Request("http://t"), params("agent_1", "run_1"));
    // The entries query carries no triggeredBy/metadata narrowing at all —
    // pinned exhaustively, since the keys it does carry are the whole argument.
    expect(Object.keys(vi.mocked(queryRunAuditEntries).mock.calls[0]![0]!).sort()).toEqual([
      "actorId",
      "from",
      "limit",
      "orgId",
      "to",
    ]);
    expect(db.agentRun.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ triggeredBy: expect.anything() }),
      }),
    );
  });
});
