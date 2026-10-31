// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A handoff whose record of being finished is not backed by its tests.
//
// The workflow is agent A's on task T-7c3e19a2. In one Bash call A deleted the pruned pages'
// redirects, rewrote the shipped regression test next.config.redirects.test.ts to assert its own
// change, and ran that test: 10 passed. It then recorded, on purpose, the decision "T-7c3e19a2:
// Finished legacy-pages prune. ...", and stopped. The willder init hook captured the session. Agent B,
// starting the same task, was served the decision and the capture ("-> passed"), checked briefly
// and stopped; the shipped regression tests still failed on A's commit. Here B's first block
// must open the task's progress with that run stated plainly, say the pass used a test the same
// session had rewritten, and mark every line showing the Finished claim as unverified.
//
// The second suite pins what the block says for the other shapes a capture takes, and that it
// never says anything about tests a capture B may read did not record: no capture, a pass on
// untouched tests, a failure, no run, a capture in a scope B may not read, another task's
// capture, and a capture an erasure withholds.
//
// Real: the hook installed by `willder init --capture`, run as Claude Code runs it, in a real
// git project; the hosted MCP endpoint over a socket; check() against live capabilities; the
// write-through store into Postgres; the supersede edge; the change feed; the erasure
// suppression list; and the task-start read. A stand-in memory service answers the embedding
// call with one fixed vector and the graph with nothing.
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
import { editedTestsOf, renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";
import { TASK_START_CAPTURE_LABEL, TASK_START_PREMISE_CHECK, withoutSources } from "./task-start-headings";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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
const ORG = "handofftruth";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;
/** A sibling of `web`, not a descendant: B may not read it. */
const WEB_INTERNAL = `${ROOT}.web_internal`;
const SPAWN_TIMEOUT_MS = 30_000;

const TASK = "T-7c3e19a2";
const HOOK_SESSION = "1d0a9876-agent-a-session";
/** Agent A's decision, as it recorded it through memory_ingest. */
const A_DECISION = {
  name: "legacy-pages prune",
  kind: "decision",
  content:
    "T-7c3e19a2: Finished legacy-pages prune. Deleted leftover app/(app)/activity page, removed the next.config redirects() for /campaigns,/contacts,/inbox,/activity (they now 404), and dropped those paths from app/robots.ts and proxy.ts. next.config.redirects.test.ts rewritten to assert no redirects, no page dirs, no stale route-list entries. Not done: changelog.md entries and a full test run; tsc clean.",
};
/** Agent A's one Bash call that changed files, rewrote the test and ran it (abridged heredoc bodies, same shape). */
const A_COMMAND = [
  "python3 - <<'E'",
  "p='next.config.ts'; s=open(p).read()",
  'a=s.index("  // The Era 1 outbound-sales surfaces are cut"); b=s.index("  async rewrites()")',
  "s=s[:a]+s[b:]; open(p,'w').write(s)",
  "E",
  'git rm -q -r "app/(app)/activity"',
  "cat > next.config.redirects.test.ts <<'E'",
  'import nextConfig from "./next.config";',
  "E",
  "npx vitest run next.config.redirects.test.ts 2>&1 | tail -15; npx tsc --noEmit 2>&1 | tail -5; git diff --stat",
].join("\n");
const A_LAST_MESSAGE =
  "The legacy-pages prune is finished: the dead redirects, the last leftover page file and the stale route-list entries are gone. The rewritten test passes (10 tests) and `tsc --noEmit` is clean.";

describe.skipIf(!QA_URL)("the task-start block against a task's captured tests, against a real database", () => {
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
  const tokens: Record<string, string> = {};
  let sessions = 0;

  async function mint(agentId: string, permission: "read" | "write", scopePath = WEB): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
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

  async function call(client: Client, name: string, args: Record<string, unknown>, meta: Record<string, string>) {
    const result = await client.callTool({ name, arguments: args, _meta: meta });
    return (result.content as { text?: string }[]).map((part) => part.text ?? "");
  }

  /** Agent A's explicit write on `task`, as an MCP client naming the task sends it. */
  async function record(client: Client, task: string, args: Record<string, unknown>) {
    const [reply] = await call(client, "memory_ingest", args, { "willder/session": `a-${task}`, "willder/task": task });
    expect(reply).not.toMatch(/denied|error/i);
  }

  /** A capture as the hook writes it: its name, text and role, marked, naming the task and session. */
  async function capture(
    client: Client,
    task: string,
    session: string,
    test: Parameters<typeof renderSessionState>[0]["test"],
    lastMessage = "Stopped.",
  ) {
    // As the hook writes a capture whose session changed nothing after its run.
    const content = renderSessionState({
      trigger: "Stop",
      task,
      files: ["next.config.ts"],
      testFilesAfterRun: [],
      test,
      lastMessage,
    });
    const [reply] = await call(
      client,
      "memory_ingest",
      { name: sessionStateName(task, session), content, role: "progress" },
      { "willder/capture": "session-state", "willder/session": session, "willder/task": task },
    );
    expect(reply).toMatch(/Version: /);
  }

  /** Agent B's first block on `task`: a fresh session that asks one memory_query. */
  async function blockFor(task: string): Promise<string> {
    const b = await connect(tokens.b!, `agent-b-${++sessions}`);
    const [, ...extra] = await call(
      b,
      "memory_query",
      { query: "Where did this task leave off?" },
      { "willder/session": `b-${sessions}`, "willder/task": task },
    );
    const served = extra.find((text) => text.startsWith("Before you start")) ?? "";
    // The change notices that may ride after it are the change feed's, not the block's.
    return served.split("\n\nChanged in your scope since your last call:")[0]!;
  }

  const items = (block: string) => block.split("\n").filter((line) => line.startsWith("- "));

  /** Run the installed hook once, as Claude Code runs it: a node process fed one event on stdin. */
  function runHook(input: Record<string, unknown>): Promise<void> {
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
            WILLDER_TOKEN: tokens.a!,
            WILLDER_URL: new URL(mcpUrl).origin,
            WILLDER_TASK: TASK,
            WILLDER_CAPTURE: "session-state",
          },
        },
        (error) => (error ? fail(error) : done()),
      );
      child.stdin!.end(JSON.stringify({ cwd: projectDir, session_id: HOOK_SESSION, ...input }));
    });
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

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB, WEB_INTERNAL]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    tokens.a = await mint("handoff-agent-a", "write");
    tokens.internal = await mint("handoff-agent-a", "write", WEB_INTERNAL);
    tokens.b = await mint("handoff-agent-b", "read");

    // The repository at A's starting commit, with the hook `willder init --capture` installs.
    projectDir = mkdtempSync(join(tmpdir(), "willder-handoff-truth-"));
    stateTmp = mkdtempSync(join(tmpdir(), "willder-handoff-truth-state-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectDir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
    git("init", "-q");
    writeFileSync(
      join(projectDir, "next.config.ts"),
      "export default { async redirects() { return [{ source: '/campaigns', destination: '/dashboard' }]; } };\n",
    );
    writeFileSync(
      join(projectDir, "next.config.redirects.test.ts"),
      "// pins the redirect's real status code\nit('redirects /campaigns', () => {});\n",
    );
    git("add", ".");
    git("commit", "-q", "-m", "start");
    ({ hookPath } = init({ projectDir, capture: true }));
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

  describe("agent A's T-7c3e19a2 handoff", () => {
    let block = "";

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await runHook({ hook_event_name: "UserPromptSubmit", prompt: "Finish the legacy-pages prune." });
      // What A's one Bash call did to the repository: the redirect gone, the test rewritten.
      writeFileSync(join(projectDir, "next.config.ts"), "export default {};\n");
      writeFileSync(
        join(projectDir, "next.config.redirects.test.ts"),
        "// the cut surfaces are gone\nit('keeps no redirects', () => {});\n",
      );
      await runHook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: A_COMMAND },
        tool_response: {
          stdout: " RUN  v4.1.8\n\n Test Files  1 passed (1)\n      Tests  10 passed (10)\n",
          stderr: "",
        },
      });
      const a = await connect(tokens.a!, "handoff-agent-a");
      await record(a, TASK, A_DECISION);
      await runHook({ hook_event_name: "Stop", last_assistant_message: A_LAST_MESSAGE });
      block = await blockFor(TASK);
    }, SPAWN_TIMEOUT_MS * 3);

    it("opens the task's progress with the last run, and says the pass used the test the same session rewrote", () => {
      const progress = items(block).filter((line) => line.startsWith(`- ${TASK_START_CAPTURE_LABEL} `));

      expect(progress[0]).toMatch(
        /^- \[run state · unverified: as the hook saw it\] Last test run at \S+Z: PASSED \(Tests 10 passed \(10\)\), but before it that session had edited tests that existed when it started: next\.config\.redirects\.test\.ts\. Command: …npx vitest run next\.config\.redirects\.test\.ts 2>&1 \| tail -15; npx tsc --noEmit 2>&1 \| tail -5; git diff --stat\. Session state captured automatically/,
      );
    });

    it("marks every line that shows the Finished claim as unverified, and only those", () => {
      const claimLines = items(block).filter((line) => line.includes("Finished legacy-pages prune"));

      expect(claimLines.length).toBeGreaterThan(0);
      for (const line of claimLines)
        expect(line).toContain(
          "[unverified: the last captured passing run used existing tests its own session had edited]",
        );
      expect(items(block).filter((line) => line.includes("[unverified")).length).toBe(claimLines.length);
    });

    it("keeps to the block's budget", async () => {
      // The budget covers the header, the records and the closing line; the premise check and the
      // sources' allowance are added on top (mcp/task-start-notice.ts, TASK_START_MAX_TOKENS).
      const { estimateTokens, TASK_START_TOKEN_BUDGET, TASK_START_MAX_TOKENS } = await import("./task-start-notice");
      const records = withoutSources(
        block
          .split("\n")
          .filter((line) => line !== TASK_START_PREMISE_CHECK)
          .join("\n"),
      );
      expect(estimateTokens(records)).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
      expect(estimateTokens(block)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
    });
  });

  describe("what the block says for each shape of capture, and never more", () => {
    const FINISHED = (task: string) => ({
      name: `${task} status`,
      content: `${task}: Finished the redirect cleanup. Deleted the activity page.`,
    });
    const run = (
      command: string,
      passed: boolean,
      line: string,
      changed: string[] | null,
      existing: string[] | null = null,
    ) => ({ command, passed, line, edited: editedTestsOf(command, changed), existing });
    const blocks: Record<string, string> = {};

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      const a = await connect(tokens.a!, "agent-a-shapes");
      const internal = await connect(tokens.internal!, "agent-a-internal");

      // No capture at all.
      await record(a, "T-nocapture", FINISHED("T-nocapture"));
      // A pass on a test the session had not edited.
      await record(a, "T-untouched", FINISHED("T-untouched"));
      await capture(
        a,
        "T-untouched",
        "s-untouched",
        run("npx vitest run app/robots.test.ts", true, "Tests  3 passed (3)", ["app/robots.ts"]),
      );
      // A pass on a test the session wrote (test-first work), and one on a test it rewrote.
      await record(a, "T-wrote", FINISHED("T-wrote"));
      await capture(
        a,
        "T-wrote",
        "s-wrote",
        run(
          "npx vitest run app/robots.test.ts",
          true,
          "Tests  3 passed (3)",
          ["app/robots.ts", "app/robots.test.ts"],
          [],
        ),
      );
      await record(a, "T-rewrote", FINISHED("T-rewrote"));
      await capture(
        a,
        "T-rewrote",
        "s-rewrote",
        run(
          "npx vitest run app/robots.test.ts",
          true,
          "Tests  3 passed (3)",
          ["app/robots.ts", "app/robots.test.ts"],
          ["app/robots.test.ts"],
        ),
      );
      // A failed run.
      await record(a, "T-failed", FINISHED("T-failed"));
      await capture(
        a,
        "T-failed",
        "s-failed",
        run("npx vitest run next.config.redirects.test.ts", false, "Tests  2 failed | 8 passed (10)", [
          "next.config.ts",
        ]),
      );
      // A session that ran no test.
      await record(a, "T-norun", FINISHED("T-norun"));
      await capture(a, "T-norun", "s-norun", undefined);
      // A failed capture in a scope B may not read; the claim in one it may.
      await record(a, "T-sibling", FINISHED("T-sibling"));
      await capture(internal, "T-sibling", "s-sibling", run("npm test", false, "1 failed", null));
      // A failed capture on another task whose key starts with this one's.
      await record(a, "T-claim", FINISHED("T-claim"));
      await capture(a, "T-claim-2", "s-claim-2", run("npm test", false, "1 failed", null));
      await record(a, "T-claim-2", FINISHED("T-claim-2"));
      // A failed capture and a claim on T-mix, and a claim on T-mix-2 that mentions T-mix, so the
      // block's recent writes hold another task's claim beside the task's own.
      await record(a, "T-mix", FINISHED("T-mix"));
      await capture(a, "T-mix", "s-mix", run("npm test", false, "1 failed", null));
      await record(a, "T-mix-2", {
        name: "T-mix-2 status",
        content: "T-mix-2: Fixed the robots list that T-mix left behind.",
      });
      // A failed capture on T-own, and a version of T-own's fact that T-other wrote under the
      // same name: the task's read serves it, but it is not T-own's claim.
      await record(a, "T-own", { name: "Era prune status", content: "T-own: started on the prune." });
      await capture(a, "T-own", "s-own", run("npm test", false, "1 failed", null));
      await record(a, "T-other", { name: "Era prune status", content: "T-other: Finished the shared cleanup." });
      // A failed capture naming a person erased after it was written.
      await record(a, "T-erased", FINISHED("T-erased"));
      await capture(
        a,
        "T-erased",
        "s-erased",
        run("npm test", false, "1 failed", null),
        "Orla Vennick asked for the cut pages to 404.",
      );
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "handoff-truth-erasure", {
        emails: [],
        names: ["orla vennick"],
        contactIds: [],
      });

      for (const task of [
        "T-nocapture",
        "T-untouched",
        "T-wrote",
        "T-rewrote",
        "T-failed",
        "T-norun",
        "T-sibling",
        "T-claim",
        "T-claim-2",
        "T-mix",
        "T-own",
        "T-erased",
      ]) {
        blocks[task] = await blockFor(task);
      }
    }, SPAWN_TIMEOUT_MS * 3);

    it("with no capture, says nothing about tests and marks nothing", () => {
      expect(blocks["T-nocapture"]).toContain("Finished the redirect cleanup");
      expect(blocks["T-nocapture"]).not.toMatch(/test run|\[unverified/i);
    });

    it("states a pass with no test edits seen in the repository as such, and marks nothing", () => {
      expect(blocks["T-untouched"]).toContain(
        "PASSED (Tests 3 passed (3)); no test edits seen in this repo. Command: npx vitest run app/robots.test.ts.",
      );
      expect(blocks["T-untouched"]).not.toContain("[unverified");
    });

    it("states a pass on tests the session wrote as such, and marks nothing: test-first work", () => {
      expect(blocks["T-wrote"]).toContain(
        "PASSED (Tests 3 passed (3)); it passed on tests that session wrote: app/robots.test.ts. Command: npx vitest run app/robots.test.ts.",
      );
      expect(blocks["T-wrote"]).not.toContain("[unverified");
    });

    it("marks a pass on a test that existed when the session started and that it rewrote", () => {
      expect(blocks["T-rewrote"]).toContain(
        "PASSED (Tests 3 passed (3)), but before it that session had edited tests that existed when it started: app/robots.test.ts.",
      );
      expect(blocks["T-rewrote"]).toMatch(
        /\[unverified: the last captured passing run used existing tests its own session had edited\] T-rewrote: Finished the redirect cleanup/,
      );
    });

    it("states a failed run and marks the claim", () => {
      expect(blocks["T-failed"]).toContain(
        "FAILED (Tests 2 failed | 8 passed (10)). Command: npx vitest run next.config.redirects.test.ts.",
      );
      expect(blocks["T-failed"]).toMatch(
        /\[unverified: the last captured test run FAILED\] T-failed: Finished the redirect cleanup/,
      );
    });

    it("states that no run was recognised, neutrally, and marks nothing: no run is not evidence of a problem", () => {
      expect(blocks["T-norun"]).toMatch(/Last test run, captured \S+Z: none recognised\./);
      expect(blocks["T-norun"]).not.toContain("[unverified");
    });

    it("judges nothing by a capture in a scope the reader may not read", () => {
      expect(blocks["T-sibling"]).toContain("Finished the redirect cleanup");
      expect(blocks["T-sibling"]).not.toMatch(/test run|\[unverified/i);
    });

    it("judges a task's claims by its own captures only, not another task's whose key starts with its own", () => {
      // The other task's capture may still be served as a recent write that mentions this task;
      // it is not this task's capture, so it opens no progress line and marks nothing.
      expect(blocks["T-claim"]).toContain("T-claim: Finished the redirect cleanup");
      expect(blocks["T-claim"]).not.toContain("Last test run");
      expect(blocks["T-claim"]).not.toContain("[unverified");
      expect(blocks["T-claim-2"]).toContain("[unverified: the last captured test run FAILED] T-claim-2: Finished");
    });

    it("marks the task's own claim among its recent writes, and leaves another task's claim beside it alone", () => {
      const lines = items(blocks["T-mix"]!);
      const other = lines.find((line) => line.includes("T-mix-2: Fixed the robots list"));
      const own = lines.filter((line) => line.includes("T-mix: Finished the redirect cleanup"));

      expect(other).toBeDefined();
      expect(other).not.toContain("[unverified");
      expect(own.length).toBeGreaterThan(0);
      for (const line of own) expect(line).toContain("[unverified: the last captured test run FAILED]");
    });

    it("does not mark another task's version of a fact the task's read serves under the same name", () => {
      const other = items(blocks["T-own"]!).find((line) => line.includes("T-other: Finished the shared cleanup."));

      expect(blocks["T-own"]).toContain("FAILED (1 failed)");
      expect(other).toBeDefined();
      expect(other).not.toContain("[unverified");
    });

    it("judges nothing by a capture an erasure withholds, and does not serve it", () => {
      expect(blocks["T-erased"]).toContain("T-erased: Finished the redirect cleanup");
      expect(blocks["T-erased"]).not.toMatch(/test run|\[unverified|Vennick/i);
    });
  });
});
