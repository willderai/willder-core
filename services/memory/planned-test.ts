// The test a plan says to run, read out of the plan's own text.
//
// A session that plans a task and hands it on often names the check that would prove the work: the
// test command, and the existing test files to extend. A short excerpt of the plan can cut them,
// and the next session then writes a weaker test of its own. The task-start block
// (mcp/task-start-notice.ts) serves what this file finds outside the excerpt, so no cut drops it.
//
// The one rule this file enforces: it reports only text the plan wrote, matched by fixed patterns,
// and nothing it infers. A command is a known test runner's invocation; a test file is a path with a
// test file's name. Text that names neither yields nothing, and the block says nothing.
//
// When a plan writes several commands (a verify list: the suite, the type check, a lint, a few
// directories), only the narrowest is said ({@link narrowestTestCommand}). In a paired study
// the agent that was served a five-command verify list ran all five and took 18 turns where the one
// without it took 10.
import { clip } from "./relevance";

/**
 * A test runner's invocation, up to the end of its line, a backtick or a shell separator:
 * `npx vitest run a.test.ts`, `pnpm test`, `npm run test:unit`, `pytest tests/x.py`. The match is
 * greedy, so it costs one pass; {@link SENTENCE_END} then ends it at its sentence.
 */
const TEST_COMMAND =
  /\b(?:(?:npx|pnpm(?:\s+exec)?|yarn|bunx?)\s+(?:vitest|jest|playwright\s+test)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?|(?:python3?\s+-m\s+)?pytest)\b[^\n`;|&]*/;

/** A full stop that ends a sentence: followed by a space or the end. A path's dot is not one. */
const SENTENCE_END = /\.(?=\s|$)/;

/** A run of the characters a path is written with: each is a candidate, read in one pass. */
const PATH_TOKEN = /[\w@()[\]./-]+/g;
/** Punctuation that ends a sentence or a clause after a path, not part of it. */
const TRAILING_PUNCTUATION = /[.,:)]+$/;
/** A test file's name, at the end of its path: `x.test.ts`, `x.spec.tsx`, `x.realdb.test.ts`, or Python's `test_x.py`. */
const TEST_FILE_NAME = /[\w)\]-]\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_\w+\.py$/;

/** The most test files named, and the most characters of the command, before the rest is counted or cut. */
const MAX_TEST_FILES = 4;
const MAX_COMMAND_CHARS = 160;

/** What a plan says to run and extend. */
export interface PlannedTest {
  /** The narrowest test runner invocation the text writes ({@link narrowestTestCommand}), cut to {@link MAX_COMMAND_CHARS}; null when it writes none. */
  command: string | null;
  /** Every distinct test file the text names, in the order it first names them, but those the command names. */
  files: string[];
}

/** Every test runner invocation `text` writes, in order, each ended at its sentence and cut to {@link MAX_COMMAND_CHARS}. */
export function testCommandsIn(text: string): string[] {
  const commands = [...text.matchAll(new RegExp(TEST_COMMAND.source, "g"))].map(([match]) =>
    match.split(SENTENCE_END, 1)[0]!.trim(),
  );
  return commands.filter((command) => command !== "").map((command) => clip(command, MAX_COMMAND_CHARS));
}

/** A word that starts a command line: a package runner, an interpreter, or a tool run on its own. */
const COMMAND_START = /^(?:npx|pnpm|yarn|bunx?|node|tsx|python3?|tsc|eslint|vitest|jest|pytest)$/;
/** What npm runs a command with; `npm` before any other word is prose ("the npm script"). */
const NPM_SUBCOMMAND = /^(?:run|test|t|exec|ci|install|i)$/;
/** A command's argument: a flag, a path or file name, a number, a script name, or a redirect. */
const ARGUMENT = /^(?:-|\d+$|[^\s]*[./][^\s]*$|(?:run|test|exec|-m)$|test:[\w-]+$|\d?>)/;

/**
 * The words a sentence that only introduces commands is made of ("Verify with:", "Test command:",
 * "Then run the full suite"). A sentence keeping any other word once its commands are out says
 * something of its own (that a test fails or passes, or not to run it) and is kept whole.
 */
const LEAD_IN_WORDS = new Set([
  "verify",
  "verified",
  "verification",
  "with",
  "by",
  "via",
  "using",
  "test",
  "tests",
  "testing",
  "command",
  "commands",
  "run",
  "check",
  "checks",
  "then",
  "and",
  "also",
  "full",
  "suite",
  "planned",
  "plan",
  "the",
  "a",
  "it",
  "to",
  "first",
  "after",
]);

/**
 * The words of `sentence` outside its command lines and its parentheses. A command runs from the
 * word that starts it, through the tool it names, to the last argument before a plain word, a
 * shell separator or the sentence's end, so "with", "then" or "the" after a command still counts.
 */
function wordsOutsideCommands(sentence: string): string[] {
  const raw = sentence.replace(/\([^()]*\)/g, " ").split(/\s+/);
  // Each word without the quotes, backticks and closing punctuation around it.
  const tokens = raw.map((word) => word.replace(/^["'`]+|["'`,.:;]+$/g, ""));
  const words: string[] = [];
  let inCommand = false;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    const ends = /[;|&]$/.test(raw[at]!);
    const startsNpm = token === "npm" && NPM_SUBCOMMAND.test(tokens[at + 1] ?? "");
    if (!inCommand && (COMMAND_START.test(token) || startsNpm)) {
      inCommand = true;
      // The tool a runner names (`npx vitest`), or npm's subcommand, then the script `npm run` names.
      at += startsNpm && /^(?:run|exec)$/.test(tokens[at + 1]!) ? 2 : 1;
    } else if (!(inCommand && (ARGUMENT.test(token) || token === ""))) {
      inCommand = false;
      if (/[\p{L}\p{N}]/u.test(token)) words.push(token);
    }
    if (ends || token === ";" || token === "|" || token === "&&") inCommand = false;
  }
  return words;
}

/**
 * `text` without each sentence that writes a test command and nothing else: once its commands are
 * taken out, only {@link LEAD_IN_WORDS} are left ("Test command:", "Verify with: a; b; c"). Any
 * other sentence is kept whole, command and all, so no claim is cut out of a record for naming the
 * test that checks it, and a warning not to run one is never dropped. Lines stay lines; a line
 * left empty goes.
 */
export function withoutTestCommands(text: string): string {
  if (!TEST_COMMAND.test(text)) return text;
  const isOnlyCommands = (sentence: string) =>
    TEST_COMMAND.test(sentence) &&
    wordsOutsideCommands(sentence).every((word) => LEAD_IN_WORDS.has(word.toLowerCase()));
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !isOnlyCommands(sentence))
        .join(" "),
    )
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** The runner's own words, which are not what a command runs: `npx vitest run`, `npm run test:unit`, `python -m pytest`. */
const RUNNER_WORD =
  /^(?:npx|pnpm|yarn|bunx?|npm|bun|exec|run|python3?|-m|vitest|jest|playwright|pytest|test(?::[\w-]+)?)$/;

/**
 * How broad `command` is, lowest narrowest: 0 when everything it names is a test file (a pytest
 * node id counts as its file), 1 when it names a test file beside a directory or pattern, 2 when
 * it names only directories or patterns, and 3 when it names nothing, so runs the whole suite. A
 * match that runs on into prose ("npx vitest run on all of it") is 4: it is not a command anyone
 * wrote to be run. Then by how many things it names, and a pytest node id before its whole file.
 */
function breadthOf(command: string): number[] {
  const named = command
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .filter((word) => word !== "" && !word.startsWith("-") && !RUNNER_WORD.test(word));
  const isFile = (word: string) => TEST_FILE_NAME.test(word.split("::", 1)[0]!);
  const bare = (word: string) => !isFile(word) && !/[./"'`:()[\]]/.test(word);
  const prose = named.some((word, at) => bare(word) && at + 1 < named.length && bare(named[at + 1]!));
  const files = named.filter(isFile).length;
  const others = named.length - files;
  const tier = prose ? 4 : named.length === 0 ? 3 : others === 0 ? 0 : files > 0 ? 1 : 2;
  return [tier, named.length, -named.filter((word) => word.includes("::")).length];
}

/**
 * The narrowest of `commands` ({@link breadthOf}), the first written among equals, or null for
 * none. One narrow command is what the next session can run first; a verify list is a plan's
 * whole checklist, which a reader then runs end to end.
 */
export function narrowestTestCommand(commands: readonly string[]): string | null {
  let narrowest: { command: string; breadth: number[] } | null = null;
  // The first key that differs decides; a tie on every key keeps the earlier command.
  const narrower = (a: number[], b: number[]) => {
    const at = a.findIndex((key, i) => key !== b[i]);
    return at !== -1 && a[at]! < b[at]!;
  };
  for (const command of commands) {
    const breadth = breadthOf(command);
    if (narrowest === null || narrower(breadth, narrowest.breadth)) narrowest = { command, breadth };
  }
  return narrowest?.command ?? null;
}

/**
 * The test `text` plans, or null when it names no test command and no test file. The command is
 * the narrowest the text writes, unless `command` is given: then it is that one when the text
 * writes it, and none otherwise, so a block that says one command across many plans says no other.
 */
export function plannedTestOf(text: string, { command: only }: { command?: string | null } = {}): PlannedTest | null {
  const written = testCommandsIn(text);
  const command =
    only === undefined ? narrowestTestCommand(written) : only !== null && written.includes(only) ? only : null;
  const named = [...text.matchAll(PATH_TOKEN)]
    .map(([token]) => token.replace(TRAILING_PUNCTUATION, ""))
    .filter((token) => TEST_FILE_NAME.test(token));
  const files = [...new Set(named)].filter((file) => !command?.includes(file));
  if (command === null && files.length === 0) return null;
  return { command, files };
}

/**
 * The planned test as one sentence: `Planned test: <command>; test files it names: <files>.` Only what
 * the plan named is said; more than {@link MAX_TEST_FILES} files are counted, not listed.
 */
export function plannedTestSentence({ command, files }: PlannedTest): string {
  const shown = files.slice(0, MAX_TEST_FILES).join(", ");
  const more = files.length > MAX_TEST_FILES ? ` (+${files.length - MAX_TEST_FILES} more)` : "";
  const parts = [
    command === null ? null : `Planned test: ${command}`,
    files.length === 0 ? null : `test files it names: ${shown}${more}`,
  ];
  const sentence = parts.filter((part) => part !== null).join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
