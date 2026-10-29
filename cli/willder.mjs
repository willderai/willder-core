#!/usr/bin/env node
// `willder init`: connect a Claude Code project to Willder in one command.
//
// It writes the `willder` MCP server into <project>/.mcp.json, pointing at the Willder
// origin's /api/mcp with `Authorization: Bearer ${WILLDER_TOKEN}` as a literal variable
// reference that Claude Code expands when it connects, and `X-Willder-Tools: coding`, the
// tool set for a coding agent. The project's other servers are kept; an earlier `willder`
// entry is replaced.
//
// It also copies cli/hooks/willder-changes.mjs (and the modules it imports) to
// <project>/.claude/hooks/ and registers it in <project>/.claude/settings.json for the
// UserPromptSubmit and PostToolUse events, so the project's agent hears about changes
// to shared memory while it is busy with other work, and for SessionStart when its source
// is compact or clear, so the task-start block is told at once after Claude Code compacts the context or the person types /clear. Running it again updates both in
// place. --url points the server entry and the hook at another origin (a local server).
//
// With --capture it also turns on session-state capture (cli/hooks/willder-capture.mjs):
// it registers the Stop, PreCompact and PostToolUseFailure events and sets
// WILLDER_CAPTURE=session-state in the settings' env. Capture is off unless asked for,
// and a rerun without --capture turns it off again.
//
// The one rule this file enforces: it never writes a token. settings.json and .mcp.json
// are usually committed; the hook reads WILLDER_TOKEN from the agent's environment at
// run time, the same variable the MCP connection uses. It also never overwrites a
// file it cannot parse: it checks both before writing either, and stops and says so.
//
// Usage: willder init [--project <dir>] [--url <willder origin>] [--capture]
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAPTURE_ENV_VALUE,
  CAPTURE_EVENTS,
  CAPTURE_HOOK_TIMEOUT_SECONDS,
  HOOK_TIMEOUT_SECONDS,
} from "./hooks/willder-capture.mjs";
import { BOUNDARY_SOURCES, mcpUrl, noticeUrl } from "./hooks/willder-changes.mjs";

/** The project's Claude Code settings directory, where init writes the hook and its settings. */
export const SETTINGS_DIR = ".claude";
/** Claude Code's project-scoped MCP server list, in the project root. */
export const MCP_CONFIG_FILE = ".mcp.json";
const SERVER_NAME = "willder";
/** Variable references, not values: Claude Code expands them at connect time. An unset
 * WILLDER_TASK sends an empty header, which the server reads as no task. X-Willder-Tools:
 * coding lists only the tools a coding agent calls (mcp/tool-set.ts), so the others' schemas
 * are not re-sent on every model turn. */
export const SERVER_HEADERS = {
  Authorization: "Bearer ${WILLDER_TOKEN}",
  "X-Willder-Task": "${WILLDER_TASK:-}",
  "X-Willder-Tools": "coding",
};
/** What a capability token looks like, to notice one already written into .mcp.json. */
const LITERAL_TOKEN = /wcap_[A-Za-z0-9_-]+/;
/** The sentence init tells the person to give the agent: one write, then one read of it. */
export const FIRST_PROMPT =
  "Save this to Willder: we store sessions in Postgres, not Redis, so they survive a restart. " +
  "Then ask Willder where we store sessions and why.";
const HOOK_FILE = "willder-changes.mjs";
/** The hook and the modules it imports, directly or through each other, copied side by side into the project. */
export const HOOK_FILES = [
  HOOK_FILE,
  "willder-capture.mjs",
  "willder-handoff.mjs",
  "willder-redact.mjs",
  "willder-test-commands.mjs",
  "willder-touches.mjs",
  "willder-transcript.mjs",
];
const HOOKS_SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "hooks");
/** Claude Code resolves $CLAUDE_PROJECT_DIR, so the hook runs from any working directory. */
export const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${HOOK_FILE}"`;
const EVENTS = ["UserPromptSubmit", "PostToolUse", "SessionStart"];
/** Matchers for events the hook answers only in part: SessionStart only after a compaction or a /clear. */
const MATCHERS = { SessionStart: BOUNDARY_SOURCES.join("|") };
/** Every event init registers or removes, so every one of them is checked before a write. */
const ALL_EVENTS = [...EVENTS, ...CAPTURE_EVENTS];

const USAGE = "Usage: willder init [--project <dir>] [--url <willder origin>] [--capture]";

/** Thrown for anything the person running init has to fix; the message says how. */
export class InitError extends Error {}

/**
 * Return `settings` with the Willder hook registered once for each event, plus
 * WILLDER_URL in its `env` when `url` is given. With `capture`, the capture events are
 * registered too and WILLDER_CAPTURE is set; without it, both are removed. Other hooks
 * and keys are kept as they were; an earlier Willder entry is replaced, not duplicated.
 * @param {Record<string, any>} settings
 * @param {string} [url]
 * @param {boolean} [capture]
 */
export function withWillderHook(settings, url, capture = false) {
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const event of ALL_EVENTS) {
    const groups = (next.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isWillderHook(h)) }))
      .filter((group) => group.hooks.length > 0);
    if (EVENTS.includes(event) || capture) {
      const timeout = capture && event !== "UserPromptSubmit" ? CAPTURE_HOOK_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
      const matcher = MATCHERS[event];
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_COMMAND, timeout }] });
    }
    if (groups.length > 0) next.hooks[event] = groups;
    else delete next.hooks[event];
  }
  if (url) next.env = { ...next.env, WILLDER_URL: url };
  if (capture) next.env = { ...next.env, WILLDER_CAPTURE: CAPTURE_ENV_VALUE };
  else if (isPlainObject(next.env)) delete next.env.WILLDER_CAPTURE;
  return next;
}

/**
 * Return `config` (the parsed .mcp.json) with the `willder` server pointing at `url`'s
 * MCP endpoint, or willder.ai's when `url` is omitted. Other servers and keys are kept.
 * @param {Record<string, any>} config
 * @param {string} [url]
 */
export function withWillderServer(config, url) {
  const endpoint = url ? mcpUrl(url) : mcpUrl();
  return {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      [SERVER_NAME]: { type: "http", url: endpoint.href, headers: { ...SERVER_HEADERS } },
    },
  };
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Describe what in an existing `hooks` value withWillderHook could not merge into,
 * or return undefined when it is absent or has the shape Claude Code expects:
 * an object of event name to an array of groups, each with an optional `hooks` array.
 * Only the events init writes are checked; it leaves the others untouched.
 * @param {unknown} hooks
 */
function hooksShapeProblem(hooks) {
  if (hooks === undefined) return undefined;
  if (!isPlainObject(hooks)) return "hooks must be an object";
  for (const event of ALL_EVENTS) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return `hooks.${event} must be an array`;
    const index = groups.findIndex(
      (group) => !isPlainObject(group) || !(group.hooks === undefined || Array.isArray(group.hooks)),
    );
    if (index !== -1) return `hooks.${event}[${index}] must be an object whose hooks is an array`;
  }
  return undefined;
}

const isWillderHook = (hook) => typeof hook?.command === "string" && hook.command.includes(`/${HOOK_FILE}`);

/**
 * Read a JSON object from `path`, or `{}` when the file does not exist.
 * @throws InitError when the file is not valid JSON or does not hold an object.
 */
function readJsonObject(path) {
  if (!existsSync(path)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InitError(`${path} is not valid JSON (${e.message}). Fix it, then run init again.`);
  }
  if (!isPlainObject(value)) throw new InitError(`${path} must hold a JSON object. Fix it, then run init again.`);
  return value;
}

/**
 * Connect `projectDir` to Willder: the MCP server entry and the hook. Returns the paths
 * it wrote, and whether the `willder` entry it replaced held a literal token.
 * @param {{ projectDir: string, url?: string, capture?: boolean }} options
 * @throws InitError when the project, the URL or an existing settings file is unusable.
 */
export function init({ projectDir, url, capture = false }) {
  if (!existsSync(projectDir)) throw new InitError(`No such directory: ${projectDir}`);
  if (url && !noticeUrl(url)) {
    throw new InitError(`--url must be an https:// origin (or http://localhost for a local server), got: ${url}`);
  }

  const claudeDir = join(projectDir, SETTINGS_DIR);
  const settingsPath = join(claudeDir, "settings.json");
  const hooksDir = join(claudeDir, "hooks");
  const hookPath = join(hooksDir, HOOK_FILE);

  const mcpConfigPath = join(projectDir, MCP_CONFIG_FILE);
  const mcpConfig = readJsonObject(mcpConfigPath);
  if (mcpConfig.mcpServers !== undefined && !isPlainObject(mcpConfig.mcpServers)) {
    throw new InitError(`${mcpConfigPath}: mcpServers must be an object. Fix it, then run init again.`);
  }
  const replacedLiteralToken = LITERAL_TOKEN.test(JSON.stringify(mcpConfig.mcpServers?.[SERVER_NAME] ?? null));

  const settings = readJsonObject(settingsPath);
  const problem = hooksShapeProblem(settings.hooks);
  if (problem) throw new InitError(`${settingsPath}: ${problem}. Fix it, then run init again.`);
  // --url and --capture merge a key into env; spreading a string or array there
  // would write it back as numbered keys. Otherwise env is not init's to judge.
  if ((url || capture) && settings.env !== undefined && !isPlainObject(settings.env)) {
    const key = url ? "WILLDER_URL" : "WILLDER_CAPTURE";
    throw new InitError(`${settingsPath}: env must be an object to add ${key} to it. Fix it, then run init again.`);
  }

  writeFileSync(mcpConfigPath, `${JSON.stringify(withWillderServer(mcpConfig, url), null, 2)}\n`);
  mkdirSync(hooksDir, { recursive: true });
  for (const file of HOOK_FILES) copyFileSync(join(HOOKS_SOURCE_DIR, file), join(hooksDir, file));
  writeFileSync(settingsPath, `${JSON.stringify(withWillderHook(settings, url, capture), null, 2)}\n`);
  return { mcpConfigPath, settingsPath, hookPath, replacedLiteralToken };
}

/**
 * What to tell the person after init: what was written, what is still theirs to do, and
 * the sentence to give the agent. Says whether WILLDER_TOKEN is set, never its value.
 * @param {{ mcpConfigPath: string, settingsPath: string, hookPath: string, replacedLiteralToken: boolean }} result
 * @param {{ capture: boolean, tokenSet: boolean }} context
 */
export function nextSteps(result, { capture, tokenSet }) {
  const lines = [
    "Connected this project to Willder:",
    `  ${result.mcpConfigPath}  (the willder MCP server; it holds the variable name, not the token)`,
    `  ${result.hookPath}`,
    `  ${result.settingsPath}`,
  ];
  if (result.replacedLiteralToken) {
    lines.push(
      "",
      `The willder entry this replaced held a token written into ${MCP_CONFIG_FILE}. Revoke that token in Access, then Tokens.`,
    );
  }
  lines.push(
    "",
    capture
      ? "Session-state capture is ON for everyone using this settings file: each session keeps one fact in Willder with its changed files, last test result and last message (secrets redacted). Run init again without --capture to turn it off."
      : "Session-state capture is off. Add --capture to turn it on (see docs/connect/claude-code.md).",
    "",
    "Next:",
  );
  if (!tokenSet) {
    lines.push("  WILLDER_TOKEN is not set in this shell. Load it before starting claude:");
    lines.push(
      "    printf 'Willder token: '; stty -echo; read -r WILLDER_TOKEN; stty echo; printf '\\n'; export WILLDER_TOKEN",
    );
  }
  lines.push("  Start claude in this project and answer Yes when it asks to use the project's MCP servers.");
  lines.push("  Then tell it:", `    ${FIRST_PROMPT}`);
  return lines.join("\n");
}

/** Parse argv (without node and script) into init's options. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "init") throw new InitError(USAGE);
  const options = { projectDir: process.cwd(), url: undefined, capture: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--capture") {
      options.capture = true;
      continue;
    }
    if (flag !== "--project" && flag !== "--url") throw new InitError(`Unknown option ${flag}.\n${USAGE}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new InitError(`${flag} needs a value.\n${USAGE}`);
    if (flag === "--project") options.projectDir = resolve(value);
    else options.url = value;
    i += 1;
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = init(options);
    console.log(nextSteps(result, { capture: options.capture, tokenSet: Boolean(process.env.WILLDER_TOKEN) }));
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
