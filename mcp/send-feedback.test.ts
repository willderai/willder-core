// send_feedback stores feedback against the caller's own org and agent, refuses once
// that agent has sent its hourly limit, and refuses once its token stops being live.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The transaction client is the mock itself, so one set of spies sees every call.
vi.mock("@/lib/db", () => {
  const db = {
    productFeedback: { count: vi.fn(), create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((work: (tx: unknown) => unknown) => work(db)),
  };
  return { db };
});

// The token lookup itself is proven against a real database in
// mcp/send-feedback.token-recheck.realdb.test.ts; here it is only live or not.
vi.mock("@/services/access", async (orig) => ({
  ...(await orig<typeof import("@/services/access")>()),
  resolveCapability: vi.fn(),
}));

import { db } from "@/lib/db";
import { resolveCapability } from "@/services/access";
import { registerWillderTools } from "./tools";
import { FEEDBACK_HOURLY_LIMIT } from "@/services/feedback/product-feedback";
import type { AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_feedback_test";

function sendFeedback(): Handler {
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
  };
  const tools = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => tools.set(name, handler)) };
  registerWillderTools(server as unknown as McpServer, ctx, { orgId: ORG, agentId: "agent_1", scopePath: ORG });
  return tools.get("send_feedback")!;
}

describe("send_feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.productFeedback.count).mockResolvedValue(0 as never);
    vi.mocked(db.productFeedback.create).mockResolvedValue({ id: "fb_1" } as never);
    vi.mocked(resolveCapability).mockResolvedValue({ orgId: ORG, agentId: "agent_1", scopePath: ORG, createdBy: null });
  });

  it("re-resolves the session's own token on every call, and stores nothing once it is not live", async () => {
    vi.mocked(resolveCapability).mockResolvedValue(null);

    const result = await sendFeedback()({ kind: "bug", message: "still here" });

    expect(resolveCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityToken: "wcap_xyz" }), "mcp");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no longer live/);
    expect(db.productFeedback.create).not.toHaveBeenCalled();
  });

  it("stores the feedback against the token's own org and agent", async () => {
    const result = await sendFeedback()({
      kind: "bug",
      message: "Drive connect hangs",
      context: "connecting a folder",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("fb_1");
    expect(db.productFeedback.create).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        agentId: "agent_1",
        kind: "bug",
        message: "Drive connect hangs",
        context: "connecting a folder",
      },
      select: { id: true },
    });
  });

  it("counts only this agent's feedback in the last hour toward the limit", async () => {
    await sendFeedback()({ kind: "request", message: "export to CSV" });

    const where = vi.mocked(db.productFeedback.count).mock.calls[0][0]!.where!;
    expect(where.orgId).toBe(ORG);
    expect(where.agentId).toBe("agent_1");
    const since = (where.createdAt as { gte: Date }).gte.getTime();
    expect(Date.now() - since).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(Date.now() - since).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it("refuses and stores nothing once the agent has hit the hourly limit", async () => {
    vi.mocked(db.productFeedback.count).mockResolvedValue(FEEDBACK_HOURLY_LIMIT as never);

    const result = await sendFeedback()({ kind: "bug", message: "again" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Not sent/);
    expect(db.productFeedback.create).not.toHaveBeenCalled();
  });

  it("still sends at one below the limit", async () => {
    vi.mocked(db.productFeedback.count).mockResolvedValue((FEEDBACK_HOURLY_LIMIT - 1) as never);

    const result = await sendFeedback()({ kind: "praise", message: "love the audit log" });

    expect(result.isError).toBeFalsy();
    expect(db.productFeedback.create).toHaveBeenCalledOnce();
  });

  it("takes the per-agent lock inside the transaction before counting", async () => {
    // The real-SQL proof that this holds a concurrent burst to the limit is
    // mcp/send-feedback.realdb.qa.test.ts; this pins the order the proof depends on.
    await sendFeedback()({ kind: "bug", message: "x" });

    expect(db.$transaction).toHaveBeenCalledOnce();
    const lockSql = (vi.mocked(db.$queryRaw).mock.calls[0][0] as unknown as string[]).join("?");
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(vi.mocked(db.$queryRaw).mock.calls[0].slice(1)).toEqual(expect.arrayContaining([ORG, "agent_1"]));
    const lockedAt = vi.mocked(db.$queryRaw).mock.invocationCallOrder[0];
    expect(lockedAt).toBeLessThan(vi.mocked(db.productFeedback.count).mock.invocationCallOrder[0]);
  });

  it("reports a storage failure as a tool error, not a thrown exception", async () => {
    vi.mocked(db.productFeedback.create).mockRejectedValue(new Error("db down"));

    const result = await sendFeedback()({ kind: "bug", message: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("db down");
  });
});
