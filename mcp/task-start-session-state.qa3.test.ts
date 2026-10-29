// Rule (b) on what a named test loads. Real capture hook in real git repositories, read back as
// the server reads it, rendered as the next agent's block, against a "Finished" decision. No
// database, no network, no model call.
//
// Rule (b) marks a pass after the session edited a test file that existed when it started. A run
// that names only test files the session did not edit is read as "about other tests" and weighs
// nothing (`weighsExistence`, NAMED_OTHER). That holds for a test file the run did not load. It
// does not hold for what a named test loads: an existing fixture, mock, conftest or setup file is
// used by the test the run names, and a deleted regression test is a test the run no longer has.
// Each case below rewrites a shipped test's support file instead of the test itself, and each
// claim must be marked.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./task-start-session-state.frozen-clock.testsupport";
import { captureSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

// Each case drives the hook through several real git processes.
vi.setConfig({ testTimeout: 30_000 });

const MCP_URL = new URL("https://willder.example/api/mcp");
const TASK = "T-prune01";
const ENV = { WILLDER_TOKEN: "wcap_prune01_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const SESSION = "prune010-handoff-truth-session";
const T0 = Date.parse("2026-10-13T22:00:00Z");
const FINISHED: ServedRule = {
  id: "decision-prune01",
  kind: "decision",
  subject: "redirect prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const CLAIM_MARKED = /\[unverified: [^\]]+\] T-prune01: Finished the redirect prune\./;

const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "willder-prune01-repo-"));
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
  return { dir, git, write };
}

function session(repo: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-prune01-state-"));
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
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  let now = T0;
  const hook = (input: Record<string, unknown>) =>
    captureSessionState({ session_id: SESSION, cwd: repo, ...input }, ENV, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now: (now += 1000),
      stateDir,
    });
  return {
    start: () => hook({ hook_event_name: "UserPromptSubmit", prompt: "Finish the redirect prune." }),
    passed: (command: string) =>
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "Tests  10 passed (10)\n", stderr: "" },
      }),
    stop: () => hook({ hook_event_name: "Stop", last_assistant_message: "The redirect prune is finished." }),
    capture: () => written.at(-1) ?? "",
  };
}

function blockFor(capture: string): string {
  const fact: ServedFact = {
    id: "capture-prune01",
    entityName: sessionStateName(TASK, SESSION),
    role: "progress",
    content: capture,
    writtenAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    ofTask: true,
  };
  return renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [FINISHED], facts: [fact] }).text ?? "";
}

const SRC = { "src/redirects.ts": "export const redirects = [['/campaigns', '/dashboard', 308]];\n" };

describe("an existing file the named test loads, rewritten, then that test run by name", () => {
  it.each([
    [
      "a fixture",
      {
        "tests/fixtures/redirects.json": '{"/campaigns": 308}\n',
        "tests/redirects.test.ts": "it('matches the fixture', () => {});\n",
      },
      "tests/fixtures/redirects.json",
      '{"/campaigns": 404}\n',
      "npx vitest run tests/redirects.test.ts",
    ],
    [
      "a mock",
      {
        "src/__mocks__/config.ts": "export const redirects = [['/campaigns', '/dashboard', 308]];\n",
        "src/redirects.test.ts": "it('uses the mock', () => {});\n",
      },
      "src/__mocks__/config.ts",
      "export const redirects = [];\n",
      "npx vitest run src/redirects.test.ts",
    ],
    [
      "pytest's conftest.py",
      { "tests/conftest.py": "import pytest\n", "tests/test_redirects.py": "def test_308(): pass\n" },
      "tests/conftest.py",
      "import pytest\ncollect_ignore = ['test_redirects.py']\n",
      "pytest tests/test_redirects.py",
    ],
    [
      "a vitest setup file",
      { "vitest.setup.ts": "export {};\n", "src/redirects.test.ts": "it('308', () => {});\n" },
      "vitest.setup.ts",
      "globalThis.expect = () => ({ toBe() {} });\n",
      "npx vitest run src/redirects.test.ts",
    ],
  ])("%s", async (_, files, rewritten, text, command) => {
    const repo = project({ ...SRC, ...files });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const redirects = [];\n");
    repo.write(rewritten, text);
    await a.passed(command);
    await a.stop();

    expect(blockFor(a.capture())).toMatch(CLAIM_MARKED);
  });
});

describe("the failing regression test removed, then another existing test run by name", () => {
  it.each([
    ["git rm", (p: ReturnType<typeof project>) => p.git("rm", "-q", "tests/redirects.test.ts")],
    [
      "moved out of the suite",
      (p: ReturnType<typeof project>) => p.git("mv", "tests/redirects.test.ts", "tests/redirects.test.ts.off"),
    ],
  ])("%s", async (_, remove) => {
    const repo = project({
      ...SRC,
      "tests/redirects.test.ts": "it('redirects /campaigns with a 308', () => {});\n",
      "tests/robots.test.ts": "it('lists /', () => {});\n",
    });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const redirects = [];\n");
    remove(repo);
    await a.passed("npx vitest run tests/robots.test.ts");
    await a.stop();

    expect(blockFor(a.capture())).toMatch(CLAIM_MARKED);
  });
});
