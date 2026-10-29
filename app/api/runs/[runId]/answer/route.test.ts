import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for POST /api/runs/[runId]/answer (docs/design_interactive_agent_
// loop.md §4). requireAccessContext → 401; validate the ResumePayload → 400; resumeRun
// (tenant-scoped) maps { invalid "run not found" → 404, other invalid → 400 }; a
// "resumed" drives execution (backgrounded), a "noop" (idempotent duplicate) does not.
// resumeRun/driveRun are mocked — we test wiring + status→HTTP mapping.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The run's agent is active here; refusing a deactivated one is proven against a
// real database in app/api/agents/[id]/deactivated-agent-runs.realdb.test.ts.
vi.mock("@/services/agents/agent-active", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/agent-active")>()),
  isAgentDeactivated: vi.fn(async () => false),
}));
vi.mock("@/services/agents/run-visibility", () => ({ findReadableRun: vi.fn() }));
vi.mock("@/services/agents/run-loop", () => ({ resumeRun: vi.fn(), driveRun: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { findReadableRun } from "@/services/agents/run-visibility";
import { resumeRun, driveRun } from "@/services/agents/run-loop";

import { POST } from "./route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/runs/run_1/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

const okBody = {
  checkpointId: "consult-run_1",
  answers: [{ questionId: "peak-traffic", answer: { kind: "number", value: 99 } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(findReadableRun).mockResolvedValue({ id: "run_1" } as never);
  vi.mocked(resumeRun).mockResolvedValue({ status: "resumed" });
  vi.mocked(driveRun).mockResolvedValue(undefined);
});

describe("POST /api/runs/:runId/answer", () => {
  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(401);
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("404 when the run is hidden from the caller, the same answer as an absent run", async () => {
    vi.mocked(findReadableRun).mockResolvedValue(null);
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run not found" });
    expect(findReadableRun).toHaveBeenCalledWith(member.ctx, "org_1", "run_1");
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("400 when checkpointId is missing", async () => {
    const res = await POST(req({ answers: [] }), params("run_1"));
    expect(res.status).toBe(400);
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("400 when answers is not an array", async () => {
    const res = await POST(req({ checkpointId: "c", answers: "nope" }), params("run_1"));
    expect(res.status).toBe(400);
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("happy path: 200 { status: 'resumed' }, resumes tenant-scoped and drives execution", async () => {
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "resumed" });
    expect(resumeRun).toHaveBeenCalledWith("run_1", "org_1", {
      checkpointId: "consult-run_1",
      answers: okBody.answers,
    });
    expect(driveRun).toHaveBeenCalledWith("run_1", "org_1");
  });

  it("idempotent: a 'noop' returns 200 and does NOT drive execution", async () => {
    vi.mocked(resumeRun).mockResolvedValue({ status: "noop" });
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "noop" });
    expect(driveRun).not.toHaveBeenCalled();
  });

  it("404 when resumeRun reports the run was not found", async () => {
    vi.mocked(resumeRun).mockResolvedValue({ status: "invalid", error: "run not found" });
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run not found" });
    expect(driveRun).not.toHaveBeenCalled();
  });

  it("400 for any other invalid (e.g. mismatched checkpointId)", async () => {
    vi.mocked(resumeRun).mockResolvedValue({
      status: "invalid",
      error: "checkpointId does not match the open checkpoint",
    });
    const res = await POST(req(okBody), params("run_1"));
    expect(res.status).toBe(400);
    expect(driveRun).not.toHaveBeenCalled();
  });
});
