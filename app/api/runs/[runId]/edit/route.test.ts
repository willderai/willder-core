import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for POST /api/runs/[runId]/edit (docs/design_interactive_agent_
// loop.md §5). requireAccessContext → 401; validate { editId, baseRevision, ops } → 400
// (incl. empty ops); applyPlanEdit (tenant-scoped) maps status → HTTP:
//   applied → 200, noop → 200 (idempotent replay), conflict → 409 (stale baseRevision),
//   invalid "run not found" → 404, other invalid → 400.
// applyPlanEdit is mocked — we test wiring + the status→HTTP mapping.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The run's agent is active here; refusing a deactivated one is proven against a
// real database in app/api/agents/[id]/deactivated-agent-runs.realdb.test.ts.
vi.mock("@/services/agents/agent-active", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/agent-active")>()),
  isAgentDeactivated: vi.fn(async () => false),
}));
vi.mock("@/services/agents/run-visibility", () => ({ findReadableRun: vi.fn() }));
vi.mock("@/services/agents/run-loop", () => ({ applyPlanEdit: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { findReadableRun } from "@/services/agents/run-visibility";
import { applyPlanEdit } from "@/services/agents/run-loop";

import { POST } from "./route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};
const plan = { runId: "run_1", agentRole: "qa", items: [], revision: 1 };

const req = (body?: unknown) =>
  new Request("http://t/api/runs/run_1/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

const okBody = {
  editId: "edit-1",
  baseRevision: 0,
  ops: [{ op: "add", item: { kind: "scenario", title: "Extra check" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(findReadableRun).mockResolvedValue({ id: "run_1" } as never);
  vi.mocked(applyPlanEdit).mockResolvedValue({ status: "applied", plan } as never);
});

describe("POST /api/runs/:runId/edit", () => {
  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(401);
    expect(applyPlanEdit).not.toHaveBeenCalled();
  });

  it("404 when the run is hidden from the caller, the same answer as an absent run", async () => {
    vi.mocked(findReadableRun).mockResolvedValue(null);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run not found" });
    expect(findReadableRun).toHaveBeenCalledWith(member.ctx, "org_1", "run_1");
    expect(applyPlanEdit).not.toHaveBeenCalled();
  });

  it("400 when editId is missing", async () => {
    const res = await POST(req({ baseRevision: 0, ops: okBody.ops }), params("run_1"));
    expect(res.status).toBe(400);
    expect(applyPlanEdit).not.toHaveBeenCalled();
  });

  it("400 when baseRevision is not a number", async () => {
    const res = await POST(req({ editId: "e", baseRevision: "0", ops: okBody.ops }), params("run_1"));
    expect(res.status).toBe(400);
  });

  it("400 when ops is not an array", async () => {
    const res = await POST(req({ editId: "e", baseRevision: 0, ops: {} }), params("run_1"));
    expect(res.status).toBe(400);
  });

  it("400 when ops is empty", async () => {
    const res = await POST(req({ editId: "e", baseRevision: 0, ops: [] }), params("run_1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("empty") });
    expect(applyPlanEdit).not.toHaveBeenCalled();
  });

  it("happy path: 200 { status: 'applied', plan }, tenant-scoped edit", async () => {
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "applied", plan });
    expect(applyPlanEdit).toHaveBeenCalledWith("run_1", "org_1", {
      editId: "edit-1",
      baseRevision: 0,
      ops: okBody.ops,
    });
  });

  it("idempotent replay: a 'noop' returns 200 with the current plan", async () => {
    vi.mocked(applyPlanEdit).mockResolvedValue({ status: "noop", plan } as never);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "noop", plan });
  });

  it("409 on a stale baseRevision (conflict) and returns the current plan to re-render from", async () => {
    vi.mocked(applyPlanEdit).mockResolvedValue({ status: "conflict", plan } as never);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "conflict", plan });
  });

  it("404 when the run is not found", async () => {
    vi.mocked(applyPlanEdit).mockResolvedValue({ status: "invalid", error: "run not found" } as never);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run not found" });
  });

  it("400 for any other invalid (e.g. editing a completed item)", async () => {
    vi.mocked(applyPlanEdit).mockResolvedValue({ status: "invalid", error: "cannot edit a completed item" } as never);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot edit a completed item" });
  });
});
