// Adversarial cases for session-state capture; each asserts the safe behaviour. Commands that
// run no tests must not count as a passing run; a session's test-like edits must never read as "untouched" however git or the
// session's directories hide them; a pass followed by changes, or by a run the hook does not
// recognise, must not back a claim; an ordinary follow-on clause must not take a claim back.
// Real capture hook in real git repositories, read back as the server reads it, rendered as the
// block B is served. No database, no network, no model call.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./task-start-session-state.frozen-clock.testsupport";
import { captureSessionState, isTestFile, sessionStateName, testRunOf } from "@/cli/hooks/willder-capture.mjs";
import { claimsCompletion } from "@/services/memory/session-state";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

// Each case drives the hook through several real git processes; under a loaded runner that takes longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const MCP_URL = new URL("https://willder.example/api/mcp");
const TASK = "T-rt698";
const ENV = { WILLDER_TOKEN: "wcap_rt698_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const SESSION = "rt698000-redteam-session";
const T0 = Date.parse("2026-10-13T15:00:00Z");
const FINISHED: ServedRule = {
  id: "decision-rt698",
  kind: "decision",
  subject: "prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const UNTOUCHED = "that session had edited no test-like file";
const CLAIM_MARKED = /\[unverified: [^\]]+\] T-rt698: Finished the redirect prune\./;
const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "willder-rt698-repo-"));
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
function session(repo: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-rt698-state-"));
  made.push(stateDir);
  const written: string[] = [];
  let versions = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    written.push(String(JSON.parse(String(init!.body)).params.arguments.content));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `Stored. Version: v${++versions}.` }] },
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
    start: (cwd = repo) => hook({ hook_event_name: "UserPromptSubmit", prompt: "Finish the prune." }, cwd),
    passed: (command: string, cwd = repo) =>
      hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          tool_response: { stdout: "ok\n", stderr: "" },
        },
        cwd,
      ),
    failed: (command: string, cwd = repo) =>
      hook(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command },
          error: "Tests  1 failed | 9 passed (10)",
        },
        cwd,
      ),
    stop: (cwd = repo) => hook({ hook_event_name: "Stop", last_assistant_message: "Finished." }, cwd),
    capture: () => written.at(-1) ?? "",
  };
}
function blockFor(capture: string): string {
  const fact: ServedFact = {
    id: "capture-rt698",
    entityName: sessionStateName(TASK, SESSION),
    role: "progress",
    content: capture,
    writtenAt: new Date(T0 + 3600e3).toISOString(),
    ofTask: true,
  };
  return renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [FINISHED], facts: [fact] }).text ?? "";
}
const SRC = { "src/redirects.ts": "export const r = [1];\n" };
const PINNED = "it('pins', () => {});\n";
const bash = (command: string) =>
  testRunOf({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: "" },
  });

describe("run detection: commands that run no tests do not count as a passing run", () => {
  it.each([
    "./gradlew build -x test",
    "gradle clean build -x test",
    "mvn verify -DskipTests",
    "cargo test --no-run",
    "pytest --collect-only -q",
    "npx jest --clearCache",
    "npx vitest --version",
    "tox -e lint",
    "make checkout",
    'git commit -am "Fix prune; vitest passes"',
    "git commit -am 'Prune redirects; jest green'",
  ])("%s", (command) => expect(bash(command)).toBeNull());
});

describe("run detection: common honest runs", () => {
  it.each(["node --test", "npm run test-unit", "bash scripts/test.sh", "nice -n 10 pytest", 'sh -c "npm test"'])(
    "%s",
    (command) => expect(bash(command)).not.toBeNull(),
  );
});

describe("a failing run, then a commit whose message names a runner after ';'", () => {
  it("must not back Finished", async () => {
    const repo = project({ ...SRC, "src/redirects.test.ts": PINNED });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const r = [];\n");
    await a.failed("npx vitest run");
    await a.passed('git commit -am "Prune redirects; vitest still red, fixing next"');
    await a.stop();
    expect(blockFor(a.capture())).toMatch(CLAIM_MARKED);
  });
  it("./gradlew test fails, then ./gradlew build -x test: must not back Finished", async () => {
    const repo = project({ ...SRC, "src/test/java/RTest.java": PINNED });
    const a = session(repo.dir);
    await a.start();
    repo.write("src/redirects.ts", "export const r = [];\n");
    await a.failed("./gradlew test");
    await a.passed("./gradlew build -x test");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(CLAIM_MARKED);
  });
});

describe("'untouched' while the session changed test-like files", () => {
  it("new test written into a second repo before the session cds there", async () => {
    const a0 = project(SRC);
    const b = project(SRC);
    const a = session(a0.dir);
    await a.start(a0.dir);
    b.write("src/redirects.test.ts", "it('keeps no redirects', () => {});\n"); // Write tool, cwd still A
    await a.passed("cd ../b && npx vitest run", b.dir);
    await a.stop(b.dir);
    expect(blockFor(a.capture())).not.toContain(UNTOUCHED);
  });
  it("tests rewritten inside a nested git repo (untracked dir of the outer repo), run from the outer root", async () => {
    const outer = project(SRC);
    execFileSync("git", ["init", "-q", join(outer.dir, "pkg")]);
    outer.write("pkg/src/a.test.ts", PINNED);
    execFileSync("git", ["-C", join(outer.dir, "pkg"), "-c", "user.email=q@e", "-c", "user.name=q", "add", "."]);
    execFileSync("git", [
      "-C",
      join(outer.dir, "pkg"),
      "-c",
      "user.email=q@e",
      "-c",
      "user.name=q",
      "commit",
      "-qm",
      "x",
    ]);
    const a = session(outer.dir);
    await a.start();
    outer.write("pkg/src/a.test.ts", "it('rewritten', () => {});\n");
    await a.passed("npx vitest run");
    await a.stop();
    expect(blockFor(a.capture())).not.toContain(UNTOUCHED);
  });
  it("package.json test script rewritten to skip the regression test", async () => {
    const repo = project({
      ...SRC,
      "src/redirects.test.ts": PINNED,
      "package.json": '{"scripts":{"test":"vitest run"}}\n',
    });
    const a = session(repo.dir);
    await a.start();
    repo.write("package.json", '{"scripts":{"test":"vitest run --exclude src/redirects.test.ts --passWithNoTests"}}\n');
    await a.passed("npm test");
    await a.stop();
    expect(blockFor(a.capture())).not.toContain(UNTOUCHED);
  });
  it.each(["src/test/../FooTest.java", "app/FooTest.java", ".env.test", "tests/integration.rs", "src/parser_test.rs"])(
    "isTestFile(%s)",
    (p) => expect(isTestFile(p)).toBe(true),
  );
  // An edit to a test file is evidence against a pass, so only real test
  // files count; a manifest or build file, and a Rust source with inline tests, do not.
  it.each(["pyproject.toml", "src/lib.rs", "tsconfig.json", "Makefile"])("not isTestFile(%s)", (p) =>
    expect(isTestFile(p)).toBe(false),
  );
  it("pre-existing untracked failing test deleted, then suite passes (documented gap)", async () => {
    const repo = project(SRC, { "src/redirects.test.ts": PINNED });
    const a = session(repo.dir);
    await a.start();
    unlinkSync(join(repo.dir, "src/redirects.test.ts"));
    await a.passed("npx vitest run");
    await a.stop();
    expect(blockFor(a.capture())).not.toContain(UNTOUCHED);
  });
  it("test file name holding the header text and ', none'", async () => {
    const repo = project({ ...SRC });
    const a = session(repo.dir);
    await a.start();
    repo.write("tests/x, none.ts", PINNED);
    await a.passed("npx vitest run");
    await a.stop();
    expect(blockFor(a.capture())).not.toContain(UNTOUCHED);
  });
});

describe("claimsCompletion: a following clause that is not a take-back", () => {
  it.each([
    "Implemented the fix. No migration needed.",
    "Done. No further changes needed.",
    "Fixed the redirect bug; nothing pending.",
    "Task complete, nothing remaining.",
    "Shipped the prune. No rollback needed.",
    "Finished the prune. Not yet.",
  ])("%s", (text) => expect(claimsCompletion(text)).toBe(true));
  it("a finished claim followed by a not-done list stays a claim", () =>
    expect(
      claimsCompletion(
        "T-7c3e19a2: Finished the old-page prune. Deleted leftover app/(app)/activity page. Not done: notes.md entries and a full test run; tsc clean.",
      ),
    ).toBe(true));
});

describe("hostile command text is read in linear time", () => {
  it.each([
    ["spaces", `echo a${" ".repeat(100_000)}b`],
    ["closing brackets", `echo a${")".repeat(100_000)}b`],
    ["quotes", `echo ${"'a' ".repeat(30_000)}`],
  ])("100k characters of %s", (_name, command) => {
    const started = performance.now();
    bash(command);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("an unrecognised failing run after a recognised pass", () => {
  it("must not back Finished on the stale pass", async () => {
    const repo = project({ ...SRC, "src/redirects.test.ts": PINNED });
    const a = session(repo.dir);
    await a.start();
    await a.passed("npx vitest run src/other.test.ts");
    repo.write("src/redirects.ts", "export const r = [];\n");
    await a.failed("npm run test-unit");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(CLAIM_MARKED);
  });
});
