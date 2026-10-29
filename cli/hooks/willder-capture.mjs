// Session-state capture: the opt-in write half of the Willder hook for Claude Code.
//
// A coding agent records what it learned when it wraps up, if it records anything, and a
// session that is killed, compacted or simply ends never wraps up. This module keeps one
// fact per (task, session) in Willder memory that says where the work stands: the files
// changed since the session started, the last test command, whether it passed and when it
// ran, which test files the session had edited before that run, which of them the command
// named, which it edited after it, the files its edit tools wrote, the shell commands it ran with
// their exit status (never their output), and the agent's last message. A pass on tests the same
// session rewrote proves little: in a paired handoff study an agent
// rewrote a shipped regression test to assert its own wrong change, ran it, and recorded the
// task as finished. Each write replaces the one before it (memory_ingest's `baseVersion`), so
// a session leaves one current fact, not a pile. It is stored with `role: progress`, so the
// next session of the task is served it after anything a person or agent recorded on purpose
// (services/memory/fact-roles.ts). Nothing here calls a model.
//
// When it writes: on Stop and PreCompact, after a test run whose result flips between failing
// and passing (at most once per FLIP_WRITE_INTERVAL_MS), and as a snapshot every
// WILLDER_SNAPSHOT_EVERY tool calls of the session's own (DEFAULT_SNAPSHOT_EVERY when unset; 0
// turns snapshots off). The flip and the snapshot cover a session that is killed before Stop ever
// fires. A snapshot needs nothing from the agent and tells it nothing: the hook starts a detached
// process that writes it (startSnapshotProcess) and returns at once, printing nothing, so a slow or
// failing server never holds up the agent's turn. Every write is the same fact in the same format,
// so a snapshot and a Stop never write twice: a write whose text, apart from its first line (what
// triggered it), equals the last one stored is not sent. One lock file per state file lets one
// write run at a time; each write reads the stored version afresh under it. A Stop or PreCompact
// that finds a write in progress hands its own to the same detached process, which waits its
// turn, and SessionEnd waits for both before it cuts the state down. What the snapshot process did
// is logged to SNAPSHOT_LOG in the state directory, never shown to the agent. A shell command's
// words are the agent's own: the server serves that line with the agent's claims.
//
// How it writes: one `tools/call memory_ingest` to the hosted /api/mcp with the session's
// own WILLDER_TOKEN, so the write is checked, audited and erasure-filtered like any other.
// A token that may not write is refused once and the session stops trying. The call is
// marked `_meta["willder/capture"] = "session-state"`, which tells the server to skip graph
// extraction for it and not to spend the session's change notices on it
// (mcp/session-capture.ts).
//
// The one rule this file enforces: nothing secret is written. Every part of the fact is
// passed through `redact` (willder-redact.mjs, best-effort, see there for what it covers),
// shell commands first through maskCommandSecrets, before it is cut to size, so a token cut in half still matches; no environment value is
// read into the fact, and the values of secret-named environment variables are removed
// wherever they appear. The fact is capped at MAX_CONTENT_CHARS.
//
// It is off unless WILLDER_CAPTURE is exactly "session-state" (`willder init --capture`
// sets it). With it on, it keeps a small state file per session and repository in the OS temp
// directory, readable by its owner only: the commit the session started on, digests of the names
// of the files that were already untracked then with each file's size and modification time,
// the last test command (redacted), its result and time, the test files edited before it
// (redacted) and the stamps of the files changed then (name digests), the last shell commands
// with their exit status and the files the edit tools wrote (redacted), a count of the session's
// tool calls, and the version its last write stored. A second small file per session lists, as digests, the repositories it was seen in. It never holds the token. When the session ends
// (SessionEnd) the state file is cut down to the version its last write stored, that write's
// digest and the session's last test run, so a session resumed under the same id (`claude -p
// --resume`, which ends at every process exit) replaces its one fact instead of starting a second,
// and a resumed process that runs no test still reports the run its session last saw; the index is
// removed. Any file left by a
// session that was killed or never resumed is removed after STALE_STATE_MS.
// A state directory that other users can write to turns capture off.
//
// Zero dependencies on purpose, like willder-changes.mjs: it is copied into projects.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redact } from "./willder-redact.mjs";
import {
  editedTestsOf,
  isTestFile,
  runnerCommandOf,
  runsTests,
  shellCommands,
  testRunOf,
  testWritesAroundRun,
  WORD_SEPARATOR,
} from "./willder-test-commands.mjs";
import { lastAssistantMessage, transcriptShowsEarlierWork } from "./willder-transcript.mjs";

export { redact };
export {
  COUNTS_FAILURES,
  editedTestsOf,
  isTestFile,
  testRunOf,
  testWritesAroundRun,
} from "./willder-test-commands.mjs";
export { readTail } from "./willder-transcript.mjs";

/** The WILLDER_CAPTURE value that turns capture on. Any other value, or none, leaves it off. */
export const CAPTURE_ENV_VALUE = "session-state";

/** The tool-call `_meta` key that marks a write as a session-state capture. */
export const CAPTURE_META_KEY = "willder/capture";

/** Claude Code events only capture listens to; `willder init --capture` registers them. */
export const CAPTURE_EVENTS = ["Stop", "PreCompact", "PostToolUseFailure", "SessionEnd"];

/** The least time between two writes triggered by a test result flipping. */
export const FLIP_WRITE_INTERVAL_MS = 10 * 60 * 1000;

/** The longest fact written, in characters. */
export const MAX_CONTENT_CHARS = 3000;

/**
 * The tool calls of the session's own between two snapshots when capture is on and
 * WILLDER_SNAPSHOT_EVERY is unset: the median number of tool calls unaided coding sessions made
 * before their first file edit, the point where a plan has formed.
 */
export const DEFAULT_SNAPSHOT_EVERY = 5;

/** The event name the snapshot process runs capture with; Claude Code never sends it. */
export const SNAPSHOT_EVENT = "WillderSnapshot";

/** The environment variable that hands the snapshot process its input. */
export const SNAPSHOT_INPUT_ENV = "WILLDER_SNAPSHOT_INPUT";

/** The file in the state directory the snapshot process logs what it did to, one line each. */
export const SNAPSHOT_LOG = "capture.log";
/** Past this size the log is moved to `capture.log.1`, replacing the one before. */
const SNAPSHOT_LOG_MAX_BYTES = 64 * 1024;

/** Claude Code's file-editing tools, and the input field naming the file. */
export const EDIT_TOOL_FIELDS = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** The most shell commands a session's state keeps, the latest last, and how much of each and of all of them the fact shows. */
const COMMANDS_KEPT = 8;
const COMMAND_SHOWN_CHARS = 160;
const COMMAND_REDACTED_CHARS = 2000;
const COMMANDS_MAX_CHARS = 700;
/** The most files edited by the agent's tools the state keeps, the latest last, and how much of them the fact shows. */
const EDITED_KEPT = 30;
const EDITED_MAX_CHARS = 400;

/** A write lock older than this is left by a process that died, and is taken over: longer than any write runs ({@link WRITE_DEADLINE_MS}). */
const LOCK_STALE_MS = 20_000;
/**
 * How long Stop, PreCompact or a test flip waits for a write in progress. After it, a test flip
 * leaves the write to the next event, and Stop and PreCompact hand theirs to a detached process
 * that waits its turn (startSnapshotProcess with `deferred`), so two writes never race.
 */
const LOCK_WAIT_MS = 1000;
/** How long SessionEnd waits for a write in progress or handed off, before cutting the state down. */
const SESSION_END_WAIT_MS = 10_000;
/** The longest opening line (what triggered the write) and the rest of the fact, which together fit MAX_CONTENT_CHARS. */
const OPENING_MAX_CHARS = 200;
const BODY_MAX_CHARS = MAX_CONTENT_CHARS - OPENING_MAX_CHARS - 1;
const LOCK_POLL_MS = 100;
/** The fields only a write changes; an event that does not write keeps what is on disk for them. */
const WRITE_FIELDS = ["versionId", "versionTask", "lastContentDigest", "denied", "lastFlipWriteAt"];

/** The longest part of the agent's last message kept, in characters. */
export const LAST_MESSAGE_MAX_CHARS = 1000;

/**
 * How far past the part it keeps the last message is redacted: a secret the cut runs
 * through is still whole when redaction sees it, and a message of any length costs the same.
 */
const REDACT_MARGIN_CHARS = 8192;

/** How long a state file left by a session that never ended is kept. */
const STALE_STATE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most untracked files remembered from a session's start. */
const MAX_START_UNTRACKED = 5000;
/** The most changed test files whose stamps a test run keeps; past this, test edits after the run are not known. */
const MAX_STAMPED_FILES = 2000;
/** The most command paths asked of `git check-ignore` per run. */
const MAX_IGNORE_CHECKS = 5;
/** The most edited test files whose existence at the session's start is looked up, and how many per git call. */
const MAX_EXISTENCE_CHECKS = 2000;
const EXISTENCE_CHECKS_PER_CALL = 200;

const TEST_LINE_MAX_CHARS = 200;
const MAX_FILES_SHOWN = 30;
const FILES_MAX_CHARS = 600;
const MAX_TEST_FILES_SHOWN = 10;
const MAX_FUNCTIONS_SHOWN = 15;
const FUNCTIONS_MAX_CHARS = 600;
const FUNCTION_NAME_MAX_CHARS = 80;
const TEST_FILES_MAX_CHARS = 300;
/**
 * Seconds Claude Code gives the hook before it stops it (cli/willder.mjs installs these): 15 s
 * for an event that may write the session's state, 5 s for UserPromptSubmit. A hook stopped
 * at its limit loses its write and the task-start notice it was about to print.
 */
export const CAPTURE_HOOK_TIMEOUT_SECONDS = 15;
export const HOOK_TIMEOUT_SECONDS = 5;
/** The task-start notice's own request (willder-changes.mjs), made after capture's git at a prompt. */
export const NOTICE_TIMEOUT_MS = 2000;
/**
 * What each limit keeps back for the work outside git and the requests: starting node, reading
 * stdin, the transcript and state files, and printing the notice. That work measured about
 * 100 ms per event on a 2,000-file repository with an 8 MB transcript (2026-10-14), so the
 * headroom is about 30 times it at a capture event and 10 times it at a prompt.
 */
const CAPTURE_HEADROOM_MS = 3000;
const PROMPT_HEADROOM_MS = 1000;
/**
 * The longest one git call may take, and all of one event's git calls together. A loaded
 * machine can take seconds per call. At a capture event git gets 4 s and the write what is left
 * of the 15 s limit after the headroom, up to WRITE_TIMEOUT_MS: 4 s + 8 s + 3 s = 15 s. At a
 * prompt git gets what the 5 s limit leaves beside the notice and the headroom, 2 s. A call past
 * the budget is not made, and what it would have told reads "not known"; a start commit or
 * untracked list it missed is recovered at a later event ({@link recoverBaseline}).
 */
const GIT_TIMEOUT_MS = 3000;
const GIT_BUDGET_MS = 4000;
const PROMPT_GIT_BUDGET_MS = HOOK_TIMEOUT_SECONDS * 1000 - NOTICE_TIMEOUT_MS - PROMPT_HEADROOM_MS;
const WRITE_TIMEOUT_MS = 8000;
/** How long after its start an event's write must be done by, so the hook ends inside its limit. */
const WRITE_DEADLINE_MS = CAPTURE_HOOK_TIMEOUT_SECONDS * 1000 - CAPTURE_HEADROOM_MS;
/** The most HEAD reflog entries read to find the commit a session started on. */
const MAX_REFLOG_ENTRIES = 1000;
/** A reflog time in seconds is past this (2001); a reflog position never is. */
const UNIX_TIME_FLOOR = 1_000_000_000;

/**
 * What the fact says when the hook saw no command it reads as a test run. Not "none run": a
 * runner it does not recognise may have run the tests.
 */
const NO_RUN_RECOGNISED = "none recognised";

/** Whether the user turned capture on. */
export function captureEnabled(env) {
  return env.WILLDER_CAPTURE?.trim() === CAPTURE_ENV_VALUE;
}

/**
 * The tool calls of the session's own between two snapshots, or 0 when snapshots are off: off
 * whenever capture is, DEFAULT_SNAPSHOT_EVERY when WILLDER_SNAPSHOT_EVERY is unset, and off for a
 * value that is not a whole number, so a typo never starts writes.
 * @param {Record<string, string | undefined>} env
 */
export function snapshotEvery(env) {
  if (!captureEnabled(env)) return 0;
  const raw = env.WILLDER_SNAPSHOT_EVERY?.trim();
  if (raw === undefined || raw === "") return DEFAULT_SNAPSHOT_EVERY;
  return /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
}

/**
 * The shell command a finished tool call ran, as the state keeps it, or null when it ran none: the
 * command with its line continuations joined and its heredocs' bodies dropped
 * ({@link withoutHeredocBodies}), each line masked for the secrets commands carry
 * ({@link maskCommandSecrets}) and redacted, its line breaks shown as ⏎, cut to
 * COMMAND_SHOWN_CHARS; and its exit status. The status is read from what Claude Code says of the
 * call, never its output: 0 for PostToolUse, the code PostToolUseFailure's error opens with
 * (`Exit code 2`), "interrupted", or "failed" when it names none.
 * @param {Record<string, any>} input
 * @param {Record<string, string | undefined>} env
 * @returns {{ command: string, status: string } | null}
 */
export function commandRecordOf(input, env) {
  const command = input?.tool_input?.command;
  if (input?.tool_name !== "Bash" || typeof command !== "string" || command.trim() === "") return null;
  let status;
  if (input.hook_event_name === "PostToolUse") status = "exit 0";
  else if (input.hook_event_name === "PostToolUseFailure") {
    const code = typeof input.error === "string" ? /^\s*Exit code (\d{1,3})\b/.exec(input.error)?.[1] : undefined;
    status = input.is_interrupt === true ? "interrupted" : code !== undefined ? `exit ${code}` : "failed";
  } else return null;
  // Only the start is masked and redacted, which bounds the cost; it is far longer than the part
  // kept, so a secret the cut runs through is still whole when redaction sees it.
  const shown = withoutHeredocBodies(command.replace(/\\\r?\n/g, ""))
    .join("\n")
    .slice(0, COMMAND_REDACTED_CHARS)
    .split("\n")
    .map((line) => redact(maskCommandSecrets(line), env).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ⏎ ");
  return { command: clip(shown, COMMAND_SHOWN_CHARS), status };
}

/** A heredoc's start with its delimiter, quoted, escaped or bare (`<<EOF`, `<<-'END-OF'`, `<<\EOF`); not a here-string, `<<<`. */
const ANY_HEREDOC_START = /(?<!<)<<(?!<)-?\s*\\?(['"]?)([^\s'"<>;&|()]+)\1/g;

/**
 * The lines of a shell command without the bodies of its heredocs (`cat > a.ts <<'E'` … `E`): text
 * fed to a command on stdin, often a whole file, is not a command, and the commands after it are
 * what a reader needs.
 */
function withoutHeredocBodies(command) {
  const kept = [];
  const pending = [];
  for (const line of command.split(/\r?\n/)) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    for (const [, , delimiter] of line.matchAll(ANY_HEREDOC_START)) pending.push(delimiter);
  }
  return kept;
}

/** One shell word: double-quoted, single-quoted or bare. */
const SHELL_WORD = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)`;
/** The value of an option named for a secret: `--password x`, `--token=x`, `--api-key x`, `-b x` is not one. */
const SECRET_OPTION = new RegExp(
  String.raw`(--?[A-Za-z0-9-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api-?key|auth|cred(?:ential)?s?|body|private-?key)[A-Za-z0-9-]*)(=|\s+)${SHELL_WORD}`,
  "gi",
);
/** A here-string's text, `<<< 'value'`. */
const HERE_STRING = new RegExp(String.raw`<<<\s*${SHELL_WORD}`, "g");
/** The password half of `user:password` given to `-u`, `--user` or `--proxy-user` (curl, wget). */
const USER_PASSWORD = new RegExp(
  String.raw`((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:=|\s+)['"]?[^:\s'"]*:)[^\s'"]+`,
  "g",
);
/** What `echo` or `printf` writes into a pipe or a file: often a password for `sudo -S`, `--password-stdin` or `~/.pgpass`. */
const ECHO_INTO_PIPE = /\b(echo|printf)\s+[^|;&>\n]+?(\s*(?:\||>))/g;
/** Tools that take a password as `-p value` or `-pvalue`, and redis-cli's `-a value`. */
const PASSWORD_FLAG_TOOLS = /\b(?:mysql|mysqldump|mysqladmin|mariadb|sshpass|login)\b/;
const REDIS_PASSWORD = new RegExp(String.raw`(\bredis-cli\b.*?(?:^|\s)-a)(\s*)${SHELL_WORD}`, "g");

/**
 * `line` with the secrets a shell command commonly carries replaced by `[redacted]`, before the
 * general redaction runs: option values named for a secret, here-strings, the password in
 * `user:password`, what `echo` pipes into the next command, `-p` passwords of the tools that take
 * one, the values a `secret set` command is given, and `htpasswd -b`'s password. Best-effort, like redaction itself: it over-redacts rather than
 * guess (an `echo` into `grep` or a file loses its text too).
 * @param {string} line
 */
export function maskCommandSecrets(line) {
  let out = line
    .replace(HERE_STRING, "<<< [redacted]")
    .replace(SECRET_OPTION, (whole, option, gap) =>
      /-(?:stdin|file)$/i.test(option) || whole.endsWith("<<<") ? whole : `${option}${gap}[redacted]`,
    )
    .replace(USER_PASSWORD, "$1[redacted]")
    .replace(ECHO_INTO_PIPE, "$1 [redacted]$2");
  out = out.replace(REDIS_PASSWORD, "$1$2[redacted]");
  if (PASSWORD_FLAG_TOOLS.test(out))
    out = out.replace(new RegExp(String.raw`((?:^|\s)-[pP])(\s*)${SHELL_WORD}`, "g"), "$1$2[redacted]");
  // `gh secret set NAME -b value`, `fly secrets set NAME=value`: every value there is a secret.
  if (/\bsecrets?\s+set\b/.test(out)) {
    out = out
      .replace(new RegExp(String.raw`((?:^|\s)-b)(\s*)${SHELL_WORD}`, "g"), "$1$2[redacted]")
      .replace(new RegExp(String.raw`(\s[A-Za-z_][A-Za-z0-9_]*=)${SHELL_WORD}`, "g"), "$1[redacted]");
  }
  if (/\bhtpasswd\b/.test(out) && /\s-[a-zA-Z]*b/.test(out))
    out = out.replace(new RegExp(String.raw`\s${SHELL_WORD}\s*$`), " [redacted]");
  return out;
}

/**
 * The file a finished tool call's edit tool wrote, as the state keeps it: from the repository
 * root when it is inside it, otherwise the path with the home directory as `~`, redacted. Null
 * when the call edits no file.
 * @param {Record<string, any>} input
 * @param {string} cwd
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 */
export function editedFileOf(input, cwd, root, env) {
  if (input?.hook_event_name !== "PostToolUse") return null;
  const field = Object.hasOwn(EDIT_TOOL_FIELDS, input.tool_name) ? EDIT_TOOL_FIELDS[input.tool_name] : undefined;
  const path = field ? input.tool_input?.[field] : undefined;
  if (typeof path !== "string" || path.trim() === "") return null;
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const shown =
    pathInRoot(root, absolute) ?? (within(homedir(), absolute) ? `~${absolute.slice(homedir().length)}` : absolute);
  return redact(shown, env);
}

/**
 * The test command as the fact shows it, at most TEST_LINE_MAX_CHARS characters. A longer one
 * is kept from the start of the line that runs the tests, marked with a leading ellipsis: an
 * agent that edits files with a heredoc and then runs the suite in one call would otherwise be
 * shown its heredoc and never the runner. `command` is already redacted.
 */
export function testCommandShown(command) {
  if (command.length <= TEST_LINE_MAX_CHARS) return command;
  const runnerLine = runnerCommandOf(command);
  const at = runnerLine === undefined ? -1 : command.lastIndexOf(runnerLine);
  const lineStart = at === -1 ? 0 : command.lastIndexOf("\n", at) + 1;
  return lineStart > 0 ? clip(`…${command.slice(lineStart)}`, TEST_LINE_MAX_CHARS) : clip(command, TEST_LINE_MAX_CHARS);
}

/** The fact's name: one per task and session, so each write replaces that session's last. */
export function sessionStateName(task, sessionId) {
  return `Session state: ${task ?? "no task named"}, session ${sessionId.slice(0, 8)}`;
}

/**
 * The fact's text. Every part is already redacted; only the last message is cut here.
 *
 * What the session's last test run showed comes in lines of its own, ahead of the command, so
 * nothing the agent wrote can stand in for them: the run's result and when it happened, the test
 * files the session had edited before it, which of those the command named (only when it had
 * edited some), which of those already existed when the session started (a test it wrote
 * itself is not one it rewrote, whatever the run named: a named test loads fixtures, mocks and
 * setup files, and a removed test is one it no longer runs), the test files it edited after the run, and
 * any test paths the run reached that the capture cannot see into. With no recognised run, the
 * test files the session had edited by the capture. A list is "not known" when git could not
 * say, or when the run was recorded by a hook from before these lines existed. The server reads
 * these lines back (services/memory/session-state.ts), so their wording is a format: change it
 * there too.
 *
 * `testFiles` are the test files among `files`, classified before redaction; when absent they
 * are read from `files`. `testFilesAfterRun` are the test files edited after the run; absent or
 * null when not known.
 * `functions` are the functions git names over the session's changed hunks ({@link functionsTouched});
 * the line is written only when git named some, so a capture with none, or one git could not read,
 * costs a reader nothing.
 * `edited` are the files the agent's edit tools wrote ({@link editedFileOf}) and `commands` the
 * shell commands it ran with their exit status ({@link commandRecordOf}), each already redacted;
 * each line is written only when there is something in it, and on one line, so nothing the agent
 * wrote opens a line the server reads.
 * @param {{ trigger: string, task?: string, files: string[] | null, edited?: string[], functions?: string[] | null, testFiles?: string[] | null, testFilesAfterRun?: string[] | null, test?: { command: string, passed: boolean, line: string, at?: string, edited?: ReturnType<typeof editedTestsOf>, existing?: string[] | null, unseen?: string[] }, commands?: { command: string, status: string }[], lastMessage?: string }} state
 */
export function renderSessionState({
  trigger,
  task,
  files,
  edited: editedFiles,
  functions,
  testFiles,
  testFilesAfterRun,
  test,
  commands,
  lastMessage,
}) {
  const message = lastMessage?.replace(/\s+/g, " ").trim();
  const edited = test?.edited ?? null;
  const testFilesNow = testFiles !== undefined ? testFiles : files && files.filter(isTestFile);
  const result = test ? (test.passed ? "passed" : "failed") : null;
  const list = (items) => filesLine(items ?? null, MAX_TEST_FILES_SHOWN, TEST_FILES_MAX_CHARS);
  return [
    `Session state captured automatically by the Willder hook at ${trigger}; not written on purpose by the agent, and may be incomplete.`,
    `Task: ${task ?? "none named"}`,
    `Files changed since the session started: ${filesLine(files)}`,
    ...(Array.isArray(editedFiles) && editedFiles.length > 0
      ? [`Files the agent's edit tools wrote: ${oneLine(filesLine(editedFiles, EDITED_KEPT, EDITED_MAX_CHARS))}`]
      : []),
    ...(Array.isArray(functions) && functions.length > 0
      ? [`Functions touched since the session started: ${functionsLine(functions)}`]
      : []),
    ...(test
      ? [
          `Last test run: ${result}${test.at ? ` at ${test.at}` : ""}`,
          `Test files this session had edited before that run: ${list(edited?.files)}`,
          ...(edited && edited.files.length > 0
            ? [
                `Of those, the last test command named: ${Array.isArray(edited.named) ? list(edited.named) : edited.named}`,
                `Of those, these existed when the session started: ${list(test.existing)}`,
              ]
            : []),
          `Test files this session edited after that run: ${list(testFilesAfterRun)}`,
          ...(test.unseen?.length
            ? [`Test paths that run reached which this capture cannot see into: ${list(test.unseen)}`]
            : []),
        ]
      : [
          `Last test run: ${NO_RUN_RECOGNISED}`,
          `Test files this session had edited by this capture: ${list(testFilesNow)}`,
        ]),
    ...(Array.isArray(commands) && commands.length > 0
      ? [`Shell commands run, oldest first, with exit status: ${commandsLine(commands)}`]
      : []),
    `Last test command: ${test ? `${test.command} -> ${result} (${test.line})` : NO_RUN_RECOGNISED}`,
    `Agent's last message: ${message ? clip(message, LAST_MESSAGE_MAX_CHARS) : "none recorded"}`,
  ].join("\n");
}

/**
 * The fact's text within MAX_CONTENT_CHARS, as `{ content, body }`, where `body` is everything after
 * its opening line. When it is too long, the oldest commands and then the oldest edited files are
 * left out first, so the two lists never push out the test lines or the agent's message; then the
 * opening and the body are each cut to a fixed length, so the same state cuts the same way whatever
 * triggered the write, and its body says whether anything changed.
 * @param {Parameters<typeof renderSessionState>[0]} state
 */
export function fittedSessionState(state) {
  let edited = state.edited ?? [];
  let commands = state.commands ?? [];
  for (;;) {
    const text = renderSessionState({ ...state, edited, commands });
    const cut = text.indexOf("\n");
    const body = text.slice(cut + 1);
    if (body.length <= BODY_MAX_CHARS || (edited.length === 0 && commands.length === 0)) {
      const kept = clip(body, BODY_MAX_CHARS);
      return { content: `${clip(text.slice(0, cut), OPENING_MAX_CHARS)}\n${kept}`, body: kept };
    }
    if (commands.length > 0) commands = commands.slice(1);
    else edited = edited.slice(1);
  }
}

/** `text` on one line: line breaks read as spaces. */
const oneLine = (text) => text.replace(/[\r\n\u2028\u2029]+/g, " ");

/** The commands line's value: `<command> (exit 0)` each, `; ` between, the latest kept when it is cut. */
function commandsLine(commands) {
  const shown = [];
  let length = 0;
  for (const { command, status } of [...commands].reverse()) {
    const item = `${oneLine(command)} (${status})`;
    if (length + item.length + 2 > COMMANDS_MAX_CHARS) break;
    shown.unshift(item);
    length += item.length + 2;
  }
  const rest = commands.length - shown.length;
  return `${rest > 0 ? `(${rest} earlier not shown) ` : ""}${shown.join("; ")}`;
}

/** The functions line's value: each name once, `; ` between, cut like the files line. */
function functionsLine(functions) {
  const shown = [];
  let length = 0;
  for (const name of functions) {
    if (shown.length === MAX_FUNCTIONS_SHOWN || length + name.length + 2 > FUNCTIONS_MAX_CHARS) break;
    shown.push(name);
    length += name.length + 2;
  }
  const rest = functions.length - shown.length;
  return `${shown.join("; ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * The functions the session's changes touch, as git names them in each hunk header of the diff
 * from the commit the session started on to the working tree (`@@ -12,3 +12,4 @@ function name(`),
 * each once, in the order git lists them, each redacted with `redactName` and then cut to
 * FUNCTION_NAME_MAX_CHARS. Read from git, never
 * guessed; null when git cannot say (no start commit, a diff past git's output bound, no time left).
 * Untracked files have no hunks, so they name no function.
 */
function functionsTouched(git, root, startCommit, redactName) {
  if (!startCommit) return null;
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", startCommit, "--"]);
  if (diff === null) return null;
  const names = [];
  for (const line of diff.split("\n")) {
    const header = /^@@ [^@\n]*@@ ?(.*)$/.exec(line);
    // Redacted whole, then cut: a secret the cut ran through would no longer match redaction.
    const name = header ? clip(redactName(header[1].trim()), FUNCTION_NAME_MAX_CHARS) : "";
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function filesLine(files, maxShown = MAX_FILES_SHOWN, maxChars = FILES_MAX_CHARS) {
  if (files === null) return "not known";
  if (files.length === 0) return "none";
  const shown = [];
  let length = 0;
  for (const file of files) {
    if (shown.length === maxShown || length + file.length + 2 > maxChars) break;
    shown.push(file);
    length += file.length + 2;
  }
  const rest = files.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/** `text` cut to `max` characters with an ellipsis, never between the halves of a surrogate pair. */
function clip(text, max) {
  if (text.length <= max) return text;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** `value` when it is a non-blank string of printable ASCII (it travels in a header), else undefined. */
export function printable(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^[\x20-\x7e]+$/.test(text) ? text : undefined;
}

/** Run git in `cwd` for at most `timeoutMs`; its stdout, or null when it fails, runs out of time or is not there. */
function runGit(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    // Non-ASCII names as they are, not octal-escaped, so a test file named in the command
    // matches; a name with a quote, backslash or control character is still quoted.
    return execFileSync("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The untracked files in `cwd`, or [] when git cannot say. */
function untrackedFiles(git, cwd) {
  const listed = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return listed === null
    ? null
    : listed
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/** A short digest of a file name, so the state file remembers names without holding them. */
const nameDigest = (name) => digest(name).slice(0, 16);

/**
 * A file's size and its modification and change times to the nanosecond the file system keeps,
 * which a rewrite changes; "" when it cannot be read. No content is read, so a large untracked
 * file costs one stat.
 */
function fileStamp(root, file) {
  try {
    const stat = statSync(join(root, file), { bigint: true });
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return "";
  }
}

/**
 * The untracked files at the session's start, as the state file keeps them: each name's digest
 * with its stamp ({@link fileStamp}), so a file that was already untracked and is rewritten later
 * still counts as changed, while the file keeps no name.
 */
function untrackedAtStart(git, root) {
  const files = untrackedFiles(git, root);
  return files === null
    ? null
    : Object.fromEntries(files.slice(0, MAX_START_UNTRACKED).map((file) => [nameDigest(file), fileStamp(root, file)]));
}

/**
 * The whole seconds before `at` (epoch ms): what a time kept to the second, as git's reflog and
 * some file systems keep it, must be below to be known to come before `at`.
 */
const wholeSecondsBefore = (at) => Math.floor(at / 1000);

/**
 * The commit HEAD was on at `at` (epoch ms), from HEAD's reflog: the newest entry made in a
 * whole second before the one `at` falls in. An entry in that same second may be after `at`, so
 * it is passed over for the one before it, which can only move the answer earlier. Null when
 * git cannot say, HEAD has no reflog, or no entry is that old (a repository cloned or a reflog
 * expired since).
 */
function headAt(git, root, at) {
  const listed = git(root, [
    "reflog",
    "show",
    "--format=%H %gd",
    "--date=unix",
    "-n",
    String(MAX_REFLOG_ENTRIES),
    "HEAD",
  ]);
  if (listed === null) return null;
  for (const line of listed.split("\n")) {
    const entry = /^([0-9a-f]{40,64}) \S*@\{(\d+)\}$/.exec(line.trim());
    if (!entry) continue;
    // A git that ignored --date gives the entry's position (HEAD@{0}), not its time: no answer.
    if (Number(entry[2]) < UNIX_TIME_FLOOR) return null;
    if (Number(entry[2]) < wholeSecondsBefore(at)) return entry[1];
  }
  return null;
}

/** A file's change time in nanoseconds, or null when it cannot be read. */
function changeTimeNs(root, file) {
  try {
    return statSync(join(root, file), { bigint: true }).ctimeNs;
  } catch {
    return null;
  }
}

/**
 * The untracked files at `at` (epoch ms), as {@link untrackedAtStart} keeps them, read later:
 * the files untracked now whose change time is in a whole second before `at`'s, so not written,
 * renamed or re-permissioned since. A file changed in that second or after is left out, so it
 * reads as the session's: the baseline can only move earlier. A file untracked at `at` and
 * deleted since is not in the list, which changes nothing: only files present are compared.
 */
function untrackedAt(git, root, at) {
  const files = untrackedFiles(git, root);
  if (files === null) return null;
  const before = BigInt(wholeSecondsBefore(at)) * 1_000_000_000n;
  const unchanged = files.filter((file) => {
    const changed = changeTimeNs(root, file);
    return changed !== null && changed < before;
  });
  return Object.fromEntries(
    unchanged.slice(0, MAX_START_UNTRACKED).map((file) => [nameDigest(file), fileStamp(root, file)]),
  );
}

/**
 * Record the parts of the session's baseline its first event could not (git too slow or not
 * answering), as they stood when the session started, never later: the start commit from
 * HEAD's reflog, and the untracked files from their change times. A state from before
 * `startedAt` was kept cannot be dated and stays as it is. Returns whether a part was recorded.
 */
function recoverBaseline(git, root, state) {
  if (typeof state.startedAt !== "number") return false;
  let recorded = false;
  if (!state.startCommit) {
    state.startCommit = headAt(git, root, state.startedAt);
    recorded ||= state.startCommit !== null;
  }
  if (state.startUntracked === null) {
    state.startUntracked = untrackedAt(git, root, state.startedAt);
    // Files changed since the start are left out though some existed then: which did is not known.
    state.startUntrackedPartial = state.startUntracked !== null;
    recorded ||= state.startUntracked !== null;
  }
  return recorded;
}

/**
 * What the session has changed in `root` since `startCommit`: files changed, committed or not,
 * renamed files under both names (so a test moved to a name that does not look like one is still
 * seen), and untracked files that were not untracked when the session started or have changed
 * since (`startUntracked`); null when git cannot say. `nested` are the nested repositories git
 * lists as one untracked directory each, whose insides the capture cannot see. A state file from
 * before stamps were kept holds a list of digests, read as unchanged.
 * @returns {{ files: string[], nested: string[] } | null}
 */
function changesSince(git, root, startCommit, startUntracked) {
  // Without the files untracked at the start, an old untracked file would read as the session's.
  if (!startCommit || startUntracked === null) return null;
  const diff = git(root, ["diff", "--name-only", "--no-renames", startCommit]);
  if (diff === null) return null;
  const tracked = diff
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stamps = Array.isArray(startUntracked)
    ? Object.fromEntries(startUntracked.map((name) => [name, null]))
    : (startUntracked ?? {});
  const present = untrackedFiles(git, root);
  if (present === null) return null;
  const nested = present.filter((file) => file.endsWith("/"));
  const untracked = present.filter((file) => {
    if (file.endsWith("/")) return false;
    const stamp = stamps[nameDigest(file)];
    return stamp === undefined || (stamp !== null && stamp !== fileStamp(root, file));
  });
  return { files: [...new Set([...tracked, ...untracked])], nested };
}

/** The stamps of the test files among `files`, keyed by name digest, as a test run leaves them; null when there are too many to keep. */
function testStampsOf(root, files) {
  const tests = files.filter(isTestFile);
  if (tests.length > MAX_STAMPED_FILES) return null;
  return Object.fromEntries(tests.map((file) => [nameDigest(file), fileStamp(root, file)]));
}

/**
 * The test files the session changed after a test run that left `stamps` ({@link testStampsOf}):
 * changed now, with another stamp than at the run or none. Null when either side is not known.
 */
function testEditsAfterRun(root, changes, stamps) {
  if (!stamps || !changes) return null;
  return changes.files.filter((file) => isTestFile(file) && stamps[nameDigest(file)] !== fileStamp(root, file));
}

/** `path` as a pathspec git reads literally, so a name like `:odd.test.ts` or `[a].test.ts` is itself. */
const literalPath = (path) => `:(literal)${path}`;

/** Which of `files` (relative to `root`) `commit` holds, asked in bounded batches; null when git cannot say. */
function filesAt(git, root, commit, files) {
  const held = new Set();
  for (let at = 0; at < files.length; at += EXISTENCE_CHECKS_PER_CALL) {
    const listed = git(root, [
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      "--",
      ...files.slice(at, at + EXISTENCE_CHECKS_PER_CALL).map(literalPath),
    ]);
    if (listed === null) return null;
    for (const line of listed.split("\n")) if (line.trim()) held.add(line.trim());
  }
  return held;
}

/**
 * Which of `files` (relative to `root`) existed when the session started: tracked at its start
 * commit, or untracked then. Judged by path, so a test deleted and written again under the same
 * path existed, and so did a test moved away from it.
 *
 * An empty list says the session wrote them all. That is said only when nothing else can have
 * brought them: HEAD has not moved to a commit that holds one (a checkout, a pull, or the
 * session's own commit), and git does not ignore one (the start never recorded those). Null when
 * it cannot be said: git cannot answer, there are too many, or none is known to have existed
 * while some cannot be looked up (a path outside the repository, a name git quotes, an untracked
 * list cut short or recovered after the start, {@link untrackedAt}).
 */
function existedAtStart(git, root, startCommit, startUntracked, startUntrackedPartial, files) {
  if (!startCommit || files.length > MAX_EXISTENCE_CHECKS) return null;
  // A name git quotes (a quote, backslash or control character in it) is not the file's name.
  const askable = files.filter((file) => !file.startsWith("../") && !file.startsWith("/") && !file.startsWith('"'));
  const atStart = filesAt(git, root, startCommit, askable);
  if (atStart === null) return null;
  const untracked = new Set(Array.isArray(startUntracked) ? startUntracked : Object.keys(startUntracked ?? {}));
  const existing = askable.filter((file) => atStart.has(file) || untracked.has(nameDigest(file)));
  if (existing.length > 0) return existing;
  if (
    startUntracked === null ||
    startUntrackedPartial ||
    askable.length < files.length ||
    untracked.size >= MAX_START_UNTRACKED
  )
    return null;
  if (askable.length === 0) return [];
  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  const atHead = !head ? null : head === startCommit ? new Set() : filesAt(git, root, head, askable);
  if (atHead === null || askable.some((file) => atHead.has(file))) return null;
  const ignored = git(root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ...askable.map(literalPath),
  ]);
  return ignored === null || ignored.trim() !== "" ? null : [];
}

/** Whether `path` is `dir` or inside it. */
const within = (dir, path) => path === dir || path.startsWith(`${dir}/`);

/** `path` with its symlinks resolved, or its directory's for a file not there (yet); null when neither resolves. */
function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return null;
    }
  }
}

/**
 * Absolute `path` relative to `root`, through symlinks on either side (macOS's `/var` is
 * `/private/var`), or null when it is outside.
 */
export function pathInRoot(root, path) {
  if (within(root, path)) return relative(root, path);
  const realRoot = realPathOf(root);
  const realPath = realPathOf(path);
  return realRoot && realPath && within(realRoot, realPath) ? relative(realRoot, realPath) : null;
}

/**
 * The test paths and directories a run reached that this capture cannot see into, as the
 * command wrote them: a directory or path outside the repository (`cd ../b && npm test`,
 * `npm --prefix ../b test`, `vitest --root /x`, `pytest /x/tests`), or inside a submodule, a
 * nested repository or a directory git ignores. A run there is about tests the capture's lists
 * do not cover. At most a few paths are asked of git, so the check stays bounded.
 * @param {string} command
 * @param {string} cwd the session's directory as the hook was told it
 * @param {string} root the repository root
 * @param {(cwd: string, args: string[]) => string | null} git
 * @param {string[]} nested nested repositories, relative to `root`, ending in `/`
 */
function unseenTestPaths(command, cwd, root, git, nested) {
  const hidden = [...submodulePaths(root), ...nested.map((dir) => dir.replace(/\/+$/, ""))];
  const unseen = [];
  let asked = 0;
  let dir = cwd;
  let dirShown = null;
  for (const part of shellCommands(command)) {
    const cd = /^(?:cd|pushd)\s+(['"]?)(.+?)\1$/.exec(part);
    if (cd) {
      dir = resolve(dir, cd[2].replace(/^~(?=\/|$)/, homedir()));
      dirShown = cd[2];
      continue;
    }
    if (!runsTests(part)) continue;
    const words = part.split(WORD_SEPARATOR).filter((word) => /[/~$]/.test(word) && !word.startsWith("-"));
    const places = [
      { shown: dirShown, path: dir },
      ...words.map((word) => ({
        shown: word,
        path: resolve(dir, word.replace(/^\$PWD(?=\/|$)/, dir).replace(/^~(?=\/|$)/, homedir())),
      })),
    ];
    for (const { shown, path } of places) {
      if (shown === null) continue;
      const inRoot = pathInRoot(root, path);
      const outside =
        inRoot === null || hidden.some((hiddenDir) => inRoot === hiddenDir || inRoot.startsWith(`${hiddenDir}/`));
      const ignored =
        !outside &&
        asked < MAX_IGNORE_CHECKS &&
        (asked++, git(root, ["check-ignore", "-q", "--", inRoot || "."]) !== null);
      if ((outside || ignored) && !unseen.includes(shown)) unseen.push(shown);
    }
  }
  return unseen;
}

/** The submodule paths `.gitmodules` in `root` declares, or none. */
function submodulePaths(root) {
  try {
    return [...readFileSync(join(root, ".gitmodules"), "utf8").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(
      ([, path]) => path,
    );
  } catch {
    return [];
  }
}

/**
 * The repository a session works in: git's top level for `cwd`, or `cwd` itself outside a
 * repository. The session's state is kept per repository, not per directory, so a `cd` into a
 * package does not start it afresh at whatever commit is checked out then.
 */
export function repositoryRoot(cwd) {
  // Found by walking up to a `.git` entry (a directory, or a file in a worktree or submodule),
  // not by asking git: one process less on every hook event.
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

const digest = (text) => createHash("sha256").update(text).digest("hex");

export function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    return state !== null && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

/**
 * Create the state directory if needed and say whether it is safe to use: a real directory,
 * not a link, owned by this user and writable by no one else. On a shared temp directory
 * another user could otherwise create it first and read or plant state files.
 */
export function stateDirUsable(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    const ownedByMe = typeof process.getuid !== "function" || stat.uid === process.getuid();
    return stat.isDirectory() && ownedByMe && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Write the state file whole or not at all, readable by its owner only. */
export function saveState(path, state) {
  try {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch {
    // A lost state file costs one write that replaces nothing; it never stops the agent.
  }
}

/** Remove state files in `dir` not touched for STALE_STATE_MS: sessions that never reached SessionEnd. */
export function removeStaleState(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^[0-9a-f]{32}\.json/.test(name)) continue;
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > STALE_STATE_MS) rmSync(path, { force: true });
    }
  } catch {
    // Cleanup is best-effort; a file left behind holds no token and no secret.
  }
}

/**
 * The agent's last message as the fact keeps it: redacted, whitespace collapsed. Only the
 * first LAST_MESSAGE_MAX_CHARS + REDACT_MARGIN_CHARS characters are redacted, which bounds
 * the cost; when that window cut the message, its last REDACT_MARGIN_CHARS / 8 characters
 * after collapsing are dropped too, so the head of a secret the window cut through (which
 * redaction may not recognise) can never reach the part kept, however much whitespace the
 * window held.
 */
function redactedLastMessage(message, env) {
  const window = message.slice(0, LAST_MESSAGE_MAX_CHARS + REDACT_MARGIN_CHARS);
  const text = redact(window, env).replace(/\s+/g, " ").trim();
  if (window.length === message.length) return text;
  return text.slice(0, Math.max(0, text.length - REDACT_MARGIN_CHARS / 8));
}

/** Why this event writes, or null when it does not. */
function writeTrigger(event, state, run, now) {
  if (event === "Stop" || event === "PreCompact") return event;
  if (event === SNAPSHOT_EVENT)
    return `a snapshot after ${Number.isSafeInteger(state.calls) ? state.calls : 0} tool calls`;
  if (!run || !state.lastTest || state.lastTest.passed === run.passed) return null;
  if (typeof state.lastFlipWriteAt === "number" && now - state.lastFlipWriteAt < FLIP_WRITE_INTERVAL_MS) return null;
  return run.passed ? "a test run that passed after failing" : "a test run that failed after passing";
}

/**
 * Send one memory_ingest call. Returns the stored version, or that the token may not
 * write, or that the base version is no longer current, or why it failed otherwise, in words
 * of the hook's own (never the server's text, which the log must not hold).
 * @returns {Promise<{ versionId: string } | { denied: true } | { stale: true } | { failed: string }>}
 */
async function ingest(fetchImpl, mcpUrl, token, { name, content, baseVersion, task, sessionId, timeoutMs }) {
  try {
    const res = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(task ? { "x-willder-task": task } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_ingest",
          arguments: { name, content, role: "progress", ...(baseVersion ? { baseVersion } : {}) },
          _meta: {
            [CAPTURE_META_KEY]: CAPTURE_ENV_VALUE,
            "willder/session": sessionId,
            ...(task ? { "willder/task": task } : {}),
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { failed: `http ${res.status}` };
    const result = (await res.json())?.result;
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") return { failed: "a reply without text" };
    if (result.isError) {
      if (text.startsWith("Access denied")) return { denied: true };
      if (text.startsWith("stale_version") || text.startsWith("unknown_version")) return { stale: true };
      return { failed: "a tool error" };
    }
    const versionId = text.match(/\bVersion: (\S+?)\.(?:\s|$)/)?.[1];
    return versionId ? { versionId } : { failed: "a reply without a version" };
  } catch (error) {
    return { failed: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timed out" : "network error" };
  }
}

/**
 * What a state file keeps once its session ends: the version its last write stored, under which
 * task, that write's digest, and the session's last test run, all already redacted. Nothing else of
 * the session's state outlives it.
 */
function endedState(state) {
  return { ended: true, ...resumedFrom(state) };
}

/**
 * What a resumed session takes from its ended state: the fact its writes replace, and the last test
 * run its session saw, so a resumed process that runs no test does not replace that run with none.
 * Test edits after the run are then judged from the stamps the run left, against the files as they
 * stand.
 */
function resumedFrom(ended) {
  if (typeof ended.versionId !== "string") return {};
  return {
    versionId: ended.versionId,
    versionTask: ended.versionTask ?? null,
    ...(typeof ended.lastContentDigest === "string" ? { lastContentDigest: ended.lastContentDigest } : {}),
    ...(ended.lastTest && typeof ended.lastTest === "object" ? { lastTest: ended.lastTest } : {}),
  };
}

/** The file listing, as digests, the repositories a session has been seen in. */
function sessionIndexPath(stateDir, sessionId) {
  return join(stateDir, `${digest(`session\0${sessionId}`).slice(0, 32)}.json`);
}

/**
 * Whether the session was already seen in a repository other than `root`, recording `root`
 * as seen. The index holds digests only; it is removed when the session ends and, like a state
 * file, a week after a session that never ended.
 */
function seenOtherRepository(stateDir, sessionId, root) {
  const path = sessionIndexPath(stateDir, sessionId);
  const roots = readState(path)?.roots;
  const seen = Array.isArray(roots) ? roots : [];
  const here = nameDigest(root);
  if (!seen.includes(here)) saveState(path, { roots: [...seen, here] });
  return seen.some((other) => other !== here);
}

/** The lock file beside a state file; the stale-state sweep removes it with its state file. */
const lockPathOf = (statePath) => `${statePath}.lock`;
/** The marker of a Stop or PreCompact write handed to the snapshot process and not yet done. */
const queuedPathOf = (statePath) => `${statePath}.queued`;

/** Whether a lock or marker file is there and newer than LOCK_STALE_MS, so its owner is still at work. */
function held(path) {
  try {
    return Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Take the lock if no one holds it, or take over one left by a process that died; true when this process holds it. */
function tryLock(path) {
  const take = () => {
    try {
      writeFileSync(path, String(process.pid), { mode: 0o600, flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (take()) return true;
  try {
    if (Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return false;
    rmSync(path, { force: true });
  } catch {
    return false;
  }
  return take();
}

/** Take the lock, waiting up to `waitMs` for a write in progress to finish; true when this process holds it. */
async function takeLock(path, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    if (tryLock(path)) return true;
    if (Date.now() >= until) return false;
    await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
  }
}

/**
 * Save the state of an event that wrote nothing, keeping what a write stored meanwhile: another
 * hook process may have written while this one ran, and the version it stored must not be lost.
 */
function saveKeepingWrites(path, state) {
  const disk = readState(path);
  if (disk && !disk.ended) copyWriteFields(disk, state);
  saveState(path, state);
}

/** Append one line to the snapshot log, owner-only, moving a full log aside first. Never throws. */
function logSnapshot(stateDir, sessionId, now, what) {
  try {
    const path = join(stateDir, SNAPSHOT_LOG);
    try {
      if (statSync(path).size > SNAPSHOT_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${new Date(now).toISOString()} session ${sessionId.slice(0, 8)} ${what}\n`, { mode: 0o600 });
  } catch {
    // The log is for the person; losing a line never stops the agent.
  }
}

/**
 * Start the process that writes a snapshot, detached, so the hook that started it returns at once.
 * It is this file run by node, handed only what it needs to find the session (its id, directory,
 * transcript and state directory) and the MCP endpoint in SNAPSHOT_INPUT_ENV; the token stays in
 * the environment it inherits, never in its arguments.
 * @param {Record<string, any>} input
 * @param {Record<string, string | undefined>} env
 * @param {{ mcpUrl: URL, stateDir: string }} where
 */
export function startSnapshotProcess(input, env, { mcpUrl, stateDir }) {
  const payload = {
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    deferred: input.deferred,
    mcp_url: String(mcpUrl),
    state_dir: stateDir,
  };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env, [SNAPSHOT_INPUT_ENV]: JSON.stringify(payload) },
  });
  child.on("error", () => {});
  child.unref();
}

/** Where the per-session state files live. */
export function defaultStateDir() {
  return join(tmpdir(), "willder-capture");
}

/** The state file of one session in one repository. */
function statePathOf(stateDir, root, sessionId) {
  return join(stateDir, `${digest(`${root}\0${sessionId}`).slice(0, 32)}.json`);
}

/**
 * The git runner one event uses. Every git call the event makes shares one budget, and the write
 * must end before the hook's limit, both timed on the real clock from the event's start;
 * `restart` starts both again (the snapshot process, once it may write).
 * @param {(cwd: string, args: string[], timeoutMs: number) => string | null} runGitIn
 * @param {number} budgetMs
 */
function eventClock(runGitIn, budgetMs) {
  let startedAt = Date.now();
  let deadline = startedAt + budgetMs;
  return {
    git: (cwd, args) => {
      const left = deadline - Date.now();
      return left > 0 ? runGitIn(cwd, args, Math.min(GIT_TIMEOUT_MS, left)) : null;
    },
    startedAt: () => startedAt,
    restart: (ms) => {
      startedAt = Date.now();
      deadline = startedAt + ms;
    },
  };
}

/**
 * SessionEnd: cut the state file down to what a resumed session needs ({@link endedState}), or
 * remove it when no write stored a version, and remove the session's repository index. A write in
 * progress, or handed off by Stop, saves into the state this cuts down, so it waits for both first.
 */
async function endSession(stateDir, sessionId, statePath) {
  const until = Date.now() + SESSION_END_WAIT_MS;
  while ((held(lockPathOf(statePath)) || held(queuedPathOf(statePath))) && Date.now() < until)
    await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
  const ended = readState(statePath);
  rmSync(sessionIndexPath(stateDir, sessionId), { force: true });
  if (ended && !ended.ended && typeof ended.versionId === "string") saveState(statePath, endedState(ended));
  else if (!ended?.ended) rmSync(statePath, { force: true });
}

/**
 * The state of a session first seen in this repository, or resumed after it ended: the commit it
 * starts from and the files already untracked then. A repository first seen after the session
 * began elsewhere, or a session resumed after it ended, has its earlier changes in that baseline,
 * so its test edits cannot be known, nor which tests existed when it started (`lateStart`).
 * @param {Record<string, any> | null} read the state file as read, an ended one for a resumed session
 */
function freshState(git, root, { input, stateDir, sessionId, now }, read) {
  return {
    startedAt: now,
    startCommit: git(root, ["rev-parse", "HEAD"])?.trim() || null,
    startUntracked: untrackedAtStart(git, root),
    lateStart: seenOtherRepository(stateDir, sessionId, root) || transcriptShowsEarlierWork(input.transcript_path),
    ...(read?.ended ? resumedFrom(read) : {}),
  };
}

/**
 * Record what a finished tool call did, as the fact reports it: its command and exit status, the
 * file it edited, and, for the session's own calls (not a subagent's), one more toward the next
 * snapshot. `recorded` says whether the state changed.
 * @returns {{ ownCall: boolean, recorded: boolean }}
 */
function recordToolCall(state, input, env, cwd, root) {
  const toolCall = input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure";
  const ownCall = toolCall && input.agent_id === undefined;
  if (!toolCall) return { ownCall, recorded: false };
  const ran = commandRecordOf(input, env);
  if (ran) state.commands = [...(Array.isArray(state.commands) ? state.commands : []), ran].slice(-COMMANDS_KEPT);
  const file = editedFileOf(input, cwd, root, env);
  if (file)
    state.edited = [...(Array.isArray(state.edited) ? state.edited : []).filter((kept) => kept !== file), file].slice(
      -EDITED_KEPT,
    );
  if (ownCall) state.calls = (Number.isSafeInteger(state.calls) && state.calls > 0 ? state.calls : 0) + 1;
  return { ownCall, recorded: ran !== null || file !== null || ownCall };
}

/**
 * Record a test run as the session's last (`state.lastTest`), redacted: its command, result and
 * summary line, and which test files the session had edited by then, read when the run happened,
 * since a test the session edits after this run did not decide it.
 * @param {{ command: string, passed: boolean, line: string }} run from {@link testRunOf}
 */
function recordTestRun(state, run, { git, root, cwd, env, now }) {
  const changes = changesSince(git, root, state.startCommit, state.startUntracked);
  const inCall = testWritesAroundRun(run.command);
  // The call's own writes, named from its directory, as paths from the repository root like git's.
  const fromRoot = (path) => pathInRoot(root, resolve(cwd, path)) ?? path;
  const writtenBefore = inCall.before.map(fromRoot);
  // A repository first seen after the session began elsewhere: what the session changed in
  // it before that is in its baseline, so its edits are not known, nor what existed at the
  // session's start; what it changes after is.
  const seen = state.lateStart ? null : (changes?.files ?? null);
  const changedByRun =
    seen === null ? (writtenBefore.length > 0 ? writtenBefore : null) : [...new Set([...seen, ...writtenBefore])];
  const edited = editedTestsOf(run.command, changedByRun);
  const redactAll = (files) => files.map((file) => redact(file, env));
  state.lastTest = {
    command: testCommandShown(redact(run.command, env)),
    passed: run.passed,
    line: clip(redact(run.line, env), TEST_LINE_MAX_CHARS),
    at: new Date(now).toISOString(),
    edited: edited && {
      files: redactAll(edited.files),
      named: Array.isArray(edited.named) ? redactAll(edited.named) : edited.named,
    },
    existing:
      edited && edited.files.length > 0 && !state.lateStart
        ? (existedAtStart(
            git,
            root,
            state.startCommit,
            state.startUntracked,
            state.startUntrackedPartial === true,
            edited.files,
          )?.map((file) => redact(file, env)) ?? null)
        : null,
    unseen: redactAll(unseenTestPaths(run.command, cwd, root, git, changes?.nested ?? [])),
    editedAfterInCall: redactAll(inCall.after.map(fromRoot)),
    stamps: changes ? testStampsOf(root, changes.files) : null,
  };
}

/**
 * Whether this call makes a snapshot due: one of the session's own, WILLDER_SNAPSHOT_EVERY or
 * more of them since the last snapshot. A due snapshot is counted from here.
 */
function claimSnapshot(state, env, ownCall) {
  const every = snapshotEvery(env);
  const since = (state.calls ?? 0) - (Number.isSafeInteger(state.snapshotCalls) ? state.snapshotCalls : 0);
  const due = ownCall && every > 0 && since >= every;
  if (due) state.snapshotCalls = state.calls;
  return due;
}

/** Start the snapshot process for `input`, logging `failure` when it cannot be started. */
function startSnapshotOrLog({ env, mcpUrl, stateDir, sessionId, now, startSnapshot }, input, failure) {
  try {
    startSnapshot(input, env, { mcpUrl, stateDir });
  } catch {
    logSnapshot(stateDir, sessionId, now, failure);
  }
}

/**
 * A write that found another in progress: keep this event's state, and hand a Stop or PreCompact
 * write to a detached process that waits its turn, marked as queued so SessionEnd waits for it.
 * A test flip leaves its write to the next event.
 */
function handOffWrite(session, state, event) {
  const { input, env, mcpUrl, stateDir, statePath, sessionId, now, startSnapshot } = session;
  saveKeepingWrites(statePath, state);
  if (event !== "Stop" && event !== "PreCompact") return;
  try {
    writeFileSync(queuedPathOf(statePath), "", { mode: 0o600 });
    startSnapshot({ ...input, deferred: event }, env, { mcpUrl, stateDir });
  } catch {
    rmSync(queuedPathOf(statePath), { force: true });
    logSnapshot(stateDir, sessionId, now, `deferred ${event} write not started: the process could not be started`);
  }
}

/** Copy the fields a write stores (WRITE_FIELDS) from `from` onto `to`, removing those `from` lacks. */
function copyWriteFields(from, to) {
  for (const field of WRITE_FIELDS) {
    if (field in from) to[field] = from[field];
    else delete to[field];
  }
}

/**
 * Take into `state` what a write stored meanwhile, read afresh under the lock, so this one
 * replaces it. When the session ended meanwhile after a write stored a version, that version is
 * replaced, not added to.
 */
function mergeStoredWrites(statePath, state) {
  const disk = readState(statePath);
  if (disk && !disk.ended) {
    copyWriteFields(disk, state);
  } else if (disk?.ended && typeof disk.versionId === "string") {
    state.versionId = disk.versionId;
    state.versionTask = disk.versionTask ?? null;
    if (typeof disk.lastContentDigest === "string") state.lastContentDigest = disk.lastContentDigest;
  }
}

/**
 * The session-state fact as it stands, redacted and fitted ({@link fittedSessionState}): the
 * files changed since the session started, the functions they touched, the test files edited
 * before and after the last run, that run, the edit tools' files, the shell commands and the
 * agent's last message.
 * @returns {{ content: string, body: string }}
 */
function sessionStateFact(state, { git, root, input, env, trigger, storedTask }) {
  const message = lastAssistantMessage(input);
  const changes = changesSince(git, root, state.startCommit, state.startUntracked);
  const stamped = state.lastTest ? testEditsAfterRun(root, changes, state.lastTest.stamps) : null;
  const inCallAfter = state.lastTest?.editedAfterInCall ?? [];
  const after =
    stamped === null && inCallAfter.length === 0
      ? null
      : [...new Set([...(stamped ?? []).map((file) => redact(file, env)), ...inCallAfter])];
  return fittedSessionState({
    trigger,
    task: storedTask,
    files: changes?.files.map((file) => redact(file, env)) ?? null,
    functions: functionsTouched(git, root, state.startCommit, (name) => redact(name, env)),
    testFiles: state.lateStart ? null : (changes?.files.filter(isTestFile).map((file) => redact(file, env)) ?? null),
    testFilesAfterRun: after,
    test: state.lastTest,
    edited: Array.isArray(state.edited) ? state.edited : [],
    commands: Array.isArray(state.commands) ? state.commands : [],
    lastMessage: message && redactedLastMessage(message, env),
  });
}

/**
 * `target` with what one memory_ingest outcome changes: the version it stored (under which task,
 * with the written digest, and for a test flip when), that the token may not write, or that the
 * base version is gone.
 */
function recordOutcome(target, outcome, { task, contentDigest, trigger, snapshot, now }) {
  if ("versionId" in outcome) {
    target.versionId = outcome.versionId;
    target.versionTask = task ?? null;
    target.lastContentDigest = contentDigest;
    if (trigger !== "Stop" && trigger !== "PreCompact" && !snapshot) target.lastFlipWriteAt = now;
  } else if ("denied" in outcome) {
    target.denied = true;
  } else if ("stale" in outcome) {
    delete target.versionId;
  }
  return target;
}

/** One memory_ingest outcome as the snapshot log words it. */
function outcomeLogged(outcome) {
  if ("versionId" in outcome) return "stored";
  if ("denied" in outcome) return "refused: this token may not write";
  if ("stale" in outcome) return "not stored: its base version was replaced; the next write starts afresh";
  return `failed: ${outcome.failed}`;
}

/**
 * Write the session-state fact, holding the state file's lock, and save what the write changed.
 * The write is skipped when its text, apart from its first line (what triggered it), equals the
 * last one stored, or when no time is left before the hook's limit: the next event that writes
 * sends the state as it then stands.
 */
async function writeSessionState(session, state, { git, root, token, fetchImpl, trigger, snapshot, said, startedAt }) {
  const { input, env, mcpUrl, stateDir, statePath, sessionId, now } = session;
  const task = printable(env.WILLDER_TASK);
  // The fact's name and text get the redacted task. The raw task travels in the request
  // (`X-Willder-Task`, `_meta`), where the server scopes the write by it and records it as
  // the write's task (change_event.task), as for any MCP call that names a task.
  const storedTask = task && redact(task, env);
  const { content, body } = sessionStateFact(state, { git, root, input, env, trigger, storedTask });
  // The first line says only what triggered the write: a Stop after a snapshot that saw the same
  // state sends nothing.
  const contentDigest = digest(body);
  const writeTimeoutMs = Math.min(WRITE_TIMEOUT_MS, startedAt + WRITE_DEADLINE_MS - Date.now());
  if (contentDigest === state.lastContentDigest || writeTimeoutMs <= 0) {
    if (snapshot)
      logSnapshot(
        stateDir,
        sessionId,
        now,
        `${said} ${writeTimeoutMs <= 0 ? "not sent: no time left" : "not sent: nothing changed since the last write"}`,
      );
    else saveState(statePath, state);
    return;
  }

  const outcome = await ingest(fetchImpl, mcpUrl, token, {
    name: sessionStateName(storedTask, sessionId),
    content,
    // A version stored under another task names another fact; a session resumed under a
    // new task starts that task's fact fresh.
    baseVersion: state.versionTask === (task ?? null) ? state.versionId : undefined,
    task,
    sessionId,
    timeoutMs: writeTimeoutMs,
  });
  const record = (target) => recordOutcome(target, outcome, { task, contentDigest, trigger, snapshot, now });
  if (!snapshot) {
    saveState(statePath, record(state));
    return;
  }
  // Hook events kept recording while this process wrote: only what the write changed is saved
  // over them, into an ended state as an ended state. A state SessionEnd removed meanwhile (it
  // had stored no version) comes back only as the ended state of the version this stored.
  const latest = readState(statePath);
  if (latest === null) {
    if ("versionId" in outcome) saveState(statePath, endedState(record(state)));
  } else {
    saveState(statePath, latest.ended ? endedState(record(latest)) : record(latest));
  }
  logSnapshot(stateDir, sessionId, now, `${said} ${outcomeLogged(outcome)}`);
}

/**
 * Run capture for one hook event: record the session's start, its test results, its shell
 * commands, the files its edit tools wrote and its tool calls, and write the session-state fact when
 * the event calls for it. A snapshot that is due is handed to `startSnapshot`, which by default
 * starts the detached snapshot process ({@link startSnapshotProcess}); that process runs this with
 * SNAPSHOT_EVENT. Returns nothing and prints nothing: capture never adds to what the agent is told.
 * Never throws.
 * @param {Record<string, any>} input the hook input Claude Code sent on stdin
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, mcpUrl: URL | null, now?: number, stateDir?: string, git?: (cwd: string, args: string[], timeoutMs: number) => string | null, startSnapshot?: typeof startSnapshotProcess }} deps
 */
export async function captureSessionState(
  input,
  env,
  {
    fetchImpl = fetch,
    mcpUrl,
    now = Date.now(),
    stateDir = defaultStateDir(),
    git: runGitIn = runGit,
    startSnapshot = startSnapshotProcess,
  },
) {
  let lock = null;
  let queued = null;
  try {
    const clock = eventClock(
      runGitIn,
      input?.hook_event_name === "UserPromptSubmit" ? PROMPT_GIT_BUDGET_MS : GIT_BUDGET_MS,
    );
    const { git } = clock;
    const token = env.WILLDER_TOKEN?.trim();
    const sessionId = printable(input?.session_id);
    if (!captureEnabled(env) || !mcpUrl || !token || !sessionId) return;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (!stateDirUsable(stateDir)) return;
    const root = repositoryRoot(cwd);
    const statePath = statePathOf(stateDir, root, sessionId);
    if (input.hook_event_name === "SessionEnd") {
      await endSession(stateDir, sessionId, statePath);
      return;
    }
    const session = { input, env, mcpUrl, stateDir, statePath, sessionId, now, startSnapshot };
    const read = readState(statePath);
    // A session that ended and is now resumed: the baseline starts again, the fact stays its one.
    const known = read?.ended ? null : read;
    const event = input.hook_event_name;
    const snapshot = event === SNAPSHOT_EVENT;
    // A Stop or PreCompact write handed to the snapshot process because another write held the lock.
    const deferred = snapshot && (input.deferred === "Stop" || input.deferred === "PreCompact") ? input.deferred : null;
    const said = deferred ? `deferred ${deferred} write` : "snapshot";
    if (deferred) queued = queuedPathOf(statePath);
    // A snapshot of a session whose state is gone (it ended meanwhile) has nothing to add.
    if (snapshot && !known) {
      logSnapshot(stateDir, sessionId, now, `${said} not sent: the session had ended`);
      return;
    }
    if (!known) removeStaleState(stateDir, now);
    const state = known ?? freshState(git, root, session, read);
    if (state.denied) return;
    const recovered = known !== null && recoverBaseline(git, root, state);
    const { ownCall, recorded } = recordToolCall(state, input, env, cwd, root);

    const run = testRunOf(input);
    const trigger = deferred ?? writeTrigger(event, state, run, now);
    if (run) recordTestRun(state, run, { git, root, cwd, env, now });
    if (!trigger) {
      const due = claimSnapshot(state, env, ownCall);
      if (!known || run || recovered || recorded) saveKeepingWrites(statePath, state);
      if (due) startSnapshotOrLog(session, input, "snapshot not started: the process could not be started");
      return;
    }
    // Any write sends the state as it stands, so the next snapshot counts from here.
    if (!snapshot) state.snapshotCalls = state.calls ?? 0;

    // One write at a time per state file. A snapshot finding one in progress leaves it the work;
    // any other event hands its write off ({@link handOffWrite}).
    const lockPath = lockPathOf(statePath);
    if (await takeLock(lockPath, deferred ? LOCK_STALE_MS + 1000 : snapshot ? 0 : LOCK_WAIT_MS)) lock = lockPath;
    else {
      if (snapshot) logSnapshot(stateDir, sessionId, now, `${said} skipped: another write was in progress`);
      else handOffWrite(session, state, event);
      return;
    }
    // The snapshot process's time limits run from when it may write, not from its wait.
    if (snapshot) clock.restart(GIT_BUDGET_MS);
    mergeStoredWrites(statePath, state);
    if (state.denied) return;
    await writeSessionState(session, state, {
      git,
      root,
      token,
      fetchImpl,
      trigger,
      snapshot,
      said,
      startedAt: clock.startedAt(),
    });
  } catch {
    // Capture must never get in the agent's way.
  } finally {
    if (lock !== null) rmSync(lock, { force: true });
    if (queued !== null) rmSync(queued, { force: true });
  }
}

/**
 * The snapshot process ({@link startSnapshotProcess}): read what the hook handed over, and run
 * capture's snapshot write with it. Exits on its own well inside a minute, whatever the server does.
 */
async function snapshotMain() {
  setTimeout(() => process.exit(0), 2 * LOCK_STALE_MS).unref();
  let payload;
  try {
    payload = JSON.parse(process.env[SNAPSHOT_INPUT_ENV] ?? "");
  } catch {
    return;
  }
  let url;
  try {
    url = new URL(payload.mcp_url);
  } catch {
    return;
  }
  // The token rides in a header, so only to HTTPS or to this machine, as the hook itself sends it.
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return;
  if (typeof payload.state_dir !== "string" || payload.state_dir === "") return;
  const env = { ...process.env };
  delete env[SNAPSHOT_INPUT_ENV];
  const input = {
    hook_event_name: SNAPSHOT_EVENT,
    session_id: payload.session_id,
    cwd: payload.cwd,
    transcript_path: payload.transcript_path,
    deferred: payload.deferred,
  };
  await captureSessionState(input, env, { mcpUrl: url, stateDir: payload.state_dir });
}

// Run as the snapshot process only when executed with its input, never when imported.
if (
  process.env[SNAPSHOT_INPUT_ENV] &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  snapshotMain().catch(() => {});
}
