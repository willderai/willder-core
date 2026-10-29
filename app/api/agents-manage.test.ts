import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for agent management routes: POST /api/agents (create custom agent)
// and PATCH /api/agents/:id (update prompt/tools/model/active). Deps mocked.
// The access decision is stubbed to allow, so these cover request validation and
// what is written; who may edit, against real grants, is
// app/api/agent-config-access.realdb.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/services/access", async (original) => {
  const allow = { allowed: true, reason: "allowed" };
  return {
    ...(await original<object>()),
    check: vi.fn(async () => allow),
  };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";

import { POST as agentsPOST } from "./agents/route";
import { PATCH as agentPATCH } from "./agents/[id]/route";

const editor = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const req = (body: unknown, method = "POST") =>
  new Request("http://t", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(editor as never);
});

// ---------------------------------------------------------------------------
// POST /api/agents
// ---------------------------------------------------------------------------

describe("POST /api/agents", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await agentsPOST(req({}))).status).toBe(401);
  });

  it("403 and nothing created when the caller may not manage access", async () => {
    vi.mocked(check).mockResolvedValueOnce({ allowed: false, reason: "needs admin" } as never);
    const res = await agentsPOST(req({ name: "My agent" }));
    expect(res.status).toBe(403);
    expect(db.agent.create).not.toHaveBeenCalled();
  });

  it("422 when name is missing", async () => {
    const res = await agentsPOST(req({ tools: [] }));
    expect(res.status).toBe(422);
  });

  it("422 when name exceeds 80 characters", async () => {
    const res = await agentsPOST(req({ name: "x".repeat(81) }));
    expect(res.status).toBe(422);
  });

  it("422 when an unknown tool key is provided", async () => {
    const res = await agentsPOST(req({ name: "My agent", tools: ["nonexistent_tool"] }));
    expect(res.status).toBe(422);
  });

  it("422 when systemPrompt exceeds 4000 characters", async () => {
    const res = await agentsPOST(req({ name: "A", systemPrompt: "x".repeat(4001) }));
    expect(res.status).toBe(422);
  });

  it("201 creates an agent with only required fields (name)", async () => {
    vi.mocked(db.agent.create).mockResolvedValue({
      id: "ag_1",
      orgId: "org_1",
      agentKey: "custom-123",
      name: "My agent",
      role: "custom",
      systemPrompt: null,
      tools: [],
      model: null,
    } as never);

    const res = await agentsPOST(req({ name: "My agent" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.agent.name).toBe("My agent");
    expect(db.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          name: "My agent",
          role: "custom",
          tools: [],
        }),
      }),
    );
  });

  it("201 creates an agent with all optional fields", async () => {
    vi.mocked(db.agent.create).mockResolvedValue({
      id: "ag_2",
      name: "Research v2",
      role: "custom",
      systemPrompt: "You are a researcher",
      tools: ["web_search"],
      model: "qwen/qwen3-32b",
    } as never);

    const res = await agentsPOST(
      req({
        name: "Research v2",
        systemPrompt: "You are a researcher",
        tools: ["web_search"],
        model: "qwen/qwen3-32b",
      }),
    );
    expect(res.status).toBe(201);
    expect(db.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemPrompt: "You are a researcher",
          tools: ["web_search"],
          model: "qwen/qwen3-32b",
        }),
      }),
    );
  });

  it("agentKey is generated with a custom- prefix (not user-controlled)", async () => {
    vi.mocked(db.agent.create).mockResolvedValue({ id: "ag_3", name: "X" } as never);
    await agentsPOST(req({ name: "X" }));
    const key: string = vi.mocked(db.agent.create).mock.calls[0][0].data.agentKey;
    expect(key).toMatch(/^custom-\d+$/);
  });

  it("agent is always scoped to the caller's org", async () => {
    vi.mocked(db.agent.create).mockResolvedValue({ id: "ag_4", name: "Y" } as never);
    await agentsPOST(req({ name: "Y" }));
    expect(db.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orgId: "org_1" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/agents/:id
// ---------------------------------------------------------------------------

const stubAgent = { id: "ag_1", orgId: "org_1", name: "Copy", role: "copy" };

describe("PATCH /api/agents/:id", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await agentPATCH(req({}, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(401);
  });

  it("a caller who may not manage access is refused before any lookup, alike for a missing and a real id", async () => {
    const refusal = { allowed: false, reason: "needs admin" };
    vi.mocked(check)
      .mockResolvedValueOnce(refusal as never)
      .mockResolvedValueOnce(refusal as never);
    vi.mocked(db.agent.findFirst).mockImplementation((async (args: { where: { id: string } }) =>
      args.where.id === stubAgent.id ? stubAgent : null) as never);

    const missing = await agentPATCH(req({ name: "New" }, "PATCH"), params({ id: "ag_x" }));
    const real = await agentPATCH(req({ name: "New" }, "PATCH"), params({ id: stubAgent.id }));

    expect(real.status).toBe(403);
    expect({ status: real.status, body: await real.json() }).toEqual({
      status: missing.status,
      body: await missing.json(),
    });
    expect(db.agent.findFirst).not.toHaveBeenCalled();
    expect(db.agent.update).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(editor.ctx, {
      action: "access.manage",
      scope: "org_org_1",
      target: `agent:${stubAgent.id}:edit`,
    });
  });

  it("404 when the agent is not in this org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await agentPATCH(req({ name: "New" }, "PATCH"), params({ id: "ag_x" }));
    expect(res.status).toBe(404);
  });

  it("422 when name is empty string", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    const res = await agentPATCH(req({ name: "" }, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(422);
  });

  it("422 when an invalid tool key is given", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    const res = await agentPATCH(req({ tools: ["bad_tool"] }, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(422);
  });

  it("200 updates name", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    vi.mocked(db.agent.update).mockResolvedValue({ ...stubAgent, name: "Renamed" } as never);
    const res = await agentPATCH(req({ name: "Renamed" }, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(200);
    expect(db.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ag_1" }, data: { name: "Renamed" } }),
    );
  });

  it("200 updates active flag to false", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    vi.mocked(db.agent.update).mockResolvedValue({ ...stubAgent, active: false } as never);
    const res = await agentPATCH(req({ active: false }, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(200);
    expect(db.agent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { active: false } }));
  });

  it("200 clears systemPrompt when set to null", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    vi.mocked(db.agent.update).mockResolvedValue({ ...stubAgent, systemPrompt: null } as never);
    const res = await agentPATCH(req({ systemPrompt: null }, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(200);
    expect(db.agent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { systemPrompt: null } }));
  });

  it("200 updates tools list", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    vi.mocked(db.agent.update).mockResolvedValue({ ...stubAgent, tools: ["web_search", "scrape"] } as never);
    const res = await agentPATCH(req({ tools: ["web_search", "scrape"] }, "PATCH"), params({ id: "ag_1" }));
    expect(res.status).toBe(200);
    expect(db.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tools: ["web_search", "scrape"] } }),
    );
  });

  it("update is scoped: findFirst uses both id AND orgId", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgent as never);
    vi.mocked(db.agent.update).mockResolvedValue(stubAgent as never);
    await agentPATCH(req({ active: true }, "PATCH"), params({ id: "ag_1" }));
    expect(db.agent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ag_1", orgId: "org_1" } }));
  });
});
