// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// A call's start, for the served-vs-used log (services/memory/task-start-served.ts), is taken
// before its notices are read, not after. When the task-start read is slow (a cold instance, a
// busy database), a start taken after it would fall more than the margin after the serving the
// same call made, and the call that served the block would count as using it. Here the notice
// takes 1.5 s, longer than the margin.
//
// Real: Postgres, /api/mcp, the task-start block and its claim, the use recorder. Stood in: a
// 1.5 s pause added after the real notice.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/mcp/change-notices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/change-notices")>();
  return {
    ...actual,
    toolCallNotice: async (...args: Parameters<typeof actual.toolCallNotice>) => {
      const notice = await actual.toolCallNotice(...args);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return notice;
    },
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_served_slow";
const SCOPE = `org_${ORG}.b`;
const AGENT = "served-slow-agent";
const RULE = "qaservedslowrule1";

describe.skipIf(!QA_URL)("the served-vs-used log when the block is slow to read", () => {
  let db: PrismaClient;
  let POST: (typeof import("@/app/api/mcp/route"))["POST"];
  const token = `wcap_test_slow_${Math.random().toString(36).slice(2)}`;

  async function wipe(): Promise<void> {
    await db.taskStartItemUse.deleteMany({ where: { orgId: ORG } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST } = await import("@/app/api/mcp/route"));
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await db.convention.create({
      data: {
        id: RULE,
        orgId: ORG,
        scopePath: SCOPE,
        kind: "convention",
        subject: "Deploy checklist",
        text: "Run the migration check first.",
        actorId: "author",
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("never counts the call that served the block, however long the block took", async () => {
    const response = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory_version", arguments: { versionId: RULE }, _meta: { "willder/session": "s-slow" } },
        }),
      }),
    );
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content.some((c) => c.text.startsWith("Before you start"))).toBe(true);
    expect((await db.taskStartServedItem.findMany({ where: { orgId: ORG } })).map((r) => r.namedId)).toEqual([RULE]);
    expect(await db.taskStartItemUse.count({ where: { orgId: ORG } })).toBe(0);
  }, 20_000);
});
