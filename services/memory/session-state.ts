// A captured session state, read back from its fact, and the completion claims it can contradict.
//
// The willder init hook can keep one fact per task and session saying where the work stands
// (cli/hooks/willder-capture.mjs, renderSessionState): the files the session changed, its last
// test command and result, which test files the session had edited before that run and which of
// them the command named, and the agent's last message. An agent may also write, on purpose,
// that the task is finished. In one real handoff, agent A rewrote
// a shipped regression test to assert its own wrong change, ran it, saw it pass, and recorded
// "Finished"; agent B was served that record and stopped. The capture held what B needed: the
// passing run used a test the same session had rewritten. This file reads that out of the fact,
// and says whether a record's text claims the work is complete, so the task-start block
// (mcp/task-start-notice.ts) can put the test result first and mark a claim the tests give
// evidence against.
//
// The one rule this file enforces: it never reports a test result or a test edit the capture
// did not record, and it finds a problem only where the capture recorded one. A fact that is
// not in the hook's format, or whose test line can be read more than one way, has no test result
// here; what the capture could not see is no evidence either way.
import type { FactRole } from "./fact-roles";
import { rankedText } from "./relevance";

// The hook's wording, line by line. It is a format: renderSessionState writes it, and
// services/memory/session-state.test.ts renders with the hook and reads with this file.
const OPENING = "Session state captured automatically by the Willder hook at ";
/** How the name of every captured session state opens; the rest names the task and session. */
export const SESSION_STATE_NAME_OPENING = "Session state: ";
const TEST_LINE = "\nLast test command: ";
/**
 * How the capture's line of shell commands opens. The hook saw each command run and its exit
 * status, but the command's words are the agent's own (a commit message, an `echo`), so a reader
 * serves the line with the agent's claims, never as observed.
 */
export const COMMANDS_LINE_OPENING = "Shell commands run, oldest first, with exit status: ";
/** How the capture's last line opens: the agent's last message, which nothing has checked. */
export const LAST_MESSAGE_OPENING = "Agent's last message: ";
const MESSAGE_LINE = `\n${LAST_MESSAGE_OPENING}`;
const FILES_LINE = "Files changed since the session started: ";
const RUN_LINE = "Last test run: ";
const EDITED_LINE = "Test files this session had edited before that run: ";
const NAMED_LINE = "Of those, the last test command named: ";
const EDITED_BY_CAPTURE_LINE = "Test files this session had edited by this capture: ";
const EDITED_AFTER_LINE = "Test files this session edited after that run: ";
const UNSEEN_LINE = "Test paths that run reached which this capture cannot see into: ";
const EXISTING_LINE = "Of those, these existed when the session started: ";
/** "No test run": "none run" from a hook before the run line, "none recognised" since. */
const NO_RUN = new Set(["none run", "none recognised"]);
const NOT_KNOWN = "not known";
const NO_FILES = "none";
const NAMED_OTHER = "none of them; it named other tests";
const NAMED_SUITE = "none by name; it ran tests without naming them";
/** The run line's value: the result, and when the run happened as the hook's clock read it. */
const RUN_VALUE = /^(passed|failed)(?: at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z))?$/;
/** The result the hook appends to the command: ` -> passed (<summary line>)`. */
const RESULT = / -> (passed|failed) \(/g;

/** How a test run relates to the test files its own session had edited before it. */
export type TestRunEdits =
  /** The session had edited no test file the capture saw, before the run. */
  | { kind: "none-seen" }
  /**
   * The run's command named test files the session had edited, listed as the hook wrote them, and
   * which of all the test files it had edited existed when it started ("none" when it wrote them
   * all; null when not known).
   */
  | { kind: "ran-edited"; files: string; existing: string | null }
  /** The session had edited these test files and the run named no test path: it ran them among the rest, and `existing` is as above. */
  | { kind: "edited-before"; files: string; existing: string | null }
  /** The session had edited these test files and the run named only other tests; `existing` is as above. */
  | { kind: "edited-other"; files: string; existing: string | null };

/** The last test run a capture recorded. */
export interface CapturedTestRun {
  result: "passed" | "failed";
  /** When the run happened, an ISO instant from the capturing machine's clock; null when the capture did not say. */
  at: string | null;
  /** The command as the hook kept it: redacted, at most 200 characters, possibly on several lines; null when unreadable. */
  command: string | null;
  /** The runner's summary line, as the hook kept it; null when unreadable. */
  summary: string | null;
  /** Which tests the run used that its session had edited before it; null when the capture did not record it. */
  edits: TestRunEdits | null;
  /** The test files the session edited after the run, as listed; "none"; or null when not known. */
  editedAfter: string | null;
  /** Test paths the run reached that the capture cannot see into, as listed; null when none. */
  unseen: string | null;
}

/** A captured session state, as far as its fact can be read one way only. */
export interface CapturedSessionState {
  /**
   * The last test run; "none" when the hook recognised no test run in the session (it may still
   * have run tests the hook does not recognise); null when unreadable.
   */
  lastTest: CapturedTestRun | "none" | null;
  /** With no recognised run: the test files the session had edited by the capture, "none", or null when not known. */
  editedByCapture: string | null;
  /** The files the session had changed by the capture, as listed; "none"; or null when not known or unreadable. */
  filesChanged: string | null;
  /** The agent's last message as the hook kept it, or null when the fact holds none whole. */
  lastMessage: string | null;
  /** The fact's text without its test lines when they were read, or its whole text when not. */
  rest: string;
}

/** What a fact must hold to be read as a capture: the hook names it, declares it progress and opens it the same way. */
interface FactText {
  entityName: string | null;
  role: FactRole | null;
  content: string;
}

/**
 * The session state `fact` holds, or null when it is not a capture. A capture is a progress fact
 * named and opened as the hook writes it; anyone who may write the scope can write one, so it is
 * trusted exactly as far as any fact from that writer.
 *
 * What the run showed is read from the lines before the command. Every line there is one the
 * hook wrote on one line (its opening, the task, the files changed, the run's result and test
 * edits), so text the agent wrote, which the command and the last message are, cannot stand in
 * for them. A capture from a hook that wrote no run line is read from the result the hook
 * appended to the command, and only when that result appears exactly once.
 */
export function capturedSessionState(fact: FactText): CapturedSessionState | null {
  const { content } = fact;
  if (
    fact.role !== "progress" ||
    !fact.entityName?.startsWith(SESSION_STATE_NAME_OPENING) ||
    !content.startsWith(OPENING)
  )
    return null;
  const testAt = content.indexOf(TEST_LINE);
  if (testAt === -1)
    return { lastTest: null, editedByCapture: null, filesChanged: null, lastMessage: null, rest: content };
  const head = content.slice(0, testAt).split("\n");
  // The message line is one line, written last, so the last one is the hook's own. A fact cut
  // before it may have lost the end of its command too.
  const messageAt = content.lastIndexOf(MESSAGE_LINE);
  const whole = messageAt > testAt;
  const filesChanged = listOf(valueOf(head, FILES_LINE));
  const lastMessage = whole ? content.slice(messageAt + MESSAGE_LINE.length) : null;
  const unread = { lastTest: null, editedByCapture: null, filesChanged, lastMessage, rest: content };
  const command = whole ? content.slice(testAt + TEST_LINE.length, messageAt) : null;
  const isTestLine = (line: string) =>
    [RUN_LINE, EDITED_LINE, NAMED_LINE, EXISTING_LINE, EDITED_BY_CAPTURE_LINE, EDITED_AFTER_LINE, UNSEEN_LINE].some(
      (prefix) => line.startsWith(prefix),
    );
  const rest = [...head.filter((line) => !isTestLine(line)), ...(whole ? [content.slice(messageAt + 1)] : [])].join(
    "\n",
  );

  const runLines = head.filter((line) => line.startsWith(RUN_LINE));
  if (runLines.length === 0) {
    // A hook from before the run line: the result appended to the command, read whole only.
    if (command === null) return unread;
    if (NO_RUN.has(command)) return { lastTest: "none", editedByCapture: null, filesChanged, lastMessage, rest };
    const run = commandRunOf(command);
    return run === null
      ? unread
      : {
          lastTest: { ...run, at: null, edits: null, editedAfter: null, unseen: null },
          editedByCapture: null,
          filesChanged,
          lastMessage,
          rest,
        };
  }
  if (runLines.length !== 1) return unread;
  const value = runLines[0]!.slice(RUN_LINE.length);
  if (NO_RUN.has(value))
    return {
      lastTest: "none",
      editedByCapture: listOf(valueOf(head, EDITED_BY_CAPTURE_LINE)),
      filesChanged,
      lastMessage,
      rest,
    };
  const run = RUN_VALUE.exec(value);
  if (run === null) return unread;
  const result = run[1] as "passed" | "failed";
  // The command and summary are shown only when the appended result agrees with the run line.
  const shown = command === null ? null : commandRunOf(command);
  const agrees = shown !== null && shown.result === result;
  return {
    lastTest: {
      result,
      at: run[2] ?? null,
      command: agrees ? shown.command : null,
      summary: agrees ? shown.summary : null,
      edits: editsOf(head),
      editedAfter: listOf(valueOf(head, EDITED_AFTER_LINE)),
      unseen: valueOf(head, UNSEEN_LINE) || null,
    },
    editedByCapture: null,
    filesChanged,
    lastMessage,
    rest,
  };
}

/**
 * The command, result and summary of `text`, `<command> -> passed|failed (<summary>)`, or null
 * when it holds the result marker other than exactly once: the command and the summary are the
 * agent's own text and may hold it too, and then which one the hook appended cannot be told.
 */
function commandRunOf(text: string): { result: "passed" | "failed"; command: string; summary: string } | null {
  const markers = [...text.matchAll(RESULT)];
  if (markers.length !== 1 || !text.endsWith(")")) return null;
  const [marker] = markers;
  return {
    result: marker![1] as "passed" | "failed",
    command: text.slice(0, marker!.index),
    summary: text.slice(marker!.index! + marker![0].length, -1),
  };
}

/** The value of the one line in `head` that starts with `prefix`, or null when there is not exactly one. */
function valueOf(head: readonly string[], prefix: string): string | null {
  const lines = head.filter((line) => line.startsWith(prefix));
  return lines.length === 1 ? lines[0]!.slice(prefix.length) : null;
}

/** A file list's value: "none", the files, or null when absent, empty or "not known". */
function listOf(value: string | null): string | null {
  return value === null || value === "" || value === NOT_KNOWN ? null : value;
}

/** The files a capture lists as changed by its session, without a "(+N more)" tail; none when it lists none or that is not known. */
export function changedFilesOf(state: CapturedSessionState): string[] {
  return state.filesChanged === null || state.filesChanged === NO_FILES ? [] : namesOf(state.filesChanged);
}

/** The file names in a list as the hook wrote it, without a "(+N more)" tail. */
function namesOf(list: string): string[] {
  return list.replace(/ \(\+\d+ more\)$/, "").split(", ");
}

/** The test edits before the run that the lines before the command state, or null when they state nothing certain. */
function editsOf(head: readonly string[]): TestRunEdits | null {
  const edited = listOf(valueOf(head, EDITED_LINE));
  if (edited === null) return null;
  if (edited === NO_FILES) return { kind: "none-seen" };
  const named = valueOf(head, NAMED_LINE);
  const existing = listOf(valueOf(head, EXISTING_LINE));
  if (named === NAMED_SUITE) return { kind: "edited-before", files: edited, existing };
  if (named === NAMED_OTHER) return { kind: "edited-other", files: edited, existing };
  if (named === null || named === "" || named === NOT_KNOWN) return null;
  return { kind: "ran-edited", files: named, existing };
}

/** A captured session state with the fact it was read from. */
export interface SessionStateFact {
  id: string;
  /** When the capture was written, as an ISO instant; absent when not known. */
  writtenAt?: string;
  state: CapturedSessionState;
}

/**
 * What a task's captured tests show against its completion claims: evidence of a problem, never
 * the lack of evidence that the work is right.
 */
export type UnverifiedReason =
  | "failed"
  | "passed-on-edited-tests"
  | "passed-after-editing-tests"
  | "tests-edited-after-pass";

/** The reason, and the captures read to reach it. */
export interface Unverified {
  reason: UnverifiedReason;
  captures: string[];
}

/**
 * The evidence, if any, that the task's captured tests contradict its completion claims.
 * `states` come newest written first.
 *
 * The task's last recognised run decides: the newest by when it ran, never later than when its
 * capture was written (a capturing machine's clock can run ahead), or, for a capture that did not
 * record the run's time, by when it was written. There is evidence of a problem in three cases
 * only:
 * - (a) that run failed;
 * - (b) it passed after its own session is known to have edited a test file that existed when the
 *   session started (changed, deleted or moved away), whatever the run named: a named test loads
 *   the fixtures, mocks and setup files beside it, and a removed test is one the run no longer
 *   has. "passed-on-edited-tests" when the run named one of those existing tests,
 *   "passed-after-editing-tests" otherwise. A pass when every test file the session edited is one
 *   it wrote is how test-first work looks, not evidence of a problem;
 * - (c) a test file is known to have been edited after it: by its own session after the run, or
 *   by a later session that recognised no run of its own.
 * Nothing else is evidence: no recognised run, a capture that could not tell, tests the capture
 * cannot see, and edits to files that are not tests leave the claims as they are. Null then, and
 * when a capture that cannot be read may hold the deciding run.
 */
export function unverifiedBy(states: readonly SessionStateFact[]): Unverified | null {
  const captures = states.map(({ id }) => id);
  const ranAt = ({ state, writtenAt }: SessionStateFact) => {
    const at = (typeof state.lastTest === "object" && state.lastTest?.at) || "";
    if (!writtenAt) return at;
    return at !== "" && at < writtenAt ? at : writtenAt;
  };
  let decider: SessionStateFact | undefined;
  for (const state of states) {
    if (typeof state.state.lastTest !== "object" || state.state.lastTest === null) continue;
    if (decider === undefined || ranAt(state) > ranAt(decider)) decider = state;
  }
  if (decider === undefined) return null;
  const deciderAt = ranAt(decider);
  if (states.some((state) => state.state.lastTest === null && (state.writtenAt ?? "") > deciderAt)) return null;
  const test = decider.state.lastTest as CapturedTestRun;
  if (test.result === "failed") return { reason: "failed", captures };
  const edits = test.edits;
  // (b) holds only for tests that existed when the session started, however the run named its
  // tests: a named test loads fixtures and setup files, and a removed test is one it no longer runs.
  if (edits && edits.kind !== "none-seen" && edits.existing !== null && edits.existing !== NO_FILES) {
    const ranExisting =
      edits.kind === "ran-edited" && namesOf(edits.files).some((file) => namesOf(edits.existing!).includes(file));
    return { reason: ranExisting ? "passed-on-edited-tests" : "passed-after-editing-tests", captures };
  }
  const editedLater = states.some(
    ({ state, writtenAt }) =>
      state.lastTest === "none" &&
      (writtenAt ?? "") > deciderAt &&
      state.editedByCapture !== null &&
      state.editedByCapture !== NO_FILES,
  );
  if ((test.editedAfter !== null && test.editedAfter !== NO_FILES) || editedLater)
    return { reason: "tests-edited-after-pass", captures };
  return null;
}

/** The words that say the work is complete, wherever they stand in a clause. */
const COMPLETION_WORDS = new Set([
  "done",
  "finished",
  "fixed",
  "resolved",
  "completed",
  "implemented",
  "shipped",
  "addressed",
  "merged",
  "landed",
]);
/** Phrases that say the work is complete or its tests pass: "all tests pass", "tests green", "ready to merge", "wrapped up". */
const COMPLETION_PHRASES =
  /\b(?:tests?\s+(?:pass(?:es|ing)?|green)|ready\s+to\s+merge|wrapped\s+up|in\s+and\s+working)\b/g;
/**
 * A word that says it only as the last word of its clause or after a verb of being: "Task
 * complete.", "is complete with tests", but not "a complete list".
 */
const COMPLETION_LAST_WORDS = new Set(["complete"]);
const BEING = new Set(["is", "are", "was", "were", "now", "fully", "all"]);

/**
 * Words that take the claim back when they stand among the three words before a completion
 * word: a negation (`not done`), a modal or a plan (`needs to be fixed`, `will be resolved`), a
 * condition (`if fixed`, `before it is fixed`), or a degree short of complete (`almost done`).
 */
const NOT_A_CLAIM_AFTER = new Set([
  "not",
  "no",
  "never",
  "nothing",
  "none",
  "nor",
  "neither",
  "yet",
  "without",
  "cannot",
  "unless",
  "until",
  "if",
  "whether",
  "once",
  "when",
  "after",
  "before",
  "will",
  "would",
  "should",
  "must",
  "need",
  "needs",
  "may",
  "might",
  "shall",
  "to",
  "be",
  "todo",
  "pending",
  "remaining",
  "remains",
  "almost",
  "nearly",
  "partially",
  "partly",
  "mostly",
  "half",
]);
/** How many words before a completion word can take it back. */
const NEGATION_REACH = 3;
/** Words that start a new part of a clause, so what came before them no longer scopes the claim. */
const CLAUSE_JOINERS = new Set(["and", "but", "so", "then", "plus"]);

/** A clause ends at `.`, `!`, `?`, `;`, `:` or `,` followed by a space, at a dash between spaces, or at a line break. */
const CLAUSE_END = /(?<=[.!?;:,])\s+|\s+[-–—]\s+|[–—]|\r?\n/;
/** Inline code, `like this`: a name in code (`done()`) is not a claim. */
const CODE_SPAN = /`[^`\n]*`/g;
/** A word: letters, digits and `_`, joined by `-` or an apostrophe, so `half-done` and `isn't` are one word each. */
const WORD = /[\p{L}\p{N}_]+(?:[-'’][\p{L}\p{N}_]+)*/gu;

/** Whether `word` takes back a completion word after it ({@link NOT_A_CLAIM_AFTER}, or any `n't`). */
const takesBack = (word: string) => NOT_A_CLAIM_AFTER.has(word) || word.endsWith("n't") || word.endsWith("n’t");

/** Whether a clause's `words` claim completion ({@link claimsCompletion}). */
function clauseClaims(words: readonly string[]): boolean {
  let partStart = 0;
  for (const [i, word] of words.entries()) {
    if (CLAUSE_JOINERS.has(word)) {
      partStart = i + 1;
      continue;
    }
    const isClaim =
      COMPLETION_WORDS.has(word) ||
      (COMPLETION_LAST_WORDS.has(word) && (i === words.length - 1 || BEING.has(words[i - 1] ?? "")));
    if (isClaim && !words.slice(Math.max(partStart, i - NEGATION_REACH), i).some(takesBack)) return true;
    // What took back an earlier completion word ("asked to be fixed") does not reach past it.
    if (isClaim) partStart = i + 1;
  }
  return false;
}

/** Whether a clause holds a completion phrase ({@link COMPLETION_PHRASES}) that none of the three words before it takes back. */
function phraseClaims(clause: string): boolean {
  for (const match of clause.toLowerCase().matchAll(COMPLETION_PHRASES)) {
    const before = [...clause.toLowerCase().slice(0, match.index).matchAll(WORD)].map(([word]) => word);
    if (!before.slice(-NEGATION_REACH).some(takesBack)) return true;
  }
  return false;
}

/** The most words a clause that only says "not" of what came before may have: "the tests are not". */
const ELIDED_NEGATION_MAX_WORDS = 6;

/**
 * Whether a clause's `words` take back the clause before it by ending on a bare negation, with
 * the claim left unsaid: "X is done; the tests are not", "the docs aren't", "tests not yet".
 * "No migration needed" and "nothing pending" end on other words and take nothing back.
 */
function isElidedNegation(words: readonly string[]): boolean {
  const last = words.at(-1);
  if (last === undefined || words.length > ELIDED_NEGATION_MAX_WORDS || clauseClaims(words)) return false;
  // It names what it takes back ("the tests are not"); a bare "Not yet." takes back nothing named.
  if (last === "yet" && words.at(-2) === "not") return words.length >= 3;
  return words.length >= 2 && (last === "not" || last.endsWith("n't") || last.endsWith("n’t"));
}

/**
 * Whether `text` claims the work is complete: a clause, not a question, that holds done,
 * finished, fixed, resolved, completed, implemented, shipped, addressed, merged or landed as a
 * whole word, a phrase such as "all tests pass" or "ready to merge" ({@link COMPLETION_PHRASES}), or
 * "complete" at its end or after "is", with none of the three words before it taking the claim
 * back ({@link NOT_A_CLAIM_AFTER}) since the clause or its last "and"/"but" began, and not
 * followed by a clause that takes it back by ending on a negation ("X is done; the tests are
 * not"). Only the first 4,000 characters are read. A word used in another sense ("a fixed
 * width") still reads as a claim; the block only states test facts beside it, so a false reading
 * adds a true sentence, never a false one.
 */
export function claimsCompletion(text: string): boolean {
  const clauses = rankedText(text)
    .replace(CODE_SPAN, " ")
    .split(CLAUSE_END)
    .map((clause) => ({
      clause,
      question: clause.trimEnd().endsWith("?"),
      words: [...clause.toLowerCase().matchAll(WORD)].map(([word]) => word),
    }))
    .filter(({ words }) => words.length > 0);
  return clauses.some(
    ({ clause, question, words }, i) =>
      !question && (clauseClaims(words) || phraseClaims(clause)) && !isElidedNegation(clauses[i + 1]?.words ?? []),
  );
}
