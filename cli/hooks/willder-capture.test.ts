// Session-state capture, the opt-in write half of the willder init hook, without a server:
// when it writes, what it writes, what it never writes, and how each write replaces the last.
// The real MCP route, access check and task-start block are exercised end to end in
// mcp/session-state-capture.realdb.test.ts.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  CAPTURE_META_KEY,
  FLIP_WRITE_INTERVAL_MS,
  LAST_MESSAGE_MAX_CHARS,
  MAX_CONTENT_CHARS,
  captureSessionState,
  editedTestsOf,
  testWritesAroundRun,
  isTestFile,
  redact,
  renderSessionState,
  sessionStateName,
  testCommandShown,
  testRunOf,
} from "./willder-capture.mjs";

const MCP_URL = new URL("https://willder.example/api/mcp");
const ENV = { WILLDER_TOKEN: "wcap_capture_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: "WEB-412" };
const SESSION = "3f1c9a2e-77aa-4b1c-9d00-session";
const T0 = Date.parse("2026-10-12T09:00:00Z");

/** A JSON-RPC answer to tools/call, as the hosted MCP route sends it. */
const rpcReply = (text: string, isError = false) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
const stored = (version: string) =>
  rpcReply(`Stored and readable now; graph extraction continues in the background. Version: ${version}.`);

let stateDir = "";
let versions = 0;
/**
 * Capture's real git, without its kill timeout, run with Date frozen. Capture gives an event's git
 * calls a budget on the real clock (3 s a call, 4 s in all), which a loaded machine can spend before
 * git answers, so a list came back "not known". The tests that use a real repository prove what
 * capture reads from git, not that budget (the budget has its own test above), so their events run
 * with the clock stopped and git unbounded.
 */
const unboundedGit = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};
/** `event` with Date frozen for its duration; real timers are back before the next line runs. */
async function withFrozenClock<T>(event: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    return await event();
  } finally {
    vi.useRealTimers();
  }
}

let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
/** git as the project would answer: HEAD at the session's start, then the files changed since. */
const git = vi.fn((_cwd: string, args: string[], _timeoutMs?: number): string | null => {
  if (args[0] === "rev-parse") return "abc123\n";
  if (args[0] === "diff") return "services/orders/ack.ts\nservices/orders/ack.test.ts\n";
  if (args[0] === "ls-files") return "notes/new-file.md\n";
  return null;
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "willder-capture-test-"));
  versions = 0;
  fetchImpl = vi.fn<typeof fetch>(async () => stored(`v${++versions}`));
  git.mockClear();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const hook = (input: Record<string, unknown>, env: Record<string, string | undefined> = ENV, now = T0) =>
  captureSessionState({ session_id: SESSION, cwd: "/work/project", ...input }, env, {
    fetchImpl,
    mcpUrl: MCP_URL,
    now,
    stateDir,
    git,
  });

const stop = (message = "Fixed the double ack: the handler now writes before it acks.") => ({
  hook_event_name: "Stop",
  last_assistant_message: message,
});
const testRun = (passed: boolean, command = "npm test -- services/orders", at = T0) =>
  [
    passed
      ? {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          tool_response: { stdout: "Tests  12 passed (12)\n", stderr: "" },
        }
      : {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command },
          error: "Exit code 1\nTests  1 failed | 11 passed (12)",
        },
    ENV,
    at,
  ] as const;

/** The memory_ingest calls the hook made, as the server receives them. */
function ingestCalls() {
  return (fetchImpl.mock.calls as unknown as [URL, RequestInit][]).map(([url, init]) => {
    const body = JSON.parse(String(init.body));
    return {
      url: String(url),
      headers: init.headers as Record<string, string>,
      params: body.params,
      method: body.method,
    };
  });
}

describe("captureSessionState: when it writes", () => {
  it("writes nothing unless the user opted in with WILLDER_CAPTURE=session-state", async () => {
    await hook(stop(), { ...ENV, WILLDER_CAPTURE: undefined });
    await hook(stop(), { ...ENV, WILLDER_CAPTURE: "1" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("writes on Stop and on PreCompact, as one memory_ingest call through /api/mcp with the session's token", async () => {
    await hook(stop());
    await hook({ hook_event_name: "PreCompact", trigger: "auto", transcript_path: undefined });

    const calls = ingestCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: MCP_URL.href,
      method: "tools/call",
      headers: expect.objectContaining({ authorization: `Bearer ${ENV.WILLDER_TOKEN}`, "x-willder-task": "WEB-412" }),
      params: {
        name: "memory_ingest",
        arguments: expect.objectContaining({ name: sessionStateName("WEB-412", SESSION), role: "progress" }),
        _meta: { [CAPTURE_META_KEY]: "session-state", "willder/session": SESSION, "willder/task": "WEB-412" },
      },
    });
  });

  it("replaces its own last write: each write after the first names the version the last one stored", async () => {
    await hook(stop("First stop."));
    await hook(stop("Second stop."));
    await hook(stop("Third stop."));

    const bases = ingestCalls().map((call) => call.params.arguments.baseVersion);
    expect(bases).toEqual([undefined, "v1", "v2"]);
  });

  it("does not write the same state twice in a row", async () => {
    await hook(stop());
    await hook(stop());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("writes after a test run whose result flips, and not after the first run or a repeat of the last result", async () => {
    await hook(...testRun(false));
    await hook(...testRun(false));
    expect(fetchImpl).not.toHaveBeenCalled();

    await hook(...testRun(true));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ingestCalls()[0].params.arguments.content).toContain("passed");

    await hook(...testRun(true, undefined, T0 + FLIP_WRITE_INTERVAL_MS));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("writes at most once per 10 minutes on test flips; Stop is not limited", async () => {
    await hook(...testRun(false, undefined, T0));
    await hook(...testRun(true, undefined, T0 + 1000));
    await hook(...testRun(false, undefined, T0 + 2000));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await hook(stop(), ENV, T0 + 3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await hook(...testRun(true, undefined, T0 + 1000 + FLIP_WRITE_INTERVAL_MS));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not count an interrupted test run as a failure", async () => {
    await hook(...testRun(true));
    await hook({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Interrupted",
      is_interrupt: true,
    });
    await hook(...testRun(true));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops trying for the session once its token is refused the write: a read-only token does not capture", async () => {
    fetchImpl.mockImplementation(async () => rpcReply("Access denied: this token may not write to org_1.web", true));

    await hook(stop("One."));
    await hook(stop("Two."));
    await hook({ hook_event_name: "PreCompact", trigger: "manual" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("starts a new version that replaces nothing when its last version was replaced elsewhere", async () => {
    await hook(stop("One."));
    fetchImpl.mockImplementationOnce(async () => rpcReply("stale_version: the fact has a newer version v9", true));
    await hook(stop("Two."));
    await hook(stop("Three."));

    expect(ingestCalls().map((call) => call.params.arguments.baseVersion)).toEqual([undefined, "v1", undefined]);
  });

  it("fails silently: a network error or a malformed answer leaves the next write to try again", async () => {
    fetchImpl.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(hook(stop("One."))).resolves.toBeUndefined();
    fetchImpl.mockImplementationOnce(async () => new Response("<html>", { status: 502 }));
    await expect(hook(stop("Two."))).resolves.toBeUndefined();
    await hook(stop("Three."));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(ingestCalls()[2].params.arguments.baseVersion).toBeUndefined();
  });

  it("makes no request without a token or a session id, and keeps no state for them", async () => {
    await hook(stop(), { ...ENV, WILLDER_TOKEN: undefined });
    await captureSessionState({ hook_event_name: "Stop", last_assistant_message: "x" }, ENV, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now: T0,
      stateDir,
      git,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

describe("captureSessionState: its state file", () => {
  it("keeps only the stored version when the session ends, and writes nothing then", async () => {
    await hook(stop());
    // The session's state, and its index of the repositories it was seen in.
    expect(readdirSync(stateDir)).toHaveLength(2);

    await hook({ hook_event_name: "SessionEnd", reason: "logout" });

    const left = readdirSync(stateDir);
    expect(left).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(join(stateDir, left[0]!), "utf8"))).sort()).toEqual([
      "ended",
      "lastContentDigest",
      "versionId",
      "versionTask",
    ]);
    await hook(...testRun(true));
    await hook(stop("Again."));
    await hook({ hook_event_name: "SessionEnd", reason: "logout" });
    expect(Object.keys(JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir)[0]!), "utf8"))).sort()).toEqual([
      "ended",
      "lastContentDigest",
      "lastTest",
      "versionId",
      "versionTask",
    ]);
    // Two writes, both at Stop; neither SessionEnd wrote.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("removes the session's state when it ends before any write", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    await hook({ hook_event_name: "SessionEnd", reason: "other" });

    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("replaces its one fact when a session is resumed after it ended, as `claude -p --resume` ends at every exit", async () => {
    await hook(stop("One."));
    await hook({ hook_event_name: "SessionEnd", reason: "other" });
    await hook(stop("Two."));
    await hook({ hook_event_name: "SessionEnd", reason: "other" });
    await hook({ hook_event_name: "SessionEnd", reason: "other" });
    await hook(stop("Three."));

    expect(ingestCalls().map((call) => call.params.arguments.baseVersion)).toEqual([undefined, "v1", "v2"]);
  });

  it("keeps reporting the session's last test run when a resumed process runs none", async () => {
    await hook(...testRun(true));
    await hook(stop("One."));
    await hook({ hook_event_name: "SessionEnd", reason: "other" });
    await hook(stop("Two: only read a file."), ENV, T0 + 60_000);

    const second = ingestCalls()[1].params.arguments;
    expect(second.baseVersion).toBe("v1");
    expect(second.content).toContain(`Last test run: passed at ${new Date(T0).toISOString()}`);
  });

  it("removes other sessions' state files untouched for a week when a session starts, and keeps recent ones", async () => {
    const old = join(stateDir, "0".repeat(32) + ".json");
    const recent = join(stateDir, "1".repeat(32) + ".json");
    writeFileSync(old, "{}");
    writeFileSync(recent, "{}");
    const weekAgo = (T0 - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, weekAgo, weekAgo);
    const hourAgo = (T0 - 60 * 60 * 1000) / 1000;
    utimesSync(recent, hourAgo, hourAgo);

    await hook({ hook_event_name: "UserPromptSubmit" });

    const left = readdirSync(stateDir);
    expect(left).not.toContain("0".repeat(32) + ".json");
    expect(left).toContain("1".repeat(32) + ".json");
    expect(left).toHaveLength(3);
  });

  it("captures nothing when its state directory can be written by other users", async () => {
    chmodSync(stateDir, 0o777);

    await hook(stop());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("names a base version only for the task that stored it: a session resumed under another task starts that task's fact fresh", async () => {
    await hook(stop("One."));
    await hook(stop("Two."), { ...ENV, WILLDER_TASK: "WEB-413" });
    await hook(stop("Three."), { ...ENV, WILLDER_TASK: "WEB-413" });

    expect(ingestCalls().map((call) => call.params.arguments.baseVersion)).toEqual([undefined, undefined, "v2"]);
  });
});

describe("captureSessionState: what it writes", () => {
  it("records files changed since the session started, against the HEAD the session started on", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    git.mockImplementation((_cwd, args) => (args[0] === "rev-parse" ? "def456\n" : args[0] === "diff" ? "a.ts\n" : ""));
    await hook(stop());

    expect(git).toHaveBeenCalledWith(
      "/work/project",
      ["diff", "--name-only", "--no-renames", "abc123"],
      expect.any(Number),
    );
    expect(ingestCalls()[0].params.arguments.content).toContain("a.ts");
  });

  it("records the functions git names over the session's hunks, each once, and writes no line when git names none or cannot say", async () => {
    const hunks =
      "diff --git a/src/a.ts b/src/a.ts\n@@ -10,2 +10,3 @@ export function resolveScope(path: string) {\n+x\n@@ -40 +41 @@ export function resolveScope(path: string) {\n@@ -90 +91 @@ class Ledger {\n@@ -1 +1 @@\n";
    const functionsLine = () => String(ingestCalls().at(-1)!.params.arguments.content).split("\n")[3];
    const projectGit = git.getMockImplementation()!;
    onTestFinished(() => void git.mockImplementation(projectGit));
    for (const [diff, expected] of [
      [
        hunks,
        "Functions touched since the session started: export function resolveScope(path: string) {; class Ledger {",
      ],
      [
        `@@ -1 +1 @@ function f${"x".repeat(56)}("gh${""}p_abcdefghijklmnopqrstuvwxyz0123456789")\n`,
        expect.stringMatching(/\[redacted\]/),
      ],
      [null, expect.stringMatching(/^Last test run: /)],
      ["diff --git a/notes.md b/notes.md\n@@ -1 +1 @@\n", expect.stringMatching(/^Last test run: /)],
    ] as const) {
      git.mockImplementation((_cwd, args) =>
        args[0] === "rev-parse"
          ? "abc123\n"
          : args[0] === "diff"
            ? args[1] === "-U0"
              ? diff
              : "src/a.ts\n"
            : args[0] === "ls-files"
              ? ""
              : null,
      );
      await hook(stop(`Run with ${String(diff).length}.`));
      expect(functionsLine()).toEqual(expected);
    }
    expect(git).toHaveBeenCalledWith(
      "/work/project",
      ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "abc123", "--"],
      expect.any(Number),
    );
  });

  it("reads the last assistant message from the transcript when the event does not carry it", async () => {
    const transcript = join(stateDir, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Looking at the ack path." }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "1", name: "Bash", input: {} }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Root cause: the handler acks before the write." }] },
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
        }),
      ].join("\n"),
    );

    await hook({ hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcript });

    expect(ingestCalls()[0].params.arguments.content).toContain("Root cause: the handler acks before the write.");
  });

  it("never writes a token, key or environment value, wherever it appears", async () => {
    const env = {
      ...ENV,
      OPENAI_API_KEY: "plain-value-without-a-known-shape-123",
      DATABASE_URL: "postgres:" + "//app:hunter2hunter2@db.internal/app",
    };
    await hook(...testRun(false, "API_TOKEN=abcd1234efgh npm test"));
    await hook(
      stop(
        `Used ${ENV.WILLDER_TOKEN} and ${env.OPENAI_API_KEY}; GitHub ghp_${"a".repeat(36)}, ` +
          `Bearer eyJhbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl, connected to ${env.DATABASE_URL}.`,
      ),
      env,
    );

    const content: string = ingestCalls()[0].params.arguments.content;
    for (const secret of [
      ENV.WILLDER_TOKEN,
      env.OPENAI_API_KEY,
      `ghp_${"a".repeat(36)}`,
      "eyJhbGciOiJIUzI1NiJ9",
      "hunter2hunter2",
      "abcd1234efgh",
    ]) {
      expect(content).not.toContain(secret);
    }
    expect(content).toContain("[redacted]");
  });

  it("redacts the names of changed files, which can carry a token or an environment value", async () => {
    const env = { ...ENV, DEPLOY_SECRET: "plain-deploy-value-0001" };
    const leaked = [`backups/ghp_${"b".repeat(36)}.json`, "notes/plain-deploy-value-0001.txt"];
    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse" ? "abc123\n" : args[0] === "diff" ? `${leaked.join("\n")}\n` : "",
    );
    await hook(stop(), env);

    const content: string = ingestCalls()[0].params.arguments.content;
    expect(content).not.toContain(`ghp_${"b".repeat(36)}`);
    expect(content).not.toContain("plain-deploy-value-0001");
    expect(content).toContain("backups/[redacted].json");
  });

  it("redacts the task in the fact's name as well as in its text", async () => {
    const env = { ...ENV, WILLDER_TASK: "WEB-412 token=hunter2hunter2", RELEASE_TOKEN: "opaque-release-0001" };
    await hook(stop(), env);
    await hook(stop("Another message."), { ...env, WILLDER_TASK: "WEB-413 opaque-release-0001" });

    const [first, second] = ingestCalls().map((call) => call.params.arguments);
    expect(first.name).not.toContain("hunter2hunter2");
    expect(first.name).toContain("WEB-412 token=[redacted]");
    expect(first.content).not.toContain("hunter2hunter2");
    expect(second.name).not.toContain("opaque-release-0001");
    expect(second.name).toContain("WEB-413 [redacted]");
  });

  it("does not list files that were already untracked when the session started", async () => {
    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse" ? "abc123\n" : args[0] === "ls-files" ? "scratch/old-notes.md\n" : "",
    );
    await hook({ hook_event_name: "UserPromptSubmit" });
    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse"
        ? "abc123\n"
        : args[0] === "diff"
          ? "a.ts\n"
          : args[0] === "ls-files"
            ? "scratch/old-notes.md\nnew-file.ts\n"
            : "",
    );
    await hook(stop());

    const content: string = ingestCalls()[0].params.arguments.content;
    expect(content).toContain("Files changed since the session started: a.ts, new-file.ts");
    expect(content).not.toContain("old-notes.md");
  });

  it("redacts the last message whole even when it is cut, however much whitespace comes before the cut", async () => {
    const token = `ghp_${"Q".repeat(36)}`;
    // The window redaction sees ends 9,192 characters in; these paddings put that end before,
    // inside and after the token.
    for (const padding of [100, ...Array.from({ length: 20 }, (_, i) => 9_150 + i * 3), 20_000]) {
      fetchImpl.mockClear();
      await hook(stop(`after ${padding} spaces:${" ".repeat(padding)}${token} and more text after it`), {
        ...ENV,
        WILLDER_TASK: `WEB-${padding}`,
      });
      const content: string = ingestCalls()[0].params.arguments.content;
      expect(content).not.toContain("ghp_");
      expect(content).not.toContain("QQQQ");
    }
  });

  it("redacts a very long last message quickly: only the part it may keep, plus a margin, is scanned", async () => {
    const message = `Done. ${"a://".repeat(750_000)}`;
    const started = performance.now();
    await hook(stop(message));

    expect(performance.now() - started).toBeLessThan(300);
    expect(ingestCalls()[0].params.arguments.content).toContain("Agent's last message: Done. a://");
  });

  it("caps the write's size when every part of it is long", async () => {
    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse"
        ? "abc123\n"
        : args[0] === "diff"
          ? Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`).join("\n")
          : "",
    );
    const env = { ...ENV, WILLDER_TASK: `WEB-412 ${"long task name ".repeat(40)}` };
    await hook(...testRun(true, `npm test -- ${"--filter something ".repeat(30)}`));
    await hook({
      ...testRun(false, `npm test -- ${"--filter something ".repeat(30)}`)[0],
      error: `Exit code 1\n${"x".repeat(400)} 1 failed`,
    });
    fetchImpl.mockClear();
    await hook(stop("word ".repeat(5000)), env, T0 + FLIP_WRITE_INTERVAL_MS);

    const content: string = ingestCalls()[0].params.arguments.content;
    expect(content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
    expect(content).toMatch(/\d+ more/);
  });
});

describe("renderSessionState", () => {
  it("says it was captured, not written on purpose, and lays out the state line by line", () => {
    const text = renderSessionState({
      trigger: "Stop",
      task: "WEB-412",
      files: ["a.ts", "b.ts"],
      test: { command: "npm test", passed: false, line: "Tests  1 failed | 11 passed (12)" },
      lastMessage: "Still failing on the retry path.",
    });

    expect(text.split("\n")).toEqual([
      "Session state captured automatically by the Willder hook at Stop; not written on purpose by the agent, and may be incomplete.",
      "Task: WEB-412",
      "Files changed since the session started: a.ts, b.ts",
      "Last test run: failed",
      "Test files this session had edited before that run: not known",
      "Test files this session edited after that run: not known",
      "Last test command: npm test -> failed (Tests  1 failed | 11 passed (12))",
      "Agent's last message: Still failing on the retry path.",
    ]);
  });

  it("keeps the last message to LAST_MESSAGE_MAX_CHARS and says what it does not know", () => {
    const text = renderSessionState({
      trigger: "PreCompact",
      task: undefined,
      files: null,
      test: undefined,
      lastMessage: "y".repeat(5000),
    });

    expect(text).toContain("Task: none named");
    expect(text).toContain("Files changed since the session started: not known");
    expect(text).toContain(
      "Last test run: none recognised\nTest files this session had edited by this capture: not known\nLast test command: none recognised",
    );
    expect(text).not.toContain("none run");
    const message = text.split("Agent's last message: ")[1];
    expect(message.length).toBeLessThanOrEqual(LAST_MESSAGE_MAX_CHARS + 1);
  });
});

describe("testRunOf", () => {
  it("reads a test command's result from the tool event: success passed, failure failed", () => {
    expect(testRunOf(testRun(true)[0])).toEqual({
      command: "npm test -- services/orders",
      passed: true,
      line: "Tests  12 passed (12)",
    });
    expect(testRunOf(testRun(false)[0])).toEqual({
      command: "npm test -- services/orders",
      passed: false,
      line: "Tests  1 failed | 11 passed (12)",
    });
  });

  const ran = (command: string) =>
    testRunOf({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout: "" },
    });

  it("ignores commands that are not test runs and tools other than Bash", () => {
    expect(
      testRunOf({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo 3 passed" },
        tool_response: { stdout: "3 passed" },
      }),
    ).toBeNull();
    expect(
      testRunOf({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "vitest.config.ts" } }),
    ).toBeNull();
  });

  it.each([
    "npx vitest run a.test.ts",
    "pytest -q",
    "go test ./...",
    "cargo test",
    "pnpm test",
    "yarn test",
    "bun test",
    "npm run test:unit",
    "CI=1 npx --yes vitest run",
    "cd api && npm test",
    "python -m pytest tests/",
    "bundle exec rspec spec/a_spec.rb:12",
    "./node_modules/.bin/jest src",
    "time make test-unit",
    "pnpm exec playwright test",
    "env -i PATH=/usr/bin npx vitest run",
    "env -u NODE_OPTIONS npm test",
    "env --unset=CI A=b npm test",
    "timeout 60 yarn jest",
    "npx vitest run x.test.ts 2>&1 | tail -15",
    // Workspace and monorepo forms, subshells and other ecosystems.
    "npm t",
    "npm -w web test",
    "npm --workspace=web test",
    "npm --workspace web run test:unit",
    "pnpm --filter web test",
    "pnpm -F web test",
    "pnpm -r test",
    "pnpm -C web test",
    "yarn workspace web test",
    "yarn workspaces foreach -A run test",
    "(cd web && npm test)",
    "{ npm test; }",
    "npx turbo run test",
    "turbo test --filter=web",
    "npx nx test web",
    "nx run web:test",
    "nx run-many -t test",
    "./mvnw test",
    "mvn -pl core verify",
    "./gradlew test",
    "./gradlew :app:check",
    "bun test",
    "bun run test",
    "deno test -A",
    "python -m unittest discover",
    "uv run pytest -q",
    "python manage.py test",
    "bin/rails test",
    "bundle exec rake spec",
    "cargo nextest run",
    "swift test",
    "php artisan test",
    "npx playwright test",
    "go test ./... -run TestAck",
    "npx cucumber-js",
    "bundle exec cucumber features/redirects.feature",
  ])("counts %j as a test run: a command that starts with a runner", (command) => {
    expect(ran(command)?.command).toBe(command);
  });

  it.each([
    "npm install -D vitest",
    "cat vitest.config.ts",
    "git commit -m 'make jest happy'",
    "ls jest.config.js",
    "grep -r pytest docs",
    "echo npm test",
    // A heredoc's body is text on stdin, not a command, however it reads.
    "cat > run.sh <<'EOF'\nnpx vitest run\nEOF",
    "cat <<-EOF > notes.md\n\tnpm test\n\tEOF",
    "python3 - <<E\nprint('pytest')\nE",
    "test -f package.json",
    "yarn add -D jest",
    "pnpm --filter web build",
    "npm -w web run build",
    "npx nx build web",
    "turbo run build",
    "mvn -q package -DskipTests",
    "cargo build",
    // Commands that start a runner but skip its tests.
    "./gradlew build -x test",
    "gradle clean build -x test",
    "mvn verify -DskipTests",
    "cargo test --no-run",
    "pytest --collect-only -q",
    "npx jest --clearCache",
    "npx vitest --version",
    "make checkout",
    // A runner's name inside a quoted message is not a command.
    'git commit -am "Fix prune; vitest passes"',
    "git commit -am 'Prune redirects; jest green'",
    // tox and nox run whatever environment is named, tests or not: not read as test runs.
    "tox -e lint",
    "tox -e py312",
    // Runs that run no test.
    "npx vitest list",
    "npx vitest bench --run",
    "pytest --fixtures",
    "go test -run '^$' ./...",
  ])("does not count %j as a test run: it names a runner and runs none", (command) => {
    expect(ran(command)).toBeNull();
  });

  it("reads a failure from the runner's own count when the command around it exits 0", () => {
    for (const command of ["npx vitest run || true", "npx vitest run; echo ok", "npx vitest run 2>&1 | tail -5"]) {
      expect(
        testRunOf({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          tool_response: { stdout: "Tests  1 failed | 9 passed (10)\n" },
        }),
      ).toMatchObject({ passed: false });
    }
    expect(
      testRunOf({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pytest" },
        tool_response: { stdout: "==== 2 failed, 8 passed in 0.4s ====\n" },
      }),
    ).toMatchObject({ passed: false });
    expect(
      testRunOf({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pytest" },
        tool_response: { stdout: "==== 10 passed, 0 failed ====\n" },
      }),
    ).toMatchObject({ passed: true });
  });

  it("does not count a run that ran no test: none found, nothing collected, all skipped, unless it counts some that ran", () => {
    const ran = (stdout: string, event = "PostToolUse") =>
      testRunOf({
        hook_event_name: event,
        tool_name: "Bash",
        tool_input: { command: "npx vitest run" },
        tool_response: { stdout },
        error: stdout,
      });
    for (const stdout of [
      "No test files found, exiting with code 0\n",
      " Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n",
      "collected 0 items\n",
      "ok  \tpkg\t0.01s [no tests to run]\n",
    ]) {
      expect(ran(stdout), stdout).toBeNull();
      expect(ran(stdout, "PostToolUseFailure"), stdout).toBeNull();
    }
    expect(ran(" Tests  1 skipped | 9 passed (10)\n")).toMatchObject({ passed: true });
  });

  it("counts a runner after a heredoc ends, and after a here-string, which has no body to skip", () => {
    expect(ran("cat > a.ts <<'E'\nexport {};\nE\nnpx vitest run a.test.ts")).not.toBeNull();
    expect(ran("cat <<<'x' > a.txt\nnpm test")).not.toBeNull();
  });
});

describe("redact", () => {
  it.each([
    ["a Willder token", "token wcap_AbCdEf0123456789xyz"],
    ["an Anthropic key", "sk-" + "ant-api03-AbCdEf0123456789AbCdEf"],
    ["a GitHub token", `github_pat_${"A1".repeat(20)}`],
    ["a Slack token", "xox" + "b-1234567890-abcdefghij"],
    ["an AWS access key", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE" + " KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----"],
    ["a secret assignment", "STRIPE_SECRET=sk_live_whatever"],
    ["credentials in a URL", "https://user:pa55word@example.com/x"],
  ])("removes %s", (_, secret) => {
    const out = redact(`before ${secret} after`, {});
    expect(out).toContain("[redacted]");
    expect(out).toMatch(/^before /);
    expect(out).not.toMatch(
      /AbCdEf0123456789|A1A1A1A1|1234567890-abcdefghij|(?:AKIA)ABCDEFGHIJKLMNOP|b3BlbnNzaC1rZXk|sk_live_whatever|pa55word/,
    );
  });

  // An assignment whose name is only the secret word: `PASSWORD=... npm test` is a common way
  // to run a suite, and an agent's message quotes config as `token: ...` or `"apiKey": "..."`.
  it.each([
    ["a bare password assignment in a test command", "PASSWORD=hunter2hunter2 npm test"],
    ["a lower-case password assignment", "password=hunter2hunter2"],
    ["a bare token in YAML style", "token: hunter2hunter2"],
    ["a bare secret in YAML style", "secret: hunter2hunter2"],
    ["an apiKey assignment", "apiKey=hunter2hunter2"],
    ["a quoted JSON key", '{"apiKey": "hunter2hunter2"}'],
  ])("removes %s, where the name is only the secret word", (_, text) => {
    expect(redact(`before ${text} after`, {})).not.toContain("hunter2hunter2");
  });

  it.each([
    ["a single-quoted key", "{'token': 'hunter2hunter2'}"],
    ["a password in a URL query", "https://db.example/connect?user=app&password=hunter2hunter2&ssl=1"],
    ["an access token in a URL query", "https://api.example/v1?access_token=hunter2hunter2"],
    ["an assignment to a very long secret-named variable", `${"LONG_NAME_".repeat(10)}TOKEN=hunter2hunter2`],
  ])("removes %s", (_, text) => {
    expect(redact(`before ${text} after`, {})).not.toContain("hunter2hunter2");
  });

  it.each([
    ["a Google API key", `AIza${"Sy0123456789abcdefghijABCDEFGHIJK_-"}`],
    ["an npm token", `npm_${"a1B2".repeat(9)}`],
    ["a GitLab token", `glpat-${"x9Y8".repeat(5)}`],
  ])("removes %s", (_, secret) => {
    const out = redact(`before ${secret} after`, {});
    expect(out).toBe("before [redacted] after");
  });

  it("leaves words that only contain a secret word alone when nothing is assigned to them", () => {
    const text = "Rotated the token and fixed the password reset; the secret is in the vault.";
    expect(redact(text, {})).toBe(text);
  });

  it("removes the values of secret-named environment variables, and leaves ordinary text alone", () => {
    const env = { MY_SERVICE_TOKEN: "opaque-value-0001", HOME: "/Users/someone", SHORT_KEY: "abc" };

    expect(redact("sent opaque-value-0001 from /Users/someone/app abc", env)).toBe(
      "sent [redacted] from /Users/someone/app abc",
    );
  });
});

// An agent did this in one Bash call: rewrote the shipped regression test to assert its own
// (wrong) change, ran it, and saw it pass. The capture recorded "passed". Which tests a passing run used that the same session
// had edited is what tells the next session how much the pass is worth.
const T_F028_COMMAND = [
  "python3 - <<'E'",
  "import re",
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
const T_F028_CHANGED = [
  "app/(app)/activity/page.tsx",
  "app/robots.ts",
  "next.config.redirects.test.ts",
  "next.config.ts",
  "proxy.ts",
];

describe("isTestFile", () => {
  it.each([
    "next.config.redirects.test.ts",
    "app/settings/connectors-panel.test.tsx",
    "src/a.spec.js",
    "src/app.e2e-spec.ts",
    "tests/test_api.py",
    "pkg/orders/ack_test.go",
    "spec/models/user_spec.rb",
    "src/__tests__/ack.js",
    "src/__snapshots__/ack.test.ts.snap",
    "src/views/home.snap",
    "src/__mocks__/api.ts",
    "pkg/testdata/golden.json",
    "tests/fixtures/expected.json",
    "e2e/login.ts",
    "test/helper.js",
    "src/test-utils.tsx",
    "src/testing-library.ts",
    "src/test.ts",
    "conftest.py",
    "vitest.config.ts",
    "vitest.setup.ts",
    "jest.setup.js",
    "src/setupTests.ts",
    "playwright.config.ts",
    "vite.config.ts",
    "vite.config.mts",
    "noxfile.py",
    "MyApp.Tests/UnitTest1.cs",
    "src/Orders.IntegrationTests/AckTests.cs",
    "src/mocks/handlers.ts",
    "tests/stubs/api.py",
    "src/fakes/clock.ts",
    "Services/Orders/Ack.Test.ts",
    "features/redirects.feature",
    "app/redirects.feature",
    "features/step_definitions/redirects.steps.ts",
    "src/Button.cy.tsx",
    ".pytest.ini",
    "src/parser_unittest.cc",
    "src/login.e2e.ts",
    // As git quotes a name holding a quote: read without the quotes.
    '"tests/a\\"b.py"',
  ])("counts %s as a file that can change what a test asserts or how tests run", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "next.config.ts",
    "contest.ts",
    "app/latest/page.tsx",
    "attest/x.ts",
    "src/manifest.json",
    "src/inspect.ts",
    "docs/specification.md",
    // A document named like a test is not one: a name needs a code or runner extension.
    "docs/tests.md",
    "docs/notes_test_plan.md",
    "release_test_notes.txt",
    "ReadMeTest.md",
    "api.spec.yaml",
    // A project's manifest or build file is not a test file, though it can configure tests.
    "package.json",
    "pyproject.toml",
    "tsconfig.json",
    "Makefile",
    "Cargo.toml",
    "setup.cfg",
    "src/lib.rs",
    "src/policy.ts",
    "src/fancy.ts",
  ])("does not count %s", (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});

describe("editedTestsOf", () => {
  it("names a snapshot with the test it belongs to", () => {
    expect(editedTestsOf("npx vitest run tests/a.test.ts -u", ["tests/__snapshots__/a.test.ts.snap"])).toEqual({
      files: ["tests/__snapshots__/a.test.ts.snap"],
      named: ["tests/__snapshots__/a.test.ts.snap"],
    });
    expect(editedTestsOf("npx vitest run tests/b.test.ts", ["tests/__snapshots__/a.test.ts.snap"])).toMatchObject({
      named: "none of them; it named other tests",
    });
  });

  it("on a call that rewrote a shipped test and ran it: the run named the test file the same session had rewritten", () => {
    expect(editedTestsOf(T_F028_COMMAND, T_F028_CHANGED)).toEqual({
      files: ["next.config.redirects.test.ts"],
      named: ["next.config.redirects.test.ts"],
    });
  });

  it("names a file by its path from the project root, with ./, as an absolute path, or by a shorter path it ends with", () => {
    const changed = ["services/orders/ack.test.ts"];
    for (const command of [
      "npx vitest run services/orders/ack.test.ts",
      "npx vitest run ./services/orders/ack.test.ts",
      "npx vitest run /work/project/services/orders/ack.test.ts",
      "cd services/orders && npx vitest run ack.test.ts",
      "npx vitest run 'services/orders/ack.test.ts'",
      "npx vitest run --dir=services/orders",
      "npx vitest run services/orders/",
      // A case-insensitive file system runs the same file under another case.
      "npx vitest run Services/Orders/Ack.test.ts",
    ]) {
      expect(editedTestsOf(command, changed), command).toEqual({ files: changed, named: changed });
    }
  });

  // Each of these runs the edited test, or may: a filter, a glob, a node id, a line suffix, a
  // directory relative to another one, a snapshot or a fixture is not a path this reads. None
  // may read as a run on tests the session had not edited.
  it.each([
    ["a vitest path filter", "npx vitest run cli/hook", ["cli/hooks/willder-capture.test.ts"]],
    ["a quoted glob", 'npx vitest run "src/**/*.test.ts"', ["src/a.test.ts"]],
    ["a directory glob", "npx vitest run 'src/**'", ["src/a.test.ts"]],
    ["a directory from a subdirectory", "cd packages/api && npx vitest run src/", ["packages/api/src/a.test.ts"]],
    ["an absolute directory", "npx vitest run /Users/me/repo/src/", ["src/a.test.ts"]],
    ["a ../ directory", "cd packages/api && npx vitest run ../shared/", ["packages/shared/x.test.ts"]],
    ["a pytest node id", "pytest tests/test_a.py::test_regression", ["tests/test_a.py"]],
    ["an rspec file:line", "bundle exec rspec spec/models/a_spec.rb:12", ["spec/models/a_spec.rb"]],
    ["a vitest file:line", "npx vitest run src/a.test.ts:12", ["src/a.test.ts"]],
    ["go test ./...", "go test ./pkg/...", ["pkg/x/a_test.go"]],
    ["a snapshot rewritten by -u", "npx vitest run -u src/a.test.ts", ["src/__snapshots__/a.test.ts.snap"]],
    ["a fixture", "npx vitest run tests/a.test.ts", ["tests/fixtures/expected.json"]],
    ["a file name with a space", 'npx vitest run "tests/my test.test.ts"', ["tests/my test.test.ts"]],
    ["$PWD", "pytest $PWD/tests/", ["tests/test_a.py"]],
    ["another test file named", "npx vitest run services/orders/ack.test.ts", ["services/billing/invoice.test.ts"]],
    ["a prefix of a directory", "npx vitest run services/ord", ["services/orders/ack.test.ts"]],
    ["npm test", "npm test", ["services/orders/ack.test.ts"]],
    ["a runner config", "npm test", ["vitest.config.ts"]],
    ["one runner named a file, the next ran everything", "npx vitest run a.test.ts && npm test", ["b.test.ts"]],
  ])("never reads %s as a run on untouched tests", (_name, command, changed) => {
    const edited = editedTestsOf(command, changed as string[]);
    expect(edited!.files.length).toBeGreaterThan(0);
    expect(edited!.named).not.toEqual([]);
  });

  it("reads a path the way vitest and jest filter by it: as part of a file's path", () => {
    expect(editedTestsOf("npx vitest run services/ord", ["services/orders/ack.test.ts"])).toEqual({
      files: ["services/orders/ack.test.ts"],
      named: ["services/orders/ack.test.ts"],
    });
    expect(editedTestsOf("npx vitest run src/a.test.ts:12", ["src/a.test.ts"])).toEqual({
      files: ["src/a.test.ts"],
      named: ["src/a.test.ts"],
    });
    expect(editedTestsOf('npx vitest run "src/**/*.test.ts"', ["src/x/a.test.ts"])).toEqual({
      files: ["src/x/a.test.ts"],
      named: ["src/x/a.test.ts"],
    });
  });

  it("reads a pytest node id and a project file as the path they name", () => {
    expect(editedTestsOf("pytest tests/test_a.py::test_x", ["tests/test_a.py"])).toEqual({
      files: ["tests/test_a.py"],
      named: ["tests/test_a.py"],
    });
    expect(editedTestsOf("dotnet test App.Tests/App.Tests.csproj", ["App.Tests/RedirectTests.cs"])).toEqual({
      files: ["App.Tests/RedirectTests.cs"],
      named: ["App.Tests/RedirectTests.cs"],
    });
  });

  it.each([
    ["go test ./...", ["pkg/redirects_test.go"]],
    ["npx vitest run --reporter=./scripts/reporter.mjs", ["src/a.test.ts"]],
    ["npx vitest run --reporter=junit --outputFile=reports/junit.xml", ["src/a.test.ts"]],
    ["pytest --cov=src/app", ["tests/test_a.py"]],
    ["pytest --junitxml=reports/junit.xml", ["tests/test_a.py"]],
    ["npx mocha --require ts-node/register", ["test/a.spec.ts"]],
    ["npx vitest run src/billing", ["src/orders/a.test.ts"]],
  ])("reads %j, given something besides test files, as a run of the suite, not of other tests", (command, files) => {
    expect(editedTestsOf(command, files)?.named).toBe("none by name; it ran tests without naming them");
  });

  it("says a run named only other tests when every runner was given test paths, none of them an edited test", () => {
    expect(editedTestsOf("npx vitest run src/b.test.ts", ["src/a.test.ts"])).toEqual({
      files: ["src/a.test.ts"],
      named: "none of them; it named other tests",
    });
    // A runner's config file is not a test path: the run below ran every test it found.
    expect(editedTestsOf("npx vitest run --config vitest.config.ts", ["src/a.test.ts"])).toEqual({
      files: ["src/a.test.ts"],
      named: "none by name; it ran tests without naming them",
    });
  });

  it("counts only a runner's own words as naming a file: a path in another command of the same call is not one it ran", () => {
    expect(editedTestsOf("git add tests/a.test.ts && npm test", ["tests/a.test.ts"])).toEqual({
      files: ["tests/a.test.ts"],
      named: "none by name; it ran tests without naming them",
    });
  });

  it("lists no test file when the session edited none, and says nothing when git could not tell", () => {
    expect(editedTestsOf("npm test", ["services/orders/ack.ts"])).toEqual({ files: [], named: [] });
    expect(editedTestsOf("npm test", null)).toBeNull();
  });
});

describe("testWritesAroundRun", () => {
  it("names the test files a call writes before its run and restores or moves after it", () => {
    expect(testWritesAroundRun("cat > a.test.ts <<'E'\nit('x')\nE\nnpx vitest run a.test.ts")).toEqual({
      before: ["a.test.ts"],
      after: [],
    });
    expect(testWritesAroundRun("npx vitest run && git checkout -- tests/redirects.test.ts")).toEqual({
      before: [],
      after: ["tests/redirects.test.ts"],
    });
    expect(testWritesAroundRun("sed -i 's/308/301/' src/a.test.ts && npm test && mv src/b.spec.ts src/b.ts")).toEqual({
      before: ["src/a.test.ts"],
      after: ["src/b.spec.ts"],
    });
    expect(testWritesAroundRun("echo ok > src/a.test.ts; npm test 2>&1 | tail -5")).toEqual({
      before: ["src/a.test.ts"],
      after: [],
    });
  });

  it("names a write after a cd from where the call moved to", () => {
    expect(
      testWritesAroundRun("cd web && cat > tests/a.test.ts <<'E'\nit('x')\nE\nnpx vitest run tests/a.test.ts"),
    ).toEqual({ before: ["web/tests/a.test.ts"], after: [] });
    expect(testWritesAroundRun("cd web; cd ../api && echo x > a.test.ts && npm test")).toEqual({
      before: ["api/a.test.ts"],
      after: [],
    });
    expect(testWritesAroundRun("cd /srv/app && echo x > a.test.ts && npm test")).toEqual({
      before: ["/srv/app/a.test.ts"],
      after: [],
    });
  });

  it("names nothing a call only reads, writes outside tests, or sends to /dev/null", () => {
    expect(testWritesAroundRun("cat src/a.test.ts && npm test")).toEqual({ before: [], after: [] });
    expect(testWritesAroundRun("sed -n 1,5p src/a.test.ts && npm test")).toEqual({ before: [], after: [] });
    expect(testWritesAroundRun("grep -c it src/a.test.ts > /dev/null && npm test")).toEqual({ before: [], after: [] });
    expect(testWritesAroundRun("echo hi > notes.md && npm test > /dev/null")).toEqual({ before: [], after: [] });
    expect(testWritesAroundRun("npm test")).toEqual({ before: [], after: [] });
  });
});

describe("captureSessionState: the test files a run's session had edited", () => {
  /**
   * git for a project whose diff since the session's start is `changed` at the moment it is asked,
   * and whose start commit held `tracked` (null: git cannot list it).
   */
  let changed: string[] = [];
  let tracked: string[] | null = [];
  beforeEach(() => {
    changed = [];
    tracked = [];
    git.mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "diff") return `${changed.join("\n")}\n`;
      if (args[0] === "ls-tree") {
        const asked = args.slice(args.indexOf("--") + 1).map((path) => path.replace(/^:\(literal\)/, ""));
        return tracked === null ? null : `${tracked.filter((file) => asked.includes(file)).join("\n")}\n`;
      }
      return "";
    });
  });

  it("records a rewritten test, a passing run of it, and the session's Stop", async () => {
    tracked = [
      "next.config.ts",
      "next.config.redirects.test.ts",
      "app/robots.ts",
      "proxy.ts",
      "app/(app)/activity/page.tsx",
    ];
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = T_F028_CHANGED;
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: T_F028_COMMAND },
      tool_response: { stdout: " Test Files  1 passed (1)\n      Tests  10 passed (10)\n", stderr: "" },
    });
    await hook(stop("The Era 1 prune is finished: the rewritten test passes (10 tests)."));

    const lines = String(ingestCalls()[0].params.arguments.content).split("\n");
    expect(lines.slice(3, 10)).toEqual([
      "Last test run: passed at 2026-10-12T09:00:00.000Z",
      "Test files this session had edited before that run: next.config.redirects.test.ts",
      "Of those, the last test command named: next.config.redirects.test.ts",
      "Of those, these existed when the session started: next.config.redirects.test.ts",
      "Test files this session edited after that run: none",
      // The heredoc's body is dropped, so the runner after it is what the line shows.
      "Shell commands run, oldest first, with exit status: python3 - <<'E' ⏎ git rm -q -r \"app/(app)/activity\" ⏎ cat > next.config.redirects.test.ts <<'E' ⏎ npx vitest run next.config.redirects.test.ts 2>&1 | tail -15;… (exit 0)",
      "Last test command: …npx vitest run next.config.redirects.test.ts 2>&1 | tail -15; npx tsc --noEmit 2>&1 | tail -5; git diff --stat -> passed (Tests  10 passed (10))",
    ]);
  });

  it("says which of the test files the session had edited existed at its start, asking git about them all", async () => {
    tracked = ["src/a.test.ts", "src/c.test.ts"];
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts src/b.test.ts"));
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Of those, the last test command named: src/a.test.ts, src/b.test.ts");
    // c.test.ts was not named, but it existed and was edited before the run: the pass came after that.
    expect(content).toContain("Of those, these existed when the session started: src/a.test.ts, src/c.test.ts\n");
    const asked = git.mock.calls.filter(([, args]) => args[0] === "ls-tree").map(([, args]) => args);
    expect(asked).toEqual([
      [
        "ls-tree",
        "-r",
        "--name-only",
        "abc123",
        "--",
        ":(literal)src/a.test.ts",
        ":(literal)src/b.test.ts",
        ":(literal)src/c.test.ts",
      ],
    ]);
  });

  it("says 'none' when the session wrote every edited test the run used: test-first work", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["src/a.ts", "src/a.test.ts"];
    await hook(...testRun(true, "npm test"));
    await hook(stop());

    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Of those, these existed when the session started: none\n",
    );
  });

  it("says 'not known' when git cannot list the start commit, never that the session wrote the tests", async () => {
    tracked = null;
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    await hook(stop());

    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );
  });

  it("says 'not known', never 'none', when some tests the run used cannot be looked up and none is known to have existed", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    // A test written outside the repository in the run's own call: git cannot say it existed.
    await hook(...testRun(true, "cat > ../shared/a.test.ts <<'EOF'\nit('x')\nEOF\nnpx vitest run ../shared/a.test.ts"));
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Of those, the last test command named: ../shared/a.test.ts");
    expect(content).toContain("Of those, these existed when the session started: not known\n");
  });

  it("says 'not known' when the untracked files at the start were too many to keep, unless a test is known to have existed", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `scratch/f-${i}.txt`).join("\n");
    git.mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "ls-files") return args.includes("--ignored") ? "" : `${many}\n`;
      if (args[0] === "diff") return `${changed.join("\n")}\n`;
      if (args[0] === "ls-tree") return args.includes(":(literal)src/old.test.ts") ? "src/old.test.ts\n" : "";
      return "";
    });
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );

    changed = ["src/a.test.ts", "src/old.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts src/old.test.ts", T0 + 1000));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: src/old.test.ts\n",
    );
  });

  it("says 'not known' for too many edited tests to ask git about, and when the start commit is not known", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = Array.from({ length: 2001 }, (_, i) => `tests/case-${i}.test.ts`);
    await hook(...testRun(true, "npm test"));
    await hook(stop());
    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );
    expect(git.mock.calls.some(([, args]) => args[0] === "ls-tree")).toBe(false);

    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir);
    // No commit when the session started (a new repository); one made since.
    let committed = false;
    git.mockImplementation((_cwd, args) => (args[0] === "rev-parse" ? (committed ? "def456\n" : null) : ""));
    await hook({ hook_event_name: "UserPromptSubmit" });
    committed = true;
    await hook(...testRun(true, "cat > tests/a.test.ts <<'EOF'\nit('x')\nEOF\nnpx vitest run tests/a.test.ts"));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );
  });

  it("asks git about edited tests in batches, so many of them still get an answer", async () => {
    tracked = ["tests/case-420.test.ts"];
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = Array.from({ length: 450 }, (_, i) => `tests/case-${i}.test.ts`);
    await hook(...testRun(true, "npm test"));
    await hook(stop());

    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Of those, these existed when the session started: tests/case-420.test.ts\n",
    );
    expect(git.mock.calls.filter(([, args]) => args[0] === "ls-tree").map(([, args]) => args.length - 5)).toEqual([
      200, 200, 50,
    ]);
  });

  it("says 'not known' for a file absent at the start that HEAD now holds: a checkout, a pull or a commit brought it", async () => {
    let head = "abc123";
    git.mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return `${head}\n`;
      if (args[0] === "diff") return `${changed.join("\n")}\n`;
      if (args[0] === "ls-tree")
        return args[3] === "def456" && args.includes(":(literal)src/a.test.ts") ? "src/a.test.ts\n" : "";
      return "";
    });
    await hook({ hook_event_name: "UserPromptSubmit" });
    head = "def456";
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );

    changed = ["src/a.test.ts", "src/b.test.ts"];
    await hook(...testRun(true, "npx vitest run src/b.test.ts", T0 + 1000));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );
  });

  it("says 'none' only when HEAD has not moved to hold the file and git does not ignore it", async () => {
    let ignored = "";
    git.mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "diff") return `${changed.join("\n")}\n`;
      if (args[0] === "ls-files" && args.includes("--ignored")) return ignored;
      return "";
    });
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: none\n",
    );

    ignored = "src/a.test.ts\n";
    await hook(...testRun(true, "npx vitest run src/a.test.ts", T0 + 1000));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known\n",
    );
  });

  it("does not know the edits of a session whose transcript already holds a tool call when its state is made: resumed, or its state lost", async () => {
    const transcript = join(stateDir, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { content: "Go." } })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } })}\n`,
    );
    await hook({ hook_event_name: "UserPromptSubmit", transcript_path: transcript });
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: not known");
    expect(content).not.toContain("these existed when the session started");
  });

  it("knows the edits of a new session, whose transcript holds only its prompt when its state is made", async () => {
    const transcript = join(stateDir, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "Go." } })}\n`);
    await hook({ hook_event_name: "UserPromptSubmit", transcript_path: transcript });
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    await hook(stop());

    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Test files this session had edited before that run: src/a.test.ts",
    );
  });

  it("says which edited tests existed even when the run named only other tests: they may be what it loads", async () => {
    tracked = ["tests/fixtures/redirects.json"];
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["tests/fixtures/redirects.json"];
    await hook(...testRun(true, "npx vitest run tests/redirects.test.ts"));
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Of those, the last test command named: none of them; it named other tests");
    expect(content).toContain("Of those, these existed when the session started: tests/fixtures/redirects.json\n");
  });

  it("gives each git call at most 3 s, and all of one event's calls 4 s together (2 s at a prompt), then reads 'not known'", async () => {
    const timeouts: number[] = [];
    let slow = 0;
    git.mockImplementation((_cwd, args, timeoutMs) => {
      timeouts.push(timeoutMs ?? -1);
      // A git that takes `slow` ms of real time, as on a loaded machine, and is stopped at its timeout.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(slow, timeoutMs ?? slow));
      if (slow > (timeoutMs ?? slow)) return null;
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "diff") return `${changed.join("\n")}\n`;
      return "";
    });
    await hook({ hook_event_name: "UserPromptSubmit" });
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(2000);
    expect(timeouts[0]).toBeGreaterThan(1900);

    timeouts.length = 0;
    changed = ["src/a.test.ts"];
    await hook(...testRun(true, "npx vitest run src/a.test.ts"));
    expect(timeouts[0]).toBeGreaterThan(2900);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(3000);

    timeouts.length = 0;
    slow = 3100;
    await hook(...testRun(true, "npx vitest run src/a.test.ts", T0 + 1000));
    // Two slow calls spend the budget: no other call is made, and the lists that needed one
    // read "not known".
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBeLessThan(1100);
    slow = 0;
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session had edited before that run: not known",
    );
  }, 30_000);

  it("reads 'not known' when git cannot list the untracked files, at the start or at the run, never 'none'", async () => {
    let listing: string | null = null;
    git.mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "diff") return `${changed.join("\n")}\n`;
      if (args[0] === "ls-files") return listing;
      return "";
    });
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = [];
    await hook(...testRun(true, "npx vitest run"));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session had edited before that run: not known",
    );
    // Once git answers, the list missed at the start is recovered from the files' change times.
    listing = "";
    // A test the run's own call writes is not called the session's: what was untracked at the start is not known.
    await hook(
      ...testRun(true, "cat > tests/new.test.ts <<'EOF'\nit('x')\nEOF\nnpx vitest run tests/new.test.ts", T0 + 1000),
    );
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Of those, these existed when the session started: not known",
    );

    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir);
    listing = "";
    await hook({ hook_event_name: "UserPromptSubmit" });
    listing = null;
    await hook(...testRun(true, "npx vitest run", T0 + 2000));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session had edited before that run: not known",
    );
  });

  it("reads the edits as they stood when the run happened: a test edited after the run is not listed", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["services/orders/ack.ts"];
    await hook(...testRun(true, "npm test"));
    changed = ["services/orders/ack.ts", "services/orders/ack.test.ts"];
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: none");
    expect(content).not.toContain("Of those");
  });

  it("says when a run named no test path after the session edited tests: it ran them among the rest", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["services/orders/ack.test.ts"];
    await hook(...testRun(true, "npm test"));
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: services/orders/ack.test.ts");
    expect(content).toContain("Of those, the last test command named: none by name; it ran tests without naming them");
  });

  it("lists the test files the session edited after its last run, and no other files", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = ["src/redirects.ts"];
    await hook(...testRun(true, "npx vitest run"));
    changed = ["src/redirects.ts", "src/redirects.test.ts", "docs/notes.md"];
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: none");
    expect(content).toContain("Test files this session edited after that run: src/redirects.test.ts");
  });

  it("says it does not know the test edits after a run that changed too many test files to keep", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    changed = Array.from({ length: 2001 }, (_, i) => `src/gen/file-${i}.test.ts`);
    await hook(...testRun(true, "npx vitest run"));
    await hook(stop("Again."));
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session edited after that run: not known",
    );
  });

  it("records when the run happened, not when the fact was written", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    await hook(...testRun(false, "npm test", T0 + 1000));
    await hook(stop(), ENV, T0 + 60_000);

    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Last test run: failed at 2026-10-12T09:00:01.000Z",
    );
  });

  it("says it does not know when git could not tell what had changed, and writes no such line without a test run", async () => {
    git.mockImplementation(() => null);
    await hook(...testRun(false, "npm test"));
    await hook(stop());
    const withRun = String(ingestCalls()[0].params.arguments.content);
    expect(withRun).toContain("Test files this session had edited before that run: not known");

    fetchImpl.mockClear();
    await hook(stop(), { ...ENV, WILLDER_TASK: "WEB-999" }, T0);
    await captureSessionState({ session_id: "another-session", cwd: "/work/other", ...stop() }, ENV, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now: T0,
      stateDir,
      git,
    });
    const withoutRun = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(withoutRun).toContain(
      "Last test run: none recognised\nTest files this session had edited by this capture: not known\nLast test command: none recognised",
    );
    expect(withoutRun).not.toContain("before that run");
  });

  it("knows a test the call itself wrote before its run, though git cannot say what changed", async () => {
    git.mockImplementation(() => null);
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat > src/a.test.ts <<'E'\nit('keeps none')\nE\nnpx vitest run src/a.test.ts" },
      tool_response: { stdout: "Tests  1 passed (1)\n", stderr: "" },
    });
    await hook(stop());

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: src/a.test.ts");
    expect(content).toContain("Of those, the last test command named: src/a.test.ts");
  });

  it("reads a state file written before this record existed as not known", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    const file = readdirSync(stateDir).find(
      (name) => "startCommit" in JSON.parse(readFileSync(join(stateDir, name), "utf8")),
    );
    writeFileSync(
      join(stateDir, file!),
      JSON.stringify({
        startCommit: "abc123",
        startUntracked: [],
        lastTest: { command: "npm test", passed: true, line: "4 passed" },
      }),
    );
    await hook(stop());

    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Test files this session had edited before that run: not known",
    );
  });

  it("redacts the names of the edited test files, and caps how many it lists", async () => {
    const env = { ...ENV, DEPLOY_SECRET: "plain-deploy-value-0002" };
    await hook({ hook_event_name: "UserPromptSubmit" }, env);
    changed = [
      "tests/plain-deploy-value-0002.test.ts",
      ...Array.from({ length: 40 }, (_, i) => `tests/case-${i}.test.ts`),
    ];
    await hook(testRun(true, "npx vitest run tests/plain-deploy-value-0002.test.ts tests/case-1.test.ts")[0], env);
    await hook(stop(), env);

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).not.toContain("plain-deploy-value-0002");
    expect(content).toContain("Of those, the last test command named: tests/[redacted].test.ts, tests/case-1.test.ts");
    expect(content).toMatch(
      /Test files this session had edited before that run: tests\/\[redacted\]\.test\.ts, tests\/case-0\.test\.ts, .*\(\+\d+ more\)/,
    );
    expect(content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
  });
});

describe("testCommandShown", () => {
  it("keeps a command that fits whole", () => {
    expect(testCommandShown("npm test -- ack")).toBe("npm test -- ack");
  });

  it("keeps a long command from the line that runs the tests, so a heredoc before it does not crowd out the runner", () => {
    expect(testCommandShown(T_F028_COMMAND)).toBe(
      "…npx vitest run next.config.redirects.test.ts 2>&1 | tail -15; npx tsc --noEmit 2>&1 | tail -5; git diff --stat",
    );
  });

  it("cuts a long runner line at the limit, never between the halves of a surrogate pair", () => {
    const shown = testCommandShown(`${"echo x\n".repeat(40)}npx vitest run ${"😀".repeat(300)}`);
    expect(shown.startsWith("…npx vitest run ")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(200);
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("keeps the head of a long command when no line of it runs tests by itself", () => {
    const command = `npm test -- ${"--filter something ".repeat(30)}`;
    expect(testCommandShown(command)).toBe(`${command.slice(0, 199)}…`);
  });
});

// Real git processes, several per case: under a loaded runner they take longer than the default 5 s.
describe("captureSessionState in a real git repository", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** A committed repository with `files`, and a hook bound to it, as Claude Code runs it. */
  function repository(files: Record<string, string>) {
    const repo = mkdtempSync(join(tmpdir(), "willder-capture-repo-"));
    made.push(repo);
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
    run("init", "-q");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    run("add", ".");
    run("commit", "-qm", "start");
    const inRepo = (input: Record<string, unknown>, cwd = repo) =>
      withFrozenClock(() =>
        captureSessionState({ session_id: SESSION, cwd, ...input }, ENV, {
          fetchImpl,
          mcpUrl: MCP_URL,
          now: T0,
          stateDir,
          git: unboundedGit,
        }),
      );
    return { repo, run, inRepo };
  }

  it("keeps one state for the repository when the session moves into a package of it, so its edits stay known", async () => {
    const { repo, inRepo } = repository({ "web/src/redirects.ts": "x\n", "web/src/redirects.test.ts": "old\n" });
    await inRepo({ hook_event_name: "UserPromptSubmit" });
    writeFileSync(join(repo, "web/src/redirects.test.ts"), "rewritten\n");
    const web = join(repo, "web");
    await inRepo(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npx vitest run src/redirects.test.ts" },
        tool_response: { stdout: "Tests  3 passed (3)\n", stderr: "" },
      },
      web,
    );
    await inRepo(stop("Finished."), web);

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: web/src/redirects.test.ts");
    expect(content).toContain("Of those, the last test command named: web/src/redirects.test.ts");
  });

  it("keeps the rest of the repository known beside a nested repository, and names a run into it as unseen", async () => {
    const { repo, inRepo } = repository({ "src/a.ts": "x\n" });
    execFileSync("git", ["init", "-q", join(repo, "pkg")]);
    writeFileSync(join(repo, "pkg", "a.test.ts"), "old\n");
    await inRepo({ hook_event_name: "UserPromptSubmit" });
    writeFileSync(join(repo, "pkg", "a.test.ts"), "rewritten\n");
    writeFileSync(join(repo, "pkg", "b.ts"), "new\n");
    writeFileSync(join(repo, "src", "a.ts"), "y\n");
    await inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run pkg/a.test.ts" },
      tool_response: { stdout: "Tests  3 passed (3)\n", stderr: "" },
    });
    await inRepo(stop("Finished."));

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(content).toMatch(/^Files changed since the session started: src\/a\.ts$/m);
    expect(content).toContain("Test files this session had edited before that run: none");
    expect(content).toContain("Test paths that run reached which this capture cannot see into: pkg/a.test.ts");
  });

  it("does not know the test edits in a repository first seen after the session began in another", async () => {
    const first = repository({ "src/a.ts": "x\n" });
    const second = repository({ "src/b.ts": "x\n", "src/b.test.ts": "old\n" });
    await first.inRepo({ hook_event_name: "UserPromptSubmit" });
    writeFileSync(join(second.repo, "src", "b.test.ts"), "rewritten\n");
    await second.inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run src/b.test.ts" },
      tool_response: { stdout: "Tests  1 passed (1)\n", stderr: "" },
    });
    await second.inRepo(stop("Finished."));

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: not known");
  });

  it("names a non-ASCII test file the run named, as git lists it unescaped", async () => {
    const repo = mkdtempSync(join(tmpdir(), "willder-capture-repo-"));
    made.push(repo);
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
    run("init", "-q");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests", "café.test.ts"), "old\n");
    run("add", ".");
    run("commit", "-qm", "start");
    const inRepo = (input: Record<string, unknown>) =>
      withFrozenClock(() =>
        captureSessionState({ session_id: SESSION, cwd: repo, ...input }, ENV, {
          fetchImpl,
          mcpUrl: MCP_URL,
          now: T0,
          stateDir,
          git: unboundedGit,
        }),
      );

    await inRepo({ hook_event_name: "UserPromptSubmit" });
    writeFileSync(join(repo, "tests", "café.test.ts"), "rewritten to assert the wrong change\n");
    await inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run tests/café.test.ts" },
      tool_response: { stdout: "Tests  3 passed (3)\n", stderr: "" },
    });
    await inRepo(stop("Finished."));

    const content = String(ingestCalls()[0].params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: tests/café.test.ts");
    expect(content).toContain("Of those, the last test command named: tests/café.test.ts");
    expect(content).toContain("Of those, these existed when the session started: tests/café.test.ts\n");
  });

  it("looks up a test whose name git would read as pathspec magic literally", async () => {
    const { repo, inRepo } = repository({
      "src/a.ts": "x\n",
      "tests/:odd.test.ts": "old\n",
      "tests/[a].test.ts": "old\n",
    });
    await inRepo({ hook_event_name: "UserPromptSubmit" });
    writeFileSync(join(repo, "tests", ":odd.test.ts"), "rewritten\n");
    writeFileSync(join(repo, "tests", "[a].test.ts"), "rewritten\n");
    await inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run" },
      tool_response: { stdout: "Tests  3 passed (3)\n", stderr: "" },
    });
    await inRepo(stop("Finished."));

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(content).toContain(
      "Of those, these existed when the session started: tests/:odd.test.ts, tests/[a].test.ts\n",
    );
  });

  it("does not say which tests existed in a repository first seen mid-session, even for a test written in the run's own call", async () => {
    const first = repository({ "src/a.ts": "x\n" });
    const second = repository({ "src/b.ts": "x\n" });
    await first.inRepo({ hook_event_name: "UserPromptSubmit" });
    writeFileSync(join(second.repo, "src", "b.test.ts"), "new\n");
    const command = "cat > src/b.test.ts <<'EOF'\nnew\nEOF\nnpx vitest run src/b.test.ts";
    await second.inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout: "Tests  1 passed (1)\n", stderr: "" },
    });
    await second.inRepo(stop("Finished."));

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(content).toContain("Of those, the last test command named: src/b.test.ts");
    expect(content).toContain("Of those, these existed when the session started: not known\n");
  });
});

describe("test files follow the recognised runners", () => {
  // Each runner the capture recognises, with a test file in the language it runs: a runner added
  // without its extension, or an extension list edited apart from the runners, fails here.
  it.each([
    ["zig test src/parse.zig", "src/parse_test.zig"],
    ["zig build test", "tests/parse.test.zig"],
    ["nimble test", "tests/test_parse.nim"],
    ["npx mocha test/ack.test.coffee", "test/ack.test.coffee"],
    ["dart test", "test/ack_test.dart"],
    ["flutter test", "test/widget_test.dart"],
    ["busted spec", "spec/ack_spec.lua"],
    ["prove -r t", "t/ack_test.t"],
    ["rebar3 eunit", "src/ack_tests.erl"],
    ["lein test", "test/ack/core_test.clj"],
    ["clojure -X:test", "test/ack/core_test.cljc"],
    ["sbt test", "src/test/scala/AckSpec.scala"],
    ["cabal test", "test/AckSpec.hs"],
    ["stack test", "test/Spec.hs"],
    ["dune test", "test/test_ack.ml"],
    ["elm-test", "tests/AckTest.elm"],
    ["xcodebuild -scheme App test", "AppTests/AckTests.swift"],
    ["robot tests/ack.robot", "tests/ack.robot"],
    ["Invoke-Pester", "Ack.Tests.ps1"],
    ["R CMD check .", "tests/testthat/test-ack.r"],
    ["julia --project test/runtests.jl", "test/runtests.jl"],
    ["zunit", "tests/ack.zunit_test.zsh"],
    ["ctest", "src/ack_test.cpp"],
    ["gotestsum ./...", "pkg/ack_test.go"],
  ])("recognises %s as a run, and %s as a test file", (command, file) => {
    expect(
      testRunOf({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "3 passed\n", stderr: "" },
      }),
    ).not.toBeNull();
    expect(isTestFile(file)).toBe(true);
  });

  it.each(["zig build", "nimble install", "dart pub get", "sbt compile", "dune build", "lein deps"])(
    "does not read %s as a test run",
    (command) => {
      expect(
        testRunOf({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command },
          tool_response: { stdout: "3 passed\n", stderr: "" },
        }),
      ).toBeNull();
    },
  );

  it.each(["docs/test_plan.zon", "notes/ack_test.nimble", "test_notes.coffee.md"])(
    "still does not count %s, whose extension no runner runs",
    (file) => {
      expect(isTestFile(file)).toBe(false);
    },
  );
});

describe("captureSessionState: staying inside the hook's time limit", () => {
  let clock = 0;
  let writeTimeouts: number[] = [];
  beforeEach(() => {
    clock = Date.parse("2026-10-14T09:00:00Z");
    writeTimeouts = [];
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      writeTimeouts.push(ms);
      return timeout(ms);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** A git that takes `extra` ms past each call's timeout to be stopped, as a loaded machine can. */
  const slowGit = (extra: () => number) =>
    git.mockImplementation((_cwd, args, timeoutMs) => {
      clock += (timeoutMs ?? 0) + extra();
      return null;
    });

  it("gives the write what is left of the 15 s limit after git and 3 s of headroom, never its full 8 s regardless", async () => {
    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse" ? "abc123\n" : args[0] === "diff" ? "src/a.ts\n" : "",
    );
    await hook({ hook_event_name: "UserPromptSubmit" });
    let extra = 0;
    slowGit(() => extra);
    const start = clock;
    await hook(stop());
    // git ran inside its 4 s budget and the write got its full 8 s: 4 + 8 + 3 = 15.
    expect(clock - start).toBeLessThanOrEqual(4000);
    expect(writeTimeouts).toEqual([8000]);

    extra = 2500;
    const later = clock;
    await hook(stop("Second stop."));
    // A git call that overran its timeout by 2.5 s: the write gets only what is left of 12 s.
    expect(clock - later).toBe(3000 + 2500);
    expect(writeTimeouts.at(-1)).toBe(12_000 - 5500);
  });

  it("skips a write that has no time left, and sends its content at the next event that has (no lost notice)", async () => {
    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse" ? "abc123\n" : args[0] === "diff" ? "src/a.ts\n" : "",
    );
    await hook({ hook_event_name: "UserPromptSubmit" });
    slowGit(() => 9000);
    await hook(stop());
    expect(ingestCalls()).toHaveLength(0);

    git.mockImplementation((_cwd, args) =>
      args[0] === "rev-parse" ? "abc123\n" : args[0] === "diff" ? "src/a.ts\n" : "",
    );
    await hook(stop());
    expect(ingestCalls()).toHaveLength(1);
    expect(String(ingestCalls()[0].params.arguments.content)).toContain(
      "Files changed since the session started: src/a.ts",
    );
  });
});

// Real git: the reflog and the files' change times are what recover a missed baseline.
describe("captureSessionState: a baseline its first event missed", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** Wait past the current whole second, so what follows is in a later one than what came before. */
  const nextSecond = () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 - (Date.now() % 1000) + 20);

  function repository() {
    const repo = mkdtempSync(join(tmpdir(), "willder-capture-baseline-"));
    made.push(repo);
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        encoding: "utf8",
      });
    run("init", "-q");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests", "ack.test.ts"), "old\n");
    run("add", ".");
    run("commit", "-qm", "start");
    // Untracked before the session, and left alone by it.
    writeFileSync(join(repo, "tests", "scratch.test.ts"), "old scratch\n");
    return { repo, run };
  }

  /** The hook in `repo`, with a git that does not answer while `gitDown()` holds. */
  const hookIn = (repo: string, gitDown: () => boolean, now: number) => (input: Record<string, unknown>) =>
    withFrozenClock(() =>
      captureSessionState({ session_id: SESSION, cwd: repo, ...input }, ENV, {
        fetchImpl,
        mcpUrl: MCP_URL,
        now,
        stateDir,
        git: (cwd, args) => (gitDown() ? null : unboundedGit(cwd, args)),
      }),
    );

  it("recovers the start commit from the reflog, not the commit the session made after it", async () => {
    const { repo, run } = repository();
    const start = run("rev-parse", "HEAD").trim();
    nextSecond();
    let down = true;
    const inRepo = hookIn(repo, () => down, Date.now());
    await inRepo({ hook_event_name: "UserPromptSubmit" });
    nextSecond();
    // The session edits an existing test and commits it, then git answers again.
    writeFileSync(join(repo, "tests", "ack.test.ts"), "weakened\n");
    run("commit", "-qam", "session work");
    down = false;
    await inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run tests/ack.test.ts" },
      tool_response: { stdout: "Tests  1 passed (1)\n", stderr: "" },
    });
    await inRepo(stop("Finished."));

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(run("rev-parse", "HEAD").trim()).not.toBe(start);
    // Measured from the commit the session started on, the committed edit is the session's.
    expect(content).toContain("Test files this session had edited before that run: tests/ack.test.ts");
    expect(content).toContain("Of those, these existed when the session started: tests/ack.test.ts");
  });

  it("recovers the untracked files from their change times: one the session wrote is its own, one it left alone is not", async () => {
    const { repo } = repository();
    nextSecond();
    let down = true;
    const inRepo = hookIn(repo, () => down, Date.now());
    await inRepo({ hook_event_name: "UserPromptSubmit" });
    nextSecond();
    writeFileSync(join(repo, "tests", "new.test.ts"), "written by the session\n");
    down = false;
    await inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run" },
      tool_response: { stdout: "Tests  2 passed (2)\n", stderr: "" },
    });
    await inRepo(stop("Finished."));

    const content = String(ingestCalls().at(-1)!.params.arguments.content);
    expect(content).toContain("Test files this session had edited before that run: tests/new.test.ts\n");
    // Whether an untracked file changed since the start existed at it cannot be told: not "none".
    expect(content).toContain("Of those, these existed when the session started: not known");
  });

  it("stays 'not known' when no reflog entry is older than the session's start", async () => {
    const before = Date.now() - 5000;
    const { repo } = repository();
    let down = true;
    // The state says the session started before the repository's first commit.
    const inRepo = hookIn(repo, () => down, before);
    await inRepo({ hook_event_name: "UserPromptSubmit" });
    down = false;
    writeFileSync(join(repo, "tests", "ack.test.ts"), "weakened\n");
    await inRepo({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx vitest run" },
      tool_response: { stdout: "Tests  1 passed (1)\n", stderr: "" },
    });
    await inRepo(stop("Finished."));

    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session had edited before that run: not known",
    );
  });
});

describe("captureSessionState: reading HEAD's reflog for a missed start commit", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const atStart = Math.floor(T0 / 1000);
  /** A git that missed the start commit at the prompt and lists `reflog` once asked. */
  function gitWithReflog(reflog: string) {
    let prompted = false;
    git.mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return prompted ? `${B}\n` : null;
      if (args[0] === "reflog") return reflog;
      if (args[0] === "diff") return args.at(-1) === A ? "tests/ack.test.ts\n" : "";
      return "";
    });
    return () => (prompted = true);
  }

  it("passes over an entry in the start's own second, which may be after it, for the one before", async () => {
    const prompted = gitWithReflog(`${B} HEAD@{${atStart}}\n${A} HEAD@{${atStart - 60}}\n`);
    await hook({ hook_event_name: "UserPromptSubmit" });
    prompted();
    await hook(...testRun(true, "npx vitest run tests/ack.test.ts", T0 + 1000));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session had edited before that run: tests/ack.test.ts",
    );
  });

  it("gives no start commit when the reflog shows positions, not times, as a git that ignored --date would", async () => {
    const prompted = gitWithReflog(`${B} HEAD@{0}\n${A} HEAD@{1}\n`);
    await hook({ hook_event_name: "UserPromptSubmit" });
    prompted();
    await hook(...testRun(true, "npx vitest run tests/ack.test.ts", T0 + 1000));
    await hook(stop());
    expect(String(ingestCalls().at(-1)!.params.arguments.content)).toContain(
      "Test files this session had edited before that run: not known",
    );
  });
});
