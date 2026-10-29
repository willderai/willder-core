import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for POST /api/agents/[id]/run-manager (the supervised QA manager route).
// Same auth spine as /run-interactive PLUS a flag gate: qaManagerEnabled() OFF → 404 (the
// surface does not exist). When enabled: requireAccessContext → 401; validate target.baseUrl
// (+ openApiUrl) → 400; find a role:"qa" agent → 404; every run requires check() memory.read
// (its scope, or the org root when scope-less) → 403 (short-circuits before any run is
// created); then createQaManagerRun + driveManager → 201 { runId }. The manager engine is mocked — we test wiring/gating, not the run.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({
  check: vi.fn(),
  normalizeScopePath: (s?: string) => (s?.trim() ? s.trim() : undefined),
  // Real semantics (services/access/check.ts): a space is never a label; a dash is ltree but
  // refused below the org root, since the run stores briefs at the path.
  isMintableScopePath: (s: string) =>
    s.split(".").every((label) => /^[A-Za-z0-9_-]+$/.test(label)) &&
    !s
      .split(".")
      .slice(1)
      .some((label) => label.includes("-")),
  orgRootPath: (orgId: string) => `org_${orgId}`,
}));
vi.mock("@/lib/db", () => ({ db: { agent: { findFirst: vi.fn() } } }));
// after() runs the callback immediately so we can assert the background drive was scheduled.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/services/agents/manager", () => ({
  qaManagerEnabled: vi.fn(),
  createQaManagerRun: vi.fn(),
  driveManager: vi.fn(),
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { qaManagerEnabled, createQaManagerRun, driveManager } from "@/services/agents/manager";

import { POST } from "./route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/agents/agent_qa/run-manager", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const okBody = { target: { baseUrl: "https://api.acme.com" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(qaManagerEnabled).mockReturnValue(true);
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_qa", active: true } as never);
  vi.mocked(createQaManagerRun).mockResolvedValue("run_1");
  vi.mocked(driveManager).mockResolvedValue(undefined);
});

describe("POST /api/agents/:id/run-manager", () => {
  it("404 (disabled) when the QA_MANAGER flag is OFF, and never authenticates or creates a run", async () => {
    vi.mocked(qaManagerEnabled).mockReturnValue(false);
    const res = await POST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("disabled") });
    expect(requireAccessContext).not.toHaveBeenCalled();
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("401 without a session, never creates a run", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await POST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(401);
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("400 when target.baseUrl is missing", async () => {
    const res = await POST(req({}), params({ id: "agent_qa" }));
    expect(res.status).toBe(400);
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("400 when target.baseUrl is not a valid URL", async () => {
    const res = await POST(req({ target: { baseUrl: "not a url" } }), params({ id: "agent_qa" }));
    expect(res.status).toBe(400);
  });

  it("400 when target.baseUrl is not http(s)", async () => {
    const res = await POST(req({ target: { baseUrl: "ftp://api.acme.com" } }), params({ id: "agent_qa" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("http(s)") });
  });

  it("400 when openApiUrl is present but not a valid http(s) URL", async () => {
    const res = await POST(
      req({ target: { baseUrl: "https://api.acme.com", openApiUrl: "wss://x" } }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(400);
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("404 when no qa-role agent exists for this org (tenant-scoped lookup)", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null as never);
    const res = await POST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(404);
    expect(db.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "agent_qa", orgId: "org_1", role: "qa" } }),
    );
    expect(createQaManagerRun).not.toHaveBeenCalled();
  });

  it("403 when the human lacks read access to a scoped run, and never creates or drives a run", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" } as never);
    const res = await POST(
      req({ target: { baseUrl: "https://api.acme.com" }, scopePath: "org_1.sales" }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(403);
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.sales" });
    expect(createQaManagerRun).not.toHaveBeenCalled();
    expect(driveManager).not.toHaveBeenCalled();
  });

  it("checks memory.read on the org root for a scope-less run, where its brief is stored", async () => {
    const res = await POST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(201);
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_org_1" });
  });

  it("403 for a scope-less run when the human cannot read the org root, and never creates or drives a run", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" } as never);
    const res = await POST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(403);
    expect(createQaManagerRun).not.toHaveBeenCalled();
    expect(driveManager).not.toHaveBeenCalled();
  });

  it("an empty-string scopePath is treated the same as no scope at all — checked against the org root and never reaches createQaManagerRun as an empty string", async () => {
    const res = await POST(
      req({ scopePath: "", target: { baseUrl: "https://api.acme.com" } }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(201);
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_org_1" });
    expect(createQaManagerRun).toHaveBeenCalledWith(expect.objectContaining({ scopePath: undefined }));
  });

  it.each(["org_1.deal A", "org_1.deal-A"])(
    "a malformed or dashed non-empty scopePath (%j) falls back to the org root instead of reaching check()'s ltree cast raw",
    async (scopePath) => {
      const res = await POST(
        req({ scopePath, target: { baseUrl: "https://api.acme.com" } }),
        params({ id: "agent_qa" }),
      );
      // Discarded and treated as a scope-less run, so the org root is what gets
      // checked; never thrown as a raw Postgres error.
      expect(res.status).toBe(201);
      expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_org_1" });
      expect(createQaManagerRun).toHaveBeenCalledWith(expect.objectContaining({ scopePath: undefined }));
    },
  );

  it("happy path: 201 { runId }, creates the run with threaded args and drives the manager in the background", async () => {
    const res = await POST(
      req({
        scopePath: "org_1.engineering",
        target: { baseUrl: "  https://api.acme.com  ", allowedHosts: ["api.acme.com"], authHeader: "Bearer x" },
        focus: "hammer /search",
        mode: "browser",
        stoppingMode: "coverage-complete",
      }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: "run_1" });

    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(createQaManagerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        agentId: "agent_qa",
        triggeredBy: "user_42",
        target: expect.objectContaining({
          baseUrl: "https://api.acme.com",
          allowedHosts: ["api.acme.com"],
          authHeader: "Bearer x",
        }),
        focus: "hammer /search",
        mode: "browser",
        scopePath: "org_1.engineering",
        stoppingMode: "coverage-complete",
      }),
    );
    expect(driveManager).toHaveBeenCalledWith("run_1");
  });

  it("defaults mode to 'api' when omitted", async () => {
    await POST(req(okBody), params({ id: "agent_qa" }));
    expect(createQaManagerRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "api" }));
  });
});
