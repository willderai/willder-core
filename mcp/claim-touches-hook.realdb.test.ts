// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The Claude Code hook's claim touches end to end: the hook `willder init` installs, in its
// own node process, records the file an Edit call names on the session's claim through the
// hosted MCP route over a socket, and hands the model the overlap the reply names
// (cli/hooks/willder-touches.mjs, services/memory/claim-overlap.ts). Same harness as
// mcp/session-state-capture.qa.realdb.test.ts.
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
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "touchhook_a";
const SCOPE = `org_${ORG}.web`;
const TASK = "WEB-500";
const SPAWN_TIMEOUT_MS = 30_000;

describe.skipIf(!QA_URL)("the hook records edited files on the session's claim and names the overlap", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let projectDir = "";
  let stateTmp = "";
  let hookPath = "";

  async function mint(agentId: string): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return token;
  }

  async function claimOverHttp(token: string, args: Record<string, unknown>) {
    const { Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client: Client = new ClientClass({ name: "qa", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    await client.callTool({
      name: "memory_note",
      arguments: { kind: "claim", ...args },
      _meta: { "willder/session": "north-session" },
    });
  }

  function runHook(token: string, input: Record<string, unknown>): Promise<string> {
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
            WILLDER_CLAIM_TOUCHES: "on",
          },
        },
        (error, stdout) => (error ? fail(error) : done(stdout)),
      );
      child.stdin!.end(JSON.stringify({ cwd: projectDir, ...input }));
    });
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { startMcpTestServer } = await import("./http-test-server");
    ({ url: mcpUrl, close: closeMcp } = await startMcpTestServer());

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG, settings: { claimOverlap: true } } });
    for (const path of [`org_${ORG}`, SCOPE]) await db.scope.create({ data: { orgId: ORG, path, name: path } });

    projectDir = mkdtempSync(join(tmpdir(), "willder-touches-qa-project-"));
    stateTmp = mkdtempSync(join(tmpdir(), "willder-touches-qa-state-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectDir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/Acme/App.git");
    writeFileSync(join(projectDir, "sessions.ts"), "export const ttl = 'edit-text-before-7f3a';\n");
    ({ hookPath } = init({ projectDir }));
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(stateTmp, { recursive: true, force: true });
  });

  it(
    "stores the edited file as the claim's touch and shows the model the other claim that edits it",
    async () => {
      await claimOverHttp(await mint("north"), {
        task: "WEB-499",
        body: "changing the session ttl",
        touches: ["file:acme/app/sessions.ts"],
      });
      const north = await db.workingNote.findFirstOrThrow({ where: { orgId: ORG, agentId: "north" } });

      const stdout = await runHook(await mint("south"), {
        hook_event_name: "PostToolUse",
        session_id: "south-session",
        tool_name: "Edit",
        tool_input: {
          file_path: join(projectDir, "sessions.ts"),
          old_string: "edit-text-before-7f3a",
          new_string: "edit-text-after-7f3a",
        },
      });

      const south = await db.workingNote.findFirstOrThrow({ where: { orgId: ORG, agentId: "south" } });
      expect(south).toMatchObject({ kind: "claim", task: TASK, touches: ["file:acme/app/sessions.ts"] });
      const context = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
      expect(context).toContain(
        "Overlapping files detected with 1 other live claim on other work. Each claim is stored; nothing was resolved.",
      );
      expect(context).toContain(`- north's claim ${north.id} on "WEB-499"`);
      // Paths only: nothing of the edit's text left the machine.
      const stored = [
        ...(await db.workingNote.findMany({ where: { orgId: ORG }, select: { body: true, touches: true } })).flatMap(
          (n) => [n.body, ...n.touches],
        ),
        ...(await db.changeEvent.findMany({ where: { orgId: ORG }, select: { summary: true } })).map((e) => e.summary),
      ].join("\n");
      expect(stored).not.toContain("7f3a");
    },
    SPAWN_TIMEOUT_MS,
  );
});
