// Which edited tests count against a pass:
// a pass after the session edited a test file that existed when it started (changed, deleted or
// moved away) is evidence the claim may rest on a rewritten test, and is marked. A pass when every
// test file the session edited is one it wrote is how test-first work looks: the line says so,
// plainly, and marks nothing. Existence is judged by path, so a test deleted and written again
// under its old path existed.
// Real hook, real git, read back as the server reads it, rendered as the next agent's block. No
// database, no network, no model call.
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
const TASK = "T-existing";
const SESSION = "exist000-session";
const ENV = { WILLDER_TOKEN: "wcap_existing_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const T0 = Date.parse("2026-10-13T18:00:00Z");
const FINISHED: ServedRule = {
  id: "decision-existing",
  kind: "decision",
  subject: "redirect prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const ANY_MARK = /\[unverified: [^\]]+\]/;
const PASSED_ON_EXISTING =
  "[unverified: the last captured passing run used existing tests its own session had edited] T-existing: Finished";
const PASSED_AFTER_EXISTING =
  "[unverified: the last captured passing run came after its session edited existing tests] T-existing: Finished";
const SRC = { "src/redirects.ts": "export const r = 1;\n" };
const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" });

/** A repository with `tracked` committed and `untracked` written but never added, as the session finds it. */
function project(tracked: Record<string, string>, untracked: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "willder-existing-repo-"));
  made.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  gitIn(dir, "init", "-q");
  for (const [path, text] of Object.entries(tracked)) write(path, text);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "start");
  for (const [path, text] of Object.entries(untracked)) write(path, text);
  return {
    dir,
    write,
    remove: (path: string) => rmSync(join(dir, path)),
    git: (...args: string[]) => gitIn(dir, ...args),
  };
}

/** One Claude Code session in `repo`, through the hook; `capture()` is the last session state it wrote. */
function session(repo: string, cwd = repo) {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-existing-state-"));
  made.push(stateDir);
  const written: string[] = [];
  let versions = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    written.push(String(JSON.parse(String(init!.body)).params.arguments.content));
    const result = { content: [{ type: "text", text: `Stored and readable now. Version: v${++versions}.` }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  let now = T0;
  const hook = (input: Record<string, unknown>) =>
    captureSessionState({ session_id: SESSION, cwd, ...input }, ENV, {
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
        tool_response: { stdout: " Test Files  1 passed (1)\n      Tests  4 passed (4)\n", stderr: "" },
      }),
    stop: () => hook({ hook_event_name: "Stop", last_assistant_message: "The redirect prune is finished." }),
    capture: () => written.at(-1) ?? "",
  };
}

/** The next agent's task-start block, holding the claim and the capture. */
function blockFor(capture: string): string {
  const fact: ServedFact = {
    id: "capture-existing",
    entityName: sessionStateName(TASK, SESSION),
    role: "progress",
    content: capture,
    writtenAt: new Date(T0 + 3600_000).toISOString(),
    ofTask: true,
  };
  return renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [FINISHED], facts: [fact] }).text ?? "";
}

describe("a pass on tests the session wrote: test-first work, stated and not marked", () => {
  it("new test files only, named by the run", async () => {
    const p = project({ ...SRC, "tests/robots.test.ts": "it('lists /')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("src/redirects.ts", "export const r = 2;\n");
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();

    expect(a.capture()).toContain("Of those, these existed when the session started: none");
    const block = blockFor(a.capture());
    expect(block).toContain(
      "PASSED (Tests 4 passed (4)); it passed on tests that session wrote: tests/redirects.test.ts. Command:",
    );
    expect(block).toContain(
      `- [decision decision-existing] [untested plan: verify before following] redirect prune: ${TASK}: Finished the redirect prune. — unknown`,
    );
    expect(block).not.toMatch(ANY_MARK);
  });

  it("new test files only, written in the same Bash call and run with the whole suite", async () => {
    const p = project({ ...SRC, "tests/robots.test.ts": "it('lists /')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("cat > tests/redirects.test.ts <<'EOF'\nit('serves 404 for /campaigns')\nEOF\nnpx vitest run");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).toContain("; it passed on tests that session wrote: tests/redirects.test.ts. Command:");
    expect(block).not.toMatch(ANY_MARK);
  });
});

describe("a pass after the session edited a test that existed when it started: marked", () => {
  it("a tracked test, edited and named by the run", async () => {
    const p = project({ ...SRC, "tests/redirects.test.ts": "it('redirects /campaigns with 308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();

    expect(a.capture()).toContain("Of those, these existed when the session started: tests/redirects.test.ts");
    const block = blockFor(a.capture());
    expect(block).toContain(
      ", but before it that session had edited tests that existed when it started: tests/redirects.test.ts. Command:",
    );
    expect(block).toContain(PASSED_ON_EXISTING);
  });

  it("a test untracked when the session started, edited, then the whole suite run", async () => {
    const p = project(SRC, { "tests/redirects.test.ts": "it('redirects /campaigns with 308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run");
    await a.stop();

    expect(blockFor(a.capture())).toContain(PASSED_AFTER_EXISTING);
  });

  it("a run that named only a new test, after the session edited an existing one it did not name", async () => {
    const p = project({ ...SRC, "tests/robots.test.ts": "it('lists /')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/robots.test.ts", "it('lists / and drops /campaigns')\n");
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).toContain(
      ", but before it that session had edited tests that existed when it started: tests/robots.test.ts. Command:",
    );
    expect(block).toContain(PASSED_AFTER_EXISTING);
  });

  it("an existing test edited beside a new one: the existing one alone is named against the pass", async () => {
    const p = project({ ...SRC, "tests/redirects.test.ts": "it('redirects /campaigns with 308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    p.write("tests/robots.test.ts", "it('drops /campaigns')\n");
    await a.passed("npx vitest run");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).toContain(
      ", but before it that session had edited tests that existed when it started: tests/redirects.test.ts. Command:",
    );
    expect(block).toContain(PASSED_AFTER_EXISTING);
  });

  it("a tracked test rewritten in the same Bash call, from a session working in a subdirectory", async () => {
    const p = project({
      "web/src/redirects.ts": "export const r = 1;\n",
      "web/tests/redirects.test.ts": "it('redirects /campaigns with 308')\n",
    });
    const a = session(p.dir, join(p.dir, "web"));
    await a.start();
    p.write("web/tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed(
      "cat > tests/redirects.test.ts <<'EOF'\nit('serves 404 for /campaigns')\nEOF\nnpx vitest run tests/redirects.test.ts",
    );
    await a.stop();

    // The call's own write is named from the repository root, as git names it: one file, not two.
    expect(a.capture()).toContain("Test files this session had edited before that run: web/tests/redirects.test.ts\n");
    expect(a.capture()).toContain("Of those, these existed when the session started: web/tests/redirects.test.ts\n");
    expect(blockFor(a.capture())).toContain(PASSED_ON_EXISTING);
  });

  it("a test restored in the run's own call, from a session working in a subdirectory, is named from the root", async () => {
    const p = project({
      "web/src/redirects.ts": "export const r = 1;\n",
      "web/tests/redirects.test.ts": "it('redirects /campaigns with 308')\n",
    });
    const a = session(p.dir, join(p.dir, "web"));
    await a.start();
    p.write("web/src/redirects.ts", "export const r = 2;\n");
    await a.passed("npx vitest run && git checkout -- tests/redirects.test.ts");
    await a.stop();

    expect(a.capture()).toContain("Test files this session edited after that run: web/tests/redirects.test.ts\n");
  });
});

describe("a test deleted and written again under its old path existed: marked", () => {
  it("a tracked test, removed from git and written again", async () => {
    const p = project({ ...SRC, "tests/redirects.test.ts": "it('redirects /campaigns with 308')\n" });
    const a = session(p.dir);
    await a.start();
    p.git("rm", "-q", "tests/redirects.test.ts");
    p.git("commit", "-qm", "drop the redirect test");
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();

    expect(blockFor(a.capture())).toContain(PASSED_ON_EXISTING);
  });

  it("an untracked test, removed and written again in the same Bash call as the run", async () => {
    const p = project(SRC, { "tests/redirects.test.ts": "it('redirects /campaigns with 308')\n" });
    const a = session(p.dir);
    await a.start();
    p.remove("tests/redirects.test.ts");
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed(
      "rm tests/redirects.test.ts && cat > tests/redirects.test.ts <<'EOF'\nit('serves 404 for /campaigns')\nEOF\nnpx vitest run tests/redirects.test.ts",
    );
    await a.stop();

    expect(blockFor(a.capture())).toContain(PASSED_ON_EXISTING);
  });
});

describe("what the capture cannot say, it does not", () => {
  it("names no test as written by the session when git cannot say what existed", async () => {
    const p = project({ ...SRC, "tests/robots.test.ts": "it('lists /')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    // The start commit is gone from the repository: git cannot list what it held.
    const startBranch = p.git("symbolic-ref", "--short", "HEAD").toString().trim();
    const startCommit = p.git("rev-parse", "HEAD").toString().trim();
    p.git("checkout", "-q", "--orphan", "fresh");
    p.git("branch", "-qD", startBranch);
    p.git("reflog", "expire", "--expire=now", "--all");
    p.git("gc", "-q", "--prune=now");
    expect(() => p.git("cat-file", "-e", startCommit)).toThrow();
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();

    const block = blockFor(a.capture());
    expect(block).not.toContain("that session wrote");
    expect(block).not.toMatch(ANY_MARK);
  });
});
