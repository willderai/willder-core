import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for the QA agent route (UC8): POST /api/agents/:id/qa. Same auth
// spine as the architecture/handoff routes: requireAccessContext → 401; validate
// scopePath + target.baseUrl (must be a valid http(s) URL) → 400; check() memory.read on
// the scope → 403 (short-circuits before any capability is minted or agent run); find a
// role:"qa" agent → 404; provision a scoped capability; run + persist via
// runAndPersistQaReview → 200 { brief, report }. All deps mocked — we test the wiring,
// not the LLM run.
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
}));
vi.mock("@/lib/qa-agent", () => ({ provisionQaAgentCapability: vi.fn() }));
vi.mock("@/services/agents/qa-run", () => ({ runAndPersistQaReview: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: vi.fn() },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { provisionQaAgentCapability } from "@/lib/qa-agent";
import { runAndPersistQaReview } from "@/services/agents/qa-run";
import { db } from "@/lib/db";

import { POST as qaPOST } from "./[id]/qa/route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body?: unknown) =>
  new Request("http://t/api/agents/agent_qa/qa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const stubAgentRow = {
  active: true,
  id: "agent_qa",
  agentKey: "qa-agent",
  name: "QA agent",
  role: "qa",
  model: "qwen/qwen3-32b",
  systemPrompt: "test it",
  tools: [],
  settings: {},
};

const stubReport = {
  title: "API smoke: acme.com",
  summary: "Core endpoints respond.",
  verdict: "healthy",
  bugs: [],
  performance: [],
  suggestions: [],
};
const stubBrief = { id: "brief_qa", type: "qa_review", title: stubReport.title };

const okBody = { scopePath: "org_1.engineering", target: { baseUrl: "https://api.acme.com" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(db.agent.findFirst).mockResolvedValue(stubAgentRow as never);
  vi.mocked(provisionQaAgentCapability).mockResolvedValue("wcap_qa");
  vi.mocked(runAndPersistQaReview).mockResolvedValue({
    brief: stubBrief,
    report: stubReport,
  } as never);
});

describe("POST /api/agents/:id/qa", () => {
  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await qaPOST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(401);
    expect(runAndPersistQaReview).not.toHaveBeenCalled();
  });

  it("scopePath is optional — a URL-only run proceeds without a capability or check()", async () => {
    const res = await qaPOST(req({ target: { baseUrl: "https://api.acme.com" } }), params({ id: "agent_qa" }));
    expect(res.status).toBe(200);
    // No scope → no memory read to gate and no capability to mint (pure black-box run).
    expect(check).not.toHaveBeenCalled();
    expect(provisionQaAgentCapability).not.toHaveBeenCalled();
    expect(runAndPersistQaReview).toHaveBeenCalledWith(
      expect.objectContaining({ scopePath: undefined, capabilityToken: undefined }),
    );
  });

  it("an empty-string scopePath is treated the same as no scope at all — still gates check() and never reaches runAndPersistQaReview as an empty string", async () => {
    const res = await qaPOST(
      req({ scopePath: "", target: { baseUrl: "https://api.acme.com" } }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(200);
    expect(check).not.toHaveBeenCalled();
    expect(provisionQaAgentCapability).not.toHaveBeenCalled();
    expect(runAndPersistQaReview).toHaveBeenCalledWith(
      expect.objectContaining({ scopePath: undefined, capabilityToken: undefined }),
    );
  });

  it.each(["org_1.deal A", "org_1.deal-A"])(
    "a malformed or dashed non-empty scopePath (%j) falls back to no scope instead of reaching check()'s ltree cast raw",
    async (scopePath) => {
      const res = await qaPOST(
        req({ scopePath, target: { baseUrl: "https://api.acme.com" } }),
        params({ id: "agent_qa" }),
      );
      // Read direction: discarded and falls back to an unscoped run, never thrown
      // as a raw Postgres error and never denied.
      expect(res.status).toBe(200);
      expect(check).not.toHaveBeenCalled();
      expect(provisionQaAgentCapability).not.toHaveBeenCalled();
      expect(runAndPersistQaReview).toHaveBeenCalledWith(
        expect.objectContaining({ scopePath: undefined, capabilityToken: undefined }),
      );
    },
  );

  it("400 when target.baseUrl is missing", async () => {
    const res = await qaPOST(req({ scopePath: "org_1.engineering" }), params({ id: "agent_qa" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("baseUrl") });
    expect(runAndPersistQaReview).not.toHaveBeenCalled();
  });

  it("400 when target.baseUrl is not a valid URL", async () => {
    const res = await qaPOST(
      req({ scopePath: "org_1.engineering", target: { baseUrl: "not a url" } }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(400);
    expect(runAndPersistQaReview).not.toHaveBeenCalled();
  });

  it("400 when target.baseUrl is not http(s) (e.g. ftp/file)", async () => {
    const res = await qaPOST(
      req({ scopePath: "org_1.engineering", target: { baseUrl: "ftp://api.acme.com" } }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("http(s)") });
    expect(runAndPersistQaReview).not.toHaveBeenCalled();
  });

  it("403 when the human lacks read access to the scope, and never mints a capability or runs", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" });
    const res = await qaPOST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(403);
    expect(provisionQaAgentCapability).not.toHaveBeenCalled();
    expect(runAndPersistQaReview).not.toHaveBeenCalled();
  });

  it("404 when no qa-role agent exists for this org", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null);
    const res = await qaPOST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(404);
    expect(provisionQaAgentCapability).not.toHaveBeenCalled();
    expect(runAndPersistQaReview).not.toHaveBeenCalled();
  });

  it("happy path: 200 returns { brief, report } and calls runAndPersistQaReview with the right args (mode defaults to 'api')", async () => {
    const res = await qaPOST(
      req({
        scopePath: "org_1.engineering",
        target: { baseUrl: "https://api.acme.com", allowedHosts: ["api.acme.com"], authHeader: "Bearer x" },
        focus: "hammer /search",
      }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.brief).toMatchObject({ id: "brief_qa" });
    expect(data.report).toMatchObject({ verdict: "healthy" });

    // The human must be able to read the scope the agent will consult —
    // checked before any capability is minted or the run happens.
    expect(check).toHaveBeenCalledWith(member.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(db.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "agent_qa", orgId: "org_1", role: "qa" }),
      }),
    );
    expect(provisionQaAgentCapability).toHaveBeenCalledWith("org_1", "org_1.engineering", "user_42");
    expect(runAndPersistQaReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRow: stubAgentRow,
        orgId: "org_1",
        scopePath: "org_1.engineering",
        capabilityToken: "wcap_qa",
        target: expect.objectContaining({
          baseUrl: "https://api.acme.com",
          allowedHosts: ["api.acme.com"],
          authHeader: "Bearer x",
        }),
        focus: "hammer /search",
        mode: "api",
      }),
    );
  });

  it("honors an explicit mode: 'browser'", async () => {
    await qaPOST(req({ ...okBody, mode: "browser" }), params({ id: "agent_qa" }));
    expect(runAndPersistQaReview).toHaveBeenCalledWith(expect.objectContaining({ mode: "browser" }));
  });

  it("trims a padded baseUrl before validating and running", async () => {
    const res = await qaPOST(
      req({ scopePath: "org_1.engineering", target: { baseUrl: "  https://api.acme.com  " } }),
      params({ id: "agent_qa" }),
    );
    expect(res.status).toBe(200);
    expect(runAndPersistQaReview).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ baseUrl: "https://api.acme.com" }) }),
    );
  });

  it("500 when the run pipeline throws (wrapped + masked, not propagated)", async () => {
    vi.mocked(runAndPersistQaReview).mockRejectedValue(new Error("LLM blew up"));
    const res = await qaPOST(req(okBody), params({ id: "agent_qa" }));
    expect(res.status).toBe(500);
    // Internal error detail is masked from the client (logged server-side instead).
    expect(await res.json()).toEqual({ error: "QA run failed" });
  });
});
