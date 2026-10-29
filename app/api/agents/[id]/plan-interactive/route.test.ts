import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for POST /api/agents/[id]/plan-interactive (docs/design_
// architecture_agent_v2.md §3). Mirrors the QA /run-interactive route test spine, but
// gated to role:"architecture" and with the arch body (scopePath + prompt, no target):
// requireAccessContext → 401; scopePath missing → 400; prompt missing → 400; find a
// role:"architecture" agent → 404; the human must pass check() memory.read → 403
// (short-circuits before any run is created); then createArchInteractiveRun + driveRun
// → 201 { runId }. The loop engine is mocked — we test wiring/gating, not the run.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The real scope helpers, so a malformed scopePath is refused the way the route refuses
// it; only the grant decision is stubbed.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) },
  },
}));
// after() runs the callback immediately so we can assert the background drive was scheduled.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/services/agents/run-loop", () => ({
  createArchInteractiveRun: vi.fn(),
  driveRun: vi.fn(),
  normalizeRunAttachments: vi.fn((raw?: { name?: unknown; content?: unknown }[]) =>
    Array.isArray(raw) && raw.length > 0 ? raw : undefined,
  ),
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { createArchInteractiveRun, driveRun } from "@/services/agents/run-loop";

import { POST } from "./route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/agents/agent_arch/plan-interactive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const okBody = { scopePath: "org_1.engineering", prompt: "plan the billing rearchitecture" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_arch", active: true } as never);
  vi.mocked(createArchInteractiveRun).mockResolvedValue("run_1");
  vi.mocked(driveRun).mockResolvedValue(undefined);
});

describe("POST /api/agents/:id/plan-interactive", () => {
  it("401 without a session, never creates a run", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await POST(req(okBody), params({ id: "agent_arch" }));
    expect(res.status).toBe(401);
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
  });

  it("400 when scopePath is missing", async () => {
    const res = await POST(req({ prompt: "plan it" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("scopePath") });
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
  });

  it("400 when prompt is missing", async () => {
    const res = await POST(req({ scopePath: "org_1.engineering" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("prompt") });
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
  });

  it("400 when scopePath/prompt are blank whitespace", async () => {
    const res = await POST(req({ scopePath: "   ", prompt: "   " }), params({ id: "agent_arch" }));
    expect(res.status).toBe(400);
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
  });

  it("404 when no architecture-role agent exists for this org (tenant-scoped lookup)", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null as never);
    const res = await POST(req(okBody), params({ id: "agent_arch" }));
    expect(res.status).toBe(404);
    expect(db.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "agent_arch", orgId: "org_1", role: "architecture" } }),
    );
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "org_1.deal A", "not a valid scope path"],
    // Valid ltree, but the plan's runs persist briefs at it, so a dash (which reads as a dot) is refused.
    ["dashed", "org_1.deal-A", "holds a dash"],
  ])(
    "403 + audits a deny when scopePath is %s — never reaches check()'s ltree cast raw, never silently widened",
    async (_, scopePath, why) => {
      const res = await POST(
        req({ scopePath, prompt: "plan the billing rearchitecture" }),
        params({ id: "agent_arch" }),
      );
      // Write direction: a required, caller-supplied scopePath drives a minted
      // capability + a persisted run, so there's no safe fallback — refuse and
      // audit, never widen.
      expect(res.status).toBe(403);
      expect(check).not.toHaveBeenCalled();
      expect(createArchInteractiveRun).not.toHaveBeenCalled();
      expect(driveRun).not.toHaveBeenCalled();
      // The failed attempt is on the record.
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orgId: "org_1",
            actorId: "user_42",
            decision: "deny",
            target: scopePath,
          }),
        }),
      );
      expect(await res.json()).toMatchObject({ error: expect.stringContaining(why) });
    },
  );

  it("403 when the human lacks read access to the scope, and never creates or drives a run", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" } as never);
    const res = await POST(req(okBody), params({ id: "agent_arch" }));
    expect(res.status).toBe(403);
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
    expect(driveRun).not.toHaveBeenCalled();
  });

  it("happy path: 201 { runId }, creates the run with the threaded args and drives the loop", async () => {
    const res = await POST(
      req({
        scopePath: "  org_1.engineering  ",
        prompt: "  plan the billing rearchitecture  ",
        context: "greenfield service",
        attachmentIds: ["att_1", "att_2"],
        autopilot: true,
      }),
      params({ id: "agent_arch" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: "run_1" });

    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(createArchInteractiveRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        agentId: "agent_arch",
        triggeredBy: "user_42",
        // scopePath + prompt are trimmed before use.
        scopePath: "org_1.engineering",
        prompt: "plan the billing rearchitecture",
        context: "greenfield service",
        attachmentIds: ["att_1", "att_2"],
        autopilot: true,
      }),
    );
    expect(driveRun).toHaveBeenCalledWith("run_1", "org_1");
  });

  it("defaults autopilot to false", async () => {
    await POST(req(okBody), params({ id: "agent_arch" }));
    expect(createArchInteractiveRun).toHaveBeenCalledWith(expect.objectContaining({ autopilot: false }));
  });
});
