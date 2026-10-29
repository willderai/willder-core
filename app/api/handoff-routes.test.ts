import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for the Handoff agent routes (UC6): POST
// /api/agents/:id/handoff (grant → scoped capability → run agent → persist Brief)
// and GET /api/briefs/:id (tenant-scoped read). Deps (Clerk/Prisma/access-check/
// capability-provisioning/agent-runner) mocked — we test auth, validation, the
// access-check short-circuit before any agent run, tenant scoping, and whatever the
// route actually does when the agent runner throws.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The real scope helpers, so a malformed scopePath is refused the way the route refuses
// it; only the grant decision is stubbed.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));
vi.mock("@/lib/handoff-agent", () => ({ provisionHandoffAgentCapability: vi.fn() }));
vi.mock("@/services/agents/runner", () => ({ runHandoffAgent: vi.fn() }));
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
    briefProvenance: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { provisionHandoffAgentCapability } from "@/lib/handoff-agent";
import { runHandoffAgent } from "@/services/agents/runner";
import { db } from "@/lib/db";

import { POST as handoffPOST } from "./agents/[id]/handoff/route";
import { GET as briefGET } from "./briefs/[id]/route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/agents/agent_1/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const stubAgentRow = {
  active: true,
  id: "agent_1",
  agentKey: "handoff-agent",
  name: "Handoff agent",
  role: "handoff",
  model: "qwen/qwen3-32b",
  systemPrompt: "brief",
  tools: [],
  settings: {},
};

const stubResult = {
  title: "Briefing for Jamie",
  summary: "Summary of engineering scope.",
  sections: [{ heading: "Architecture", content: "Uses Postgres + ltree." }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgentRow as never);
  vi.mocked(provisionHandoffAgentCapability).mockResolvedValue("wcap_test");
  vi.mocked(runHandoffAgent).mockResolvedValue(stubResult as never);
  vi.mocked(db.brief.create).mockResolvedValue({ id: "brief_1", ...stubResult } as never);
});

describe("POST /api/agents/:id/handoff", () => {
  it("happy path: 200, creates a Brief with the right fields", async () => {
    const res = await handoffPOST(
      req({ scopePath: "org_1.engineering", granteeName: "Jamie", granteeRole: "Contractor", context: "onboarding" }),
      params({ id: "agent_1" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.brief).toMatchObject({ id: "brief_1", title: "Briefing for Jamie" });

    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(db.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "agent_1", orgId: "org_1", role: "handoff" } }),
    );
    expect(provisionHandoffAgentCapability).toHaveBeenCalledWith("org_1", "org_1.engineering", "user_42");
    expect(runHandoffAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRow: stubAgentRow,
        granteeName: "Jamie",
        granteeRole: "Contractor",
        context: "onboarding",
        orgId: "org_1",
        capabilityToken: "wcap_test",
        memoryScope: "org_1.engineering",
      }),
    );
    expect(db.brief.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          type: "handoff",
          granteeName: "Jamie",
          granteeRole: "Contractor",
          scopePath: "org_1.engineering",
          title: stubResult.title,
          summary: stubResult.summary,
          sections: stubResult.sections,
        }),
      }),
    );
  });

  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await handoffPOST(
      req({ scopePath: "org_1.engineering", granteeName: "Jamie" }),
      params({ id: "agent_1" }),
    );
    expect(res.status).toBe(401);
  });

  it("400 when scopePath is missing", async () => {
    const res = await handoffPOST(req({ granteeName: "Jamie" }), params({ id: "agent_1" }));
    expect(res.status).toBe(400);
  });

  it("400 when scopePath is whitespace-only — normalizeScopePath collapses it to undefined instead of reaching check()/the ltree cast as a truthy non-ltree string", async () => {
    const res = await handoffPOST(req({ scopePath: "   ", granteeName: "Jamie" }), params({ id: "agent_1" }));
    expect(res.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect(provisionHandoffAgentCapability).not.toHaveBeenCalled();
    expect(runHandoffAgent).not.toHaveBeenCalled();
    expect(db.brief.create).not.toHaveBeenCalled();
  });

  it("400 when granteeName is missing", async () => {
    const res = await handoffPOST(req({ scopePath: "org_1.engineering" }), params({ id: "agent_1" }));
    expect(res.status).toBe(400);
  });

  it.each([
    ["malformed", "org_1.deal A", "not a valid scope path"],
    // Valid ltree, but persisted and later written to, so a dash (which reads as a dot) is refused.
    ["dashed", "org_1.deal-A", "holds a dash"],
  ])(
    "403 + audits a deny when scopePath is %s — never reaches check()'s ltree cast raw, never silently widened",
    async (_, scopePath, why) => {
      const res = await handoffPOST(req({ scopePath, granteeName: "Jamie" }), params({ id: "agent_1" }));
      // Write direction: a required, caller-supplied scopePath drives a minted
      // capability + a persisted Brief.scopePath, so there's no safe fallback —
      // refuse and audit, never widen.
      expect(res.status).toBe(403);
      expect(check).not.toHaveBeenCalled();
      expect(provisionHandoffAgentCapability).not.toHaveBeenCalled();
      expect(runHandoffAgent).not.toHaveBeenCalled();
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
    const res = await handoffPOST(req({ scopePath: "org_1.sales", granteeName: "Jamie" }), params({ id: "agent_1" }));
    expect(res.status).toBe(403);
    // The access check must short-circuit before any capability is
    // minted or the agent is run — no LLM call ever happens on a denied scope.
    expect(provisionHandoffAgentCapability).not.toHaveBeenCalled();
    expect(runHandoffAgent).not.toHaveBeenCalled();
    expect(db.brief.create).not.toHaveBeenCalled();
  });

  it("404 when no handoff-role agent exists for this org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await handoffPOST(
      req({ scopePath: "org_1.engineering", granteeName: "Jamie" }),
      params({ id: "agent_1" }),
    );
    expect(res.status).toBe(404);
    expect(provisionHandoffAgentCapability).not.toHaveBeenCalled();
    expect(runHandoffAgent).not.toHaveBeenCalled();
  });

  it("propagates when the agent runner throws (route has no try/catch around runHandoffAgent)", async () => {
    vi.mocked(runHandoffAgent).mockRejectedValue(new Error("LLM blew up"));
    await expect(
      handoffPOST(req({ scopePath: "org_1.engineering", granteeName: "Jamie" }), params({ id: "agent_1" })),
    ).rejects.toThrow("LLM blew up");
    expect(db.brief.create).not.toHaveBeenCalled();
  });

  it("stores the sources the agent run read with the brief, from the set the run filled", async () => {
    vi.mocked(runHandoffAgent).mockImplementation(async (opts) => {
      opts.sourcesRead?.add("src_slack");
      opts.sourcesRead?.add("src_drive");
      return stubResult as never;
    });

    const res = await handoffPOST(
      req({ scopePath: "org_1.engineering", granteeName: "Jamie" }),
      params({ id: "agent_1" }),
    );

    expect(res.status).toBe(200);
    expect(db.briefProvenance.create).toHaveBeenCalledWith({
      data: { briefId: "brief_1", sourceIds: ["src_drive", "src_slack"] },
    });
  });

  // GET /api/briefs/:id/staleness uses Brief.createdAt as its lower bound.
  // Letting Prisma's own
  // @default(now()) stamp createdAt at INSERT time (after the agent run)
  // silently excludes a write that lands during generation, which is exactly
  // the window this feature claims to cover. createdAt must instead reflect
  // when generation started, not when the row landed.
  it("stamps Brief.createdAt from before the agent run, not from row-insert time", async () => {
    const beforeCall = Date.now();
    vi.mocked(runHandoffAgent).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return stubResult as never;
    });
    const res = await handoffPOST(
      req({ scopePath: "org_1.engineering", granteeName: "Jamie" }),
      params({ id: "agent_1" }),
    );
    const afterInsert = Date.now();
    expect(res.status).toBe(200);

    const createCall = vi.mocked(db.brief.create).mock.calls[0][0] as { data: { createdAt: Date } };
    const createdAt = createCall.data.createdAt;
    expect(createdAt).toBeInstanceOf(Date);
    // Captured right before the (30ms-delayed) agent run started...
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeCall);
    // ...not at insert time, comfortably after the delay completed.
    expect(createdAt.getTime()).toBeLessThan(afterInsert - 15);
  });
});

describe("GET /api/briefs/:id", () => {
  const stubBrief = { id: "brief_1", orgId: "org_1", scopePath: "org_1.engineering", title: "Briefing for Jamie" };

  it("happy path: 200 with the brief", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stubBrief as never);
    const res = await briefGET(new Request("http://t"), params({ id: "brief_1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.brief).toEqual(stubBrief);
    expect(db.brief.findFirst).toHaveBeenCalledWith({
      where: { id: "brief_1", orgId: "org_1", retirements: { none: {} } },
    });
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: stubBrief.scopePath });
  });

  it("404, same as an absent id, when the reader's grant on the brief's own scope no longer covers it", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stubBrief as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" });
    const res = await briefGET(new Request("http://t"), params({ id: "brief_1" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "brief not found" });
  });

  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await briefGET(new Request("http://t"), params({ id: "brief_1" }));
    expect(res.status).toBe(401);
  });

  it("404 when the brief does not exist", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
    const res = await briefGET(new Request("http://t"), params({ id: "missing" }));
    expect(res.status).toBe(404);
  });

  it("404 for cross-org isolation: a brief belonging to a different org is never returned", async () => {
    // db.brief.findFirst is called scoped to this org, so a brief owned by another
    // org simply won't match — the mock proves the route always filters by orgId.
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
    const res = await briefGET(new Request("http://t"), params({ id: "brief_owned_by_org_2" }));
    expect(res.status).toBe(404);
    expect(db.brief.findFirst).toHaveBeenCalledWith({
      where: { id: "brief_owned_by_org_2", orgId: "org_1", retirements: { none: {} } },
    });
  });
});
