import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// send_feedback against a real Postgres: the hourly limit
// counts one agent in one org, so a second org whose agent has the same id and a
// second agent in the same org each keep their own allowance; feedback older
// than an hour stops counting; a burst of concurrent calls cannot exceed it;
// and a stored row carries the token's org and agent, whatever the arguments
// say. mcp/send-feedback.test.ts mocks the database, so none of these
// predicates had run against SQL before.
//
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG_A = "orgQaFeedbackA";
const ORG_B = "orgQaFeedbackB";
const AGENT = "agentQaFeedback";
const OTHER_AGENT = "agentQaFeedbackOther";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

describe.skipIf(!QA_URL)("send_feedback against real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, registerWillderTools: any, hashCapabilityToken: (token: string) => string, LIMIT: number;

  // send_feedback re-resolves its token on every call, so each caller holds a
  // real live token for its own org and agent.
  const sendFeedbackAs = async (orgId: string, agentId: string): Promise<Handler> => {
    const token = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: `org_${orgId}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const tools = new Map<string, Handler>();
    const server = { registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => tools.set(name, handler)) };
    registerWillderTools(
      server,
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId, agentId, scopePath: `org_${orgId}` },
    );
    return tools.get("send_feedback")!;
  };

  const sendTimes = async (send: Handler, n: number) => {
    const results = [];
    for (let i = 0; i < n; i++) results.push(await send({ kind: "bug", message: `report ${i}` }));
    return results;
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ registerWillderTools } = await import("./tools"));
    ({ hashCapabilityToken } = await import("@/services/access/capabilities"));
    ({ FEEDBACK_HOURLY_LIMIT: LIMIT } = await import("@/services/feedback/product-feedback"));
    for (const id of [ORG_A, ORG_B]) {
      await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
  });

  beforeEach(async () => {
    await db.productFeedback.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await db.capability.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
  });

  afterAll(async () => {
    await db.capability.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await db.$disconnect();
  });

  it("stores the row under the token's org and agent", async () => {
    const result = await (
      await sendFeedbackAs(ORG_A, AGENT)
    )({ kind: "request", message: "export", orgId: ORG_B, agentId: "spoof" });
    expect(result.isError).toBeFalsy();
    const rows = await db.productFeedback.findMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: ORG_A, agentId: AGENT, kind: "request", message: "export", context: null });
  });

  it("refuses the agent's call past the limit and stores nothing for it", async () => {
    const results = await sendTimes(await sendFeedbackAs(ORG_A, AGENT), LIMIT + 1);
    expect(results.slice(0, LIMIT).every((r) => !r.isError)).toBe(true);
    expect(results[LIMIT].isError).toBe(true);
    expect(results[LIMIT].content[0].text).toMatch(/^Not sent/);
    expect(await db.productFeedback.count({ where: { orgId: ORG_A, agentId: AGENT } })).toBe(LIMIT);
  });

  it("keeps another org's agent with the same id on its own allowance", async () => {
    await sendTimes(await sendFeedbackAs(ORG_A, AGENT), LIMIT);
    const result = await (await sendFeedbackAs(ORG_B, AGENT))({ kind: "bug", message: "org B" });
    expect(result.isError).toBeFalsy();
  });

  it("keeps another agent in the same org on its own allowance", async () => {
    await sendTimes(await sendFeedbackAs(ORG_A, AGENT), LIMIT);
    const result = await (await sendFeedbackAs(ORG_A, OTHER_AGENT))({ kind: "bug", message: "other agent" });
    expect(result.isError).toBeFalsy();
  });

  it("stops counting feedback older than an hour", async () => {
    const old = new Date(Date.now() - 61 * 60 * 1000);
    await db.productFeedback.createMany({
      data: Array.from({ length: LIMIT }, (_, i) => ({
        orgId: ORG_A,
        agentId: AGENT,
        kind: "bug",
        message: `old ${i}`,
        createdAt: old,
      })),
    });
    const result = await (await sendFeedbackAs(ORG_A, AGENT))({ kind: "bug", message: "fresh" });
    expect(result.isError).toBeFalsy();
  });

  it("holds the limit when the agent's calls arrive concurrently", async () => {
    // MCP clients issue parallel tool calls; a count-then-insert with nothing
    // serializing one agent's calls lets every call in a burst read the same count.
    const send = await sendFeedbackAs(ORG_A, AGENT);
    await Promise.all(Array.from({ length: LIMIT * 2 }, (_, i) => send({ kind: "bug", message: `burst ${i}` })));
    expect(await db.productFeedback.count({ where: { orgId: ORG_A, agentId: AGENT } })).toBe(LIMIT);
  });

  it("goes with its org when the org is deleted", async () => {
    const org = "orgQaFeedbackGone";
    await db.org.create({ data: { id: org, name: org } });
    await (
      await sendFeedbackAs(org, AGENT)
    )({ kind: "praise", message: "bye" });
    await db.org.delete({ where: { id: org } });
    expect(await db.productFeedback.count({ where: { orgId: org } })).toBe(0);
  });
});
