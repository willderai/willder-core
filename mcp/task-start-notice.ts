// The task-start block on a session's first tool result.
//
// An agent that starts a task without the org's conventions or the state other runs
// left behind repeats their mistakes. Asking for them is a tool call an agent has to
// think of; this block is served instead, unasked, on the first result of each
// session, next to the change notices (mcp/change-notices.ts). Reading and ranking
// live in services/memory/task-start.ts; this file decides what fits and how it reads.
//
// The one rule this file enforces: the block has a fixed token budget, spent on what
// decides the task first, and every record says what backs it. The records share one room, the
// budget less the block's header and closing line ({@link recordRoom}); a line that shows no
// record, such as the premise check or the line on what changed since the last session, is added
// on top when shown and takes nothing from it, so it never pushes a record out. The sections
// follow status (services/memory/claim-status.ts): the working notes live on the task, since a
// live claim on it decides whether to start it at all; what is settled for the task, a person's
// records and its rules; the leads earlier sessions of the task left, each labelled by its
// status; the scope's rules in force; the questions open on the task; and what is related, the
// notes on other tasks on one line, recent writes and stale flags. Each line goes in whole or not
// at all, and the block says how many it left out. The task's writes leave room for
// the scope's first RESERVED_RULE_LINES rules, and the rules are served on compact lines, so
// about ten fit where the task's own records leave room: a rule an agent does not see is one
// a person has to restate. It shares the piggyback with at most MAX_NOTICES_PER_CALL change
// notices; together they stay under PIGGYBACK_TOKEN_BUDGET.
//
// The scope's rules and recent writes are ranked by what the session is doing, not only by the
// task's name: the prompt the hook sends, or a tool call's own arguments ({@link rankingTextOf}),
// read for this one answer and kept nowhere.
//
// A task's captured session state (cli/hooks/willder-capture.mjs) says what its last test run
// showed. The newest capture is served first among the task's progress notes, opening with that
// run stated plainly: passed or FAILED, and what the capture saw its session do to tests around
// it. A line showing one of the task's own records that claims the work is complete is marked
// unverified only on evidence of a problem: the run failed, it passed on tests its own session
// had edited, or tests were edited after it (services/memory/session-state.ts). Anything the
// capture could not see marks nothing. With no capture, nothing is said about tests at all.
//
// A plan another session left is not a rule. A claim's status comes from what was recorded, never
// from its words or its writer's role: a person's record is settled; anything else is a lead,
// labelled by what the captures of its own session show it did after writing it (untested,
// failing, tested) or as proposed when none speaks to it. A cause or a constraint is served as
// what its writer declared it, a finding to check; a decision, a progress note or a claim with no
// role that nothing backs is served as a plan, and a decision whose session recorded no test run
// after it is labelled an untested plan, to verify before following. The leads open with the findings and what recorded
// evidence shows tested (a progress note aside), then the plans beside the options their writers
// rejected: in a paired study both legs Willder misled followed an
// untested plan served above the cause that pointed at the right fix. The block
// says once, under the leads' heading, to check the claims a plan rests on before building on it.
// The test a write plans is said after its excerpt, so the cut never drops it, and the block says
// one command, the narrowest any of the task's served writes names; a plan's sentence that only
// introduces a command or a verify list is left out of its excerpt (services/memory/planned-test.ts).
//
// A line serves what a record says, not how it starts. Each of the task's own writes is served
// on one line, in the order the read ranked them (services/memory/task-start.ts, rankTaskFacts):
// within a role tier, the newest source on the session's subject that does not quote it first,
// its parts in the order written, then the write
// most relevant to what the session is doing, the newest first among equals.
// The line is an excerpt of at most TASK_FACT_EXCERPT_CHARS characters, every part of the write
// read as one text, each sentence once, cut around the session's terms, so the budget holds
// several of the task's writes and not only the newest two; the section's heading says once
// that memory_version opens any of them whole. Every other record is served by the passage of
// its text most relevant to the task (services/memory/relevance.ts), the first few that are
// about the task longer than the rest. A record that holds none of the session's terms is served
// its opening, and a write that only mentions one in passing is served its summary: the longer
// passages go only to what is about the task.
//
// Every line names its source: a rule or fact line ends with who wrote it and the
// day, `— builder, 10-15` ({@link sourceOf}), and a recent write gives the day after its writer.
// A person is named only as "person", and a connected source the reader's scope does not hold only
// as "connector", the same as one whose row was deleted (services/memory/task-start.ts). Sources
// ride on an allowance of their own (SOURCE_ALLOWANCE_TOKENS), so while it lasts, about twenty
// lines, naming them pushes no record out; past it a source costs record room like the rest of its
// line, and a block of many short records serves a few fewer of them.
//
// Versions of one fact that conflict, two writers' different texts under one name in one scope
// (services/memory/served-conflicts.ts), are served together under one line that names every
// source and asks the person which holds before acting on any; the block never picks one, never
// shows one without the others, and a version the winner rule retired is served only there.
//
// A session that starts after a gap opens, right under the header, with one line saying what
// changed in its scope while the agent was away: how many changes, by how many other writers,
// and how many were made under the session's task (services/memory/since-last-session.ts). It
// is counts only, so it names no record; the change notices after the block say what changed.
// A session that is not a return, or returns to a scope where nothing changed, gets no line.
import { AccessDeniedError, check, type AccessContext } from "@/services/access";
import { FACT_RECORD_TYPE } from "@/services/memory/change-events";
import { MAX_WAITING_COUNTED } from "@/services/memory/change-feed";
import { factVersionsIn } from "@/services/memory/fact-reads";
import { recordRevisionKey, revisionToken } from "@/services/memory/revision";
import { noteTime } from "@/services/memory/working-notes";
import {
  NO_WEIGHTS,
  bestPassage,
  clip,
  isAboutTheTask,
  oneLine,
  rankedText,
  termsOf,
  type TermWeights,
} from "@/services/memory/relevance";
import {
  claimTaskStartDelivery,
  markTaskStartDue,
  readServableTaskStart,
  sessionAlreadyServed,
  writesOf,
  type LiveNotes,
  type ServedFact,
  type ServedNote,
  type ServedRule,
  type ServedWrite,
  type StaleFlag,
  type TaskContext,
  type TaskStartContext,
  type TaskStartRead,
} from "@/services/memory/task-start";
import { markWritesAgainst } from "@/services/memory/superseded-facts";
import { servedConflicts } from "@/services/memory/served-conflicts";
import {
  HANDOFF_PARTS,
  handoffParts,
  isHandoffName,
  type HandoffPart,
  type HandoffParts,
} from "@/services/memory/session-handoff";
import {
  COMMANDS_LINE_OPENING,
  LAST_MESSAGE_OPENING,
  capturedSessionState,
  claimsCompletion,
  unverifiedBy,
  type CapturedSessionState,
  type SessionStateFact,
  type CapturedTestRun,
  type UnverifiedReason,
} from "@/services/memory/session-state";
import {
  narrowestTestCommand,
  plannedTestOf,
  plannedTestSentence,
  testCommandsIn,
  withoutTestCommands,
} from "@/services/memory/planned-test";
import {
  claimStatusOf,
  ruleIsSettled,
  type ClaimStatus,
  type ClaimStatusOf,
  type ClaimStatusReason,
  type ClaimWriter,
  type SessionCapture,
} from "@/services/memory/claim-status";
import type { FactRole } from "@/services/memory/fact-roles";
import type { SinceLastSession } from "@/services/memory/since-last-session";
import {
  CONFLICT_OPENING,
  SINCE_LAST_SESSION_OPENING,
  TASK_START_CAPTURE_LABEL,
  TASK_START_HEADER,
  TASK_START_HEADINGS,
  TASK_START_OBSERVED_LABEL,
  TASK_START_PREMISE_CHECK,
  TASK_START_UNTESTED_PLAN,
} from "./task-start-headings";

/**
 * Token budget for the task-start block's header, record lines and closing line, estimated as
 * {@link estimateTokens}. The lines that show no record are added on top ({@link TASK_START_MAX_TOKENS}).
 */
export const TASK_START_TOKEN_BUDGET = 600;

/**
 * Token budget for the records of a block served at a session boundary, or to a task that holds a
 * handoff ({@link renderTaskStartBlock}). Such a block is told once per boundary, not once per
 * call, and it is what the next session finishes the work from, so the handoff's parts and what
 * they rest on are not cut to fit the first block's budget.
 */
export const BOUNDARY_TASK_START_TOKEN_BUDGET = 2000;

/**
 * The most characters of one handoff part a boundary block serves, from its start: the start is
 * what a reader needs and what a check that the part arrived looks for. Six parts at this length
 * take about half the boundary budget; memory_version opens the handoff whole.
 */
const HANDOFF_PART_MAX_CHARS = 700;

/** The most characters of a captured session's shell commands line a boundary block serves, with the claims. */
const COMMANDS_SHOWN_CHARS = 400;

/**
 * The most characters of a captured agent's last message a boundary block serves on its own line:
 * all the hook keeps of it (LAST_MESSAGE_MAX_CHARS in cli/hooks/willder-capture.mjs), so serving it
 * apart never shortens what a first block would serve.
 */
const LAST_MESSAGE_SHOWN_CHARS = 1000;

/** The closing line at its longest, held out of the records' room so adding it never breaks the budget. */
const CLOSING_LINE_RESERVE = "\n(999 more left out: ask memory_query for them)";

/**
 * Estimated tokens for everything one tool result carries besides its own answer: the
 * task-start block at its longest ({@link TASK_START_MAX_TOKENS}) plus MAX_NOTICES_PER_CALL
 * change lines of about 75 tokens. An estimate, not enforced: a merged change line names its
 * fact in full, so the notices can run past it, and the hook then cuts at a line end and says so.
 */
export const PIGGYBACK_TOKEN_BUDGET = 1200;

/** Longest passage of a rule, fact or write served, in characters; a longer one is cut and says so. */
const LINE_TEXT_MAX_CHARS = 300;

/**
 * Longest passage of one of the scope's rules, in characters; such a line never gets the longer
 * passage. The line names the rule by its id and subject, and its passage says what the rule is
 * about. At this length about ten rules with long names fit the budget, where six did at
 * {@link LINE_TEXT_MAX_CHARS}. The task's own decisions keep the full length.
 */
export const RULE_TEXT_MAX_CHARS = 140;

/**
 * How many records about the task are served a longer passage, in the block's order,
 * and how long. Three, because the first three items are what an agent reads before it
 * acts; three lines of this length leave room in the budget for the header and a few
 * shorter lines.
 */
const SUBSTANCE_RECORDS = 3;
const SUBSTANCE_MAX_CHARS = 560;

/**
 * The most characters of one of the task's writes its line serves: an excerpt, cut around the
 * session's terms, never the longer passage. Served whole at 1,300 characters, two writes filled
 * the budget, and the block found the deciding review only when it was one of the newest two;
 * at this length about seven fit, ranked by the session's words. The line names the fact, so
 * memory_version opens it whole.
 */
export const TASK_FACT_EXCERPT_CHARS = 200;

/**
 * The most characters of a captured session state its line serves (services/memory/session-state.ts),
 * from its opening: the length every task write was served at before excerpts. A capture is the
 * session's own handoff: its last test run, what that run relates to, the files it changed and its
 * last message, which decides whether the task's own claims of completion stand.
 */
const CAPTURE_MAX_CHARS = 1300;

/** The characters a capture's line spends on its label and its planned test, both said within {@link CAPTURE_MAX_CHARS}. */
function captureExtrasLength(plannedTest: string | null): number {
  return TASK_START_CAPTURE_LABEL.length + 1 + (plannedTest === null ? 0 : plannedTest.length + 1);
}

/**
 * How many of the scope's rules the task's writes leave room for: no line of the task's writes
 * is served past the point where the first this many rules would no longer fit after it. Only rules the scope holds are reserved for, so
 * a scope with none gives its task's writes the whole budget. Three, the lines an agent reads
 * before it acts: a task with a long history otherwise leaves its rules no room at all, and a
 * rule an agent does not see is one a person has to restate.
 */
export const RESERVED_RULE_LINES = 3;

/**
 * What a line showing one of the task's completion claims says first, when the task's captured
 * tests give evidence against it ({@link unverifiedBy}). Each states what the capture recorded,
 * and nothing about the claim: read beside a record that only uses the word in another sense, it
 * is still true. With no such evidence a claim is shown as written.
 */
const UNVERIFIED: Record<UnverifiedReason, string> = {
  failed: "[unverified: the last captured test run FAILED]",
  "passed-on-edited-tests":
    "[unverified: the last captured passing run used existing tests its own session had edited]",
  "passed-after-editing-tests":
    "[unverified: the last captured passing run came after its session edited existing tests]",
  "tests-edited-after-pass": "[unverified: tests were edited after the last captured passing run]",
};

/**
 * What a claim's status label says of why it has that status ({@link claimStatusOf}): what was
 * recorded of it and of its own session, and nothing the claim says of itself.
 */
const STATUS_REASON: Record<ClaimStatusReason | "open-by-kind", string> = {
  "recorded-by-person": "recorded by a person",
  "no-session-recorded": "",
  "no-capture-after-it": "",
  "capture-unreadable": "its session's capture could not be read",
  "no-files-no-tests": "its session changed no files and ran no tests, as captured",
  "no-tests": "its session ran no tests, as captured",
  failed: "its session's last test run after it FAILED",
  "passed-on-edited-tests": "its session passed only on tests it had edited",
  "passed-after-editing-tests": "its session passed after editing existing tests",
  "tests-edited-after-pass": "tests were edited after its session's passing run",
  "run-not-after-it": "its session's last test run is not known to follow it",
  "files-not-named": "its session's passing run changed no file it names",
  passed: "its session's tests passed after it, on files it names",
  "open-by-kind": "an open item or a choice, which a passing run does not settle",
};

/** The roles a plan is written under: what the writer chose, how far it got, or nothing declared. */
const PLAN_ROLES: readonly (FactRole | null)[] = ["decision", "progress", null];

/**
 * The roles that say what the task's problem is and where: served as their role, a finding to
 * check, never as a plan, and ahead of the plans among the leads.
 */
const FINDING_ROLES: readonly (FactRole | null)[] = ["cause", "constraint"];

/** The statuses recorded evidence backs: a person's record, or a run its session passed after it. */
const SETTLED_STATUSES: ReadonlySet<ClaimStatus> = new Set(["tested", "verified"]);

/** The statuses under which a claim stays a plan: nothing recorded shows it worked. */
const PLAN_STATUSES: ReadonlySet<ClaimStatus> = new Set(["proposed", "untested", "failing"]);

/**
 * Why a claim's status says no test run backs it at all: no session or capture after it was
 * recorded, or its session ran no tests. A run that passed on edited tests, before the claim or on
 * other files still ran, so its plan keeps the plain label that says which ({@link STATUS_REASON}).
 */
const NO_RUN_REASONS: ReadonlySet<ClaimStatusReason | "open-by-kind"> = new Set([
  "no-session-recorded",
  "no-capture-after-it",
  "no-tests",
  "no-files-no-tests",
]);

/**
 * What a claim is served as: its writer's declared role while recorded evidence backs it, and a
 * plan while it does not, for a role that chooses an approach or says how far it got. A decision
 * whose session recorded no test run after it ({@link NO_RUN_REASONS}) is an untested plan
 * ({@link TASK_START_UNTESTED_PLAN}): the approach another session chose, to verify before following. A cause or a constraint stays its role whatever backs
 * it: it says where the problem is, and its status says how far that is checked. The writer's word
 * is how it saw its claim; the type says how far the record backs it.
 */
function claimTypeOf(role: FactRole | null, { status, reason }: Pick<ClaimStatusOf, "status" | "reason">): string {
  if (role === "rejected") return "rejected option";
  if (!PLAN_STATUSES.has(status) || !PLAN_ROLES.includes(role)) return role ?? "note";
  return role === "decision" && NO_RUN_REASONS.has(reason) ? TASK_START_UNTESTED_PLAN : "plan";
}

/** Whether a claim served as `type` is a plan, which the premise check follows from. */
const isPlan = (type: string | null) => type === "plan" || type === TASK_START_UNTESTED_PLAN;

/**
 * The label a claim's line opens with: its type, then its status and why, e.g. `[cause · untested: ...]`.
 * A claim no capture of its session speaks to is `[cause · proposed]`: the status says it all, and the
 * scope's decisions and most handoffs, which are this, keep their room. An untested plan says so in
 * place of its type and status, `[untested plan: verify before following]`, with why when known.
 */
function statusLabel(
  type: string,
  { status, reason }: { status: ClaimStatus; reason: ClaimStatusReason | "open-by-kind" },
): string {
  const why = STATUS_REASON[reason];
  if (type === TASK_START_UNTESTED_PLAN) return why === "" ? `[${type}]` : `[${type} · ${why}]`;
  return why === "" ? `[${type} · ${status}]` : `[${type} · ${status}: ${why}]`;
}

/**
 * What a rule with a status is served as: a decision by its claim type, and a convention as a
 * plan while recorded evidence does not back it, else as the convention it is.
 */
function ruleTypeOf(kind: ServedRule["kind"], status: ClaimStatusOf): string {
  if (kind === "decision") return claimTypeOf("decision", status);
  return PLAN_STATUSES.has(status.status) ? "plan" : "convention";
}

/** The tag on a rule an agent recorded: it stays in force, and the line says who recorded it. */
const AGENT_RECORDED = "[agent-recorded]";

/**
 * Tokens the block's sources may take beyond the records' room ({@link recordRoom}): about twenty
 * lines' worth at the usual four or five tokens a source costs. A line's source is charged here
 * while this lasts, so naming who wrote each record never pushes a record out of a block of that
 * many lines; past it, a source is charged to the room like the rest of its line.
 */
export const SOURCE_ALLOWANCE_TOKENS = 100;

/** Longest writer name a source shows, in code points. */
const SOURCE_NAME_MAX_CHARS = 32;

/**
 * A writer's name as its source shows it: on one line, with the separator a source opens with
 * (" — ") replaced by " – ", so the source's own separator is the last one on its line. What a
 * line serves of a record is never rewritten: a source is only ever appended after it, so the last
 * " — " on a rule or fact line is always the block's own (withoutSources, mcp/task-start-headings.ts).
 */
function sourceName(writtenBy: string): string {
  return oneLine(writtenBy).replaceAll(" — ", " – ");
}

/** `at` as a source dates it: the month and day in UTC, e.g. "10-15", or null when unknown or unreadable. */
function dayShown(at: string | undefined): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(5, 10);
}

/**
 * Who wrote a record and when, as its line names it: `builder, 10-15`. The writer is the name the
 * read gives (services/memory/task-start.ts): an agent's id, "person", a connector's type or
 * "connector", or "imported"; "unknown" when the read gave none.
 */
export function sourceOf(writtenBy: string | undefined, writtenAt: string | undefined): string {
  const who = writtenBy ? clip(sourceName(writtenBy), SOURCE_NAME_MAX_CHARS) : "unknown";
  const day = dayShown(writtenAt);
  return day === null ? who : `${who}, ${day}`;
}

/** The source a fact's or rule's line ends with: ` — ` and {@link sourceOf}. */
function sourceSuffix(record: { writtenBy?: string; writtenAt?: string }): string {
  return ` — ${sourceOf(record.writtenBy, record.writtenAt)}`;
}

/**
 * The line opening a conflicting set (services/memory/served-conflicts.ts): which fact, every
 * source, and the ask. It names no winner and says nothing is settled. It does not start with
 * "- ", so readers that count a block's record lines count only the versions under it.
 */
export function conflictLine(entityName: string, sources: readonly string[]): string {
  const named =
    sources.length <= 2 ? sources.join(" and ") : `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}`;
  const which = sources.length <= 2 ? "either" : "any of them";
  // The name is quoted, so a quote in it is shown as an apostrophe: stored text cannot close the
  // quote and go on to name sources of its own.
  return `${CONFLICT_OPENING} "${clip(oneLine(entityName).replaceAll('"', "'"), 80)}" from ${named}: ask the person which holds before acting on ${which}.`;
}

/** Most characters of a captured test command, and of its summary line, the session-state line repeats. */
const TEST_COMMAND_SHOWN_CHARS = 120;
const TEST_SUMMARY_SHOWN_CHARS = 100;

/** Longest working-note task shown, in characters; the rest of the line is the note's body. */
const NOTE_TASK_SHOWN_CHARS = 120;

/** Tool-call `_meta` keys a client may set. Both are optional hints, never authority. */
export const SESSION_META_KEY = "willder/session";
export const TASK_META_KEY = "willder/task";
const META_VALUE_MAX_CHARS = 512;

/**
 * A run of Unicode control characters (NUL, line breaks, tabs, DEL, the C1 range). A hint
 * is stored and matched as Postgres text, which rejects NUL outright, so a hint carrying one
 * would fail the write it rides on; each run becomes one space instead.
 */
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

/**
 * The request header that names the task for every call on a connection, for clients
 * that cannot set `_meta` per call (IDE clients set it from an environment variable in
 * their MCP config). Like `_meta["willder/task"]` it is a hint that selects context,
 * never authority: what is served stays inside what the token may read.
 */
export const TASK_HEADER = "x-willder-task";

/**
 * The request header that names the session for a client that is not an MCP connection:
 * the change-feed hook sends its agent CLI's own session id in it. Like
 * `_meta["willder/session"]` it is a hint that only decides when the block is told
 * again, never what it holds.
 */
export const SESSION_HEADER = "x-willder-session";

/**
 * The request header the change-feed hook sends at a session boundary: when Claude Code has just
 * compacted the session's context or the person typed /clear (SessionStart with source `compact`
 * or `clear`). Compaction keeps the session id, so without it the model after the compaction,
 * which no longer holds the block, would never be told it again ({@link headerSaysCompacted}). A
 * /clear starts a new session id, so it needs no second telling; either value lays the block out
 * as a boundary's, verified first ({@link headerSaysBoundary}). Any other value is an ordinary poll.
 * Like the session header it decides when and in what order the block is told, never what the
 * reader may see.
 */
export const REASON_HEADER = "x-willder-reason";

/** Whether a request's {@link REASON_HEADER} says the session's context was just compacted. */
export function headerSaysCompacted(headerValue: string | null | undefined): boolean {
  return headerValue === "compact";
}

/** Whether a request's {@link REASON_HEADER} reports a session boundary: a compaction, or a /clear. */
export function headerSaysBoundary(headerValue: string | null | undefined): boolean {
  return headerValue === "compact" || headerValue === "clear";
}

/** What the block is served for: the scope, the session, and what the task is about. */
export interface TaskStartRequest {
  scopePath: string;
  /** The session the call belongs to ({@link sessionKeyOf}), or "" when neither the client nor its connection names one. */
  sessionKey: string;
  taskText: string;
  /** The task the session names ({@link taskKeyOf}); absent when it names none. */
  taskKey?: string;
  /**
   * Aborted once the reply can no longer reach the caller: it hung up, or its wait ran out.
   * Then the block is not claimed, so the session's next call is told it instead of nobody.
   */
  abandoned?: AbortSignal;
  /**
   * Set when the session's context was just compacted: when the request reached the server. A
   * block delivered before then is due once more, for this call or, if this one is abandoned, the
   * session's next. One delivered after it, to a call that overtook this request, stays served,
   * so a late request never makes the same context be told the block twice.
   */
  compactedAt?: Date;
  /**
   * Set when the request reports a session boundary, a compaction or a /clear: the block is laid
   * out as a boundary's ({@link renderTaskStartBlock}) even for a task that holds no handoff.
   */
  boundary?: boolean;
  /**
   * Told the fact versions the block's lines show, once it is delivered: the change notices that
   * follow it leave out the line announcing any of them (mcp/change-notices.ts), which would only
   * repeat what the block just said.
   */
  onShown?: (factVersionIds: readonly string[]) => void;
}

/**
 * A rough token count: four characters per token, rounded up. Deliberately a
 * tokenizer-free estimate, so the budget is the same for every client and model.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A string value from a tool call's `_meta`, bounded by {@link boundedHint}, or undefined.
 * `extra` is the handler's second argument; it is read defensively because a tool
 * registered without an input schema receives it first, and a client may send any shape.
 */
function metaString(extra: unknown, key: string): string | undefined {
  if (typeof extra !== "object" || extra === null || !("_meta" in extra)) return undefined;
  const meta = extra._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return boundedHint((meta as Record<string, unknown>)[key]);
}

/**
 * A client hint as served, or undefined when not a string: control characters replaced
 * ({@link CONTROL_CHARACTERS}), trimmed, cut to {@link META_VALUE_MAX_CHARS}.
 */
function boundedHint(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.replace(CONTROL_CHARACTERS, " ").trim().slice(0, META_VALUE_MAX_CHARS)
    : undefined;
}

/**
 * A whole value that is an environment-variable reference, such as `${WILLDER_TASK}` or
 * `${env:WILLDER_TASK}`: what a client sends when it does not expand its MCP config. Every
 * session of that client sends the same literal, so taken as a task it would serve each
 * session what the others wrote.
 */
const UNEXPANDED_PLACEHOLDER = /^\$\{[^}]*\}$/;

/** `hint` when it names a task, or undefined when it is absent, blank or an {@link UNEXPANDED_PLACEHOLDER}. */
function taskNamedBy(hint: string | undefined): string | undefined {
  return hint && !UNEXPANDED_PLACEHOLDER.test(hint) ? hint : undefined;
}

/**
 * The task a connection names for all its calls: the {@link TASK_HEADER} value, read
 * with the same bound as `_meta["willder/task"]`, or undefined when it is absent, blank
 * or an unexpanded placeholder.
 */
export function connectionTaskOf(headerValue: string | null | undefined): string | undefined {
  return taskNamedBy(boundedHint(headerValue));
}

/** The session a request names in {@link SESSION_HEADER}, bounded as `_meta` is, or "" for none. */
export function headerSessionOf(headerValue: string | null | undefined): string {
  return boundedHint(headerValue) ?? "";
}

/**
 * The session a tool call belongs to: `_meta["willder/session"]`, else the session of the
 * connection it arrived on (mcp/connection-session.ts), else "" for none. A call's own
 * `_meta` wins because it is the more specific of the two: a client that names its sessions
 * may carry one across connections. A blank name names none.
 */
export function sessionKeyOf(extra: unknown, connectionSession = ""): string {
  return metaString(extra, SESSION_META_KEY) || connectionSession;
}

/**
 * The task a tool call names: `_meta["willder/task"]`, else the task its connection names
 * ({@link connectionTaskOf}), else undefined; a blank or placeholder value names none. A
 * call's own `_meta` wins because it is the more specific of the two. Unlike
 * {@link taskTextOf} it never falls back to the call's arguments: it is the key that ties
 * a session's writes to later sessions of the same task, so only the client's own name
 * for the task will do.
 */
export function taskKeyOf(extra: unknown, connectionTask?: string): string | undefined {
  return taskNamedBy(metaString(extra, TASK_META_KEY)) ?? connectionTask;
}

/**
 * What the block is ranked by ({@link rankingTextOf}) on a tool call: the task the call names
 * ({@link taskKeyOf}), and the string arguments of the call itself (a memory_query's question,
 * an ingest's name), which say what the session is doing now.
 */
export function taskTextOf(args: unknown, extra: unknown, connectionTask?: string): string {
  const work =
    typeof args === "object" && args !== null
      ? Object.values(args)
          .filter((value): value is string => typeof value === "string")
          .join(" ")
      : "";
  return rankingTextOf(taskKeyOf(extra, connectionTask), work);
}

/**
 * The text the scope's rules and recent writes are ranked by: the task's name, then what the
 * session is doing (a prompt, a tool call's arguments), bounded as a hint is
 * ({@link META_VALUE_MAX_CHARS}). A task's name alone is often a key with no words in it; a
 * prompt is a real query. Neither ever chooses the task's own records, which are found by the
 * task's name alone (services/memory/task-start.ts), and when the task is named, only its name
 * decides which other records are about it (ownTermsOf, services/memory/relevance.ts): the
 * prompt ranks them.
 */
export function rankingTextOf(taskKey: string | undefined, work: string): string {
  const bounded = boundedHint(work) ?? "";
  return [taskKey ?? "", bounded].filter((part) => part !== "").join("\n");
}

/**
 * The request header in which the change-feed hook sends the prompt the session was given:
 * redacted, cut and percent-encoded by the hook (cli/hooks/willder-changes.mjs). It ranks the
 * block and is kept nowhere: never stored, logged or echoed.
 */
export const PROMPT_HEADER = "x-willder-prompt";

/** The prompt a request sends in {@link PROMPT_HEADER}, decoded, or "" when it sends none or it does not decode. */
export function headerPromptOf(headerValue: string | null | undefined): string {
  if (!headerValue) return "";
  try {
    return decodeURIComponent(headerValue);
  } catch {
    return "";
  }
}

/** `marker` and a space, or nothing when there is no marker. */
const marked = (marker: string | null) => (marker ? `${marker} ` : "");

/**
 * The rule's line, saying `passage` of its text, after `marker` when its claim is unverified, then
 * its source ({@link sourceOf}). A `label` follows its id: who recorded it, or its status when it
 * is served as a lead.
 */
function formatRule(
  rule: ServedRule,
  passage: string,
  marker: string | null = null,
  label: string | null = null,
): string {
  return `- [${rule.kind} ${rule.id}] ${marked(label)}${oneLine(rule.subject)}: ${marked(marker)}${passage}${sourceSuffix(rule)}`;
}

/** How a fact's line opens and closes besides its passage. */
interface FactLineParts {
  moreParts?: number;
  marker?: string | null;
  /** Said in place of the writer's role: its status label ({@link statusLabel}) or a capture's. */
  label?: string | null;
  /** A sentence after the passage that no cut drops: the planned test. */
  after?: string | null;
}

/**
 * The fact's line: its role, or the label said in its place, then `passage` of its text and what
 * follows it, then its id, how many more parts of the same write the passage covers, its name, and
 * last its source ({@link sourceOf}).
 * The id is the link: readers match it as `[fact <id>]`, and
 * memory_version opens the fact whole.
 */
function formatFact(
  fact: ServedFact,
  passage: string,
  { moreParts = 0, marker = null, label = null, after = null }: FactLineParts = {},
): string {
  const role = marked(label);
  const following = after ? ` ${after}` : "";
  const more = moreParts > 0 ? ` (+${moreParts} parts)` : "";
  const about = fact.entityName ? ` ${oneLine(fact.entityName)}` : "";
  return `- ${role}${marked(marker)}${passage}${following} [fact ${fact.id}]${more}${about}${sourceSuffix(fact)}`;
}

/** An instant as the block states it, to the second in UTC, or null when unknown or unreadable. */
function instantShown(at: string | null | undefined): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? null : noteTime(new Date(time));
}

/**
 * What a passing run's line adds about the tests its session edited, as far as the capture saw
 * them, and nothing it did not record. Tests the session wrote itself are named as that, without
 * a "but": writing a test and then passing it is how test-first work looks. "No test edits seen"
 * is scoped to the repository the hook reads: it is never said of a run that reached tests the
 * capture cannot see into, and it is never "the session edited no test".
 */
function editsClause(test: CapturedTestRun): string {
  const { edits, editedAfter, unseen } = test;
  const after = editedAfter !== null && editedAfter !== "none" ? oneLine(editedAfter) : null;
  if (edits && edits.kind !== "none-seen") {
    if (edits.existing !== null && edits.existing !== "none") {
      const alsoAfter = after === null ? "" : `; tests were also edited after it: ${after}`;
      return `, but before it that session had edited tests that existed when it started: ${oneLine(edits.existing)}${alsoAfter}`;
    }
    // Every test file the session edited is one it wrote (test-first work), or that is not known.
    const files = oneLine(edits.files);
    const before =
      edits.kind === "edited-other"
        ? `; that session had ${edits.existing === "none" ? "written" : "edited"} other tests, which it did not name: ${files}`
        : edits.existing === "none"
          ? `; it passed on tests that session wrote: ${files}`
          : `; that session had edited tests ${edits.kind === "ran-edited" ? "it ran" : "before it"}: ${files}`;
    return after === null ? before : `${before}, but tests were edited after it: ${after}`;
  }
  if (after !== null) return `, but tests were edited after it: ${after}`;
  if (edits?.kind === "none-seen" && editedAfter === "none" && unseen === null)
    return "; no test edits seen in this repo";
  return "";
}

/** `rest` without the capture's shell commands line ({@link COMMANDS_LINE_OPENING}). */
function withoutCommandsLine(rest: string): string {
  return rest
    .split("\n")
    .filter((line) => !line.startsWith(COMMANDS_LINE_OPENING))
    .join("\n");
}

/**
 * A captured session state's text as the block serves it: its last test run stated first (the
 * result and when it ran, what the runner summed up, how it relates to the tests its session had
 * edited, then the command), then the rest of what it holds, without the hook's own test lines.
 * A capture whose test lines cannot be read is served exactly as written.
 */
function sessionStateText(fact: ServedFact, state: CapturedSessionState): string {
  const test = state.lastTest;
  if (test === null) return fact.content;
  // The shell commands are the agent's own words, and long: a boundary serves them with the
  // claims ({@link renderTaskStartBlock}); a first block leaves them out to keep to its budget.
  const rest = withoutCommandsLine(state.rest);
  const captured = instantShown(fact.writtenAt);
  const capturedOpening = captured === null ? "Last test run:" : `Last test run, captured ${captured}:`;
  if (test === "none") return `${capturedOpening} none recognised. ${rest}`;
  const ranAt = instantShown(test.at);
  const opening = ranAt === null ? capturedOpening : `Last test run at ${ranAt}:`;
  const summary = test.summary === null ? "" : ` (${clip(test.summary, TEST_SUMMARY_SHOWN_CHARS)})`;
  const edits = test.result === "passed" ? editsClause(test) : "";
  const unseen = test.unseen === null ? "" : `; it ran tests outside what the capture can see: ${oneLine(test.unseen)}`;
  const command = test.command === null ? "" : ` Command: ${clip(test.command, TEST_COMMAND_SHOWN_CHARS)}.`;
  return `${opening} ${test.result.toUpperCase()}${summary}${edits}${unseen}.${command} ${rest}`;
}

/**
 * The task's captured session states, newest first: by when each was written, and in the read's
 * order between two written at the same instant. A capture whose time is unknown comes last.
 * Only a capture the task itself wrote counts: another task's, read because it shares the
 * fact's name, says nothing about this task's tests.
 */
function sessionStatesOf(facts: readonly ServedFact[]): (SessionStateFact & { fact: ServedFact })[] {
  const states = facts.flatMap((fact) => {
    const state = fact.ofTask ? capturedSessionState(fact) : null;
    return state ? [{ id: fact.id, ...(fact.writtenAt ? { writtenAt: fact.writtenAt } : {}), state, fact }] : [];
  });
  // ISO instants in one format order as their code units do; Array.prototype.sort is stable.
  const newestFirst = (a: string, b: string) => (a > b ? -1 : a < b ? 1 : 0);
  return states.sort((a, b) => newestFirst(a.fact.writtenAt ?? "", b.fact.writtenAt ?? ""));
}

/**
 * `facts` with `latest` moved to just before the first progress note: first among them, after every
 * fact that decides the task. An untested plan decides the task whatever role its writer gave it,
 * so the capture goes after every one of them too: the plan's label already says what the capture
 * recorded, and the capture's long line must not take the room the plan needs.
 */
function latestCaptureFirst(
  facts: readonly ServedFact[],
  latest: ServedFact | undefined,
  isUntestedPlan: (fact: ServedFact) => boolean,
): ServedFact[] {
  if (latest === undefined) return [...facts];
  const others = facts.filter((fact) => fact !== latest);
  const firstProgress = others.findIndex((fact) => fact.role === "progress" && !isUntestedPlan(fact));
  const afterLastPlan = others.findLastIndex(isUntestedPlan) + 1;
  const at = Math.max(firstProgress === -1 ? others.length : firstProgress, afterLastPlan);
  return [...others.slice(0, at), latest, ...others.slice(at)];
}

/**
 * The write's line: its operation, record, writer and the day it was written, then what it says. The prefix stays
 * first because readers find a write by it (`- create fact <id> by`). A write that carries the
 * text of the fact version it created says `passage` of it, marked first when a conflict has
 * since retired the version; any other says its summary, which carries that mark already.
 */
function formatWrite(
  write: ServedWrite & { supersededById?: string | null },
  passage: string,
  marker: string | null = null,
): string {
  const day = dayShown(write.writtenAt);
  const line = `- ${write.op} ${write.recordType} ${write.recordId} by ${write.actorId}${day === null ? "" : `, ${day}`}`;
  if (write.content !== undefined) {
    const superseded = write.supersededById ? `[superseded by ${write.supersededById}] ` : "";
    return `${line}: ${marked(marker)}${superseded}${passage}`;
  }
  return write.summary ? `${line}: ${marked(marker)}${write.summary}` : line;
}

function formatNote(note: ServedNote): string {
  return `- [${note.kind} ${note.id}] ${note.agentId} on "${clip(note.task, NOTE_TASK_SHOWN_CHARS)}", live until ${noteTime(note.expiresAt)}: ${clip(note.body, LINE_TEXT_MAX_CHARS)}`;
}

/** Longest task name the collapsed line repeats for a note on another task. */
const OTHER_NOTE_TASK_SHOWN_CHARS = 60;

/**
 * The one line naming the live notes on other tasks: who holds each and on what, and how many
 * are live in all when not all are named. It does not start with "- ", so readers that count a
 * block's record lines do not count it: a note on
 * another task is never what decides this one.
 */
function otherNotesLine(others: readonly ServedNote[], unnamed: number): string {
  if (others.length === 0)
    return `Also live in this scope: ${unnamed} more working ${unnamed === 1 ? "note" : "notes"}.`;
  const named = others.map(
    (note) => `${note.agentId} on "${clip(note.task, OTHER_NOTE_TASK_SHOWN_CHARS)}" [${note.kind} ${note.id}]`,
  );
  const more = unnamed > 0 ? `; ${unnamed} more` : "";
  return `Also live in this scope, on other tasks: ${named.join("; ")}${more}.`;
}

function formatStale(flag: StaleFlag): string {
  return `- fact ${flag.graphitiFactUuid}: its ${flag.sourceType} ${flag.sourceRef} moved since it was recorded`;
}

/**
 * One line of the block before it is cut: the revision key of the record it shows, the fact
 * version it shows, if any, and the record's text with how its line says a passage of it.
 * A line is only cut once the block reaches it, so a record the budget has no room for is
 * never scanned for its passage.
 */
interface Entry {
  key: string;
  factVersionId?: string;
  /** The fact version the line shows, by its text or by the write that stored it. */
  shownFactId?: string;
  /** The text a passage is cut from; "" for a line that shows none. */
  text: string;
  line: (passage: string) => string;
  /** The task terms the passage is cut around: none for the task's own records. */
  weights: TermWeights;
  /**
   * For a compact line: the most characters of its text it shows. Such a line never gets the
   * longer passage. Absent for every other line.
   */
  compactChars?: number;
  /** For a task write stored in parts: the revision keys and fact versions of its later parts, which its line shows too. */
  parts?: { keys: string[]; factVersionIds: string[] };
  /** The revision keys of further records the line names, beside {@link key}. */
  alsoKeys?: readonly string[];
  /** Content the line shows that has no stored version behind it: a working note, a source link. */
  readScopes?: readonly ReadScope[];
  /** Whether {@link line} carries the unverified mark. */
  marked?: boolean;
  /** Whether {@link line} serves a claim as a plan, which the premise check follows from. */
  plan?: boolean;
  /** The captures the line's status or mark was decided from, which the block then shows too. */
  statedCaptures?: readonly string[];
  /** Whether the line must leave the room held for the scope's first rules ({@link RESERVED_RULE_LINES}). */
  leavesRuleRoom?: boolean;
  /** Whether the line is one of the task's own writes, the first of which is served before any rule. */
  taskWrite?: boolean;
  /** The characters of the line its sources take, charged to {@link SOURCE_ALLOWANCE_TOKENS} while it lasts. */
  sourceChars?: number;
  /** How many records the line shows, counted as left out when it is: more than one for a conflicting set. */
  records?: number;
  /** The status recorded evidence gives the claim the line shows ({@link claimStatusOf}); absent for a line that shows none. */
  status?: ClaimStatus;
  /** Whether the line shows an option its writer rejected. */
  rejected?: boolean;
  /**
   * Whether the line opens the task's leads: a finding (a cause or a constraint its writer
   * declared, {@link FINDING_ROLES}), or an approach recorded evidence shows tested. A progress
   * note stays after the plans and the capture, and a rejected option beside its plan, tested or not.
   */
  readFirst?: boolean;
  /**
   * Whether the line shows one part of a record that the block serves on several lines (a
   * handoff's parts, a capture's run and message). The served log records the record at the first
   * of its lines the block shows, so one record served on six lines counts as one item.
   */
  splitRecord?: boolean;
  /** Whether the line shows a part of the task's newest handoff, whose room the other lines leave ({@link renderTaskStartBlock}). */
  handoffPart?: boolean;
}

/** A task's newest handoff (services/memory/session-handoff.ts): the write it is stored as, and its parts. */
interface ServedHandoff {
  write: ServedFact[];
  parts: HandoffParts;
}

/**
 * The newest handoff among the task's own writes that holds every part, or null. A write in a
 * conflicting set is served with the set instead, never on its own, so it is never this. A handoff
 * the read cut short of a part is served as any other write.
 */
function newestHandoff(
  writes: readonly ServedFact[][],
  inConflict: (fact: ServedFact) => boolean,
): ServedHandoff | null {
  let newest: ServedHandoff | null = null;
  for (const write of writes) {
    const head = write[0]!;
    if (!head.ofTask || !isHandoffName(head.entityName) || inConflict(head)) continue;
    const parts = handoffParts(write.map((fact) => fact.content).join("\n"));
    if (HANDOFF_PARTS.some((part) => parts[part.key] === null)) continue;
    if (newest === null || (head.writtenAt ?? "") > (newest.write[0]!.writtenAt ?? "")) newest = { write, parts };
  }
  return newest;
}

/**
 * A scope whose content a line shows without a stored version behind it, and the agent that
 * wrote that content when it is a working note. The reader's own note is its own text and
 * adds nothing to its session (services/access/derived-writes.ts).
 */
export interface ReadScope {
  scopePath: string;
  writtenBy?: string;
}

/** The rendered block, the revision token of exactly what it contains, and the fact versions its lines show. */
export interface TaskStartBlock {
  text: string | null;
  revision: string;
  factVersionIds: string[];
  /** Every fact version the block shows, by its text or by the write that stored it: what the erased-person check must clear. */
  shownFactIds: string[];
  /** The revision keys each item line shows, in the block's order: what the served log records (services/memory/task-start-served.ts). */
  lines: string[][];
  /** The scopes of the notes and source links the block shows, for the derived-write rule. */
  readScopes: ReadScope[];
}

/** `count` and `noun`, with the noun in the plural unless the count is one. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The line saying what changed while the agent was away: when its last call was, in UTC, then
 * the counts. Past the cap the writers and the task's share are left out, since they were
 * counted over the first changes only.
 */
export function sinceLastSessionLine(since: SinceLastSession): string {
  const opening = `${SINCE_LAST_SESSION_OPENING} (last call ${since.lastCallAt.toISOString().slice(0, 16).replace("T", " ")} UTC):`;
  if (since.capped) return `${opening} ${since.changes} or more changes by others in your scope.`;
  const onTask = since.onTask > 0 ? `, ${since.onTask} on this task` : "";
  return `${opening} ${counted(since.changes, "change")} by ${counted(since.writers, "other writer")} in your scope${onTask}.`;
}

/**
 * The most tokens the whole block can take: {@link TASK_START_TOKEN_BUDGET} and the sources'
 * allowance ({@link SOURCE_ALLOWANCE_TOKENS}), plus the two lines
 * that show no record at their longest, the premise check and the line on what changed since the
 * last session. The line is longest just under the cap, where every count has three digits; at
 * the cap it says "or more" and leaves the writers and the task's share out.
 */
export const TASK_START_MAX_TOKENS =
  TASK_START_TOKEN_BUDGET +
  SOURCE_ALLOWANCE_TOKENS +
  estimateTokens(`\n${TASK_START_PREMISE_CHECK}`) +
  estimateTokens(
    `\n${sinceLastSessionLine({
      lastCallAt: new Date(0),
      changes: MAX_WAITING_COUNTED - 1,
      capped: false,
      writers: MAX_WAITING_COUNTED - 1,
      onTask: MAX_WAITING_COUNTED - 1,
    })}`,
  );

/** The most tokens a boundary block can take: {@link TASK_START_MAX_TOKENS} with the boundary's records budget. */
export const BOUNDARY_TASK_START_MAX_TOKENS =
  TASK_START_MAX_TOKENS - TASK_START_TOKEN_BUDGET + BOUNDARY_TASK_START_TOKEN_BUDGET;

/**
 * The room the block's record lines share under `budget`: the budget less the header and the
 * closing line. The one place the records' room is decided; a line that shows no record is never
 * charged to it.
 */
function recordRoom(budget: number): number {
  return budget - estimateTokens(TASK_START_HEADER) - estimateTokens(CLOSING_LINE_RESERVE);
}

/** The line on what changed since the last session and the revision key naming what it says, or null when nothing did. */
function sinceEntry(since: SinceLastSession | null): { line: string; key: string } | null {
  if (since === null) return null;
  const line = sinceLastSessionLine(since);
  const counts = `${since.changes}/${since.capped ? "capped" : `${since.writers}/${since.onTask}`}`;
  return { line, key: recordRevisionKey("since", since.lastCallAt.toISOString(), counts) };
}

/**
 * Each conflicting set's versions (services/memory/served-conflicts.ts) as one item: the line that
 * asks the person ({@link conflictLine}), naming every version's source, then each version's own
 * line at its compact length. The item stands where the first of its versions stood in `lists`,
 * taken in order, and the others are taken out of where they stood. It is served whole or not at
 * all, so the block never shows one version of a conflict without the others, and it marks none
 * of them as the one that holds.
 */
function serveConflictsTogether(
  lists: readonly Entry[][],
  writes: ReadonlyMap<Entry, ServedFact[]>,
  setOf: ReadonlyMap<string, string>,
  leads: readonly Entry[],
): void {
  const sets = new Map<string, { list: Entry[]; entry: Entry }[]>();
  for (const list of lists) {
    for (const entry of list) {
      const set = setOf.get(writes.get(entry)?.[0]?.id ?? "");
      if (set !== undefined) sets.set(set, [...(sets.get(set) ?? []), { list, entry }]);
    }
  }
  for (const found of sets.values()) {
    if (found.length < 2) continue;
    const [first, ...rest] = found;
    const entries = found.map(({ entry }) => entry);
    const heads = entries.map((entry) => writes.get(entry)![0]!);
    // One source per writer: two people, or two connectors, under one label are still two sources.
    const byWriter = new Map(
      heads.map((fact) => [
        fact.writer?.actorId?.trim() ? `${fact.writer.actorType}\u0000${fact.writer.actorId}` : fact.id,
        fact,
      ]),
    );
    const ask = conflictLine(
      heads[0]!.entityName ?? "",
      [...byWriter.values()].map((fact) => sourceOf(fact.writtenBy, fact.writtenAt)),
    );
    const lines = entries.map((entry) =>
      entry.line(bestPassage(entry.text, entry.weights, entry.compactChars ?? LINE_TEXT_MAX_CHARS)),
    );
    const later = (entry: Entry) => entry.parts ?? { keys: [], factVersionIds: [] };
    const together: Entry = {
      key: first!.entry.key,
      factVersionId: first!.entry.factVersionId,
      shownFactId: first!.entry.shownFactId,
      text: "",
      line: () => [ask, ...lines].join("\n"),
      weights: NO_WEIGHTS,
      parts: {
        keys: [...later(first!.entry).keys, ...rest.flatMap(({ entry }) => [entry.key, ...later(entry).keys])],
        factVersionIds: [
          ...later(first!.entry).factVersionIds,
          ...rest.flatMap(({ entry }) => [entry.factVersionId!, ...later(entry).factVersionIds]),
        ],
      },
      marked: entries.some((entry) => entry.marked),
      // The premise check is said under the leads' heading, so only a set served there says a plan.
      plan: first!.list === leads && entries.some((entry) => entry.plan),
      statedCaptures: entries.flatMap((entry) => entry.statedCaptures ?? []),
      leavesRuleRoom: true,
      taskWrite: true,
      sourceChars: entries.reduce((chars, entry) => chars + (entry.sourceChars ?? 0), 0),
      records: entries.length,
      // A disputed cause is still a cause: the set opens the leads when any version would.
      readFirst: entries.some((entry) => entry.readFirst === true),
    };
    first!.list.splice(first!.list.indexOf(first!.entry), 1, together);
    for (const { list, entry } of rest) list.splice(list.indexOf(entry), 1);
  }
}

/**
 * Render sections in order under the budget. Each line goes in whole or not at all; a
 * line with a longer passage goes in short when the long form does not fit. A section's
 * heading only appears with at least one of its lines. The revision covers the lines that
 * made it in, so it names what the session was actually told.
 *
 * The line saying what changed since the agent's last session, when there is one, goes first,
 * under the header; the premise check goes under the leads' heading. Neither takes room from the
 * records ({@link recordRoom}), so the block is at most `budget` plus their cost. The sections
 * follow status, in the order the module comment gives, and a record the task's sections show is
 * not shown again below: a task decision is left out of the scope's rules, and a fact version's
 * own write out of the recent writes.
 *
 * The block's one planned test command is said only on a line the block serves: when the write
 * whose command is narrowest does not fit, the block is laid out again choosing among the others,
 * so a block whose lines name a test command never says none.
 */
export function renderTaskStartBlock(sections: TaskStartSections, budgetGiven?: number): TaskStartBlock {
  const unserved = new Set<string>();
  for (;;) {
    const { block, commandFrom } = layOutBlock(sections, budgetGiven, unserved);
    if (commandFrom === null || block.factVersionIds.includes(commandFrom)) return block;
    unserved.add(commandFrom);
  }
}

/** What {@link renderTaskStartBlock} lays out. */
type TaskStartSections = TaskStartContext &
  Partial<TaskContext> & {
    notes?: LiveNotes;
    writes: (ServedWrite & { supersededById?: string | null })[];
    since?: SinceLastSession | null;
    /** Set when the request reports a session boundary ({@link TaskStartRequest.boundary}). */
    boundary?: boolean;
  };

/**
 * One layout of the block ({@link renderTaskStartBlock}), choosing its planned test command from
 * every write of the task but those in `unserved`, and the fact id of the write it said it on.
 */
function layOutBlock(
  sections: TaskStartSections,
  budgetGiven: number | undefined,
  unserved: ReadonlySet<string>,
): { block: TaskStartBlock; commandFrom: string | null } {
  const header = TASK_START_HEADER;
  const decisions = sections.decisions ?? [];
  const weights = sections.weights ?? NO_WEIGHTS;
  const factWeights = sections.factWeights ?? NO_WEIGHTS;
  const shownDecisions = new Set(decisions.map((d) => d.id));
  // A version the winner rule retired, or one read only for its name, is served only inside a
  // conflicting set; every version in a set is served together, under one line that asks.
  const conflicts = servedConflicts(sections.facts ?? []);
  const taskFacts = conflicts.facts;
  const shownFacts = new Set(taskFacts.map((f) => f.id));

  // What the task's captures say about its tests, and the mark a completion claim of its own
  // carries when they do not back it; null when nothing was captured or nothing is unverified.
  // Decided from every capture the read found, not only those among the served facts, which a
  // task's later notes can push past the facts' limit.
  const servedCaptures = sessionStatesOf(taskFacts);
  const captures = sections.captures === undefined ? servedCaptures : sessionStatesOf(sections.captures.read);
  const unverified = unverifiedBy(captures);
  const markFor = (text: string) =>
    unverified !== null && claimsCompletion(text) ? UNVERIFIED[unverified.reason] : null;
  const captured = new Map(servedCaptures.map(({ fact, state }) => [fact, state]));

  // Each claim's status comes from recorded evidence (services/memory/claim-status.ts): who its
  // change event says recorded it, and what the captures of its own session, by the session key
  // their change events recorded, show it did after writing it. Never from its words or role.
  const sessionCaptures: SessionCapture[] = captures.map(({ id, writtenAt, state, fact }) => ({
    id,
    ...(writtenAt ? { writtenAt } : {}),
    state,
    sessionKey: fact.sessionKey ?? null,
    ...(fact.scopePath === undefined ? {} : { scopePath: fact.scopePath }),
  }));
  const statusOf = (
    claim: { by?: ClaimWriter; sessionKey?: string | null; writtenAt?: string; scopePath?: string },
    text: string,
  ): ClaimStatusOf =>
    claimStatusOf(
      {
        by: claim.by ?? "unknown",
        sessionKey: claim.sessionKey ?? null,
        ...(claim.writtenAt ? { writtenAt: claim.writtenAt } : {}),
        ...(claim.scopePath === undefined ? {} : { scopePath: claim.scopePath }),
        text,
      },
      sessionCaptures,
    );
  const factStatuses = new Map<ServedFact, ClaimStatusOf>();
  for (const write of writesOf(taskFacts)) {
    if (!captured.has(write[0]!))
      factStatuses.set(write[0]!, statusOf(write[0]!, write.map((fact) => fact.content).join("\n")));
  }
  // A plan of the task's own that a capture recorded no test run after: the capture is served after
  // every one of them, since the plan's label already says what backs it, and the capture's long
  // line must not take the room the plan needs. Its own session's capture makes it untested; one
  // its own session's capture does not speak to (no session recorded, or another session's) is
  // proposed, and goes first too when the task's latest capture, written after it, ran no test.
  const latest = servedCaptures[0];
  const latestRanNoTest = (fact: ServedFact) =>
    latest !== undefined && latest.state.lastTest === "none" && (latest.fact.writtenAt ?? "") >= (fact.writtenAt ?? "");
  const isUntestedPlan = (fact: ServedFact) => {
    const status = factStatuses.get(fact)?.status;
    const open = status === "untested" || (status === "proposed" && latestRanNoTest(fact));
    return fact.ofTask === true && open && PLAN_ROLES.includes(fact.role);
  };
  const facts = latestCaptureFirst(taskFacts, servedCaptures[0]?.fact, isUntestedPlan);

  // A block at a session boundary, or for a task that holds a handoff, is laid out for finishing
  // the work: what is verified first, then what still fails, the decisions and why, live state and
  // questions, and the plan and next step last, as claims to check. The newest handoff is served
  // part by part where each belongs, and the newest capture split into what the hook saw and the
  // agent's last message, which nothing has checked. Its records get a budget of their own.
  const handoff = newestHandoff(writesOf(taskFacts), (fact) => conflicts.setOf.has(fact.id));
  const boundary = sections.boundary === true || handoff !== null;
  const budget = budgetGiven ?? (boundary ? BOUNDARY_TASK_START_TOKEN_BUDGET : TASK_START_TOKEN_BUDGET);
  const boundaryCapture = boundary ? servedCaptures[0] : undefined;

  // The task's own records are cut with no task terms, so the task's wording never changes them.
  const ruleEntry = (
    rule: ServedRule,
    ruleWeights: TermWeights,
    {
      compactChars,
      marker = null,
      status,
    }: { compactChars?: number; marker?: string | null; status?: ClaimStatusOf } = {},
  ): Entry => {
    const type = status === undefined ? null : ruleTypeOf(rule.kind, status);
    const label = status !== undefined ? statusLabel(type!, status) : rule.by === "agent" ? AGENT_RECORDED : null;
    return {
      key: recordRevisionKey("convention", rule.id, 1),
      text: rule.text,
      line: (passage) => formatRule(rule, passage, marker, label),
      weights: ruleWeights,
      marked: marker !== null,
      plan: isPlan(type),
      statedCaptures: status?.captures ?? [],
      sourceChars: sourceSuffix(rule).length,
      ...(compactChars === undefined ? {} : { compactChars }),
      ...(status === undefined ? {} : { status: status.status }),
    };
  };
  // A capture states its own tests first; any other fact the task wrote is marked by its own
  // claim. A version another task or a person wrote under the same name is not this task's claim.
  const factEntry = (fact: ServedFact): Entry => {
    const state = captured.get(fact);
    const marker = state || !fact.ofTask ? null : markFor(fact.content);
    return {
      key: recordRevisionKey("fact", fact.id, 1),
      factVersionId: fact.id,
      shownFactId: fact.id,
      text: state ? sessionStateText(fact, state) : fact.content,
      line: (passage) => formatFact(fact, passage, { marker }),
      weights: NO_WEIGHTS,
      marked: marker !== null,
    };
  };
  // Only a write the same task recorded is marked: another task's claim is not this task's to judge.
  const writeEntry = (write: ServedWrite & { supersededById?: string | null }): Entry => {
    const marker = write.ofTask ? markFor(`${write.summary}\n${write.content ?? ""}`) : null;
    return {
      key: recordRevisionKey("change", write.id, 1),
      factVersionId: factVersionsIn([write])[0],
      ...(write.recordType === FACT_RECORD_TYPE ? { shownFactId: write.recordId } : {}),
      text: write.content ?? "",
      line: (passage) => formatWrite(write, passage, marker),
      weights,
      marked: marker !== null,
      sourceChars: dayShown(write.writtenAt) === null ? 0 : ", 00-00".length,
    };
  };
  const fixedEntry = (line: string, key: string): Entry => ({ key, text: "", line: () => line, weights: NO_WEIGHTS });

  // The test a write plans is said after its excerpt, so no cut drops it: from a capture that
  // recognised no run, its agent's last message; from any other write of the task, its own text.
  // The block says one command, the narrowest any of these writes names, on the first line that
  // names it; another write's line says only the test files it names. Each sentence is said once.
  const plannedSourceOf = (write: readonly ServedFact[]): string | null => {
    const state = captured.get(write[0]!);
    return state
      ? state.lastTest === "none"
        ? state.lastMessage
        : null
      : write[0]!.ofTask
        ? write.map((fact) => fact.content).join("\n")
        : null;
  };
  // A boundary serves the newest handoff and capture by their parts, with no planned test.
  const saysPlannedTest = (write: readonly ServedFact[]) =>
    write[0] !== handoff?.write[0] && write[0] !== boundaryCapture?.fact;
  const candidates = writesOf(facts).filter((write) => saysPlannedTest(write) && !unserved.has(write[0]!.id));
  let plannedCommand = narrowestTestCommand(
    candidates.flatMap((write) => testCommandsIn(plannedSourceOf(write) ?? "")),
  );
  let commandFrom: string | null = null;
  const plannedSaid = new Set<string>();
  const plannedTestFor = (write: readonly ServedFact[]): string | null => {
    const source = plannedSourceOf(write);
    const planned = source
      ? plannedTestOf(source, { command: unserved.has(write[0]!.id) ? null : plannedCommand })
      : null;
    const sentence = planned ? plannedTestSentence(planned) : null;
    if (sentence === null || plannedSaid.has(sentence)) return null;
    if (planned!.command !== null) {
      plannedCommand = null;
      commandFrom = write[0]!.id;
    }
    plannedSaid.add(sentence);
    return sentence;
  };

  // Each of the task's writes is one line: an excerpt of all its parts, cut around the session's
  // terms, opened by its status label (a capture by its own), marked when any part claims
  // completion, and followed by the test it plans. A capture is served from its opening, which
  // states its test run, at CAPTURE_MAX_CHARS whatever the session's words. A write a person
  // recorded is settled; every other is a lead.
  const settledFacts: Entry[] = [];
  const leadFacts: Entry[] = [];
  const writeEntries = new Map<Entry, ServedFact[]>();
  for (const write of writesOf(facts)) {
    // At a boundary the newest handoff and capture are served by their parts, below.
    if (write[0] === handoff?.write[0] || write[0] === boundaryCapture?.fact) continue;
    const [head, ...parts] = write.map(factEntry);
    const claims = write.filter((fact) => fact.ofTask && !captured.has(fact)).map((fact) => fact.content);
    const marker = claims.length === 0 ? null : markFor(claims.join("\n"));
    const status = factStatuses.get(write[0]!);
    const type = status === undefined ? null : claimTypeOf(write[0]!.role, status);
    const label = status === undefined ? TASK_START_CAPTURE_LABEL : statusLabel(type!, status);
    const after = plannedTestFor(write);
    // Line by line, as stored: the passage is cut at line ends and sentence ends, and a header
    // line every part repeats is served once (bestPassage). A plan, a rejected option or a note of
    // the task's own leaves out a sentence that is only a test command or a verify list, which the
    // planned test says once and narrowest, so it never takes the room of the approach. A capture
    // is served as the hook saw it, a finding whole, so no cause is cut for naming the test that
    // shows it, and another writer's version under the task's name as written: its commands are
    // not among those the planned test is chosen from.
    const finding = FINDING_ROLES.includes(write[0]!.role);
    const text = [head!, ...parts].map((part) => part.text).join("\n");
    const cutsCommands = write[0]!.ofTask === true && !captured.has(write[0]!) && !finding;
    const entry: Entry = {
      ...head!,
      text: cutsCommands ? withoutTestCommands(text) : text,
      line: (passage: string) => formatFact(write[0]!, passage, { moreParts: parts.length, marker, label, after }),
      weights: captured.has(write[0]!) ? NO_WEIGHTS : factWeights,
      // A capture's label and planned test are said within its length, so saying them never
      // lengthens the line and never takes room another record needs.
      compactChars: captured.has(write[0]!) ? CAPTURE_MAX_CHARS - captureExtrasLength(after) : TASK_FACT_EXCERPT_CHARS,
      marked: marker !== null,
      plan: isPlan(type),
      statedCaptures: status?.captures ?? [],
      leavesRuleRoom: true,
      taskWrite: true,
      parts: { keys: parts.map((part) => part.key), factVersionIds: parts.map((part) => part.factVersionId!) },
      sourceChars: sourceSuffix(write[0]!).length,
      ...(status === undefined ? {} : { status: status.status }),
      rejected: type === "rejected option",
      readFirst:
        finding || (status?.status === "tested" && write[0]!.role !== "progress" && write[0]!.role !== "rejected"),
    };
    (status?.status === "verified" ? settledFacts : leadFacts).push(entry);
    writeEntries.set(entry, write);
  }
  serveConflictsTogether([settledFacts, leadFacts], writeEntries, conflicts.setOf, leadFacts);

  // The task's decisions and conventions: settled only when a person recorded them. Anything else
  // the task recorded, whichever kind its writer declared, is a lead served by its status, so an
  // agent cannot settle its own plan by recording it as a convention. A person's convention is
  // settled with no label; a person's decision says it is verified.
  const taskDecisionEntry = (d: ServedRule): Entry => {
    const marker = d.ofTask ? markFor(`${d.subject}\n${d.text}`) : null;
    if (d.kind !== "decision" && d.by === "person") return ruleEntry(d, NO_WEIGHTS, { marker });
    return ruleEntry(d, NO_WEIGHTS, { marker, status: statusOf(d, `${d.subject}\n${d.text}`) });
  };
  const decisionEntries = decisions.map((d) => ({ entry: taskDecisionEntry(d), settled: d.by === "person" }));

  // The scope's rules: a rule in force whoever recorded it, tagged when an agent did, and a
  // decision a person recorded. A decision anyone else recorded is a lead, after the task's own.
  const scopeRules = sections.rules.filter((r) => !shownDecisions.has(r.id));
  const rulesInForce = scopeRules.filter(ruleIsSettled);
  const scopeLeads = scopeRules.filter((r) => !rulesInForce.includes(r));

  // The notes on this task come first, whole: a live claim on it decides whether to start at
  // all. Its questions follow the rules; the notes on other tasks are related, on one line.
  const notes = sections.notes ?? { served: [], total: 0 };
  const noteKey = (n: ServedNote) => recordRevisionKey("note", n.id, n.expiresAt.toISOString());
  const noteScope = (n: ServedNote): ReadScope => ({ scopePath: n.scopePath, writtenBy: n.agentId });
  const noteEntry = (n: ServedNote): Entry => ({
    ...fixedEntry(formatNote(n), noteKey(n)),
    readScopes: [noteScope(n)],
  });
  const ownNotes = notes.served.filter((n) => n.ofTask);
  const otherNotes = notes.served.filter((n) => !n.ofTask);
  const unnamedNotes = notes.total - notes.served.length;
  // The task's leads open with its findings and what recorded evidence shows tested, then the
  // plans, each beside the options its writer rejected (the read ranks both as deciding, so they
  // stay together), then the rest in the read's order. A plan nothing tested is the one most likely
  // wrong, so it is read after the cause that says where to look, and is the first a short budget cuts.
  const taskDecisionLeads = decisionEntries
    .filter(({ settled }) => !settled)
    .map(({ entry }) => ({ ...entry, readFirst: entry.status === "tested" }));
  const taskLeads = [...taskDecisionLeads, ...leadFacts];
  const leads = [
    ...taskLeads.filter((entry) => entry.readFirst === true),
    ...taskLeads.filter((entry) => entry.readFirst !== true),
    ...scopeLeads.map((r) => ({
      ...ruleEntry(r, weights, { compactChars: RULE_TEXT_MAX_CHARS, status: statusOf(r, `${r.subject}\n${r.text}`) }),
      leavesRuleRoom: true,
    })),
  ];
  const related: Entry[] = [
    ...(otherNotes.length === 0 && unnamedNotes === 0
      ? []
      : [
          {
            ...fixedEntry(
              otherNotesLine(otherNotes, unnamedNotes),
              recordRevisionKey("notes", "unnamed", unnamedNotes),
            ),
            alsoKeys: otherNotes.map(noteKey),
            readScopes: otherNotes.map(noteScope),
          },
        ]),
    ...sections.writes
      .filter((w) => !(w.recordType === FACT_RECORD_TYPE && shownFacts.has(w.recordId)))
      .map(writeEntry),
    ...sections.stale.map((f) => ({
      ...fixedEntry(formatStale(f), recordRevisionKey("provenance", f.id, f.flaggedAt.toISOString())),
      readScopes: [{ scopePath: f.scopePath }],
    })),
  ];
  const settled = [...decisionEntries.filter(({ settled }) => settled).map(({ entry }) => entry), ...settledFacts];
  const rules = rulesInForce.map((r) => ruleEntry(r, weights, { compactChars: RULE_TEXT_MAX_CHARS }));
  const liveNotes = ownNotes.filter((n) => n.kind !== "question").map(noteEntry);
  const questions = ownNotes.filter((n) => n.kind === "question").map(noteEntry);

  // One line of a record the boundary block serves on several: written out whole here, so no cut
  // around the session's terms can drop the start a reader needs.
  const splitLine = (fact: ServedFact, line: string, extra: Partial<Entry> = {}): Entry => ({
    key: recordRevisionKey("fact", fact.id, 1),
    factVersionId: fact.id,
    shownFactId: fact.id,
    text: "",
    line: () => line,
    weights: NO_WEIGHTS,
    leavesRuleRoom: true,
    taskWrite: true,
    sourceChars: sourceSuffix(fact).length,
    splitRecord: true,
    ...extra,
  });

  // The newest handoff's parts, each labelled by what recorded evidence shows of that part, never
  // by its words. "Done and checked:" is a claim about work done: its status comes from its own text
  // alone, the files it names, so a run on a file only the next step names never verifies it. Every
  // other part is open by what it is (still to do, not yet checked, the next step, a choice made or
  // turned down): a passing run after it does not settle it, so it is never labelled above untested.
  const handoffStatusOf = (
    key: HandoffPart,
  ): (Omit<ClaimStatusOf, "reason"> & { reason: ClaimStatusReason | "open-by-kind" }) | null => {
    if (handoff === null) return null;
    const status = statusOf(handoff.write[0]!, handoff.parts[key]!);
    if (key === "checked" || !SETTLED_STATUSES.has(status.status)) return status;
    return { status: "proposed", reason: "open-by-kind", captures: status.captures };
  };
  const handoffLine = (key: HandoffPart): Entry[] => {
    const status = handoffStatusOf(key);
    if (handoff === null || status === null) return [];
    const head = handoff.write[0]!;
    const { heading } = HANDOFF_PARTS.find((part) => part.key === key)!;
    const later = handoff.write.slice(1).map((fact) => fact.id);
    const line = formatFact(head, `${heading} ${clip(handoff.parts[key]!, HANDOFF_PART_MAX_CHARS)}`, {
      moreParts: later.length,
      label: statusLabel("handoff", status),
    });
    return [
      splitLine(head, line, {
        handoffPart: true,
        statedCaptures: status.captures,
        status: status.status,
        parts: { keys: later.map((id) => recordRevisionKey("fact", id, 1)), factVersionIds: later },
      }),
    ];
  };
  const checkedIsTested = SETTLED_STATUSES.has(handoffStatusOf("checked")?.status ?? "proposed");

  // The newest capture: what the hook saw (its run, the files and functions changed) is verified,
  // or unfinished when the run failed; the agent's last message is a claim like any other.
  const captureLines = (() => {
    if (boundaryCapture === undefined) return { observed: [] as Entry[], failed: false, message: [] as Entry[] };
    const { fact, state } = boundaryCapture;
    const messageAt = state.rest.lastIndexOf(LAST_MESSAGE_OPENING);
    const beforeMessage = (messageAt === -1 ? state.rest : state.rest.slice(0, messageAt).trimEnd()).split("\n");
    // The commands line holds the agent's own words (a commit message, an echo): it is served with
    // the agent's claims, not as observed.
    const commandsLine = beforeMessage.find((line) => line.startsWith(COMMANDS_LINE_OPENING));
    const observedRest = beforeMessage.join("\n");
    const seen = clip(
      sessionStateText(fact, { ...state, rest: observedRest }),
      CAPTURE_MAX_CHARS - TASK_START_OBSERVED_LABEL.length - 1,
    );
    const failed = state.lastTest !== null && state.lastTest !== "none" && state.lastTest.result === "failed";
    const message = [
      ...(commandsLine === undefined
        ? []
        : [
            splitLine(
              fact,
              formatFact(fact, clip(commandsLine, COMMANDS_SHOWN_CHARS), { label: TASK_START_CAPTURE_LABEL }),
            ),
          ]),
      ...(state.lastMessage === null
        ? []
        : [
            splitLine(
              fact,
              formatFact(fact, `${LAST_MESSAGE_OPENING}${clip(state.lastMessage, LAST_MESSAGE_SHOWN_CHARS)}`, {
                label: TASK_START_CAPTURE_LABEL,
              }),
            ),
          ]),
    ];
    return {
      observed: [splitLine(fact, formatFact(fact, seen, { label: TASK_START_OBSERVED_LABEL }))],
      failed,
      message,
    };
  })();
  const tested = (entry: Entry) => entry.status === "tested";
  const decidedLeads = leads.filter((entry) => entry.rejected && !tested(entry));
  const claimLeads = leads.filter((entry) => !tested(entry) && !decidedLeads.includes(entry));

  const all: { heading: string; entries: Entry[] }[] = boundary
    ? [
        {
          heading: TASK_START_HEADINGS.verified,
          entries: [
            ...(captureLines.failed ? [] : captureLines.observed),
            ...(checkedIsTested ? handoffLine("checked") : []),
            ...settled,
            ...leads.filter(tested),
          ],
        },
        {
          heading: TASK_START_HEADINGS.unfinished,
          entries: [...(captureLines.failed ? captureLines.observed : []), ...handoffLine("unfinished")],
        },
        {
          heading: TASK_START_HEADINGS.decided,
          entries: [...handoffLine("decisions"), ...handoffLine("rejected"), ...decidedLeads],
        },
        { heading: TASK_START_HEADINGS.live, entries: liveNotes },
        { heading: TASK_START_HEADINGS.questions, entries: questions },
        {
          heading: TASK_START_HEADINGS.claims,
          entries: [
            ...(checkedIsTested ? [] : handoffLine("checked")),
            ...handoffLine("unchecked"),
            ...handoffLine("next"),
            ...captureLines.message,
            ...claimLeads,
          ],
        },
        { heading: TASK_START_HEADINGS.rules, entries: rules },
        { heading: TASK_START_HEADINGS.related, entries: related },
      ]
    : [
        { heading: TASK_START_HEADINGS.live, entries: liveNotes },
        { heading: TASK_START_HEADINGS.settled, entries: settled },
        { heading: TASK_START_HEADINGS.leads, entries: leads },
        { heading: TASK_START_HEADINGS.rules, entries: rules },
        { heading: TASK_START_HEADINGS.questions, entries: questions },
        { heading: TASK_START_HEADINGS.related, entries: related },
      ];
  // Where the premise check goes: under the heading of the section that serves plans.
  const planHeading = boundary ? TASK_START_HEADINGS.claims : TASK_START_HEADINGS.leads;

  const lines = [header];
  const keys: string[] = [];
  const factVersionIds: string[] = [];
  const shownFactIds: string[] = [];
  const readScopes: ReadScope[] = [];
  const itemLines: string[][] = [];
  let left = 0;
  let markShown = false;
  let planShown = false;
  const stated: string[] = [];
  // Every record line is measured against this one room and nothing else is charged to it.
  const room = recordRoom(budget);
  let used = 0;
  // The room the task's writes leave for the scope's first rules: each rule's line at its
  // compact length, under its heading, as the rules section would serve it.
  const ruleReserve = rulesInForce.slice(0, RESERVED_RULE_LINES).reduce(
    (tokens, rule) => {
      const entry = ruleEntry(rule, NO_WEIGHTS);
      const line = `\n${entry.line(clip(oneLine(rule.text), RULE_TEXT_MAX_CHARS))}`;
      return tokens + estimateTokens(line.slice(entry.sourceChars ?? 0));
    },
    rulesInForce.length === 0 ? 0 : estimateTokens(`\n${TASK_START_HEADINGS.rules}`),
  );

  // The first SUBSTANCE_RECORDS lines whose record is about the task (isAboutTheTask)
  // and whose longer passage fits get it, in the block's order; a relevant line whose longer passage does not
  // fit is cut short and leaves its turn to the next. A compact line is never given it. Every
  // other line is cut short, around the task's terms when its record holds any.
  let substanceLeft = SUBSTANCE_RECORDS;
  const cut = (
    { text, line, weights: cutAround, compactChars }: Entry,
    fits: (candidate: string) => boolean,
  ): string | null => {
    // A line too long with no passage cannot fit with one, so its text is never scanned.
    if (!fits(line(""))) return null;
    if (text === "") return line("");
    if (compactChars === undefined && substanceLeft > 0 && isAboutTheTask(cutAround, termsOf(rankedText(text)))) {
      const long = line(bestPassage(text, cutAround, SUBSTANCE_MAX_CHARS));
      if (fits(long)) {
        substanceLeft--;
        return long;
      }
    }
    const short = line(bestPassage(text, cutAround, compactChars ?? LINE_TEXT_MAX_CHARS));
    return fits(short) ? short : null;
  };

  let servedTaskWrites = 0;
  let sourceLeft = SOURCE_ALLOWANCE_TOKENS;
  const splitShown = new Set<string>();
  // The handoff's parts are what the next session finishes from, and its next step is served last,
  // so every other line leaves the room they take: a long list of verified records never cuts the
  // next step. Each part's line is a fixed length (HANDOFF_PART_MAX_CHARS), so its room is known.
  const handoffRoom = new Map(
    all.flatMap((section) =>
      section.entries
        .filter((entry) => entry.handoffPart)
        .map(
          (entry) => [entry, estimateTokens(`\n${section.heading}`) + estimateTokens(`\n${entry.line("")}`)] as const,
        ),
    ),
  );
  let handoffLeft = [...handoffRoom.values()].reduce((tokens, room) => tokens + room, 0);
  for (const section of all) {
    let headed = false;
    for (const entry of section.entries) {
      const headingCost = headed || section.heading === "" ? 0 : estimateTokens(`\n${section.heading}`);
      // A task write after the first, and a lead from the scope, leave the room held for the
      // scope's first rules: the task's most relevant write comes before any rule, however small
      // the budget.
      const held = entry.leavesRuleRoom && !(entry.taskWrite && servedTaskWrites === 0) ? ruleReserve : 0;
      // The tokens a line's sources add are charged to their allowance while it lasts, not to the
      // room: the room is charged what the line costs without them.
      const sourceCost = (candidate: string) => {
        const line = `\n${candidate}`;
        return Math.min(estimateTokens(line) - estimateTokens(line.slice(entry.sourceChars ?? 0)), sourceLeft);
      };
      const ownRoom = handoffRoom.get(entry);
      const leftForHandoff = ownRoom === undefined ? handoffLeft : handoffLeft - ownRoom;
      const fits = (candidate: string) =>
        used + headingCost + estimateTokens(`\n${candidate}`) - sourceCost(candidate) + held + leftForHandoff <= room;
      const served = cut(entry, fits);
      if (ownRoom !== undefined) handoffLeft -= ownRoom;
      if (served === null) {
        left += entry.records ?? 1;
        continue;
      }
      if (!headed && section.heading !== "") lines.push(section.heading);
      headed = true;
      lines.push(served);
      if (entry.marked) markShown = true;
      if (entry.plan) planShown = true;
      stated.push(...(entry.statedCaptures ?? []));
      if (entry.taskWrite) servedTaskWrites++;
      // A record served on several lines is logged and counted once, at the first line shown.
      const again = entry.splitRecord === true && splitShown.has(entry.key);
      if (entry.splitRecord) splitShown.add(entry.key);
      const partKeys = again ? [] : (entry.parts?.keys ?? []);
      const partVersions = again ? [] : (entry.parts?.factVersionIds ?? []);
      if (!again) keys.push(entry.key, ...partKeys, ...(entry.alsoKeys ?? []));
      if (entry.factVersionId && !again) factVersionIds.push(entry.factVersionId);
      if (entry.shownFactId && !again) shownFactIds.push(entry.shownFactId);
      factVersionIds.push(...partVersions);
      shownFactIds.push(...partVersions);
      readScopes.push(...(entry.readScopes ?? []));
      itemLines.push(again ? [] : [entry.key, ...partKeys]);
      const free = sourceCost(served);
      used += headingCost + estimateTokens(`\n${served}`) - free;
      sourceLeft -= free;
    }
  }

  const sinceShown = sinceEntry(sections.since ?? null);
  if (keys.length === 0 && sinceShown === null) {
    return {
      block: {
        text: null,
        revision: revisionToken([]),
        factVersionIds: [],
        shownFactIds: [],
        lines: [],
        readScopes: [],
      },
      commandFrom,
    };
  }
  if (left > 0) lines.push(`(${left} more left out: ask memory_query for them)`);
  // The premise check follows the leads' heading, so it is read before the plans it is about.
  // At a boundary it is said whenever claims are, since the next step is one.
  if ((planShown || boundary) && lines.includes(planHeading))
    lines.splice(lines.indexOf(planHeading) + 1, 0, TASK_START_PREMISE_CHECK);
  // The line on what changed since the last session comes first of all. It shows no record, so
  // it is not one of the served log's item lines, and its revision key names the counts it said.
  if (sinceShown !== null) {
    lines.splice(1, 0, sinceShown.line);
    keys.push(sinceShown.key);
  }
  // A mark or a status says what captures recorded, so they are shown in it even when their own
  // lines are not: the erased-person check clears them, and the revision names them.
  const statedCaptures = [...(markShown && unverified !== null ? unverified.captures : []), ...stated];
  for (const id of statedCaptures) {
    if (!shownFactIds.includes(id)) shownFactIds.push(id);
    const key = recordRevisionKey("fact", id, 1);
    if (!keys.includes(key)) keys.push(key);
  }
  return {
    block: {
      text: lines.join("\n"),
      revision: revisionToken(keys),
      factVersionIds,
      shownFactIds,
      lines: itemLines,
      readScopes,
    },
    commandFrom,
  };
}

/**
 * The task-start block for this call, or null when this session was already served the
 * block for this task and scope, or there is nothing to say. A request made right after a
 * compaction makes the block due again first, so the compacted session is told it once more.
 *
 * The caller must already have decided with can() that `ctx` may read
 * `request.scopePath`. A block with content is then authorized again with the audited
 * check(), so each delivery leaves one audit row and a quiet session leaves none.
 *
 * @throws AccessDeniedError when access was revoked between the caller's can() and
 * this check(); nothing is delivered and the session is not marked served.
 */
export async function taskStartNotice(ctx: AccessContext, request: TaskStartRequest): Promise<string | null> {
  const delivery = { sessionKey: request.sessionKey, scopePath: request.scopePath, taskKey: request.taskKey ?? "" };
  if (request.compactedAt !== undefined) await markTaskStartDue(ctx, delivery, request.compactedAt);
  if (await sessionAlreadyServed(ctx, delivery)) return null;

  // A write whose version later lost a conflict is still recent run state, but its text
  // is not what the fact says; it is served marked as superseded, never bare. The record
  // of who won came back with the read, so marking costs no statement of its own.
  const render = ({ context, task, notes, winners, since }: TaskStartRead) =>
    renderTaskStartBlock({
      ...context,
      ...task,
      notes,
      since,
      writes: markWritesAgainst(context.writes, winners),
      boundary: request.boundary === true,
    });
  // The erased-person check runs on what the block shows, and the block is rendered again
  // without any record that fails it. The last rendering is of the read that passed.
  const last = new Map<TaskStartRead, TaskStartBlock>();
  const servable = await readServableTaskStart(
    ctx,
    request.scopePath,
    request.taskText,
    request.taskKey ?? "",
    (read) => {
      last.clear();
      last.set(read, render(read));
      return last.get(read)!.shownFactIds;
    },
  );
  const block = last.get(servable) ?? render(servable);
  if (block.text !== null) {
    const decision = await check(ctx, { action: "memory.read", scope: request.scopePath });
    if (!decision.allowed) throw new AccessDeniedError(decision);
  }
  // A reply nobody will read must not use up the session's block: it is claimed only while
  // the caller still waits, and otherwise left for the session's next call.
  if (request.abandoned?.aborted) return null;
  // A line showing a fact version, a task's fact or a recent write, may cut its text,
  // so it counts as the change feed's lines do: a sighting (services/memory/fact-reads.ts).
  // Another agent's working note and a source link have no stored version; the scope each
  // was read from joins the agent's record for the derived-write rule (services/access/derived-writes.ts).
  // Both are recorded by the claim's own statement, so only a claimed block records them,
  // and always does: there is no moment where the block is claimed and its scopes are not yet recorded.
  const actorId = ctx.actor.id;
  const shown =
    ctx.actor.type === "agent"
      ? {
          agentId: actorId,
          versionIds: block.factVersionIds,
          scopePaths: block.readScopes.filter((read) => read.writtenBy !== actorId).map((read) => read.scopePath),
        }
      : undefined;
  // Recorded even when empty, so a quiet session costs one update per call after this.
  if (!(await claimTaskStartDelivery(ctx, delivery, block.revision, block.lines, shown))) return null;
  if (block.text !== null) request.onShown?.(block.factVersionIds);
  return block.text;
}
