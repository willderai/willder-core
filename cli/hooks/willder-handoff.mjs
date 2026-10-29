// The handoff ask: the part of the Willder hook for Claude Code that, on a long session, asks the
// agent to record where the task stands before the context is cleared or compacted.
//
// On a long run the context sent each turn keeps growing, and a fresh session that starts from a
// short summary costs far less per turn. A fresh session can only finish the work as well as an
// unbroken one if it is told what the earlier one knew: what still fails, what was checked and
// how, what was decided and rejected and why, what was never checked, and what to verify first.
// The agent is the only one who knows the reasons, so this module asks it, once, at a natural
// stopping point.
//
// When it asks: on a PostToolUse whose transcript's last model turn re-sent at least
// WILLDER_HANDOFF_AT tokens of context (input plus cache read plus cache write, what the next turn
// sends again), at a checkpoint: a test run whose runner summary reports passes and no failures,
// or a `git commit` that made a commit. Not the tool's exit flag: most test commands end in a
// pipe, whose exit says nothing about the tests. It asks at most once until the context drops
// back under the threshold (a compaction) or the session changes (a /clear).
//
// What it asks for: one memory_ingest named `Handoff: <task>, session <id8>` with six headings
// (services/memory/session-handoff.ts holds the format; memory_ingest refuses a handoff missing a
// part, saying what to add), and a memory_note of kind question per open question. The next
// session of the task is served the handoff verified-first (mcp/task-start-notice.ts).
//
// The restart nudge: once a complete handoff is stored, and only when WILLDER_RESTART_NUDGE is
// "on", it tells the agent to end its reply with HANDOFF_RESTART_LINE, which a person answers with
// /clear and a runner with a fresh session. It is off by default until the long-task study shows a
// split keeps the pass rate.
//
// Settings:
//   WILLDER_HANDOFF_AT     the context size, in tokens, past which it asks; 0 turns the ask off.
//                          Unset, it is DEFAULT_HANDOFF_AT when capture is on (WILLDER_CAPTURE,
//                          the same consent as the session-state fact) and off otherwise. A value
//                          that is not a whole number turns it off: a typo never starts prompts.
//   WILLDER_RESTART_NUDGE  "on" turns the restart nudge on; anything else leaves it off.
//
// The one rule this file enforces: a restart is never suggested before a complete handoff is
// stored. It keeps one small file per session in the capture's state directory, readable by its
// owner only, holding three flags; it is removed with the capture's stale files.
//
// Zero dependencies on purpose, like willder-changes.mjs: it is copied into projects.
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  COUNTS_FAILURES,
  captureEnabled,
  defaultStateDir,
  printable,
  readState,
  readTail,
  saveState,
  stateDirUsable,
  testRunOf,
} from "./willder-capture.mjs";
import { redact } from "./willder-redact.mjs";

/**
 * The six headings a handoff opens its lines with, in the order asked. A format: memory_ingest
 * checks them (HANDOFF_PARTS in services/memory/session-handoff.ts), and a test holds the two equal.
 */
export const HANDOFF_HEADINGS = [
  "Still failing or unfinished:",
  "Done and checked:",
  "Decisions:",
  "Rejected:",
  "Not yet checked:",
  "Next step:",
];

/** The threshold when capture is on and WILLDER_HANDOFF_AT is unset, in tokens of context per turn. */
export const DEFAULT_HANDOFF_AT = 120_000;

/** The value of WILLDER_RESTART_NUDGE that turns the restart nudge on. */
export const RESTART_NUDGE_ON = "on";

/** The line an agent ends its reply with once its handoff is stored and the nudge is on; a runner restarts on it. */
export const HANDOFF_RESTART_LINE = "Willder handoff recorded: /clear to continue from it.";

/** A `git commit`, allowing git's global options before the subcommand (`git -C . commit`). */
const GIT_COMMIT = /\bgit\s+(?:(?:-[cC]\s+\S+|--[a-z-]+(?:=\S+)?)\s+)*commit\b/;
/** What `git commit` prints when it made a commit: `[branch abc1234] message`. */
const COMMIT_MADE = /^\[[^\]\n]+ [0-9a-f]{7,40}\]/m;
/** The most characters of the task's name the ask repeats, after redaction. */
const TASK_SHOWN_CHARS = 200;
/** A heading opening a line, after optional spaces and one list marker, as memory_ingest reads it. */
const headingAt = (heading, flags = "m") => new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${heading}`, flags);
/** A part that says there is nothing under it. */
const SAYS_NONE = /^(?:none|nothing|n\/a)\b/i;
/** The next step opens with what to check. */
const VERIFY_FIRST = /^(?:first[,:]?\s+)?(?:verify|check|confirm|run|test|re-run|rerun)\b/i;
/** Evidence for checked work: a commit sha (hex with a digit and a letter), or a runner's result. */
const EVIDENCE =
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\b\d+\s+(?:passed|passing|tests? passed)\b|\bPASS\s+\S+\.\w+|\bexit(?: code)? 0\b/;

/**
 * Whether a handoff's content is complete by the rules memory_ingest refuses on
 * (services/memory/session-handoff.ts, handoffProblems; a test holds the two in agreement): every
 * heading opens exactly one line with something under it, the checked work names evidence or says
 * none, and the next step opens with what to verify.
 * @param {string} content
 */
export function handoffComplete(content) {
  const found = HANDOFF_HEADINGS.map((heading) => ({
    heading,
    match: headingAt(heading).exec(content),
    count: (content.match(headingAt(heading, "gm")) ?? []).length,
  }));
  if (found.some((f) => f.match === null || f.count > 1)) return false;
  const order = [...found].sort((a, b) => a.match.index - b.match.index);
  const part = (heading) => {
    const at = order.findIndex((f) => f.heading === heading);
    const start = order[at].match.index + order[at].match[0].length;
    return content.slice(start, order[at + 1]?.match.index ?? content.length).trim();
  };
  if (HANDOFF_HEADINGS.some((heading) => part(heading) === "")) return false;
  const checked = part(HANDOFF_HEADINGS[1]);
  return (SAYS_NONE.test(checked) || EVIDENCE.test(checked)) && VERIFY_FIRST.test(part(HANDOFF_HEADINGS[5]));
}

/** A memory_ingest call on any MCP server name the client gave Willder. */
const MEMORY_INGEST_TOOL = /^mcp__.+__memory_ingest$/;
/** What memory_ingest's reply says when it stored the write: `... Version: <id>.` */
const STORED = /\bVersion: [^\s.]+/;

/**
 * The context threshold for this session, in tokens, or 0 when the ask is off.
 * @param {Record<string, string | undefined>} env
 */
export function handoffThreshold(env) {
  const raw = env.WILLDER_HANDOFF_AT?.trim();
  if (raw === undefined || raw === "") return captureEnabled(env) ? DEFAULT_HANDOFF_AT : 0;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
}

/**
 * The context the transcript's last model turn re-sent, in tokens: its input, cache read and cache
 * write. Null when the transcript holds no turn with usage in its tail, so an unread size never
 * reads as a small one.
 * @param {unknown} transcriptPath
 */
export function contextOf(transcriptPath) {
  if (typeof transcriptPath !== "string") return null;
  const lines = readTail(transcriptPath).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // A subagent's turn (a sidechain) re-sends its own context, not this session's.
    const usage = entry?.type === "assistant" && entry.isSidechain !== true ? entry.message?.usage : undefined;
    if (!usage || typeof usage !== "object") continue;
    const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
    const total =
      count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (total > 0) return total;
  }
  return null;
}

/** A tool response's text, whatever shape Claude Code hands it in. */
function responseText(response) {
  if (typeof response === "string") return response;
  const blocks = Array.isArray(response) ? response : Array.isArray(response?.content) ? response.content : null;
  if (blocks)
    return blocks
      .map((block) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : ""))
      .join("\n");
  const out = [response?.stdout, response?.stderr].filter((part) => typeof part === "string");
  return out.length > 0 ? out.join("\n") : "";
}

/**
 * Whether a finished tool call is a checkpoint: a test run whose output reports passes and no
 * failures anywhere (the capture's {@link testRunOf} reads only the last summary line, and a runner
 * can print a failed file count above a passing test count), or a `git commit` that made a commit.
 * @param {Record<string, any>} input a PostToolUse hook input
 */
export function isCheckpoint(input) {
  if (input?.hook_event_name !== "PostToolUse" || input.tool_name !== "Bash") return false;
  const output = responseText(input.tool_response);
  const run = testRunOf(input);
  if (run) return run.passed && run.line !== "exit 0" && !COUNTS_FAILURES.test(output);
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  return GIT_COMMIT.test(command) && COMMIT_MADE.test(output);
}

/**
 * Whether a finished tool call stored a handoff: a memory_ingest of a fact named as one, every
 * heading opening a line of its content, that the server answered with a stored version. The
 * server refuses an incomplete one, so a stored version is the proof; completeness is checked
 * here too ({@link handoffComplete}), so a server from before that check cannot turn the nudge on.
 * @param {Record<string, any>} input a PostToolUse hook input
 */
export function storedHandoff(input) {
  if (input?.hook_event_name !== "PostToolUse" || !MEMORY_INGEST_TOOL.test(String(input.tool_name ?? ""))) return false;
  const name = input.tool_input?.name;
  const content = input.tool_input?.content;
  if (typeof name !== "string" || typeof content !== "string" || input.tool_input?.kind !== undefined) return false;
  if (!name.trimStart().toLowerCase().startsWith("handoff:")) return false;
  return handoffComplete(content) && STORED.test(responseText(input.tool_response));
}

/**
 * The ask, as the hook hands it to the model: the size, why now, the name to use and the six
 * headings, each opening its own line.
 * @param {{ context: number, threshold: number, task?: string, sessionId: string }} at
 */
export function handoffAsk({ context, threshold, task, sessionId }) {
  const name = `Handoff: ${task ?? "<this task>"}, session ${sessionId.slice(0, 8)}`;
  return [
    `Willder handoff: this session re-sends about ${Math.round(context / 1000)}k tokens of context each turn (WILLDER_HANDOFF_AT is ${threshold}), and this is a checkpoint. Before you go on, record where the task stands, so a later session can finish it as well as you would: one memory_ingest named "${name}" with role progress, its content under these six headings, each opening its own line:`,
    `${HANDOFF_HEADINGS[0]} what must still pass or be done, naming the test or file.`,
    `${HANDOFF_HEADINGS[1]} what you ran, with its evidence: the test command and its runner's result, the commit sha.`,
    `${HANDOFF_HEADINGS[2]} each choice you made, with its reason.`,
    `${HANDOFF_HEADINGS[3]} each option you turned down, with its reason, or none.`,
    `${HANDOFF_HEADINGS[4]} what you believe but have not tested.`,
    `${HANDOFF_HEADINGS[5]} what to verify first, then what to do.`,
    "Then a memory_note of kind question for each open question, and carry on with the task. A handoff missing a part is refused, and the reply says what to add.",
  ].join("\n");
}

/** The restart nudge, given once a complete handoff is stored and only when the nudge is on. */
export const RESTART_NUDGE = `Willder: your handoff is stored, with every part. End this reply with this line on its own, so the session can restart from the handoff: ${HANDOFF_RESTART_LINE}`;

/** The per-session flags file, named by a digest of the session id only. */
function flagsPath(stateDir, sessionId) {
  return join(stateDir, `${createHash("sha256").update(`handoff\0${sessionId}`).digest("hex").slice(0, 32)}.json`);
}

/**
 * What the hook adds for the handoff on this event, or null: the ask, at a checkpoint past the
 * threshold, once per crossing; the restart nudge, once a complete handoff is stored, only when
 * the nudge is on. Never throws: the handoff must never get in the agent's way.
 * @param {Record<string, any>} input the hook input Claude Code sent on stdin
 * @param {Record<string, string | undefined>} env
 * @param {{ stateDir?: string }} [deps]
 */
export function handoffContext(input, env, { stateDir = defaultStateDir() } = {}) {
  try {
    // A subagent's tool call (its input names the agent) is not a checkpoint of this session.
    if (input?.hook_event_name !== "PostToolUse" || input.agent_id !== undefined) return null;
    const threshold = handoffThreshold(env);
    const sessionId = printable(input.session_id);
    if (threshold === 0 || !sessionId || !stateDirUsable(stateDir)) return null;
    const path = flagsPath(stateDir, sessionId);
    const flags = { asked: false, stored: false, nudged: false, ...readState(path) };
    const context = contextOf(input.transcript_path);
    let say = null;
    if (context !== null && context < threshold) {
      // Back under the threshold: a compaction. The next crossing asks again.
      if (!flags.asked && !flags.stored && !flags.nudged) return null;
      Object.assign(flags, { asked: false, stored: false, nudged: false });
    } else if (storedHandoff(input)) {
      flags.stored = true;
      if (env.WILLDER_RESTART_NUDGE?.trim() === RESTART_NUDGE_ON && !flags.nudged) {
        flags.nudged = true;
        say = RESTART_NUDGE;
      }
    } else if (context !== null && !flags.asked && !flags.stored && isCheckpoint(input)) {
      flags.asked = true;
      const task = printable(env.WILLDER_TASK);
      // Redacted as the capture redacts it, and cut, since the agent is asked to store the name.
      say = handoffAsk({ context, threshold, task: task && redact(task, env).slice(0, TASK_SHOWN_CHARS), sessionId });
    } else {
      return null;
    }
    saveState(path, flags);
    return say;
  } catch {
    return null;
  }
}
