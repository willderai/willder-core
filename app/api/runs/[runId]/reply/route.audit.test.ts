import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/runs/:runId/reply reads the brief a finished run produced. Deciding
// whether the caller may see the run already decides `memory.read` on that
// brief's scope, so the reply must not decide it a second time: every check()
// writes an audit row, and a second row for the same read overstates how much
// was read. These tests run the real run-visibility and brief modules over a
// mocked database and count check() calls.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The run's agent is active here; refusing a deactivated one is proven against a
// real database in app/api/agents/[id]/deactivated-agent-runs.realdb.test.ts.
vi.mock("@/services/agents/agent-active", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/agent-active")>()),
  isAgentDeactivated: vi.fn(async () => false),
}));
vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  return {
    check: vi.fn(),
    isValidLtreePath: actual.isValidLtreePath,
    orgRootPath: actual.orgRootPath,
    pathCovers: vi.fn(),
    flattenSql: vi.fn(),
    scopeContainsSql: vi.fn(),
  };
});
vi.mock("@/lib/db", () => ({
  db: {
    agentRun: { findFirst: vi.fn() },
    brief: { findFirst: vi.fn() },
    briefRetirement: { findFirst: vi.fn() },
  },
}));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/agents/manager", () => ({
  createQaManagerRun: vi.fn(),
  createArchManagerRun: vi.fn(),
  driveManager: vi.fn(),
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { createQaManagerRun } from "@/services/agents/manager";
import { POST } from "./route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = () =>
  new Request("http://t/api/runs/run_prev/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "again, harder" }),
  });
const params = { params: Promise.resolve({ runId: "run_prev" }) };

const run = {
  id: "run_prev",
  agentId: "agent_qa",
  phase: "done",
  briefId: "brief_1",
  meta: { agentRole: "qa", target: { baseUrl: "https://api.acme.com" }, scopePath: "org_1.engineering" },
};
const brief = (scopePath: string) => ({
  id: "brief_1",
  orgId: "org_1",
  scopePath,
  title: "QA report",
  summary: "3 endpoints failed under load.",
  type: "qa_review",
});

let retired = false;
/** The stored brief, honouring a `NOT_RETIRED` filter the way Postgres would. */
const storeBrief = (scopePath: string) =>
  vi
    .mocked(db.brief.findFirst)
    .mockImplementation((async (args: { where?: { retirements?: unknown } }) =>
      retired && args?.where?.retirements ? null : brief(scopePath)) as never);

/** The scopes check() was asked about, in order. */
const checkedScopes = () => vi.mocked(check).mock.calls.map(([, request]) => request.scope);
const seededFocus = () => vi.mocked(createQaManagerRun).mock.calls[0]?.[0].focus ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(db.agentRun.findFirst).mockResolvedValue(run as never);
  retired = false;
  vi.mocked(db.briefRetirement.findFirst).mockImplementation((async () =>
    retired ? { briefId: "brief_1" } : null) as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
  vi.mocked(createQaManagerRun).mockResolvedValue("run_new");
});

describe("POST /api/runs/:runId/reply: one audited decision per scope read", () => {
  it("decides once when the brief sits at the run's own scope", async () => {
    storeBrief("org_1.engineering");
    const res = await POST(req(), params);
    expect(res.status).toBe(201);
    expect(checkedScopes()).toEqual(["org_1.engineering"]);
    expect(seededFocus()).toContain("3 endpoints failed under load.");
  });

  it("decides once per scope when the brief sits at another scope", async () => {
    storeBrief("org_1.engineering.qa");
    const res = await POST(req(), params);
    expect(res.status).toBe(201);
    expect(checkedScopes()).toEqual(["org_1.engineering", "org_1.engineering.qa"]);
    expect(seededFocus()).toContain("3 endpoints failed under load.");
  });

  it("refuses the run, with no brief content, when the brief's scope is denied", async () => {
    storeBrief("org_1.finance");
    vi.mocked(check).mockImplementation(
      async (_ctx, request) => ({ allowed: request.scope !== "org_1.finance", reason: "grant" }) as never,
    );
    const res = await POST(req(), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run not found" });
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("does not seed the follow-up from a withdrawn brief", async () => {
    storeBrief("org_1.engineering");
    retired = true;
    const res = await POST(req(), params);
    expect(res.status).toBe(201);
    expect(seededFocus()).not.toContain("3 endpoints failed under load.");
  });
});
