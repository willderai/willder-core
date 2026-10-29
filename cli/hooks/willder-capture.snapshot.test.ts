// The snapshot: capture writes the session's state every WILLDER_SNAPSHOT_EVERY tool calls with no
// action from the agent and nothing said to it. These tests drive capture as the hook and the
// snapshot process do, against a fake server; the last block runs the real hook as Claude Code
// runs it, with a local stub for the server.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturedSessionState } from "@/services/memory/session-state";
import {
  CAPTURE_META_KEY,
  DEFAULT_SNAPSHOT_EVERY,
  SNAPSHOT_EVENT,
  SNAPSHOT_LOG,
  MAX_CONTENT_CHARS,
  captureSessionState,
  commandRecordOf,
  maskCommandSecrets,
  sessionStateName,
  snapshotEvery,
} from "./willder-capture.mjs";

const MCP_URL = new URL("https://willder.example/api/mcp");
const ENV = { WILLDER_TOKEN: "wcap_snapshot_test_token", WILLDER_CAPTURE: "session-state", WILLDER_TASK: "WEB-77" };
const SESSION = "5a1e0c3d-0000-4b1c-9d00-snapshot";
const OTHER_SESSION = "9b2f7e11-1111-4c2d-8e11-snapshot";
const CWD = "/work/project";
const T0 = Date.parse("2026-10-20T09:00:00Z");

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

let stateDir = "";
let transcript = "";
let versions = 0;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
/** The snapshots the hook started, as the snapshot process would be handed them. */
let started: Record<string, unknown>[] = [];
const git = vi.fn((_cwd: string, args: string[]): string | null => {
  if (args[0] === "rev-parse") return "abc123\n";
  if (args[0] === "diff") return args.includes("--name-only") ? "src/orders/ack.ts\n" : "";
  if (args[0] === "ls-files") return "";
  return null;
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "willder-snapshot-test-"));
  transcript = join(stateDir, "..", `${stateDir.split("/").at(-1)}-transcript.jsonl`);
  versions = 0;
  started = [];
  fetchImpl = vi.fn<typeof fetch>(async () => rpcReply(`Stored and readable now. Version: v${++versions}.`));
  setLastMessage("Found it: the ack is sent before the write commits; moving the write first.");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(transcript, { force: true });
});

/** The agent's latest text, as Claude Code writes it to the transcript. */
function setLastMessage(text: string) {
  writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text },
          { type: "tool_use", name: "Bash" },
        ],
      },
    })}\n`,
  );
}

const deps = (now = T0) => ({
  fetchImpl,
  mcpUrl: MCP_URL,
  now,
  stateDir,
  git,
  startSnapshot: (input: Record<string, unknown>) => {
    started.push(input);
  },
});

const hook = (input: Record<string, unknown>, env: Record<string, string | undefined> = ENV, session = SESSION) =>
  captureSessionState({ session_id: session, cwd: CWD, transcript_path: transcript, ...input }, env, deps());

/** Run the snapshot process's write for `session`, as startSnapshotProcess's child does. */
const snapshot = (session = SESSION, env: Record<string, string | undefined> = ENV) =>
  captureSessionState(
    { hook_event_name: SNAPSHOT_EVENT, session_id: session, cwd: CWD, transcript_path: transcript },
    env,
    deps(),
  );

const read = (path = "src/orders/ack.ts") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: `${CWD}/${path}` },
  tool_response: { content: "file text" },
});
const edit = (path = "src/orders/ack.ts") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: `${CWD}/${path}`, old_string: "a", new_string: "b" },
});
const bash = (command: string, stdout = "") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "" },
});
const bashFailed = (command: string, error: string) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command },
  error,
});

async function calls(
  inputs: Record<string, unknown>[],
  env: Record<string, string | undefined> = ENV,
  session = SESSION,
) {
  for (const input of inputs) await hook(input, env, session);
}

function ingests() {
  return (fetchImpl.mock.calls as unknown as [URL, RequestInit][]).map(
    ([, init]) => JSON.parse(String(init.body)).params,
  );
}

const logLines = () =>
  existsSync(join(stateDir, SNAPSHOT_LOG)) ? readFileSync(join(stateDir, SNAPSHOT_LOG), "utf8").trim().split("\n") : [];
const lockPath = (session = SESSION) =>
  join(stateDir, `${createHash("sha256").update(`${CWD}\0${session}`).digest("hex").slice(0, 32)}.json.lock`);

describe("snapshotEvery: on by default whenever capture is on", () => {
  it.each([
    ["capture on, unset", { WILLDER_CAPTURE: "session-state" }, DEFAULT_SNAPSHOT_EVERY],
    ["capture on, blank", { WILLDER_CAPTURE: "session-state", WILLDER_SNAPSHOT_EVERY: " " }, DEFAULT_SNAPSHOT_EVERY],
    ["capture on, another count", { WILLDER_CAPTURE: "session-state", WILLDER_SNAPSHOT_EVERY: "12" }, 12],
    ["capture on, 0", { WILLDER_CAPTURE: "session-state", WILLDER_SNAPSHOT_EVERY: "0" }, 0],
    ["capture on, a typo", { WILLDER_CAPTURE: "session-state", WILLDER_SNAPSHOT_EVERY: "5x" }, 0],
    ["capture off, a count", { WILLDER_SNAPSHOT_EVERY: "3" }, 0],
  ])("%s", (_, env, expected) => {
    expect(snapshotEvery(env)).toBe(expected);
  });

  it("defaults to 5 tool calls", () => {
    expect(DEFAULT_SNAPSHOT_EVERY).toBe(5);
  });
});

describe("the snapshot: when it is taken", () => {
  it("starts one after every DEFAULT_SNAPSHOT_EVERY tool calls of the session's own, and writes the session's state as hook-captured", async () => {
    await hook({ hook_event_name: "UserPromptSubmit" });
    await calls([read(), edit(), bash("npx vitest run src/orders", "Tests  3 passed (3)\n")]);
    await hook(bashFailed("npm run lint", "Exit code 2\nlint output"));
    expect(started).toHaveLength(0);
    await hook(read());
    expect(started).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    await snapshot();

    const [params] = ingests();
    expect(params.name).toBe("memory_ingest");
    expect(params.arguments).toMatchObject({ name: sessionStateName("WEB-77", SESSION), role: "progress" });
    expect(params._meta).toEqual({
      [CAPTURE_META_KEY]: "session-state",
      "willder/session": SESSION,
      "willder/task": "WEB-77",
    });
    const content = String(params.arguments.content);
    expect(content.split("\n")[0]).toBe(
      "Session state captured automatically by the Willder hook at a snapshot after 5 tool calls; not written on purpose by the agent, and may be incomplete.",
    );
    expect(content).toContain("Files changed since the session started: src/orders/ack.ts");
    expect(content).toContain("Files the agent's edit tools wrote: src/orders/ack.ts");
    expect(content).toContain(
      "Shell commands run, oldest first, with exit status: npx vitest run src/orders (exit 0); npm run lint (exit 2)",
    );
    expect(content).toContain("Last test run: passed at 2026-10-20T09:00:00.000Z");
    expect(content).toMatch(
      /\nAgent's last message: Found it: the ack is sent before the write commits; moving the write first\.$/,
    );
    expect(logLines()).toEqual([expect.stringMatching(/session 5a1e0c3d snapshot stored$/)]);

    await calls([read(), read(), read(), read()]);
    expect(started).toHaveLength(1);
    await hook(read());
    expect(started).toHaveLength(2);
  });

  it("does not count a subagent's tool calls toward a snapshot", async () => {
    await calls(Array.from({ length: 12 }, () => ({ ...read(), agent_id: "sub-1", agent_type: "Explore" })));
    expect(started).toHaveLength(0);
  });

  it("counts every WILLDER_SNAPSHOT_EVERY calls when it is set", async () => {
    await calls([read(), read()], { ...ENV, WILLDER_SNAPSHOT_EVERY: "2" });
    expect(started).toHaveLength(1);
  });
});

describe("the snapshot: what it never writes", () => {
  it("writes nothing when nothing changed since the last write, and a Stop that saw the same state writes nothing either", async () => {
    await calls([edit(), bash("git status"), read(), read(), read()]);
    await snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await calls([read(), read(), read(), read(), read()]);
    expect(started).toHaveLength(2);
    await snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logLines().at(-1)).toMatch(/snapshot not sent: nothing changed since the last write$/);

    await hook({
      hook_event_name: "Stop",
      last_assistant_message: "Found it: the ack is sent before the write commits; moving the write first.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await hook({ hook_event_name: "Stop", last_assistant_message: "Moved the write before the ack; tests pass." });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Stop replaces the snapshot's fact: one fact for the session, not two.
    expect(ingests()[1].arguments).toMatchObject({ name: sessionStateName("WEB-77", SESSION), baseVersion: "v1" });
  });

  it("redacts a planted secret in a command, the latest message and an edited file's name", async () => {
    const github = `ghp_${"q".repeat(36)}`;
    const env = { ...ENV, DEPLOY_API_KEY: "plain-deploy-value-7731" };
    setLastMessage(`Used ${github} and ${env.DEPLOY_API_KEY} to call the deploy API with ${ENV.WILLDER_TOKEN}.`);
    await calls(
      [
        bash(`curl -H "Authorization: Bearer ${github}" https://api.example.com/deploy`),
        bash(`DEPLOY_API_KEY=${env.DEPLOY_API_KEY} ./deploy.sh --token ${ENV.WILLDER_TOKEN}`),
        edit(`notes/${github}.md`),
        read(),
        read(),
      ],
      env,
    );
    await snapshot(SESSION, env);

    const content = String(ingests()[0].arguments.content);
    for (const secret of [github, env.DEPLOY_API_KEY, ENV.WILLDER_TOKEN]) expect(content).not.toContain(secret);
    expect(content).toContain("[redacted]");
    expect(content).toContain("curl -H");
  });

  it("stores commands and exit codes, never what a tool printed or returned", async () => {
    await calls([
      bash("cat .env.example", "OUTPUT_BODY_MARKER_1 line one\nline two"),
      bashFailed("npm test", "Exit code 1\nERROR_BODY_MARKER_2 expected 3 to be 4"),
      bashFailed("sleep 100", "Interrupted ERROR_BODY_MARKER_3"),
      { ...read(), tool_response: { content: "READ_BODY_MARKER_4" } },
      bashFailed("make", "ERROR_BODY_MARKER_5 no exit code here"),
    ]);
    await snapshot();

    const content = String(ingests()[0].arguments.content);
    expect(content).not.toMatch(/BODY_MARKER/);
    expect(content).toContain(
      "Shell commands run, oldest first, with exit status: cat .env.example (exit 0); npm test (exit 1); sleep 100 (failed); make (failed)",
    );
  });

  it("keeps a heredoc's body out of the command, and the commands after it in", () => {
    const record = commandRecordOf(
      bash("cat > a.ts <<'EOF'\nexport const SECRET_FILE_BODY = 1;\nEOF\nnpx vitest run a.test.ts"),
      ENV,
    );
    expect(record).toEqual({ command: "cat > a.ts <<'EOF' ⏎ npx vitest run a.test.ts", status: "exit 0" });
  });

  it("writes and keeps nothing when capture is off, and starts no snapshot when WILLDER_SNAPSHOT_EVERY is 0", async () => {
    const off = { WILLDER_TOKEN: ENV.WILLDER_TOKEN, WILLDER_TASK: "WEB-77", WILLDER_SNAPSHOT_EVERY: "1" };
    await calls(
      Array.from({ length: 10 }, () => edit()),
      off,
    );
    await snapshot(SESSION, off);
    expect(started).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(stateDir)).toEqual([]);

    await calls(
      Array.from({ length: 10 }, () => edit()),
      { ...ENV, WILLDER_SNAPSHOT_EVERY: "0" },
    );
    expect(started).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the snapshot: secrets a shell command carries", () => {
  it.each([
    ["mysql -phunter2xyz db", "-p[redacted]"],
    ["sshpass -p 'hunter2xyz' ssh deploy@host", "-p [redacted]"],
    ["docker login -p hunter2xyz ghcr.io", "-p [redacted]"],
    ["curl -u admin:hunter2xyz https://api.example.com", "admin:[redacted]"],
    ["curl --user=admin:hunter2xyz https://api.example.com", "admin:[redacted]"],
    ["htpasswd -b .htpasswd admin hunter2xyz", "admin [redacted]"],
    ["echo hunter2xyz | sudo -S apt-get update", "echo [redacted] |"],
    ["printf '%s' hunter2xyz | docker login --password-stdin", "printf [redacted] |"],
    ["gh secret set API -b hunter2xyz", "-b [redacted]"],
    ["fly secrets set API=hunter2xyz", "API=[redacted]"],
    ["psql --password=hunter2xyz -h db", "--password=[redacted]"],
    ["deploy --api-key hunter2xyz", "--api-key [redacted]"],
    ["base64 -d <<< 'hunter2xyz123456'", "<<< [redacted]"],
    ["vercel login --token-stdin <<< 'hunter2xyz123456'", "--token-stdin <<< [redacted]"],
    ["redis-cli -h cache -a hunter2xyz ping", "-a [redacted] ping"],
    ["echo 'hunter2xyz' > ~/.pgpass", "echo [redacted] > ~/.pgpass"],
    ["export TOKEN=\\\nhunter2xyzabc && ls", "TOKEN=[redacted]"],
    ["cat > .env <<'END-OF'\nSTRIPE=hunter2xyz\nEND-OF\nls", "cat > .env <<'END-OF' ⏎ ls"],
    ["cat <<\\EOF > .env\nSTRIPE=hunter2xyz\nEOF", "cat <<\\EOF > .env"],
    ['cat <<"E.O.F" > .env\nSTRIPE=hunter2xyz\nE.O.F', 'cat <<"E.O.F" > .env'],
  ])("%s", (command, kept) => {
    const shown = commandRecordOf(bash(command), ENV)!.command;
    expect(shown).not.toContain("hunter2xyz");
    expect(shown).toContain(kept);
  });

  it("leaves ordinary commands as they are", () => {
    for (const command of [
      "mkdir -p src/a && npx vitest run",
      "ssh -p 2222 deploy@host uptime",
      'git commit -m "fix: tests pass"',
      "grep -rn token src",
      "docker login --password-stdin -u me ghcr.io",
      "ls > out.txt",
    ]) {
      expect(maskCommandSecrets(command)).toBe(command);
    }
  });
});

describe("the snapshot: it fits its fact without pushing out the test run or the message", () => {
  const longCommands = Array.from({ length: 8 }, (_, i) =>
    bash(`npx tsx scripts/step-${i}.ts --input ${"data/".repeat(25)}file-${i}.json`),
  );
  const manyEdits = Array.from({ length: 30 }, (_, i) => edit(`src/module-${i}/${"nested/".repeat(4)}file-${i}.ts`));
  const bigGit = (_cwd: string, args: string[]): string | null => {
    if (args[0] === "rev-parse") return "abc123\n";
    if (args[0] === "diff" && args.includes("--name-only"))
      return Array.from({ length: 30 }, (_, i) => `src/module-${i}/${"nested/".repeat(4)}file-${i}.ts`).join("\n");
    if (args[0] === "diff")
      return Array.from({ length: 15 }, (_, i) => `@@ -1 +1 @@ export function handler${i}${"X".repeat(60)}(`).join(
        "\n",
      );
    return "";
  };

  it("leaves out the oldest commands and edited files first, so the test run and the whole message are still read", async () => {
    git.mockImplementation(bigGit);
    const message = `${"The handler acks before the write commits. ".repeat(23)}Done.`.slice(0, 1000);
    setLastMessage(message);
    await calls([...manyEdits, bash("npx vitest run src", "Tests  40 passed (40)\n"), ...longCommands]);
    await snapshot();

    const params = ingests()[0];
    const content = String(params.arguments.content);
    expect(content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
    const state = capturedSessionState({ entityName: params.arguments.name, role: "progress", content });
    expect(state?.lastTest).toMatchObject({ result: "passed" });
    expect(state?.lastMessage).toBe(message.replace(/\s+/g, " ").trim());
  });

  it("cuts a fact whose task name alone overruns it to MAX_CONTENT_CHARS, the same way whatever triggered it", async () => {
    const env = { ...ENV, WILLDER_TASK: `T-${"long-task-name-".repeat(250)}` };
    await calls([bash("echo one"), read(), read(), read(), read()], env);
    await snapshot(SESSION, env);
    expect(String(ingests()[0].arguments.content).length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
    await hook(
      {
        hook_event_name: "Stop",
        last_assistant_message: "Found it: the ack is sent before the write commits; moving the write first.",
      },
      env,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends nothing at Stop after a snapshot of the same long state, though their first lines differ in length", async () => {
    git.mockImplementation(bigGit);
    setLastMessage("x".repeat(1200));
    await calls([...manyEdits, ...longCommands]);
    await snapshot();
    await hook({ hook_event_name: "Stop", last_assistant_message: "x".repeat(1200) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("the snapshot: one fact per session, across sessions, resume and compaction", () => {
  it("keeps two sessions in one repository apart: each its own count, fact and version", async () => {
    for (let i = 0; i < 5; i++) {
      await hook(bash(`echo a${i}`), ENV, SESSION);
      await hook(bash(`echo b${i}`), ENV, OTHER_SESSION);
    }
    expect(started.map((input) => input.session_id)).toEqual([SESSION, OTHER_SESSION]);
    await snapshot(SESSION);
    await snapshot(OTHER_SESSION);
    await calls([bash("echo a-more"), read(), read(), read(), read()], ENV, SESSION);
    await snapshot(SESSION);

    const writes = ingests().map((params) => ({
      name: params.arguments.name,
      base: params.arguments.baseVersion,
      content: String(params.arguments.content),
    }));
    expect(writes.map(({ name, base }) => [name, base])).toEqual([
      [sessionStateName("WEB-77", SESSION), undefined],
      [sessionStateName("WEB-77", OTHER_SESSION), undefined],
      [sessionStateName("WEB-77", SESSION), "v1"],
    ]);
    expect(writes[0].content).not.toContain("echo b");
    expect(writes[1].content).not.toContain("echo a");
  });

  it("replaces the same fact after the session ends and is resumed", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await snapshot();
    await hook({ hook_event_name: "SessionEnd", reason: "other" });

    await calls([bash("echo two"), read(), read(), read(), read()]);
    expect(started).toHaveLength(2);
    await snapshot();

    expect(ingests().map((params) => params.arguments.baseVersion)).toEqual([undefined, "v1"]);
    expect(String(ingests()[1].arguments.content)).toContain("echo two");
  });

  it("does nothing for a snapshot whose session ended before it ran", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await hook({ hook_event_name: "SessionEnd", reason: "other" });
    await snapshot();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes nothing at PreCompact when a snapshot already holds the state, and keeps counting after it", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await snapshot();
    await hook({ hook_event_name: "PreCompact", trigger: "auto" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await calls([bash("echo two"), read(), read(), read(), read()]);
    expect(started).toHaveLength(2);
    await snapshot();
    expect(ingests().map((params) => params.arguments.baseVersion)).toEqual([undefined, "v1"]);
  });

  it("keeps what hook events recorded while a snapshot was writing", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    // Two more calls land while the snapshot process waits for the server.
    fetchImpl.mockImplementationOnce(async () => {
      await calls([bash("echo two"), read()]);
      return rpcReply(`Stored and readable now. Version: v${++versions}.`);
    });
    await snapshot();
    await calls([read(), read(), read()]);

    expect(started).toHaveLength(2);
    await snapshot();
    const contents = ingests().map((params) => String(params.arguments.content));
    expect(contents[1]).toContain("echo one (exit 0); echo two (exit 0)");
    expect(contents[1].split("\n")[0]).toContain("a snapshot after 10 tool calls");
    expect(ingests()[1].arguments.baseVersion).toBe("v1");
  });
});

describe("the snapshot: it never gets in the agent's way", () => {
  it("leaves the write to one already in progress, and says so in the log", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    writeFileSync(lockPath(), "4242");

    await snapshot();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(lockPath(), "utf8")).toBe("4242");
    expect(logLines().at(-1)).toMatch(/snapshot skipped: another write was in progress$/);
  });

  it("takes over a lock left by a process that died, and removes it after its write", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    writeFileSync(lockPath(), "4242");
    const minuteAgo = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath(), minuteAgo, minuteAgo);

    await snapshot();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("has Stop wait for a snapshot's write in progress, then replace its fact", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await snapshot();
    writeFileSync(lockPath(), "4242");

    const stopped = hook({ hook_event_name: "Stop", last_assistant_message: "Done." });
    await new Promise((done) => setTimeout(done, 300));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    rmSync(lockPath());
    await stopped;

    expect(ingests().map((params) => params.arguments.baseVersion)).toEqual([undefined, "v1"]);
  });

  it("has a Stop that cannot get the lock hand its write to the background, which waits its turn and replaces the same fact", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await snapshot();
    writeFileSync(lockPath(), "4242");

    await hook({ hook_event_name: "Stop", last_assistant_message: "Done: the write now commits before the ack." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(started.at(-1)).toMatchObject({ hook_event_name: "Stop", deferred: "Stop" });
    expect(existsSync(lockPath().replace(/\.lock$/, ".queued"))).toBe(true);

    rmSync(lockPath());
    setLastMessage("Done: the write now commits before the ack.");
    await captureSessionState(
      { hook_event_name: SNAPSHOT_EVENT, deferred: "Stop", session_id: SESSION, cwd: CWD, transcript_path: transcript },
      ENV,
      deps(),
    );

    expect(ingests().map((params) => params.arguments.baseVersion)).toEqual([undefined, "v1"]);
    expect(String(ingests()[1].arguments.content).split("\n")[0]).toContain("Willder hook at Stop;");
    expect(existsSync(lockPath().replace(/\.lock$/, ".queued"))).toBe(false);
  }, 20_000);

  it("has SessionEnd wait for a Stop write handed to the background, so the session's last state is written", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await snapshot();
    writeFileSync(lockPath(), "4242");
    await hook({ hook_event_name: "Stop", last_assistant_message: "Done: the write now commits before the ack." });
    const ending = hook({ hook_event_name: "SessionEnd", reason: "other" });
    rmSync(lockPath());
    setLastMessage("Done: the write now commits before the ack.");
    await captureSessionState(
      { hook_event_name: SNAPSHOT_EVENT, deferred: "Stop", session_id: SESSION, cwd: CWD, transcript_path: transcript },
      ENV,
      deps(),
    );
    await ending;

    expect(ingests().map((params) => params.arguments.baseVersion)).toEqual([undefined, "v1"]);
    const left = JSON.parse(readFileSync(lockPath().replace(/\.lock$/, ""), "utf8"));
    expect(left).toMatchObject({ ended: true, versionId: "v2" });
  }, 20_000);

  it("has a Stop handed to the background replace the version a snapshot stored after SessionEnd gave up waiting", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    // A snapshot holds the lock; the Stop handed to the background starts and waits for it.
    writeFileSync(lockPath(), "4242");
    setLastMessage("Done: the write now commits before the ack.");
    const deferredStop = captureSessionState(
      { hook_event_name: SNAPSHOT_EVENT, deferred: "Stop", session_id: SESSION, cwd: CWD, transcript_path: transcript },
      ENV,
      deps(),
    );
    // Meanwhile SessionEnd gives up waiting and the snapshot saves the ended state of the v1 it stored.
    const statePath = lockPath().replace(/\.lock$/, "");
    writeFileSync(statePath, JSON.stringify({ ended: true, versionId: "v1", versionTask: "WEB-77" }));
    versions = 1;
    rmSync(lockPath());
    await deferredStop;

    expect(ingests().map((params) => params.arguments.baseVersion)).toEqual(["v1"]);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ ended: true, versionId: "v2" });
  }, 20_000);

  it("has SessionEnd wait for a write in progress, so the version it stores is kept for a resume", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    let ending: Promise<void> | undefined;
    fetchImpl.mockImplementationOnce(async () => {
      ending = hook({ hook_event_name: "SessionEnd", reason: "other" });
      await new Promise((done) => setTimeout(done, 200));
      return rpcReply(`Stored and readable now. Version: v${++versions}.`);
    });
    await snapshot();
    await ending;

    const [file] = readdirSync(stateDir).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
    const left = JSON.parse(readFileSync(join(stateDir, file!), "utf8"));
    expect(left).toMatchObject({ ended: true, versionId: "v1" });
    expect(left.commands).toBeUndefined();
  });

  it("brings back only an ended state when the session's state was removed while it wrote", async () => {
    await calls([bash("echo one"), read(), read(), read(), read()]);
    const statePath = lockPath().replace(/\.lock$/, "");
    fetchImpl.mockImplementationOnce(async () => {
      rmSync(statePath);
      return rpcReply(`Stored and readable now. Version: v${++versions}.`);
    });
    await snapshot();

    const left = JSON.parse(readFileSync(statePath, "utf8"));
    expect(left).toMatchObject({ ended: true, versionId: "v1" });
    expect(left.commands).toBeUndefined();
  });

  it("logs a failed write without throwing, and the next snapshot tries again", async () => {
    fetchImpl.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await calls([bash("echo one"), read(), read(), read(), read()]);
    await expect(snapshot()).resolves.toBeUndefined();
    fetchImpl.mockImplementationOnce(async () => new Response("<html>", { status: 502 }));
    await calls([read(), read(), read(), read(), read()]);
    await snapshot();
    await calls([read(), read(), read(), read(), read()]);
    await snapshot();

    expect(logLines().map((line) => line.replace(/^\S+ session \S+ /, ""))).toEqual([
      "snapshot failed: network error",
      "snapshot failed: http 502",
      "snapshot stored",
    ]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("returns nothing from any event: capture never adds to what the agent is told", async () => {
    const results = [];
    for (const input of [read(), edit(), bash("echo x"), read(), read()]) results.push(await hook(input));
    results.push(await snapshot());
    expect(results.every((result) => result === undefined)).toBe(true);
  });
});

describe("the real hook: the snapshot is written after the hook has returned, and the agent is told nothing of it", () => {
  const HOOK = fileURLToPath(new URL("./willder-changes.mjs", import.meta.url));

  /** A stub Willder: no change notices; memory_ingest answered only when the test says so. */
  async function stubServer() {
    const ingested: string[] = [];
    let answer: (() => void) | null = null;
    const held: ServerResponse[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.startsWith("/api/mcp")) {
          ingested.push(body);
          held.push(res);
          answer?.();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ notice: null }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nextIngest = () => new Promise<void>((done) => (ingested.length > 0 ? done() : (answer = done)));
    const release = () => {
      for (const res of held.splice(0))
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: "Stored. Version: v1." }] },
          }),
        );
    };
    return { origin, ingested, nextIngest, release, close: () => new Promise((done) => server.close(done)) };
  }

  /** Run the hook once, as Claude Code does: the input on stdin; its stdout once it has exited. */
  function runHook(input: Record<string, unknown>, env: NodeJS.ProcessEnv) {
    return new Promise<string>((done, fail) => {
      const child = execFile(
        process.execPath,
        [HOOK],
        { env, timeout: 30_000, encoding: "utf8" },
        (error: Error | null, stdout: string) => (error ? fail(error) : done(stdout)),
      );
      child.stdin?.end(JSON.stringify(input));
    });
  }

  async function session(snapshots: "on" | "off") {
    const server = await stubServer();
    const temp = mkdtempSync(join(tmpdir(), "willder-snapshot-e2e-"));
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      TMPDIR: temp,
      WILLDER_URL: server.origin,
      WILLDER_TOKEN: "wcap_snapshot_e2e_token",
      WILLDER_CAPTURE: "session-state",
      ...(snapshots === "off" ? { WILLDER_SNAPSHOT_EVERY: "0" } : {}),
    };
    const base = { session_id: "e2e00000-snapshot", cwd: temp, transcript_path: join(temp, "t.jsonl") };
    writeFileSync(
      base.transcript_path,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the ack path." }] } })}\n`,
    );
    const outputs: string[] = [];
    outputs.push(await runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the double ack" }, env));
    for (const input of [read(), edit(), bash("echo hi"), read(), read()])
      outputs.push(await runHook({ ...base, ...input }, env));
    return { server, temp, outputs };
  }

  it("prints exactly what it prints with snapshots off, and the write arrives after the hook process exited", async () => {
    const [on, off] = await Promise.all([session("on"), session("off")]);
    try {
      expect(on.outputs).toEqual(off.outputs);
      // Every hook process has exited; the snapshot's write arrives from the detached process and
      // is still unanswered, so no hook waited for it.
      await on.server.nextIngest();
      const params = JSON.parse(on.server.ingested[0]!).params;
      expect(params.arguments.content).toContain("at a snapshot after 5 tool calls");
      expect(params._meta[CAPTURE_META_KEY]).toBe("session-state");
      on.server.release();
      const log = join(on.temp, "willder-capture", SNAPSHOT_LOG);
      await vi.waitFor(() => expect(existsSync(log) && readFileSync(log, "utf8")).toMatch(/snapshot stored/), {
        timeout: 20_000,
        interval: 100,
      });
      expect(off.server.ingested).toEqual([]);
    } finally {
      await on.server.close();
      await off.server.close();
      rmSync(on.temp, { recursive: true, force: true });
      rmSync(off.temp, { recursive: true, force: true });
    }
  }, 180_000);
});
