// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Session-state capture: where a capture may land. The hook writes with the session's own token, under a name made
// of the task and the session id, replacing the version its state file remembers. These
// tests check that none of that reaches past the session's own fact: not another org, not
// another scope, not another task's fact in the same session, and not a fact of the same
// name that another agent wrote. Same harness as mcp/session-state-capture.realdb.test.ts:
// the installed hook in its own node process against the hosted MCP route over a socket.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
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
const ORG_A = "capqa_a";
const ORG_B = "capqa_b";
const WEB_A = `org_${ORG_A}.web`;
const OPS_A = `org_${ORG_A}.ops`;
const WEB_B = `org_${ORG_B}.web`;
const TASK = "WEB-412";
const OTHER_TASK = "WEB-413";
const SPAWN_TIMEOUT_MS = 30_000;

describe.skipIf(!QA_URL)("session-state capture lands only on the session's own fact", () => {
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

  async function mint(orgId: string, agentId: string, scopePath: string): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function ingestAs(token: string, args: Record<string, unknown>, task = TASK) {
    const client: Client = new ClientClass({ name: "qa", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    const result = await client.callTool({
      name: "memory_ingest",
      arguments: args,
      _meta: { "willder/session": "qa-mcp", "willder/task": task },
    });
    return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
  }

  function runHook(token: string, input: Record<string, unknown>, env: Record<string, string> = {}): Promise<void> {
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
            ...env,
          },
        },
        (error) => (error ? fail(error) : done()),
      );
      child.stdin!.end(JSON.stringify({ cwd: projectDir, ...input }));
    });
  }

  const rowsNamed = (orgId: string, name: string) =>
    db.memoryChunk.findMany({ where: { orgId, entityName: name }, orderBy: { createdAt: "asc" } });
  const superseded = async (orgId: string, rowId: string) =>
    (await db.changeEvent.count({ where: { orgId, recordType: "fact", op: "supersede", recordId: rowId } })) > 0;

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

    for (const [org, paths] of [
      [ORG_A, [`org_${ORG_A}`, WEB_A, OPS_A]],
      [ORG_B, [`org_${ORG_B}`, WEB_B]],
    ] as const) {
      await db.org.deleteMany({ where: { id: org } });
      await db.org.create({ data: { id: org, name: org } });
      for (const path of paths) await db.scope.create({ data: { orgId: org, path, name: path } });
    }

    projectDir = mkdtempSync(join(tmpdir(), "willder-capture-qa-project-"));
    stateTmp = mkdtempSync(join(tmpdir(), "willder-capture-qa-state-"));
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
    for (const org of [ORG_A, ORG_B]) await db.org.deleteMany({ where: { id: org } });
    await db.$disconnect();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(stateTmp, { recursive: true, force: true });
  });

  it(
    "writes only into its own token's org and scope, beside a same-named fact in another org and scope",
    async () => {
      const session = "a1a1a1a1-qa-tenants";
      const name = sessionStateName(TASK, session);
      const tokenA = await mint(ORG_A, "agent-a", WEB_A);
      // The same name already exists in another org, and in another scope of this org.
      await ingestAs(await mint(ORG_B, "agent-b", WEB_B), { name, content: "Org B's own session state." });
      await ingestAs(await mint(ORG_A, "agent-ops", OPS_A), { name, content: "The ops scope's own session state." });
      const [bRow] = await rowsNamed(ORG_B, name);
      const [opsRow] = await rowsNamed(ORG_A, name);

      await runHook(tokenA, {
        hook_event_name: "Stop",
        session_id: session,
        last_assistant_message: "Org A, web scope.",
      });

      const aRows = (await rowsNamed(ORG_A, name)).filter((row) => row.id !== opsRow!.id);
      expect(aRows).toHaveLength(1);
      expect(aRows[0]!.scopePath).toBe(WEB_A);
      expect(aRows[0]!.content).toContain("Org A, web scope.");
      expect(await rowsNamed(ORG_B, name)).toHaveLength(1);
      expect(await superseded(ORG_B, bRow!.id)).toBe(false);
      expect(await superseded(ORG_A, opsRow!.id)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "gives another task in the same session its own fact, and leaves the first task's fact current",
    async () => {
      const session = "b2b2b2b2-qa-tasks";
      const token = await mint(ORG_A, "agent-tasks", WEB_A);
      await runHook(token, { hook_event_name: "Stop", session_id: session, last_assistant_message: "First task." });
      // The same Claude Code session, resumed under another task: the state file still holds
      // the first task's version, which is not a version of the second task's fact.
      await runHook(
        token,
        { hook_event_name: "Stop", session_id: session, last_assistant_message: "Second task." },
        { WILLDER_TASK: OTHER_TASK },
      );
      await runHook(
        token,
        { hook_event_name: "Stop", session_id: session, last_assistant_message: "Second task, again." },
        { WILLDER_TASK: OTHER_TASK },
      );

      const [first] = await rowsNamed(ORG_A, sessionStateName(TASK, session));
      const second = await rowsNamed(ORG_A, sessionStateName(OTHER_TASK, session));
      expect(first!.content).toContain("First task.");
      expect(await superseded(ORG_A, first!.id)).toBe(false);
      expect(second.at(-1)!.content).toContain("Second task, again.");
    },
    SPAWN_TIMEOUT_MS * 2,
  );

  it(
    "never replaces a fact of the same name that another agent wrote",
    async () => {
      const session = "c3c3c3c3-qa-squat";
      const name = sessionStateName(TASK, session);
      const other = await ingestAs(await mint(ORG_A, "agent-other", WEB_A), {
        name,
        content: "Another agent's note under this name.",
        role: "decision",
      });
      expect(other).toContain("Version");
      const [otherRow] = await rowsNamed(ORG_A, name);
      // More than the one-second concurrent-write window, so this is not a race.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      await runHook(await mint(ORG_A, "agent-hook", WEB_A), {
        hook_event_name: "Stop",
        session_id: session,
        last_assistant_message: "Hook write.",
      });

      expect(await superseded(ORG_A, otherRow!.id)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "stores neither the session's token nor a secret-named environment value, in the fact's name or text",
    async () => {
      const session = "d4d4d4d4-qa-secrets";
      const token = await mint(ORG_A, "agent-secrets", WEB_A);
      const dbPassword = "qa-db-password-0001";
      await runHook(
        token,
        {
          hook_event_name: "Stop",
          session_id: session,
          last_assistant_message: `Ran with ${token} against ${dbPassword}.`,
        },
        { DB_PASSWORD: dbPassword, WILLDER_TASK: `${TASK} token=qa-task-secret-0001` },
      );

      const rows = await db.memoryChunk.findMany({ where: { orgId: ORG_A, entityName: { contains: "d4d4d4d4" } } });
      expect(rows).toHaveLength(1);
      for (const text of [rows[0]!.content, rows[0]!.entityName ?? ""]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(dbPassword);
        expect(text).not.toContain("qa-task-secret-0001");
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
