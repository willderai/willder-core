import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for the Architecture agent route (UC7): POST
// /api/agents/:id/architecture — plan/architecture grounded in confirmed memory,
// bounded to a scoped capability. The flow mirrors the Handoff route
// (app/api/handoff-routes.test.ts, the closest analog): requireAccessContext → 401;
// validate scopePath → 400; check() memory.read on the scope → 403 (and the agent
// runner must NOT be invoked when denied); find a
// role:"architecture" agent → 404; provision a scoped capability; run the agent;
// persist a Brief (type "architecture_plan") → 200 { brief }.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The real scope helpers, so a malformed scopePath is refused the way the route refuses
// it; only the grant decision is stubbed.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));
vi.mock("@/lib/architecture-agent", () => ({
  provisionArchitectureAgentCapability: vi.fn(),
  architectureAgentContext: vi.fn(() => ({ orgId: "org_1", actor: { type: "agent", id: "architecture-agent" } })),
}));
vi.mock("@/services/agents/runner", () => ({
  runArchitectureAgent: vi.fn(),
  // The route calls this when the run returns a diagram; keep it a real-ish stub.
  drawioLinkFromMermaid: vi.fn(() => "https://app.diagrams.net/#create=stub"),
}));
// The route imports these for the contradiction→dispute path; the happy-path stub
// returns no contradictions, so they're mocked but not exercised here.
vi.mock("@/services/facts/conflicts", () => ({ resolveContradictions: vi.fn(async () => []) }));
vi.mock("@/services/memory/fact-disputes", () => ({ openFactDispute: vi.fn() }));
// The brief's change event is create-brief.test.ts's subject; here it only has to succeed.
vi.mock("@/services/memory/change-events", () => ({ recordChangeEvent: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    // createBrief (services/memory/create-brief.ts) writes through a transaction; this
    // double runs it against the same mocked client.
    $transaction: vi.fn(function (this: unknown, fn: (tx: unknown) => unknown) {
      return fn(this);
    }),
    agent: { findFirst: vi.fn() },
    brief: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { provisionArchitectureAgentCapability } from "@/lib/architecture-agent";
import { runArchitectureAgent } from "@/services/agents/runner";
import { db } from "@/lib/db";

import { POST as architecturePOST } from "./agents/[id]/architecture/route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/agents/agent_arch/architecture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const stubAgentRow = {
  active: true,
  id: "agent_arch",
  agentKey: "architecture-agent",
  name: "Architecture agent",
  role: "architecture",
  model: "qwen/qwen3-32b",
  systemPrompt: "plan",
  tools: [],
  settings: {},
};

const stubResult = {
  title: "Payments service — architecture plan",
  summary: "A plan grounded in the confirmed engineering decisions in memory.",
  sections: [{ heading: "System design", content: "Postgres + ltree, Graphiti for memory." }],
  milestones: [
    { label: "Schema + migrations", dueDate: "2026-08-01" },
    { label: "Access gate wired", dueDate: "2026-08-10" },
  ],
  diagram: "graph TD; A[API]-->B[(Postgres)];",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgentRow as never);
  vi.mocked(provisionArchitectureAgentCapability).mockResolvedValue("wcap_arch");
  vi.mocked(runArchitectureAgent).mockResolvedValue(stubResult as never);
  vi.mocked(db.brief.create).mockResolvedValue({ id: "brief_arch", ...stubResult } as never);
});

describe("POST /api/agents/:id/architecture", () => {
  it("happy path: 200, persists a Brief with type architecture_plan (+ milestones/diagram)", async () => {
    const res = await architecturePOST(
      req({ scopePath: "org_1.engineering", title: "Payments service", context: "new service" }),
      params({ id: "agent_arch" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.brief).toMatchObject({ id: "brief_arch", title: stubResult.title });

    // The human must be able to read the scope being planned over (same gate as
    // handoff) — checked before any capability is minted or agent run.
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(db.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "agent_arch", orgId: "org_1", role: "architecture" }),
      }),
    );
    expect(provisionArchitectureAgentCapability).toHaveBeenCalledWith("org_1", "org_1.engineering", "user_42");
    expect(runArchitectureAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRow: stubAgentRow,
        orgId: "org_1",
        capabilityToken: "wcap_arch",
        memoryScope: "org_1.engineering",
      }),
    );
    // Brief persisted as an architecture_plan, with milestones + diagram carried
    // through when the runner returns them.
    expect(db.brief.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          type: "architecture_plan",
          scopePath: "org_1.engineering",
          title: stubResult.title,
          summary: stubResult.summary,
          sections: stubResult.sections,
          milestones: stubResult.milestones,
          diagram: stubResult.diagram,
        }),
      }),
    );
  });

  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await architecturePOST(req({ scopePath: "org_1.engineering" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(401);
  });

  it("400 when scopePath is missing", async () => {
    const res = await architecturePOST(req({ title: "Payments" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(400);
    expect(runArchitectureAgent).not.toHaveBeenCalled();
  });

  it("400 when scopePath is whitespace-only — normalizeScopePath collapses it to undefined instead of reaching check()/the ltree cast as a truthy non-ltree string", async () => {
    const res = await architecturePOST(req({ scopePath: "   ", title: "Payments" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect(provisionArchitectureAgentCapability).not.toHaveBeenCalled();
    expect(runArchitectureAgent).not.toHaveBeenCalled();
    expect(db.brief.create).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "org_1.deal A", "not a valid scope path"],
    // Valid ltree, but persisted and later written to, so a dash (which reads as a dot) is refused.
    ["dashed", "org_1.deal-A", "holds a dash"],
  ])(
    "403 + audits a deny when scopePath is %s — never reaches check()'s ltree cast raw, never silently widened",
    async (_, scopePath, why) => {
      const res = await architecturePOST(req({ scopePath, title: "Payments" }), params({ id: "agent_arch" }));
      // Write direction: a required, caller-supplied scopePath drives a minted
      // capability + a persisted Brief.scopePath, so there's no safe fallback —
      // refuse and audit, never widen.
      expect(res.status).toBe(403);
      expect(check).not.toHaveBeenCalled();
      expect(provisionArchitectureAgentCapability).not.toHaveBeenCalled();
      expect(runArchitectureAgent).not.toHaveBeenCalled();
      expect(db.brief.create).not.toHaveBeenCalled();
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

  it("403 when the human lacks read access to the scope, and never invokes the agent runner", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" });
    const res = await architecturePOST(req({ scopePath: "org_1.sales" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(403);
    // A denied scope short-circuits before any capability is minted
    // or the LLM is run — no plan is ever generated on data the human can't read.
    expect(provisionArchitectureAgentCapability).not.toHaveBeenCalled();
    expect(runArchitectureAgent).not.toHaveBeenCalled();
    expect(db.brief.create).not.toHaveBeenCalled();
  });

  it("404 when no architecture-role agent exists for this org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await architecturePOST(req({ scopePath: "org_1.engineering" }), params({ id: "agent_arch" }));
    expect(res.status).toBe(404);
    expect(provisionArchitectureAgentCapability).not.toHaveBeenCalled();
    expect(runArchitectureAgent).not.toHaveBeenCalled();
  });

  it("propagates when the agent runner throws (mirrors handoff: no try/catch around the run)", async () => {
    // Handoff's route lets a runner error propagate (no try/catch), and this route
    // mirrors it.
    vi.mocked(runArchitectureAgent).mockRejectedValue(new Error("LLM blew up"));
    await expect(
      architecturePOST(req({ scopePath: "org_1.engineering" }), params({ id: "agent_arch" })),
    ).rejects.toThrow("LLM blew up");
    expect(db.brief.create).not.toHaveBeenCalled();
  });
});
