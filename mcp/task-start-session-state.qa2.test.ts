// Real capture hook in real git repositories, read back as the server reads it, rendered as the block
// B is served, against a "Finished" decision. No database, no network, no model call.
//
// Two classes. A test the run used can still sit where the capture does not look: inside a
// submodule, in a gitignored path, or in another repository the command reached without moving
// the hook's directory; each must not read as "untouched". And an honest session must not be
// marked only because the repository holds something the session never touched: a nested
// repository that was there before it started, or an untracked file it cleaned up before its run.
//
// The honest cases are ones real sessions do: run tests under `env -i PATH="$PATH" HOME="$HOME"`, or
// run tests, then write notes files, then say the work is done.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./task-start-session-state.frozen-clock.testsupport";
import { captureSessionState, sessionStateName, testRunOf } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

// Each case drives the hook through several real git processes.
vi.setConfig({ testTimeout: 30_000 });

const MCP_URL = new URL("https://willder.example/api/mcp");
const TASK = "T-qa698r2";
const ENV = { WILLDER_TOKEN: "wcap_qa698r2_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const SESSION = "qa698r20-handoff-truth-session";
const T0 = Date.parse("2026-10-13T17:30:00Z");
const FINISHED: ServedRule = {
  id: "decision-qa698r2",
  kind: "decision",
  subject: "redirect prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const UNTOUCHED = "that session had edited no test-like file";

const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.email=qa@example.com", "-c", "user.name=qa", "-c", "protocol.file.allow=always", ...args],
    { stdio: "pipe" },
  );

/** A committed git project holding `files`, in `parent` (a fresh temp directory by default), plus `untracked` files written after the commit. */
function project(files: Record<string, string>, untracked: Record<string, string> = {}, parent?: string) {
  const dir = parent
    ? join(parent, `repo-${Math.random().toString(36).slice(2, 8)}`)
    : mkdtempSync(join(tmpdir(), "willder-qa698r2-repo-"));
  if (parent) mkdirSync(dir, { recursive: true });
  else made.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  gitIn(dir, "init", "-q");
  for (const [path, text] of Object.entries(files)) write(path, text);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "start");
  for (const [path, text] of Object.entries(untracked)) write(path, text);
  return { dir, git: (...args: string[]) => gitIn(dir, ...args), write };
}

/** One agent session whose hook runs with `repo` as its directory, as Claude Code drives it. */
function session(repo: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-qa698r2-state-"));
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

/** B's block for the task: A's Finished decision and A's capture, both the task's own. */
function blockFor(capture: string): string {
  const fact: ServedFact = {
    id: "capture-qa698r2",
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

describe("a test the run used, where the capture does not look, is not 'untouched'", () => {
  it("a test rewritten inside a git submodule and run from the superproject: git diff lists only the submodule's path", async () => {
    const core = project({ "tests/redirects.test.ts": PINNED_TEST });
    const app = project(REDIRECTS);
    app.git("submodule", "add", "-q", core.dir, "packages/core");
    app.git("commit", "-qm", "add core");
    const a = session(app.dir);
    await a.start();
    app.write("packages/core/tests/redirects.test.ts", REWRITTEN_TEST);
    await a.passed("npx vitest run packages/core/tests/redirects.test.ts");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    // A run the capture cannot see into is stated as such and backs nothing, and is not a mark on the claim.
    expect(block).toContain("it ran tests outside what the capture can see");
    expect(block).not.toContain("no test edits seen");
  });

  it("a test the session wrote into a gitignored directory and ran by name", async () => {
    const repo = project({ ...REDIRECTS, ".gitignore": "tmp/\n" });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const redirects = [];\n");
    repo.write("tmp/redirects.test.ts", REWRITTEN_TEST);
    await a.passed("npx vitest run tmp/redirects.test.ts");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    // A run the capture cannot see into is stated as such and backs nothing, and is not a mark on the claim.
    expect(block).toContain("it ran tests outside what the capture can see");
    expect(block).not.toContain("no test edits seen");
  });

  it.each([
    // No cd at all: the hook's directory is the session's repository, the run is in the sibling.
    ["npm --prefix", (b: string) => `npm --prefix ${b} test`],
    ["vitest --root", (b: string) => `npx vitest run --root ${b}`],
    ["pytest on a path", (b: string) => `pytest ${b}/tests/test_redirects.py`],
    // Claude Code resets its directory when a `cd` leaves the project, so the hook's cwd stays put.
    ["cd outside the project", (b: string) => `cd ${b} && npx vitest run`],
  ])("a test rewritten in a sibling repository and run there through %s", async (_, command) => {
    const parent = mkdtempSync(join(tmpdir(), "willder-qa698r2-two-"));
    made.push(parent);
    const here = project(REDIRECTS, {}, parent);
    const there = project({ ...REDIRECTS, "tests/test_redirects.py": "def test_pins(): pass\n" }, {}, parent);
    const a = session(here.dir);
    await a.start();
    there.write("tests/test_redirects.py", "def test_keeps_none(): pass\n");
    await a.passed(command(there.dir));
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).not.toContain(UNTOUCHED);
    // A run the capture cannot see into is stated as such and backs nothing, and is not a mark on the claim.
    expect(block).toContain("it ran tests outside what the capture can see");
    expect(block).not.toContain("no test edits seen");
  });
});

describe("an honest session is not marked for what it never touched", () => {
  it("a repository holding an untracked nested clone from before the session", async () => {
    const repo = project({ ...REDIRECTS, "src/redirects.test.ts": PINNED_TEST });
    project({ "README.md": "upstream\n" }, {}, join(repo.dir, "scripts"));
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const redirects = [['/campaigns', '/dashboard', 308]];\n");
    await a.passed("npx vitest run");
    await a.stop();

    expect(blockFor(a.capture())).not.toContain("[unverified");
  });

  it("an untracked scratch file from before the session, removed before the passing run", async () => {
    const repo = project({ ...REDIRECTS, "src/redirects.test.ts": PINNED_TEST }, { "debug.log": "old output\n" });
    const a = session(repo.dir);
    await a.start();
    unlinkSync(join(repo.dir, "debug.log"));
    repo.write("src/redirects.ts", "export const redirects = [['/campaigns', '/dashboard', 308]];\n");
    await a.passed("npx vitest run");
    await a.stop();

    expect(blockFor(a.capture())).not.toContain("[unverified");
  });
});

describe("an honest session is not marked", () => {
  it.each([
    'env -i PATH="$PATH" HOME="$HOME" npx vitest run scripts/check-doc-anchors.test.ts',
    "env -u NODE_OPTIONS npm test",
  ])("%s is a test run", (command) => {
    expect(
      testRunOf({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "Tests  10 passed (10)" },
      }),
    ).not.toBeNull();
  });

  it("tests pass, then the session records its decision in notes.md and state.md", async () => {
    const repo = project({
      ...REDIRECTS,
      "src/redirects.test.ts": PINNED_TEST,
      "planning/notes.md": "# Decisions\n",
      "planning/state.md": "# State\n",
    });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const redirects = [['/campaigns', '/dashboard', 308]];\n");
    await a.passed("npx vitest run");
    repo.write("planning/notes.md", "# Decisions\n\n### 2026-10-13 — Redirects keep 308\n");
    repo.write("planning/state.md", "# State\n\nSTART HERE: redirects done.\n");
    await a.stop();

    expect(blockFor(a.capture())).not.toContain("[unverified");
  });
});
