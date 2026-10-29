// `willder init` against a real temporary project directory: what it writes, what
// it keeps, and what it refuses to touch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_EVENTS } from "./hooks/willder-capture.mjs";
import { FIRST_PROMPT, HOOK_COMMAND, InitError, init, parseArgs } from "./willder.mjs";

const CLI = join(import.meta.dirname, "willder.mjs");

let projectDir = "";
const settingsPath = () => join(projectDir, ".claude", "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const writeSettings = (text: string) => {
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), text);
};
const willderHooks = (settings: { hooks: Record<string, { hooks: { command: string }[] }[]> }, event: string) =>
  settings.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command === HOOK_COMMAND);

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "willder-init-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("willder init", () => {
  it("copies the hook in and registers it for prompts and tool results", () => {
    const { hookPath } = init({ projectDir });

    expect(existsSync(hookPath)).toBe(true);
    const settings = readSettings();
    expect(willderHooks(settings, "UserPromptSubmit")).toHaveLength(1);
    expect(willderHooks(settings, "PostToolUse")).toHaveLength(1);
  });

  it("never writes the token, even when one is in its own environment", () => {
    const previous = process.env.WILLDER_TOKEN;
    process.env.WILLDER_TOKEN = "wcap_must_not_be_written";
    try {
      init({ projectDir, url: "https://willder.example" });
    } finally {
      if (previous === undefined) delete process.env.WILLDER_TOKEN;
      else process.env.WILLDER_TOKEN = previous;
    }

    expect(readFileSync(settingsPath(), "utf8")).not.toContain("wcap_must_not_be_written");
    expect(readSettings().env).toEqual({ WILLDER_URL: "https://willder.example" });
  });

  it("keeps the project's own hooks and settings, and adds itself only once on a rerun", () => {
    const own = { type: "command", command: "npm run lint" };
    writeSettings(JSON.stringify({ model: "sonnet", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [own] }] } }));

    init({ projectDir });
    init({ projectDir });
    const settings = readSettings();

    expect(settings.model).toBe("sonnet");
    expect(settings.hooks.PostToolUse[0]).toEqual({ matcher: "Edit", hooks: [own] });
    expect(willderHooks(settings, "PostToolUse")).toHaveLength(1);
    expect(willderHooks(settings, "UserPromptSubmit")).toHaveLength(1);
  });

  it("registers SessionStart only after a compaction or a /clear, once on a rerun, keeping the project's own SessionStart hooks", () => {
    const own = { type: "command", command: "echo started" };
    writeSettings(JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [own] }] } }));

    init({ projectDir });
    init({ projectDir });
    const groups = readSettings().hooks.SessionStart;

    expect(groups).toEqual([
      { matcher: "startup", hooks: [own] },
      { matcher: "compact|clear", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 5 }] },
    ]);
  });

  it("refuses to overwrite a settings file it cannot parse, and leaves it as it was", () => {
    writeSettings("{ not json");

    expect(() => init({ projectDir })).toThrow(InitError);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  });

  it.each([
    ["hooks that is not an object", { hooks: [] }, /hooks must be an object/],
    [
      "an event that is not an array",
      { hooks: { PostToolUse: { matcher: "Edit" } } },
      /hooks\.PostToolUse must be an array/,
    ],
    ["a group that is not an object", { hooks: { UserPromptSubmit: ["npm test"] } }, /hooks\.UserPromptSubmit\[0\]/],
    [
      "a group whose hooks is not an array",
      { hooks: { PostToolUse: [{ hooks: "npm test" }] } },
      /hooks\.PostToolUse\[0\]/,
    ],
  ])("refuses a settings file with %s, and leaves it and the project as they were", (_, settings, message) => {
    const text = JSON.stringify(settings);
    writeSettings(text);

    expect(() => init({ projectDir })).toThrow(InitError);
    expect(() => init({ projectDir })).toThrow(message);
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
    expect(existsSync(join(projectDir, ".claude", "hooks"))).toBe(false);
  });

  it.each([
    ["a string", "WILLDER_URL=https://old.example"],
    ["an array", ["WILLDER_URL"]],
    ["null", null],
  ])("with --url, refuses an env that is %s, and leaves it and the project as they were", (_, env) => {
    const text = JSON.stringify({ env });
    writeSettings(text);

    expect(() => init({ projectDir, url: "https://willder.example" })).toThrow(InitError);
    expect(() => init({ projectDir, url: "https://willder.example" })).toThrow(/env must be an object/);
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
    expect(existsSync(join(projectDir, ".claude", "hooks"))).toBe(false);
  });

  it("with --url, adds WILLDER_URL beside the project's own env; without it, leaves env alone", () => {
    writeSettings(JSON.stringify({ env: { NODE_ENV: "test" } }));
    init({ projectDir, url: "https://willder.example" });
    expect(readSettings().env).toEqual({ NODE_ENV: "test", WILLDER_URL: "https://willder.example" });

    writeSettings(JSON.stringify({ env: "left as it was" }));
    init({ projectDir });
    expect(readSettings().env).toBe("left as it was");
  });

  it("refuses a URL the hook would send a token to in the clear", () => {
    expect(() => init({ projectDir, url: "http://willder.example" })).toThrow(/https/);
    expect(existsSync(settingsPath())).toBe(false);
  });
});

describe("willder init: the MCP server entry", () => {
  const mcpPath = () => join(projectDir, ".mcp.json");
  const readMcp = () => JSON.parse(readFileSync(mcpPath(), "utf8"));
  const expectedServer = (url: string) => ({
    type: "http",
    url,
    headers: {
      Authorization: "Bearer ${WILLDER_TOKEN}",
      "X-Willder-Task": "${WILLDER_TASK:-}",
      "X-Willder-Tools": "coding",
    },
  });

  it("writes the willder server into a fresh project's .mcp.json, as variable references", () => {
    init({ projectDir });

    expect(readMcp()).toEqual({ mcpServers: { willder: expectedServer("https://willder.ai/api/mcp") } });
  });

  it("points the server at --url's MCP endpoint", () => {
    init({ projectDir, url: "http://localhost:3000" });

    expect(readMcp().mcpServers.willder.url).toBe("http://localhost:3000/api/mcp");
  });

  it("keeps the project's other servers and keys, and a rerun leaves both files byte-identical", () => {
    const other = { command: "npx", args: ["some-server"] };
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { other }, note: "kept" }));

    init({ projectDir });
    const mcpAfterFirst = readFileSync(mcpPath(), "utf8");
    const settingsAfterFirst = readFileSync(settingsPath(), "utf8");
    init({ projectDir });

    expect(readMcp()).toEqual({
      mcpServers: { other, willder: expectedServer("https://willder.ai/api/mcp") },
      note: "kept",
    });
    expect(readFileSync(mcpPath(), "utf8")).toBe(mcpAfterFirst);
    expect(readFileSync(settingsPath(), "utf8")).toBe(settingsAfterFirst);
  });

  it("replaces an earlier willder entry that held a literal token, and says so", () => {
    const leaked = {
      type: "http",
      url: "https://willder.ai/api/mcp",
      headers: { Authorization: "Bearer wcap_written_by_mistake" },
    };
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { willder: leaked } }));

    const { replacedLiteralToken } = init({ projectDir });

    expect(replacedLiteralToken).toBe(true);
    expect(readFileSync(mcpPath(), "utf8")).not.toContain("wcap_");
    expect(init({ projectDir }).replacedLiteralToken).toBe(false);
  });

  it.each([
    ["is not JSON", "{ not json", /not valid JSON/],
    ["is not an object", "[]", /must hold a JSON object/],
    [
      "has mcpServers that is not an object",
      JSON.stringify({ mcpServers: ["willder"] }),
      /mcpServers must be an object/,
    ],
  ])("refuses a .mcp.json that %s, and writes nothing", (_, text, message) => {
    writeFileSync(mcpPath(), text);

    expect(() => init({ projectDir })).toThrow(InitError);
    expect(() => init({ projectDir })).toThrow(message);
    expect(readFileSync(mcpPath(), "utf8")).toBe(text);
    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
  });

  it("writes no .mcp.json when the settings file is the one it refuses", () => {
    writeSettings("{ not json");

    expect(() => init({ projectDir })).toThrow(InitError);
    expect(existsSync(mcpPath())).toBe(false);
  });
});

describe("the willder command", () => {
  const run = (env: Record<string, string>) =>
    execFileSync(process.execPath, [CLI, "init", "--project", projectDir], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    });

  it("connects a fresh project in one run and prints the sentence to give the agent", () => {
    const out = run({});

    expect(existsSync(join(projectDir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude", "hooks", "willder-changes.mjs"))).toBe(true);
    expect(out).toContain(FIRST_PROMPT);
    expect(out).toContain("WILLDER_TOKEN is not set");
  });

  it("with WILLDER_TOKEN set, neither prints it nor writes it, and skips the step that loads it", () => {
    const token = "wcap_" + "must_never_be_printed";
    const out = run({ WILLDER_TOKEN: token });

    expect(out).not.toContain(token);
    expect(out).not.toContain("WILLDER_TOKEN is not set");
    expect(readFileSync(join(projectDir, ".mcp.json"), "utf8")).not.toContain(token);
    expect(readFileSync(settingsPath(), "utf8")).not.toContain(token);
  });

  it("exits 1 with the fix on stderr when it refuses a file", () => {
    writeFileSync(join(projectDir, ".mcp.json"), "{ not json");

    expect(() => execFileSync(process.execPath, [CLI, "init", "--project", projectDir], { stdio: "pipe" })).toThrow(
      /Fix it, then run init again/,
    );
  });
});

describe("willder init --capture", () => {
  it("copies the capture module beside the hook, and registers the capture events only when asked", () => {
    init({ projectDir });
    let settings = readSettings();
    expect(existsSync(join(projectDir, ".claude", "hooks", "willder-capture.mjs"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude", "hooks", "willder-redact.mjs"))).toBe(true);
    for (const event of CAPTURE_EVENTS) expect(settings.hooks[event]).toBeUndefined();
    expect(settings.env?.WILLDER_CAPTURE).toBeUndefined();

    init({ projectDir, capture: true });
    settings = readSettings();
    for (const event of CAPTURE_EVENTS) expect(willderHooks(settings, event)).toHaveLength(1);
    expect(settings.env.WILLDER_CAPTURE).toBe("session-state");
  });

  it("registers SessionEnd with capture, so a session's state file is removed when it ends", () => {
    init({ projectDir, capture: true });

    for (const event of ["Stop", "PreCompact", "PostToolUseFailure", "SessionEnd"])
      expect(willderHooks(readSettings(), event)).toHaveLength(1);
  });

  it("gives the events that may write long enough to finish the write, and the prompt hook its usual bound", () => {
    init({ projectDir, capture: true });
    const settings = readSettings();
    const timeoutOf = (event: string) =>
      settings.hooks[event]
        .flatMap((g: { hooks: { command: string; timeout: number }[] }) => g.hooks)
        .find((h: { command: string }) => h.command === HOOK_COMMAND).timeout;

    expect(timeoutOf("UserPromptSubmit")).toBe(5);
    for (const event of ["PostToolUse", ...CAPTURE_EVENTS]) expect(timeoutOf(event)).toBe(15);
  });

  it("turns capture off again on a rerun without --capture, keeping the project's own Stop hooks", () => {
    const own = { type: "command", command: "say done" };
    writeSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [own] }] }, env: { NODE_ENV: "test" } }));

    init({ projectDir, capture: true });
    init({ projectDir });
    const settings = readSettings();

    expect(settings.hooks.Stop).toEqual([{ hooks: [own] }]);
    expect(settings.hooks.PreCompact).toBeUndefined();
    expect(settings.hooks.PostToolUseFailure).toBeUndefined();
    expect(settings.env).toEqual({ NODE_ENV: "test" });
    expect(willderHooks(settings, "PostToolUse")).toHaveLength(1);
  });

  it("refuses --capture when env is not an object, and leaves the project as it was", () => {
    const text = JSON.stringify({ env: "WILLDER_CAPTURE=session-state" });
    writeSettings(text);

    expect(() => init({ projectDir, capture: true })).toThrow(/env must be an object/);
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  });

  it("refuses a malformed capture event in an existing settings file", () => {
    writeSettings(JSON.stringify({ hooks: { Stop: { hooks: [] } } }));

    expect(() => init({ projectDir, capture: true })).toThrow(/hooks\.Stop must be an array/);
  });
});

describe("parseArgs", () => {
  it("reads --project and --url", () => {
    expect(parseArgs(["init", "--project", "/tmp/p", "--url", "https://w.example"])).toEqual({
      projectDir: "/tmp/p",
      url: "https://w.example",
      capture: false,
    });
  });

  it("reads --capture as a flag that takes no value, in any position", () => {
    expect(parseArgs(["init", "--capture", "--project", "/tmp/p"])).toEqual({
      projectDir: "/tmp/p",
      url: undefined,
      capture: true,
    });
    expect(parseArgs(["init", "--project", "/tmp/p", "--capture"]).capture).toBe(true);
  });

  it("rejects an unknown command, an unknown flag, and a flag without a value", () => {
    expect(() => parseArgs(["install"])).toThrow(InitError);
    expect(() => parseArgs(["init", "--token", "x"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["init", "--url"])).toThrow(/needs a value/);
  });
});
