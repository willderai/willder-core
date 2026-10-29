import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for POST /api/runs/[runId]/reply — the "reply to the AI agent"
// follow-up on a FINISHED run. Fully mocked (no db, no manager engine, no LLM): we test
// the wiring/gating + that the follow-up is routed THROUGH THE MANAGER mechanism (NOT the
// single-agent redirect path), seeded with (prior brief as context + the reply as the
// directive), and that non-repliable states / unsupported roles are refused.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The run's agent is active here; refusing a deactivated one is proven against a
// real database in app/api/agents/[id]/deactivated-agent-runs.realdb.test.ts.
vi.mock("@/services/agents/agent-active", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/agent-active")>()),
  isAgentDeactivated: vi.fn(async () => false),
}));
vi.mock("@/services/agents/run-visibility", () => ({ findReadableRunWithBrief: vi.fn() }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/agents/manager", () => ({
  createQaManagerRun: vi.fn(),
  createArchManagerRun: vi.fn(),
  driveManager: vi.fn(),
}));

import { requireAccessContext } from "@/lib/access-context";
import { findReadableRunWithBrief } from "@/services/agents/run-visibility";
import { createQaManagerRun, createArchManagerRun, driveManager } from "@/services/agents/manager";

import { POST } from "./route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/runs/run_prev/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

const qaRun = {
  id: "run_prev",
  agentId: "agent_qa",
  phase: "done",
  briefId: "brief_1",
  meta: {
    type: "qa-interactive",
    agentRole: "qa",
    target: { baseUrl: "https://api.acme.com" },
    focus: "hammer /search",
    mode: "api",
    scopePath: "org_1.engineering",
  },
};

const archRun = {
  id: "run_prev",
  agentId: "agent_arch",
  phase: "done",
  briefId: "brief_2",
  meta: {
    type: "architecture-interactive",
    agentRole: "architecture",
    scopePath: "org_1.engineering",
    prompt: "plan the billing rearchitecture",
    context: "existing framing",
  },
};

/** The run (and the brief it produced) findReadableRunWithBrief hands back; null = hidden. */
const readable = (run: object | null, brief: object | null = null) =>
  vi.mocked(findReadableRunWithBrief).mockResolvedValue((run && { run, brief }) as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  readable(qaRun, { title: "QA report", summary: "3 endpoints failed under load.", type: "qa_review" });
  vi.mocked(createQaManagerRun).mockResolvedValue("run_new");
  vi.mocked(createArchManagerRun).mockResolvedValue("run_new");
  vi.mocked(driveManager).mockResolvedValue(undefined);
});

describe("POST /api/runs/:runId/reply", () => {
  it("401 without a session, never touches the db", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await POST(req({ message: "hi" }), params("run_prev"));
    expect(res.status).toBe(401);
    expect(findReadableRunWithBrief).not.toHaveBeenCalled();
  });

  it("400 when message is empty/blank", async () => {
    const res = await POST(req({ message: "   " }), params("run_prev"));
    expect(res.status).toBe(400);
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("404 when the run is absent or hidden from the caller, and never creates or drives a run", async () => {
    readable(null);
    const res = await POST(req({ message: "redo it" }), params("run_prev"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run not found" });
    expect(findReadableRunWithBrief).toHaveBeenCalledWith(member.ctx, "org_1", "run_prev");
    expect(createQaManagerRun).not.toHaveBeenCalled();
    expect(driveManager).not.toHaveBeenCalled();
  });

  it("409 when the run is not finished (reply only on a completed run)", async () => {
    readable({ ...qaRun, phase: "executing" });
    const res = await POST(req({ message: "redo it" }), params("run_prev"));
    expect(res.status).toBe(409);
    expect(createQaManagerRun).not.toHaveBeenCalled();
    expect(driveManager).not.toHaveBeenCalled();
  });

  it("400 for an unsupported agent role, gracefully (no run created)", async () => {
    readable({ ...qaRun, meta: { type: "handoff-interactive", agentRole: "handoff" } });
    const res = await POST(req({ message: "redo it" }), params("run_prev"));
    expect(res.status).toBe(400);
    expect(createQaManagerRun).not.toHaveBeenCalled();
    expect(createArchManagerRun).not.toHaveBeenCalled();
  });

  it("QA happy path: triggers a MANAGER run (not a single-agent run) seeded with reply + prior brief + original focus, then drives the manager", async () => {
    const res = await POST(req({ message: "also check rate limits" }), params("run_prev"));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: "run_new" });

    // Routed through the MANAGER mechanism.
    expect(createQaManagerRun).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createQaManagerRun).mock.calls[0][0];
    expect(arg).toMatchObject({
      orgId: "org_1",
      agentId: "agent_qa",
      triggeredBy: "user_42",
      target: { baseUrl: "https://api.acme.com" },
      mode: "api",
      scopePath: "org_1.engineering",
    });
    // The reply is threaded as the directive (feedback).
    expect(arg.focus).toContain("also check rate limits");
    // The prior brief is carried as context.
    expect(arg.focus).toContain("3 endpoints failed under load.");
    // The original focus is preserved.
    expect(arg.focus).toContain("hammer /search");
    // Driven by the MANAGER engine, not driveRun.
    expect(driveManager).toHaveBeenCalledWith("run_new");
  });

  it("Architecture happy path: MANAGER run with the reply as the prompt/directive, prior brief folded into context", async () => {
    readable(archRun, { title: "Billing plan", summary: "Chosen: event-sourced ledger.", type: "architecture_plan" });
    const res = await POST(req({ message: "redo assuming 10x traffic" }), params("run_prev"));
    expect(res.status).toBe(201);

    expect(createArchManagerRun).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createArchManagerRun).mock.calls[0][0];
    expect(arg).toMatchObject({
      agentId: "agent_arch",
      scopePath: "org_1.engineering",
      prompt: "redo assuming 10x traffic",
    });
    expect(arg.context).toContain("existing framing");
    expect(arg.context).toContain("Chosen: event-sourced ledger.");
    expect(createQaManagerRun).not.toHaveBeenCalled();
    expect(driveManager).toHaveBeenCalledWith("run_new");
  });
});
