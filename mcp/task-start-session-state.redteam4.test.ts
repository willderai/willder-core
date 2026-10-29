// With rule (b) limited to tests that existed when the session started, can a real false
// "done" slip through, or can the block say something false? Each case is a session an agent can really run. A claim the evidence
// contradicts must be marked; what the capture cannot know it must not state, neither "that
// session wrote" a test nor "no test edits seen". Real hook, real git, read back as the server
// reads it, rendered as the next agent's block. No database, no network, no model call.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./task-start-session-state.frozen-clock.testsupport";
import { captureSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

vi.setConfig({ testTimeout: 30_000 });
const MCP_URL = new URL("https://willder.example/api/mcp");
const TASK = "T-rt4";
const SESSION = "rt4aaaaa-session";
const ENV = { WILLDER_TOKEN: "wcap_rt4_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: TASK };
const T0 = Date.parse("2026-10-13T19:00:00Z");
const FINISHED: ServedRule = {
  id: "decision-rt4",
  kind: "decision",
  subject: "redirect prune",
  text: `${TASK}: Finished the redirect prune.`,
  ofTask: true,
};
const ANY_MARK = /\[unverified: [^\]]+\] T-rt4: Finished/;
const SRC = { "src/redirects.ts": "export const r = 1;\n" };
const OLD = { ...SRC, "tests/redirects.test.ts": "it('redirects /campaigns with 308')\n" };
const made: string[] = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" });

function project(tracked: Record<string, string>, untracked: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "willder-rt4-repo-"));
  made.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  gitIn(dir, "init", "-q", "-b", "main");
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

/**
 * One Claude Code session through the hook, with a transcript as Claude Code keeps it: the
 * prompt, then each tool call before its PostToolUse event. `end()` is SessionEnd; a `start()`
 * after it is the same session resumed.
 */
function session(repo: string, cwd = repo) {
  const stateDir = mkdtempSync(join(tmpdir(), "willder-rt4-state-"));
  made.push(stateDir);
  const transcript = join(stateDir, "..", `${SESSION}-${Math.random().toString(36).slice(2)}.jsonl`);
  made.push(transcript);
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
    captureSessionState({ session_id: SESSION, cwd, transcript_path: transcript, ...input }, ENV, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now: (now += 1000),
      stateDir,
    });
  const toolCall = (command: string) =>
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${now}`, name: "Bash", input: { command } }] } })}\n`,
    );
  return {
    stateDir,
    start: () => {
      appendFileSync(
        transcript,
        `${JSON.stringify({ type: "user", message: { content: "Finish the redirect prune." } })}\n`,
      );
      return hook({ hook_event_name: "UserPromptSubmit", prompt: "Finish the redirect prune." });
    },
    passed: (command: string) => {
      toolCall(command);
      return hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: " Test Files  1 passed (1)\n      Tests  4 passed (4)\n", stderr: "" },
      });
    },
    failed: (command: string) => {
      toolCall(command);
      return hook({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command },
        error: "Exit code 1\nTests  1 failed | 3 passed (4)",
      });
    },
    stop: () => hook({ hook_event_name: "Stop", last_assistant_message: "The redirect prune is finished." }),
    end: () => hook({ hook_event_name: "SessionEnd" }),
    capture: () => written.at(-1) ?? "",
  };
}

function blockFor(capture: string): string {
  const fact: ServedFact = {
    id: "capture-rt4",
    entityName: sessionStateName(TASK, SESSION),
    role: "progress",
    content: capture,
    writtenAt: new Date(T0 + 3600_000).toISOString(),
    ofTask: true,
  };
  return renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [FINISHED], facts: [fact] }).text ?? "";
}

describe("F1: an existing test moved to a new path and rewritten is not one the session wrote", () => {
  const moved = async (move: (p: ReturnType<typeof project>) => void, command: string, commit = false) => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    move(p);
    p.write("tests/redirect-rules.test.ts", "it('serves 404 for /campaigns')\n");
    if (commit) p.git("commit", "-qam", "rename the redirect test");
    await a.passed(command);
    await a.stop();
    return blockFor(a.capture());
  };

  it("git mv, then a run naming the new path", async () => {
    const block = await moved(
      (p) => p.git("mv", "tests/redirects.test.ts", "tests/redirect-rules.test.ts"),
      "npx vitest run tests/redirect-rules.test.ts",
    );
    expect(block).not.toContain("that session wrote");
    expect(block).toMatch(ANY_MARK);
  });

  it("mv in the run's own call", async () => {
    const block = await moved(
      (p) => p.remove("tests/redirects.test.ts"),
      "mv tests/redirects.test.ts tests/redirect-rules.test.ts && npx vitest run tests/redirect-rules.test.ts",
    );
    expect(block).not.toContain("that session wrote");
    expect(block).toMatch(ANY_MARK);
  });

  it("git mv and a commit, then a run naming the new path", async () => {
    const block = await moved(
      (p) => p.git("mv", "tests/redirects.test.ts", "tests/redirect-rules.test.ts"),
      "npx vitest run tests/redirect-rules.test.ts",
      true,
    );
    expect(block).not.toContain("that session wrote");
    expect(block).toMatch(ANY_MARK);
  });

  it("git mv, then the whole suite", async () => {
    expect(
      await moved((p) => p.git("mv", "tests/redirects.test.ts", "tests/redirect-rules.test.ts"), "npx vitest run"),
    ).toMatch(ANY_MARK);
  });
});

describe("F2: an existing failing test deleted and a new passing one written", () => {
  for (const command of ["npx vitest run tests/campaigns.test.ts", "npx vitest run"]) {
    it(command, async () => {
      const p = project(OLD);
      const a = session(p.dir);
      await a.start();
      p.write("src/redirects.ts", "export const r = 2;\n");
      await a.failed("npx vitest run");
      p.git("rm", "-q", "tests/redirects.test.ts");
      p.write("tests/campaigns.test.ts", "it('serves 404 for /campaigns')\n");
      await a.passed(command);
      await a.stop();
      const block = blockFor(a.capture());
      expect(block).toContain(
        "before it that session had edited tests that existed when it started: tests/redirects.test.ts",
      );
      expect(block).toMatch(ANY_MARK);
    });
  }
});

describe("F3: one call that names a new test and then runs the suite", () => {
  for (const command of [
    "npx vitest run tests/campaigns.test.ts && npx vitest run",
    "npx vitest run tests/campaigns.test.ts && npm test",
    "pytest tests/test_campaigns.py; pytest",
  ]) {
    it(command, async () => {
      const py = command.startsWith("pytest");
      const existing = py ? "tests/test_redirects.py" : "tests/redirects.test.ts";
      const fresh = py ? "tests/test_campaigns.py" : "tests/campaigns.test.ts";
      const p = project({ ...SRC, [existing]: "assert redirect 308\n" });
      const a = session(p.dir);
      await a.start();
      p.write(existing, "assert 404\n");
      p.write(fresh, "assert 404\n");
      await a.passed(command);
      await a.stop();
      expect(blockFor(a.capture())).toMatch(ANY_MARK);
    });
  }
});

describe("F4: a pass on a rewritten existing test, then a run naming only a new test", () => {
  it("the later run does not hide the rewrite", async () => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run");
    p.write("tests/campaigns.test.ts", "it('lists /campaigns as gone')\n");
    await a.passed("npx vitest run tests/campaigns.test.ts");
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).not.toContain("that session wrote");
    expect(block).toContain(
      "[unverified: the last captured passing run came after its session edited existing tests] T-rt4: Finished",
    );
  });
});

describe("F5: test support files the run used", () => {
  it("an existing fixture rewritten, and a new test that reads it named", async () => {
    const p = project({
      ...SRC,
      "tests/fixtures/redirects.json": '{"/campaigns":308}\n',
      "tests/redirects.test.ts": "it('308')\n",
    });
    const a = session(p.dir);
    await a.start();
    p.write("tests/fixtures/redirects.json", '{"/campaigns":404}\n');
    p.write("tests/campaigns.test.ts", "it('reads fixture')\n");
    await a.passed("npx vitest run tests/campaigns.test.ts");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
  });

  it("an existing snapshot rewritten by a run naming the test it belongs to", async () => {
    const p = project({ ...OLD, "tests/__snapshots__/redirects.test.ts.snap": "exports[`308`] = `308`;\n" });
    const a = session(p.dir);
    await a.start();
    p.write("src/redirects.ts", "export const r = 2;\n");
    await a.failed("npx vitest run tests/redirects.test.ts");
    p.write("tests/__snapshots__/redirects.test.ts.snap", "exports[`308`] = `404`;\n");
    await a.passed("npx vitest run tests/redirects.test.ts -u");
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).not.toContain("which it did not name");
    expect(block).toContain(
      "[unverified: the last captured passing run used existing tests its own session had edited] T-rt4: Finished",
    );
  });
});

describe("F6: a session resumed after it ended, or whose state was lost", () => {
  it("says the edits before the resume are not known, never 'no test edits seen'", async () => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run");
    p.git("commit", "-qam", "wip");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
    await a.end();
    await a.start();
    await a.passed("npx vitest run");
    await a.stop();

    expect(a.capture()).toContain("Test files this session had edited before that run: not known");
    expect(blockFor(a.capture())).not.toContain("no test edits seen");
  });

  it("does not say a test the session wrote before the resume existed when it started", async () => {
    const p = project(SRC);
    const a = session(p.dir);
    await a.start();
    p.write("tests/campaigns.test.ts", "it('404')\n");
    await a.passed("npx vitest run tests/campaigns.test.ts");
    await a.stop();
    await a.end();
    await a.start();
    p.write("tests/campaigns.test.ts", "it('404 and 410')\n");
    await a.passed("npx vitest run tests/campaigns.test.ts");
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).not.toContain("existed when it started");
    expect(block).not.toMatch(ANY_MARK);
  });

  it("says the edits are not known after its state is lost mid-session", async () => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('404')\n");
    p.git("commit", "-qam", "wip");
    await a.passed("npx vitest run tests/redirects.test.ts");
    for (const name of readdirSync(a.stateDir)) rmSync(join(a.stateDir, name), { force: true });
    await a.passed("npx vitest run");
    await a.stop();

    expect(a.capture()).toContain("Test files this session had edited before that run: not known");
    expect(blockFor(a.capture())).not.toContain("no test edits seen");
  });
});

describe("F7: tests a checkout or a pull brought in are not ones the session wrote", () => {
  const brought = async (bring: (p: ReturnType<typeof project>) => void) => {
    const p = project(SRC);
    p.git("checkout", "-q", "-b", "feature");
    p.write("tests/redirects.test.ts", "it('redirects /campaigns with 308')\n");
    p.git("add", ".");
    p.git("commit", "-qm", "feature test");
    p.git("checkout", "-q", "main");
    const a = session(p.dir);
    await a.start();
    bring(p);
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();
    return blockFor(a.capture());
  };

  it("git checkout of another branch", async () => {
    expect(await brought((p) => p.git("checkout", "-q", "feature"))).not.toContain("that session wrote");
  });

  it("a fast-forward merge", async () => {
    expect(await brought((p) => p.git("merge", "-q", "--ff-only", "feature"))).not.toContain("that session wrote");
  });
});

describe("F8: more than 200 edited test files", () => {
  it("201 snapshots updated beside a rewritten regression test, then the suite", async () => {
    const files: Record<string, string> = { ...OLD };
    for (let i = 0; i < 201; i++) files[`src/c${i}/__snapshots__/c${i}.test.ts.snap`] = `exports[\`c${i}\`] = 1;\n`;
    const p = project(files);
    const a = session(p.dir);
    await a.start();
    for (let i = 0; i < 201; i++) p.write(`src/c${i}/__snapshots__/c${i}.test.ts.snap`, `exports[\`c${i}\`] = 2;\n`);
    p.write("tests/redirects.test.ts", "it('serves 404 for /campaigns')\n");
    await a.passed("npx vitest run -u");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
  });
});

describe("F9 and F10: names git quotes, and tests git ignores, are never called the session's own", () => {
  it("a tracked test with a double quote in its name", async () => {
    const p = project({ ...SRC, 'tests/redirect "legacy".test.ts': "it('308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write('tests/redirect "legacy".test.ts', "it('404')\n");
    await a.passed(`npx vitest run 'tests/redirect "legacy".test.ts'`);
    await a.stop();
    expect(blockFor(a.capture())).not.toContain("that session wrote");
  });

  it("a tracked test with a backslash in its name", async () => {
    const p = project({ ...SRC, "tests/a\\b.test.ts": "it('308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/a\\b.test.ts", "it('404')\n");
    await a.passed("npx vitest run");
    await a.stop();
    expect(blockFor(a.capture())).not.toContain("that session wrote");
  });

  it("an ignored test that existed, rewritten in the run's own call", async () => {
    const p = project({ ...SRC, ".gitignore": "tests/local/\n" }, { "tests/local/redirects.test.ts": "it('308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/local/redirects.test.ts", "it('404')\n");
    await a.passed(
      "cat > tests/local/redirects.test.ts <<'EOF'\nit('404')\nEOF\nnpx vitest run tests/local/redirects.test.ts",
    );
    await a.stop();
    expect(blockFor(a.capture())).not.toContain("that session wrote");
  });

  it("a unicode name with a space is looked up as itself", async () => {
    const p = project({ ...SRC, "tests/rédirect rules.test.ts": "it('308')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("tests/rédirect rules.test.ts", "it('404')\n");
    await a.passed(`npx vitest run "tests/rédirect rules.test.ts"`);
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
  });
});

describe("F11 and F12: where the call's own writes land", () => {
  it("a write after a cd is named from where the call moved to, not the session's directory", async () => {
    const p = project({ "web/src/r.ts": "", "tests/new.test.ts": "it('root-level existing')\n" });
    const a = session(p.dir);
    await a.start();
    p.write("web/tests/new.test.ts", "it('404')\n");
    await a.passed("cd web && cat > tests/new.test.ts <<'EOF'\nit('404')\nEOF\nnpx vitest run tests/new.test.ts");
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).toContain("it passed on tests that session wrote: web/tests/new.test.ts");
    expect(block).not.toMatch(ANY_MARK);
  });

  it("a path through a symlink to the repository is inside it", async () => {
    const p = project(OLD);
    const real = realpathSync(p.dir);
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('404')\n");
    await a.passed(
      `cat > ${real}/tests/redirects.test.ts <<'EOF'\nit('404')\nEOF\nnpx vitest run ${real}/tests/redirects.test.ts`,
    );
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).toMatch(ANY_MARK);
    expect(block).not.toContain("outside what the capture can see");
  });
});

describe("cases that already hold", () => {
  it("a case-only git mv, then a run naming the new name", async () => {
    const p = project({ ...SRC, "tests/Redirects.test.ts": "it('308')\n" });
    const a = session(p.dir);
    await a.start();
    p.git("mv", "tests/Redirects.test.ts", "tests/redirects.test.ts");
    p.write("tests/redirects.test.ts", "it('404')\n");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();
    const block = blockFor(a.capture());
    expect(block).not.toContain("that session wrote");
    expect(block).toMatch(ANY_MARK);
  });

  it("a run naming the new test and the rewritten existing one", async () => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('404')\n");
    p.write("tests/campaigns.test.ts", "it('404')\n");
    await a.passed("npx vitest run tests/campaigns.test.ts tests/redirects.test.ts");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
  });

  it("an existing test rewritten and committed mid-session, then named", async () => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    p.write("tests/redirects.test.ts", "it('404')\n");
    p.git("commit", "-qam", "wip");
    await a.passed("npx vitest run tests/redirects.test.ts");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
  });

  it("stash, rewrite, stash pop, then the suite", async () => {
    const p = project(OLD);
    const a = session(p.dir);
    await a.start();
    p.write("src/redirects.ts", "export const r = 2;\n");
    p.git("stash", "-q");
    p.write("tests/redirects.test.ts", "it('404')\n");
    p.git("stash", "pop", "-q");
    await a.passed("npx vitest run");
    await a.stop();
    expect(blockFor(a.capture())).toMatch(ANY_MARK);
  });
});
