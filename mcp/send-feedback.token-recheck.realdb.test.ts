// send_feedback checks its token on every call, not only when the session opened.
//
// The stdio server resolves its token once, at start (mcp/server.ts), and every
// memory tool is then caught per call by check(). send_feedback reads no memory and
// never reaches check(), so a token revoked or expired after the session opened
// could keep writing feedback. This opens a session the way the stdio server does,
// stops the token, and calls send_feedback again, against a real database.
//
// Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "orgQaFeedbackRecheck";
const AGENT = "agent-feedback-recheck";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

describe.skipIf(!QA_URL)("send_feedback after its session's token stops being live", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let resolveCapability: (typeof import("@/services/access/check"))["resolveCapability"];
  let token = "";
  let capabilityId = "";

  /** Open a session as the stdio server does: resolve the token once, then register the tools. */
  async function openSession(): Promise<Handler> {
    const cap = await resolveCapability(token, "mcp");
    if (!cap) throw new Error("the token should be live when the session opens");
    const tools = new Map<string, Handler>();
    const server = { registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => tools.set(name, handler)) };
    registerWillderTools(
      server as unknown as McpServer,
      { orgId: cap.orgId, actor: { type: "agent", id: cap.agentId, capabilityToken: token }, origin: "mcp" },
      cap,
    );
    return tools.get("send_feedback")!;
  }

  const stored = () => db.productFeedback.count({ where: { orgId: ORG } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
    ({ resolveCapability } = await import("@/services/access/check"));
  });

  beforeEach(async () => {
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    capabilityId = (
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: AGENT,
          tokenHash: hashCapabilityToken(token),
          scopePath: `org_${ORG}`,
          permission: "read",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("sends while the token is live", async () => {
    const send = await openSession();

    expect((await send({ kind: "bug", message: "first" })).isError).toBeFalsy();
    expect(await stored()).toBe(1);
  });

  it("refuses once the token is revoked mid-session, stores nothing, and audits the refusal", async () => {
    const send = await openSession();
    await db.capability.update({ where: { id: capabilityId }, data: { revokedAt: new Date() } });

    const result = await send({ kind: "bug", message: "after the revoke" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no longer live/);
    expect(await stored()).toBe(0);
    const refusal = await db.auditLog.findFirst({
      where: { orgId: ORG, action: "capability.refused", actorId: AGENT },
    });
    expect(refusal).toMatchObject({ decision: "deny", metadata: { capabilityId } });
  });

  it("refuses once the token expires mid-session", async () => {
    const send = await openSession();
    await db.capability.update({ where: { id: capabilityId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await send({ kind: "bug", message: "after expiry" })).isError).toBe(true);
    expect(await stored()).toBe(0);
  });

  it("refuses once the token's agent is switched off mid-session, and stores nothing", async () => {
    const agent = await db.agent.create({
      data: { orgId: ORG, agentKey: AGENT, name: "Feedback agent", role: "copy" },
    });
    const send = await openSession();
    await db.agent.update({ where: { id: agent.id }, data: { active: false } });

    expect((await send({ kind: "bug", message: "after deactivation" })).isError).toBe(true);
    expect(await stored()).toBe(0);
  });
});
