// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A task's captured tests are
// read per tenant. Two orgs hold the same scope string and the same task key; one org's failed
// capture must neither open the other org's progress nor mark its Finished claim, and the org's
// own failed capture still must. Real: the hosted MCP route, check() against live capabilities,
// the write-through store into Postgres, the change feed and the task-start read.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "case698tenanta";
const OTHER_ORG = "case698tenantb";
/** The same scope string in both orgs. */
const WEB = "org_qa698.web";
const TASK = "T-tenant";
const FAILED_RUN = {
  command: "npx vitest run",
  passed: false,
  line: "Tests  2 failed | 8 passed (10)",
  at: new Date().toISOString(),
  edited: { files: [], named: [] },
};

describe.skipIf(!QA_URL)("a task's captured tests, two tenants with the same scope and task key", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let sessions = 0;

  async function mint(orgId: string, agentId: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: WEB,
        permission,
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function connect(token: string): Promise<Client> {
    const client: Client = new ClientClass({ name: `case698-${++sessions}`, version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>, meta: Record<string, string>) {
    const result = await client.callTool({ name, arguments: args, _meta: meta });
    return (result.content as { text?: string }[]).map((part) => part.text ?? "");
  }

  async function claimFinished(writer: Client, task: string) {
    const [reply] = await call(
      writer,
      "memory_ingest",
      { name: `${task} status`, content: `${task}: Finished the redirect cleanup.` },
      { "willder/session": `w-${++sessions}`, "willder/task": task },
    );
    expect(reply).toMatch(/Version: /);
  }

  async function captureFailed(writer: Client, task: string, session: string) {
    const content = renderSessionState({
      trigger: "Stop",
      task,
      files: ["src/redirects.ts"],
      test: FAILED_RUN,
      lastMessage: "Stopped.",
    });
    const [reply] = await call(
      writer,
      "memory_ingest",
      { name: sessionStateName(task, session), content, role: "progress" },
      { "willder/capture": "session-state", "willder/session": session, "willder/task": task },
    );
    expect(reply).toMatch(/Version: /);
  }

  async function blockFor(reader: Client, task: string): Promise<string> {
    const [, ...extra] = await call(
      reader,
      "memory_query",
      { query: "Where did this task leave off?" },
      { "willder/session": `r-${++sessions}`, "willder/task": task },
    );
    const served = extra.find((text) => text.startsWith("Before you start")) ?? "";
    return served.split("\n\nChanged in your scope since your last call:")[0]!;
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.deleteMany({ where: { id: orgId } });
      await db.org.create({ data: { id: orgId, name: orgId } });
      for (const path of ["org_qa698", WEB]) await db.scope.create({ data: { orgId, path, name: path } });
    }
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    for (const orgId of [ORG, OTHER_ORG]) await db.org.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  });

  it("another tenant's failed capture under the same task key and scope string decides nothing and is not served", async () => {
    const own = await connect(await mint(ORG, "case698-writer", "write"));
    const other = await connect(await mint(OTHER_ORG, "case698-writer", "write"));
    await claimFinished(own, TASK);
    await captureFailed(other, TASK, "other-tenant-session");

    const block = await blockFor(await connect(await mint(ORG, "case698-reader", "read")), TASK);

    expect(block).toContain(`${TASK}: Finished the redirect cleanup.`);
    expect(block).not.toMatch(/test run|\[unverified|other-tenant/i);
  });

  it("the org's own failed capture under that key still marks the claim (the check above can fail)", async () => {
    const own = await connect(await mint(ORG, "case698-writer-2", "write"));
    await claimFinished(own, `${TASK}-own`);
    await captureFailed(own, `${TASK}-own`, "own-tenant-session");

    const block = await blockFor(await connect(await mint(ORG, "case698-reader-2", "read")), `${TASK}-own`);

    expect(block).toContain(
      `[unverified: the last captured test run FAILED] ${TASK}-own: Finished the redirect cleanup.`,
    );
  });
});
