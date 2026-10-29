// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The stdio server is one connection per process, so one task-start session per process
// (mcp/connection-session.ts). Two real `mcp/server.ts` processes for the same token, started
// one after the other, each serve the block on their first call and never repeat it.
//
// Real: the stdio server process, its startup checks, Postgres, the capability token and the
// task-start delivery claim. Stood in: the graph service URL and key, which startup requires
// to be set but which no call here reaches.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;
/** Handed to the spawned server, which otherwise gets no environment at all. */
const { HOME, NODE_ENV, PATH } = process.env;

const ORG = "qa_stdio_session";
const SCOPE = `org_${ORG}.b`;
const AGENT = "stdio-session-agent";
const RULE = "qastdiorule1";
const REPO_ROOT = resolve(__dirname, "..");

interface ToolResult {
  content: { type: string; text: string }[];
}

describe.skipIf(!QA_URL)("the stdio server is one task-start session per process", () => {
  let db: PrismaClient;
  let token: string;

  async function reset(): Promise<void> {
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    await reset();
    await db.org.create({ data: { id: ORG, name: ORG } });
    token = `wcap_test_stdio_${Math.random().toString(36).slice(2)}`;
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
        text: "Run the migration check before every release.",
        actorId: "author",
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  /** A new stdio server process for the token, connected. */
  async function startServer(): Promise<Client> {
    const transport = new StdioClientTransport({
      // How a stranger following docs/development.md starts it (lib/db-startup.realdb.test.ts runs it the same way).
      command: join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      args: ["mcp/server.ts"],
      cwd: REPO_ROOT,
      env: {
        ...(HOME ? { HOME } : {}),
        ...(NODE_ENV ? { NODE_ENV } : {}),
        PATH: PATH ?? "",
        DATABASE_URL: QA_URL!,
        GRAPHITI_SERVICE_URL: "http://127.0.0.1:9",
        GRAPHITI_SERVICE_API_KEY: "unused-by-these-calls",
        WILLDER_CAPABILITY_TOKEN: token,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "qa-stdio-client", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  const blockOf = (result: ToolResult): string | undefined =>
    result.content.map((c) => c.text).find((text) => text.startsWith("Before you start"));
  const anyCall = (client: Client) =>
    client.callTool({ name: "get_my_brief", arguments: { briefId: "no-such-brief" } }) as Promise<ToolResult>;

  it("serves a second process started right after the first, and never repeats within one", async () => {
    const one = await startServer();
    try {
      expect(blockOf(await anyCall(one))).toContain(`[convention ${RULE}]`);
      expect(blockOf(await anyCall(one))).toBeUndefined();
    } finally {
      await one.close();
    }
    const two = await startServer();
    try {
      expect(blockOf(await anyCall(two))).toContain(`[convention ${RULE}]`);
      expect(blockOf(await anyCall(two))).toBeUndefined();
    } finally {
      await two.close();
    }
    const keys = (await db.taskStartDelivery.findMany({ where: { orgId: ORG } })).map((d) => d.sessionKey);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^mcp:[0-9a-f-]{36}$/);
  }, 60_000);
});
