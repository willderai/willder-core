// The task-start block must never call a pass "untouched" when the session that recorded it rewrote the tests,
// and must never mark an honest run "ran no tests". Each case below runs the real capture hook
// (cli/hooks/willder-capture.mjs) in a real git repository, reads its capture back as the server
// does (services/memory/session-state.ts), and renders the block B is served
// (mcp/task-start-notice.ts), against agent A's claim shape: "Finished".
// No database, no network, no model call.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./task-start-session-state.frozen-clock.testsupport";
import {
  captureSessionState,
  isTestFile,
  renderSessionState,
  sessionStateName,
  testRunOf,
} from "@/cli/hooks/willder-capture.mjs";
import { capturedSessionState, unverifiedBy } from "@/services/memory/session-state";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

// Each case drives the hook through several real git processes; under a loaded runner (the full
// suite, a CI shard) that takes longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const MCP_URL = new URL("https://willder.example/api/mcp");
const TASK = "T-case698";
const ENV = { WILLDER_TOKEN: "wcap_qa698_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const SESSION = "case698000-handoff-truth-session";
const T0 = Date.parse("2026-10-13T15:00:00Z");
const FINISHED: ServedRule = {
  id: "decision-case698",
  kind: "decision",
  subject: "redirect prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const UNTOUCHED = "that session had edited no test-like file";
const CLAIM_MARKED = /\[unverified: [^\]]+\] T-case698: Finished the redirect prune\./;

const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A committed git project holding `files`, plus `untracked` files written after the commit. */
function project(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "willder-case698-repo-"));
  made.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=qa@example.com", "-c", "user.name=qa", ...args], {
      stdio: "pipe",
    });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git("init", "-q");
  for (const [path, text] of Object.entries(files)) write(path, text);
  git("add", ".");
  git("commit", "-qm", "start");
  for (const [path, text] of Object.entries(untracked)) write(path, text);
  return { dir, git, write };
}

/** One agent session in `repo`, driven through the real hook the way Claude Code drives it. */
function session(repo: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-case698-state-"));
  made.push(stateDir);
  const written: string[] = [];
  let versions = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    written.push(String(JSON.parse(String(init!.body)).params.arguments.content));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `Stored and readable now. Version: v${++versions}.` }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  let now = T0;
  const hook = (input: Record<string, unknown>, cwd = repo) =>
    captureSessionState({ session_id: SESSION, cwd, ...input }, ENV, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now: (now += 1000),
      stateDir,
    });
  return {
    start: () => hook({ hook_event_name: "UserPromptSubmit", prompt: "Finish the redirect prune." }),
    passed: (command: string, cwd = repo) =>
      hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          tool_response: { stdout: "Tests  10 passed (10)\n", stderr: "" },
        },
        cwd,
      ),
    stop: (cwd = repo) =>
      hook({ hook_event_name: "Stop", last_assistant_message: "The redirect prune is finished." }, cwd),
    capture: () => written.at(-1) ?? "",
  };
}

/** B's block for the task: A's Finished decision and A's capture, both the task's own. */
function blockFor(capture: string): string {
  const fact: ServedFact = {
    id: "capture-case698",
    entityName: sessionStateName(TASK, SESSION),
    role: "progress",
    content: capture,
    writtenAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    ofTask: true,
  };
  return renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [FINISHED], facts: [fact] }).text ?? "";
}

const REDIRECTS = { "src/redirects.ts": "export const redirects = [['/campaigns', '/dashboard']];\n" };
const PINNED_TEST = "it('redirects /campaigns with a 308', () => {});\n";
const REWRITTEN_TEST = "it('keeps no redirects', () => {});\n";

describe("a pass recorded before the session rewrote its tests is not 'untouched'", () => {
  it.each([
    ["claims Finished without running the tests again", null],
    // Each of these runs the rewritten test, and the hook does not count it as a run.
    ["re-runs through pnpm's workspace filter", "pnpm --filter web test"],
    ["re-runs through npm's workspace flag", "npm -w web test"],
    ["re-runs inside a subshell", "(cd web && npm test)"],
  ])("baseline pass, then the regression test is rewritten, then it %s", async (_, rerun) => {
    const repo = project({ ...REDIRECTS, "src/redirects.test.ts": PINNED_TEST });
    const a = session(repo.dir);
    await a.start();
    await a.passed("npx vitest run");
    repo.write("src/redirects.ts", "export const redirects = [];\n");
    repo.write("src/redirects.test.ts", REWRITTEN_TEST);
    if (rerun) await a.passed(rerun);
    await a.stop();

    expect(a.capture()).toContain("Files changed since the session started: src/redirects.test.ts, src/redirects.ts");
    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    expect(block).toMatch(CLAIM_MARKED);
  });
});

describe("the session's own test edits are seen whatever git shape they take", () => {
  it("a test file left untracked by an earlier session, then rewritten and run by this one", async () => {
    // A handoff in the same working tree: A wrote the test and never committed it; this session rewrites it.
    const repo = project(REDIRECTS, { "src/redirects.test.ts": PINNED_TEST });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.test.ts", REWRITTEN_TEST);
    await a.passed("npx vitest run src/redirects.test.ts");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    expect(block).toMatch(CLAIM_MARKED);
  });

  it("a failing test moved out of the suite with git mv: git diff --name-only lists only the new name", async () => {
    const repo = project({ ...REDIRECTS, "src/redirects.test.ts": PINNED_TEST });
    const a = session(repo.dir);
    await a.start();
    repo.git("mv", "src/redirects.test.ts", "src/redirects.disabled.ts");
    await a.passed("npx vitest run");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    expect(block).toMatch(CLAIM_MARKED);
  });

  it("a test rewrite committed before the agent cds into the package to run it", async () => {
    // Claude Code's hook input carries the session's current directory, which a `cd` in a Bash
    // call moves (the cwd field of a session transcript changes the same way). The hook keys its
    // state file by that directory, so the run starts a new state at the current HEAD.
    const repo = project({
      "web/src/redirects.ts": REDIRECTS["src/redirects.ts"],
      "web/src/redirects.test.ts": PINNED_TEST,
    });
    const web = join(repo.dir, "web");
    const a = session(repo.dir);
    await a.start();
    repo.write("web/src/redirects.test.ts", REWRITTEN_TEST);
    repo.git("commit", "-qam", "prune era 1 redirects");
    await a.passed("cd web && npx vitest run", web);
    await a.stop(web);

    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    expect(block).toMatch(CLAIM_MARKED);
  });
});

describe("isTestFile covers the test layouts of the runners the hook recognises", () => {
  it.each([
    // `dotnet test` is a recognised runner; .NET puts tests in a `<Project>.Tests` directory.
    "MyApp.Tests/UnitTest1.cs",
    "src/Orders.Tests/AckTests.cs",
    // The PR claims mocks are covered; MSW's documented location is src/mocks/.
    "src/mocks/handlers.ts",
    // Vitest reads its `test` block (include, exclude, setupFiles) from vite.config.* too.
    "vite.config.ts",
    "vite.config.mts",
  ])("%s is test-like", (path) => {
    expect(isTestFile(path)).toBe(true);
  });
});

describe("an honest run through a monorepo workspace command is a test run", () => {
  it.each([
    "npm t",
    "npm -w web test",
    "npm --workspace=web test",
    "pnpm --filter web test",
    "pnpm -F web test",
    "pnpm -r test",
    "pnpm -C web test",
    "yarn workspace web test",
    "(cd web && npm test)",
    "npx turbo run test",
    "npx nx test web",
    "./mvnw test",
  ])("%s", (command) => {
    expect(
      testRunOf({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "Tests  10 passed (10)" },
      }),
    ).not.toBeNull();
  });

  it("is not reported to the next session as 'ran no tests'", async () => {
    const repo = project({ ...REDIRECTS, "src/redirects.test.ts": PINNED_TEST });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const redirects = [['/campaigns', '/dashboard', 308]];\n");
    await a.passed("pnpm --filter web test");
    await a.stop();

    expect(blockFor(a.capture())).not.toContain("ran no tests");
  });
});

describe("a run cannot be dated after the capture that recorded it", () => {
  it("an older capture whose run time is later than when it was written does not outvote the newest session's FAILED run", () => {
    // Session 1's machine clock runs two hours ahead (or the capture was written by hand with a
    // future run time). Session 2, newer by every server clock, ran the tests and they failed.
    const failedRun = {
      command: "npx vitest run",
      passed: false,
      line: "Tests  2 failed | 8 passed (10)",
      at: "2026-10-13T15:09:00.000Z",
      edited: { files: [], named: [] },
    };
    const skewedPass = {
      command: "npx vitest run",
      passed: true,
      line: "Tests  10 passed (10)",
      at: "2026-10-13T17:00:00.000Z",
      edited: { files: [], named: [] },
    };
    const state = (test: typeof failedRun) =>
      capturedSessionState({
        entityName: sessionStateName(TASK, SESSION),
        role: "progress",
        content: renderSessionState({ trigger: "Stop", task: TASK, files: ["src/redirects.ts"], test }),
      })!;

    const verdict = unverifiedBy([
      { id: "session-2", writtenAt: "2026-10-13T15:10:00.000Z", state: state(failedRun) },
      { id: "session-1", writtenAt: "2026-10-13T15:00:00.000Z", state: state(skewedPass) },
    ]);

    expect(verdict?.reason).toBe("failed");
  });
});
