// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A session's captures are one thing to everyone else.
// The willder init hook snapshots a session every few tool calls, each snapshot a new version of
// the session's one capture fact. Toward the free plan's episode cap, all of one session's
// snapshots count as one episode; and another agent in the scope is told of the session's capture
// once, at its first version, not at every snapshot. A second session counts, and is told, again.
//
// Real: the hosted MCP endpoint over a socket, check() against live capabilities, the episode
// counter on the org row, the write-through store, the change feed and the notices on another
// agent's tool results. The writes are the hook's own calls, marked as captures.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import { CHANGE_NOTICES_HEADING } from "./task-start-headings";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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
const ORG = "captureonce";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;
const TASK = "WEB-77";
const FIRST = "5a1e0c3d-capture-once-1";
const SECOND = "9b2f7e11-capture-once-2";

describe.skipIf(!QA_URL)("a session's captures count once and are told once, against a real database", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let a: Client;
  let b: Client;

  async function mint(agentId: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
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

  async function connect(token: string, name: string): Promise<Client> {
    const client: Client = new ClientClass({ name, version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    return client;
  }

  /** One snapshot as the hook sends it: the session's capture fact, marked, replacing `base` when given. */
  async function snapshot(session: string, n: number, base?: string): Promise<string> {
    const content = renderSessionState({
      trigger: `a snapshot after ${n * 5} tool calls`,
      task: TASK,
      files: [`src/step-${n}.ts`],
      lastMessage: `Step ${n} done.`,
    });
    const result = await a.callTool({
      name: "memory_ingest",
      arguments: {
        name: sessionStateName(TASK, session),
        content,
        role: "progress",
        ...(base ? { baseVersion: base } : {}),
      },
      _meta: { "willder/capture": "session-state", "willder/session": session, "willder/task": TASK },
    });
    const text = (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
    const version = /\bVersion: (\S+?)\.(?:\s|$)/.exec(text)?.[1];
    if (!version) throw new Error(`snapshot not stored: ${text}`);
    return version;
  }

  /** A session's `count` snapshots, each replacing the one before. */
  async function snapshots(session: string, count: number): Promise<string[]> {
    const versions: string[] = [];
    for (let n = 1; n <= count; n++) versions.push(await snapshot(session, n, versions.at(-1)));
    return versions;
  }

  /** The change-notice lines another agent's next tool result carries. */
  async function noticeLines(): Promise<string[]> {
    const result = await b.callTool({
      name: "memory_query",
      arguments: { query: "orders" },
      _meta: { "willder/session": "b-session" },
    });
    const text = (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
    const at = text.indexOf(CHANGE_NOTICES_HEADING);
    if (at === -1) return [];
    return text
      .slice(at + CHANGE_NOTICES_HEADING.length)
      .split("\n")
      .filter((line) => line.startsWith("- "));
  }

  const episodes = async () =>
    (await db.org.findUniqueOrThrow({ where: { id: ORG }, select: { episodeCount: true } })).episodeCount;

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

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG, plan: "free" } });
    for (const path of [ROOT, WEB]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    a = await connect(await mint("agent-a", "write"), "agent-a");
    b = await connect(await mint("agent-b", "read"), "agent-b");
    // Agent B's first call starts its notices from here.
    await noticeLines();
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("counts N snapshots of one session as one episode, and tells another agent of them once", async () => {
    const before = await episodes();
    const versions = await snapshots(FIRST, 4);

    expect(new Set(versions).size).toBe(4);
    expect(await episodes()).toBe(before + 1);
    const lines = await noticeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(versions[0]);
  });

  it("counts a second session again, and tells of it once more", async () => {
    const before = await episodes();
    const versions = await snapshots(SECOND, 3);

    expect(await episodes()).toBe(before + 1);
    const lines = await noticeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(versions[0]);
  });

  it("still counts, and tells of, every replacement of a fact that is not a session's capture", async () => {
    const before = await episodes();
    const write = async (base?: string) => {
      const result = await a.callTool({
        name: "memory_ingest",
        // Marked as a capture but not named as one: the mark alone never makes a write free.
        arguments: {
          name: "Orders retry policy",
          content: `Retry ${base ?? "first"}.`,
          role: "progress",
          ...(base ? { baseVersion: base } : {}),
        },
        _meta: { "willder/capture": "session-state", "willder/session": "a-other", "willder/task": TASK },
      });
      return /\bVersion: (\S+?)\.(?:\s|$)/.exec(
        (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n"),
      )![1]!;
    };
    await write(await write());

    expect(await episodes()).toBe(before + 2);
    expect((await noticeLines()).length).toBeGreaterThanOrEqual(2);
  });
});
