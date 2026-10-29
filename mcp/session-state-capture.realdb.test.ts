// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Capture by doing, through the willder init hook (cli/hooks/willder-capture.mjs): a coding
// agent that is killed, compacted or simply stops still hands its task on. An agent stopped
// before it wraps up writes nothing to memory on its own, so without a capture the work it
// did is lost.
//
// The workflow: agent A works task WEB-412 in a git project where `willder init --capture`
// installed the hook. It records one decision on purpose through MCP. Then, as Claude Code
// would run it, the installed hook sees a failing test run, a passing one, and the session's
// Stop. Agent B starts the same task fresh and is served the decision first, then one
// session-state line: the last one, opening with the passing run and naming the changed file.
//
// Real: the installed hook in its own node process, the hosted MCP endpoint over a socket,
// check() against live capabilities, the write-through store into Postgres, the supersede
// edge, the change feed and the task-start read. A stand-in memory service answers the
// embedding call with one fixed vector and the graph with nothing; the queue is counted, not
// run, since what is measured is that a capture queues no graph job at all.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { init } from "@/cli/willder.mjs";
import { sessionStateName } from "@/cli/hooks/willder-capture.mjs";
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
const ORG = "sessioncapture";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;
const TASK = "WEB-412";
const HOOK_SESSION = "7d3e91c0-hook-session-a";
const READ_ONLY_SESSION = "0b6f22aa-hook-session-r";
const DECISION = {
  name: "Webhook retries",
  content: "Retry a failed webhook with exponential backoff, at most 5 attempts.",
  role: "decision",
};
const LAST_MESSAGE = "Moved the ack after the write in services/orders/ack.ts; the suite passes now.";
const SPAWN_TIMEOUT_MS = 30_000;

describe.skipIf(!QA_URL)("session-state capture through the willder init hook, against a real database", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let projectDir = "";
  let stateTmp = "";
  let hookPath = "";
  let queued = 0;
  const tokens: Record<string, string> = {};

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

  async function call(client: Client, name: string, args: Record<string, unknown>, session: string) {
    const result = await client.callTool({
      name,
      arguments: args,
      _meta: { "willder/session": session, "willder/task": TASK },
    });
    return (result.content as { text?: string }[]).map((part) => part.text ?? "");
  }

  /** Run the installed hook once, as Claude Code runs it: a node process fed one event on stdin. */
  function runHook(token: string, input: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
    return new Promise((done, fail) => {
      const child = execFile(
        process.execPath,
        [hookPath],
        {
          cwd: projectDir,
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
            TMPDIR: stateTmp,
            WILLDER_TOKEN: token,
            WILLDER_URL: new URL(mcpUrl).origin,
            WILLDER_TASK: TASK,
            WILLDER_CAPTURE: "session-state",
          },
        },
        (error, stdout, stderr) => (error ? fail(error) : done({ stdout, stderr })),
      );
      child.stdin!.end(JSON.stringify({ cwd: projectDir, ...input }));
    });
  }

  const sessionStateRows = (session: string) =>
    db.memoryChunk.findMany({
      where: { orgId: ORG, entityName: sessionStateName(TASK, session) },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => {
      queued += 1;
      return { ids: [`job-${queued}`] };
    }) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    tokens.a = await mint("agent-a", "write");
    tokens.x = await mint("agent-x", "write");
    tokens.r = await mint("agent-r", "read");

    // A project with one commit, and the hook installed by `willder init --capture`.
    projectDir = mkdtempSync(join(tmpdir(), "willder-capture-project-"));
    stateTmp = mkdtempSync(join(tmpdir(), "willder-capture-state-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectDir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
    git("init", "-q");
    writeFileSync(join(projectDir, "ack.ts"), "export const ack = () => true;\n");
    git("add", ".");
    git("commit", "-q", "-m", "start");
    ({ hookPath } = init({ projectDir, capture: true }));
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(stateTmp, { recursive: true, force: true });
  });

  it(
    "hands a session's last state to the next session of the task, after what was decided on purpose, as one fact",
    async () => {
      const a = await connect(tokens.a, "agent-a");
      await call(a, "memory_ingest", DECISION, "a-mcp");
      const jobsBeforeCapture = queued;

      await runHook(tokens.a, {
        hook_event_name: "UserPromptSubmit",
        session_id: HOOK_SESSION,
        prompt: "fix the double ack",
      });
      writeFileSync(join(projectDir, "ack.ts"), "export const ack = () => write() && true;\n");
      await runHook(tokens.a, {
        hook_event_name: "PostToolUseFailure",
        session_id: HOOK_SESSION,
        tool_name: "Bash",
        tool_input: { command: "npm test -- ack" },
        error: "Exit code 1\nTests  1 failed | 3 passed (4)",
      });
      await runHook(tokens.a, {
        hook_event_name: "PostToolUse",
        session_id: HOOK_SESSION,
        tool_name: "Bash",
        tool_input: { command: "npm test -- ack" },
        tool_response: { stdout: "Tests  4 passed (4)\n", stderr: "" },
      });
      expect(await sessionStateRows(HOOK_SESSION)).toHaveLength(1);
      await runHook(tokens.a, {
        hook_event_name: "Stop",
        session_id: HOOK_SESSION,
        last_assistant_message: LAST_MESSAGE,
      });

      // Two writes, the second replacing the first: one current version, a supersede edge between them.
      const rows = await sessionStateRows(HOOK_SESSION);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.role)).toEqual(["progress", "progress"]);
      const supersede = await db.changeEvent.findMany({ where: { orgId: ORG, recordType: "fact", op: "supersede" } });
      expect(supersede.map((event) => event.recordId)).toContain(rows[0]!.id);
      // Neither capture queued a graph job; the decision did.
      expect(queued).toBe(jobsBeforeCapture);
      expect(jobsBeforeCapture).toBeGreaterThan(0);

      const b = await connect(await mint("agent-b", "read"), "agent-b");
      const [, ...extra] = await call(b, "memory_query", { query: "Where did the double ack work leave off?" }, "b-1");
      const block = extra.find((text) => text.startsWith("Before you start")) ?? "";
      const lines = block.split("\n").filter((line) => line.startsWith("- ") && line.includes(" [fact "));
      const decisionAt = lines.findIndex((line) => line.includes(DECISION.content));
      const stateLines = lines.filter((line) => line.includes("Session state captured automatically"));
      expect(decisionAt).toBe(0);
      expect(stateLines).toHaveLength(1);
      expect(stateLines[0]).toContain(`[fact ${rows[1]!.id}]`);
      expect(stateLines[0]).toContain("ack.ts");
      // The block states the last run first and plainly; the session edited ack.ts, no test file.
      expect(stateLines[0]).toMatch(
        /^- \[run state · unverified: as the hook saw it\] Last test run at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: PASSED \(Tests 4 passed \(4\)\); no test edits seen in this repo\. Command: npm test -- ack\. /,
      );
      expect(stateLines[0]).toContain(LAST_MESSAGE);
    },
    SPAWN_TIMEOUT_MS * 2,
  );

  it(
    "does not spend the agent's change notices on its own capture",
    async () => {
      const a = await connect(tokens.a, "agent-a-2");
      await call(a, "memory_query", { query: "anything new?" }, "a-mcp-2");
      const x = await connect(tokens.x, "agent-x");
      await call(
        x,
        "memory_ingest",
        { name: "Ack ordering", content: "The ack queue drains every 30 seconds." },
        "x-1",
      );

      await runHook(tokens.a, {
        hook_event_name: "Stop",
        session_id: HOOK_SESSION,
        last_assistant_message: "Stopped again.",
      });
      const after = await call(a, "memory_query", { query: "anything new?" }, "a-mcp-2");

      expect(after.join("\n")).toContain("The ack queue drains every 30 seconds.");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "with a read-only token, writes nothing, is refused once, and stops asking for the session",
    async () => {
      const denials = () => db.auditLog.count({ where: { orgId: ORG, actorId: "agent-r", decision: "deny" } });

      await runHook(tokens.r, {
        hook_event_name: "Stop",
        session_id: READ_ONLY_SESSION,
        last_assistant_message: "One.",
      });
      const afterFirst = await denials();
      await runHook(tokens.r, {
        hook_event_name: "Stop",
        session_id: READ_ONLY_SESSION,
        last_assistant_message: "Two.",
      });

      expect(await sessionStateRows(READ_ONLY_SESSION)).toHaveLength(0);
      expect(afterFirst).toBe(1);
      expect(await denials()).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
