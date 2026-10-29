import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for the UC3 agents routes: GET /api/agents, GET /api/agents/:id,
// GET /api/agents/:id/runs, GET /api/runs/:runId. Deps (Clerk/Prisma, run visibility) mocked.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findMany: vi.fn(), findFirst: vi.fn() },
    agentRun: { findMany: vi.fn(), findFirst: vi.fn() },
    campaign: { findMany: vi.fn().mockResolvedValue([]) },
    campaignProspect: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
// Run visibility is proven against real Postgres in app/api/runs/run-scope.realdb.test.ts,
// and who reads an agent's configuration in app/api/agent-config-access.realdb.test.ts;
// here every run is visible and the member may not read configuration, so these tests
// stay on the routes' own wiring.
vi.mock("@/services/access", async (orig) => ({
  ...(await orig<typeof import("@/services/access")>()),
  readableScopePaths: vi.fn(async () => []),
  can: vi.fn(async () => ({ allowed: false, reason: "needs access.manage" })),
}));
vi.mock("@/services/agents/run-visibility", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/run-visibility")>()),
  canReadRun: vi.fn(async () => true),
  runVisibleUnder: vi.fn(() => true),
  listVisibleRuns: vi.fn(async () => ({ runs: [], total: 0 })),
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { listVisibleRuns } from "@/services/agents/run-visibility";

import { GET as agentsGET } from "./agents/route";
import { GET as agentGET } from "./agents/[id]/route";
import { GET as runsGET } from "./agents/[id]/runs/route";
import { GET as runGET } from "./runs/[runId]/route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
});

const stubAgent = {
  id: "agent_1",
  orgId: "org_1",
  agentKey: "copy-agent",
  name: "Copy agent",
  role: "copy",
  model: "qwen/qwen3-32b",
  active: true,
  _count: { runs: 3 },
  runs: [],
};

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

describe("GET /api/agents", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await agentsGET()).status).toBe(401);
  });

  it("returns the org's agents", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([stubAgent] as never);
    const res = await agentsGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agents).toHaveLength(1);
    expect(db.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: "org_1" } }));
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await agentGET(new Request("http://t"), params({ id: "agent_1" }));
    expect(res.status).toBe(401);
  });

  it("404 when agent not in org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await agentGET(new Request("http://t"), params({ id: "agent_1" }));
    expect(res.status).toBe(404);
  });

  it("returns the agent with runs", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    const res = await agentGET(new Request("http://t"), params({ id: "agent_1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agent.agentKey).toBe("copy-agent");
    expect(db.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "agent_1", orgId: "org_1" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id/runs
// ---------------------------------------------------------------------------

const stubRun = {
  id: "run_1",
  status: "completed",
  triggeredBy: "user_42",
  meta: { campaignId: "camp_1" },
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
};

describe("GET /api/agents/:id/runs", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await runsGET(new Request("http://t"), params({ id: "agent_1" }));
    expect(res.status).toBe(401);
  });

  it("404 when agent not in org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await runsGET(new Request("http://t"), params({ id: "agent_1" }));
    expect(res.status).toBe(404);
  });

  it("returns the visible page and its total, without the run's credential", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_1" } as never);
    vi.mocked(listVisibleRuns).mockResolvedValue({
      runs: [{ ...stubRun, meta: { ...stubRun.meta, target: { authHeader: "Bearer secret" } } }] as never,
      total: 7,
      nextCursor: null,
    });
    const res = await runsGET(new Request("http://t?limit=10"), params({ id: "agent_1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs).toHaveLength(1);
    expect(data.total).toBe(7);
    expect(JSON.stringify(data)).not.toContain("Bearer secret");
    expect(listVisibleRuns).toHaveBeenCalledWith("org_1", [], "agent_1", {
      limit: 10,
      order: "desc",
      status: undefined,
      search: undefined,
    });
  });

  it("passes status, order and a trimmed search through", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_1" } as never);
    await runsGET(new Request("http://t?status=failed&order=asc&q=%20Acme%20"), params({ id: "agent_1" }));
    expect(listVisibleRuns).toHaveBeenCalledWith("org_1", [], "agent_1", {
      limit: 20,
      order: "asc",
      status: "failed",
      search: "Acme",
    });
  });

  it("caps limit at 100 and falls back to the default for a non-number", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_1" } as never);
    await runsGET(new Request("http://t?limit=9999"), params({ id: "agent_1" }));
    expect(vi.mocked(listVisibleRuns).mock.calls[0][3].limit).toBe(100);
    await runsGET(new Request("http://t?limit=abc"), params({ id: "agent_1" }));
    expect(vi.mocked(listVisibleRuns).mock.calls[1][3].limit).toBe(20);
  });

  it.each([
    ["status=paused", "status must be one of running, completed, failed"],
    ["order=sideways", "order must be asc or desc"],
    [`q=${"x".repeat(101)}`, "q must be at most 100 characters"],
  ])("refuses %s with a message naming the fix", async (query, error) => {
    vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_1" } as never);
    const res = await runsGET(new Request(`http://t?${query}`), params({ id: "agent_1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(listVisibleRuns).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/runs/:runId
// ---------------------------------------------------------------------------

describe("GET /api/runs/:runId", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await runGET(new Request("http://t"), params({ runId: "run_1" }));
    expect(res.status).toBe(401);
  });

  it("404 when run not in org", async () => {
    vi.mocked(db.agentRun.findFirst).mockResolvedValue(null);
    const res = await runGET(new Request("http://t"), params({ runId: "run_1" }));
    expect(res.status).toBe(404);
  });

  it("returns the run with its agent", async () => {
    vi.mocked(db.agentRun.findFirst).mockResolvedValue({
      ...stubRun,
      agent: { id: "agent_1", agentKey: "copy-agent", name: "Copy agent", role: "copy" },
    } as never);
    const res = await runGET(new Request("http://t"), params({ runId: "run_1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run.agent.agentKey).toBe("copy-agent");
    expect(db.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run_1", orgId: "org_1" } }),
    );
  });
});
