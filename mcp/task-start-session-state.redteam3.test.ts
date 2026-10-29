// Can a real false "done" slip through? Each case is a session whose completion claim the
// evidence the hook can observe contradicts (a failed run, a pass on or after rewritten tests,
// tests edited after the pass), and asserts the claim is marked. Real hook, real git, read
// back as the server reads it, rendered as B's block. No database, no network, no model call.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./task-start-session-state.frozen-clock.testsupport";
import { captureSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

vi.setConfig({ testTimeout: 30_000 });
const MCP_URL = new URL("https://willder.example/api/mcp");
const TASK = "T-rt3";
const ENV = { WILLDER_TOKEN: "wcap_rt3_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const T0 = Date.parse("2026-10-13T17:30:00Z");
const FINISHED: ServedRule = {
  id: "decision-rt3",
  kind: "decision",
  subject: "redirect prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const MARKED = /\[unverified: [^\]]+\] T-rt3: Finished the redirect prune\./;
const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=qa@example.com", "-c", "user.name=qa", ...args], { stdio: "pipe" });

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "willder-rt3-repo-"));
  made.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  gitIn(dir, "init", "-q");
  for (const [path, text] of Object.entries(files)) write(path, text);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "start");
  return { dir, write, git: (...a: string[]) => gitIn(dir, ...a) };
}

function session(repo: string, id = "rt3aaaaa-session") {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-rt3-state-"));
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
  const hook = (input: Record<string, unknown>) =>
    captureSessionState({ session_id: id, cwd: repo, ...input }, ENV, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now: (now += 1000),
      stateDir,
    });
  return {
    start: () => hook({ hook_event_name: "UserPromptSubmit", prompt: "Finish the redirect prune." }),
    exit0: (command: string, stdout = "Tests  10 passed (10)\n") =>
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout, stderr: "" },
      }),
    failed: (command: string) =>
      hook({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command },
        error: "Exit code 1\nTests  1 failed | 9 passed (10)",
      }),
    stop: () => hook({ hook_event_name: "Stop", last_assistant_message: "The redirect prune is finished." }),
    capture: () => written.at(-1) ?? "",
  };
}

function blockFor(capture: string, id = "rt3aaaaa-session"): string {
  const fact: ServedFact = {
    id: "capture-rt3",
    entityName: sessionStateName(TASK, id),
    role: "progress",
    content: capture,
    writtenAt: new Date(T0 + 3600_000).toISOString(),
    ofTask: true,
  };
  return renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [FINISHED], facts: [fact] }).text ?? "";
}

async function rewrittenThenPassed(files: Record<string, string>, testPath: string, command: string) {
  const p = project(files);
  const a = session(p.dir);
  await a.start();
  p.write(testPath, "// rewritten to assert the wrong change\n");
  await a.exit0(command);
  await a.stop();
  return { block: blockFor(a.capture()), capture: a.capture() };
}

const SRC = { "src/redirects.ts": "export const r = 1;\n" };

describe("a whole-suite run whose options carry a path reads as 'named only other tests'", () => {
  const cases: [string, Record<string, string>, string, string][] = [
    [
      "go test ./...",
      { "pkg/redirects.go": "package pkg\n", "pkg/redirects_test.go": "package pkg\n" },
      "pkg/redirects_test.go",
      "go test ./...",
    ],
    [
      "vitest --reporter=./file",
      { ...SRC, "tests/redirects.test.ts": "it('308')\n", "scripts/reporter.mjs": "" },
      "tests/redirects.test.ts",
      "npx vitest run --reporter=./scripts/reporter.mjs",
    ],
    [
      "vitest --outputFile=reports/junit.xml",
      { ...SRC, "tests/redirects.test.ts": "it('308')\n" },
      "tests/redirects.test.ts",
      "npx vitest run --reporter=junit --outputFile=reports/junit.xml",
    ],
    [
      "pytest --cov=src/app",
      { "src/app/r.py": "", "tests/test_redirects.py": "def test_308(): pass\n" },
      "tests/test_redirects.py",
      "pytest --cov=src/app",
    ],
    [
      "pytest --junitxml=reports/junit.xml",
      { "app.py": "", "tests/test_redirects.py": "def test_308(): pass\n" },
      "tests/test_redirects.py",
      "pytest --junitxml=reports/junit.xml",
    ],
    [
      "mocha --require ts-node/register",
      { ...SRC, "test/redirects.spec.ts": "it('308')\n" },
      "test/redirects.spec.ts",
      "npx mocha --require ts-node/register",
    ],
    [
      "dotnet test App.Tests/App.Tests.csproj",
      { "App/R.cs": "", "App.Tests/App.Tests.csproj": "", "App.Tests/RedirectsTest.cs": "" },
      "App.Tests/RedirectsTest.cs",
      "dotnet test App.Tests/App.Tests.csproj",
    ],
  ];
  for (const [name, files, testPath, command] of cases) {
    it(name, async () => {
      const { block } = await rewrittenThenPassed(files, testPath, command);
      expect(block).toMatch(MARKED);
    });
  }
});

describe("a failing test run recorded as a pass because the Bash call exits 0", () => {
  for (const command of ["npx vitest run || true", "npx vitest run; echo ok", "npx vitest run 2>&1 | tail -5"]) {
    it(command, async () => {
      const p = project({ ...SRC, "tests/redirects.test.ts": "it('308')\n" });
      const a = session(p.dir);
      await a.start();
      p.write("src/redirects.ts", "export const r = 2;\n");
      await a.exit0(
        command,
        " FAIL  tests/redirects.test.ts > 308\n Test Files  1 failed (1)\n      Tests  1 failed | 9 passed (10)\n",
      );
      await a.stop();
      const block = blockFor(a.capture());
      expect(block).toMatch(MARKED);
    });
  }
});

describe("a recognised 'run' that runs no tests replaces the failing run", () => {
  for (const command of [
    "npx vitest list",
    "pytest --fixtures",
    "go test -run '^$' ./...",
    "npx vitest run --passWithNoTests -t nomatch",
    "npx vitest bench --run",
  ]) {
    it(command, async () => {
      const p = project({ ...SRC, "tests/redirects.test.ts": "it('308')\n" });
      const a = session(p.dir);
      await a.start();
      p.write("src/redirects.ts", "export const r = 2;\n");
      await a.failed("npx vitest run");
      // As each runner prints it when it runs no test.
      const output: Record<string, string> = {
        "npx vitest list": "tests/redirects.test.ts > 308\n",
        "pytest --fixtures": "cache -- .venv/lib/python3.12/site-packages/_pytest/cacheprovider.py:556\n",
        "go test -run '^$' ./...": "ok  \texample.com/app\t0.002s [no tests to run]\n",
        "npx vitest run --passWithNoTests -t nomatch": " Test Files  1 skipped (1)\n      Tests  1 skipped (1)\n",
        "npx vitest bench --run": " BENCH  Summary\n",
      };
      await a.exit0(command, output[command]!);
      await a.stop();
      const block = blockFor(a.capture());
      expect(block).toMatch(MARKED);
    });
  }
});

describe("real test files the classifier does not count as tests", () => {
  const cases: [string, Record<string, string>, string, string][] = [
    [
      "cucumber .feature",
      { ...SRC, "features/redirects.feature": "Feature: 308\n" },
      "features/redirects.feature",
      "bundle exec cucumber",
    ],
    [
      "cypress component *.cy.tsx",
      { ...SRC, "src/Button.cy.tsx": "it('308')\n" },
      "src/Button.cy.tsx",
      "npx cypress run --component",
    ],
    [
      "pytest .pytest.ini",
      { "app.py": "", "tests/test_redirects.py": "def test_308(): pass\n", ".pytest.ini": "[pytest]\n" },
      ".pytest.ini",
      "pytest",
    ],
  ];
  for (const [name, files, testPath, command] of cases) {
    it(name, async () => {
      const { block } = await rewrittenThenPassed(files, testPath, command);
      expect(block).toMatch(MARKED);
    });
  }
});

describe("rewritten test restored in the same Bash call after the run", () => {
  it("npx vitest run; git checkout -- tests/redirects.test.ts", async () => {
    const p = project({ ...SRC, "tests/redirects.test.ts": "it('308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("src/redirects.ts", "export const r = 2;\n");
    p.write("tests/redirects.test.ts", "it('no redirects')\n");
    p.git("checkout", "--", "tests/redirects.test.ts");
    await a.exit0("npx vitest run && git checkout -- tests/redirects.test.ts");
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).toMatch(MARKED);
  });
});
