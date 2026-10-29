// The fixed lines a tool result's piggyback prints: the task-start block's opening and section
// headings (mcp/task-start-notice.ts), and the change notices' heading (mcp/change-notices.ts).
//
// The one rule this file enforces: every reader that finds the block, a section of it or the
// change notices by these lines imports them from here, never a copy of the text. A copy goes
// stale the day a heading changes, and a reader keyed on the old text then finds nothing.
// `mcp/task-start-headings.drift.test.ts`
// fails when a source file spells one of these lines out instead of importing it.
//
// No imports, so a script can read these without loading the database client.

/** The block's first line. Its wording may change; its {@link TASK_START_OPENING} does not. */
export const TASK_START_HEADER = "Before you start: what Willder holds for this task; each line says what backs it.";

/**
 * How the block's first line opens, under this header and every one served before it: what a
 * reader finds the block by, so a block a stored transcript or an older deploy carries is still found.
 */
export const TASK_START_OPENING = "Before you start:";

/**
 * Where the task-start block starts in a tool result's text: the first line that opens with
 * {@link TASK_START_OPENING}, or -1 when none does. Only a line's start counts, so an answer that
 * quotes the opening inside a line is not taken for the block.
 */
export function taskStartBlockAt(text: string): number {
  if (text.startsWith(TASK_START_OPENING)) return 0;
  const at = text.indexOf(`\n${TASK_START_OPENING}`);
  return at === -1 ? -1 : at + 1;
}

/**
 * The line after the leads' heading when the block serves a claim as a plan: one nothing recorded
 * shows worked (services/memory/claim-status.ts). It does not start with "- ", so readers that
 * count a block's record lines do not count it.
 */
export const TASK_START_PREMISE_CHECK =
  "A plan is a hypothesis until it is tested: before building on one, check in the code the claims it rests on (what owns what, whether a named event or pattern exists, the repo's existing convention); options it rejected may be the right ones.";

/**
 * How the line after the header opens when the session is a return and something changed in its
 * scope while the agent was away (services/memory/since-last-session.ts). Like the premise check
 * it does not start with "- ", so readers that count a block's record lines do not count it.
 */
export const SINCE_LAST_SESSION_OPENING = "Since your last session";

/**
 * What a decision's label says when nothing recorded shows a test run backing it
 * (services/memory/claim-status.ts, status proposed or untested): an approach another session
 * chose and never ran a test on. Its line is served after the task's causes and constraints, so a
 * reader checks it against the code instead of following it (mcp/task-start-notice.ts).
 */
export const TASK_START_UNTESTED_PLAN = "untested plan: verify before following";

/**
 * How a captured session state's line opens, in place of a claim's status label: what the hook
 * saw a session do (cli/hooks/willder-capture.mjs), marked unverified like any lead, since the
 * line also quotes the agent's last message and nothing has checked what that message claims.
 */
export const TASK_START_CAPTURE_LABEL = "[run state · unverified: as the hook saw it]";

/**
 * How the line opens that serves a task's conflicting versions of one fact together
 * (services/memory/served-conflicts.ts): the fact's name, every version's source, and the ask to
 * check with the person before acting on any. Like the premise check it does not start with "- ",
 * so readers that count a block's record lines count only the versions under it.
 */
export const CONFLICT_OPENING = "Conflicting versions of";

/**
 * How the line opens that serves what the hook itself saw a session do, in a block at a session
 * boundary: its last test run, the files and functions it changed. The agent's last message, which
 * nothing has checked, is served apart, under {@link TASK_START_CAPTURE_LABEL}; the label still says
 * so, because the line names the record and memory_version opens it whole, message included.
 */
export const TASK_START_OBSERVED_LABEL = "[run state · observed: by the hook; the agent's message in it is unverified]";

/**
 * The block's section headings, by the status of what each holds (services/memory/claim-status.ts).
 * A section is headed only when it serves a line. A first block prints live, settled, leads, rules,
 * questions, related, in that order. A block at a session boundary, or for a task with a handoff
 * (services/memory/session-handoff.ts), prints what decides how to finish first and the plan last:
 * verified, unfinished, decided, live, questions, claims, rules, related.
 */
export const TASK_START_HEADINGS = {
  /** The working notes on this task, live now. */
  live: "Live now:",
  /** The task's conventions, decisions and facts a person recorded. */
  settled: "Settled for this task:",
  /** What earlier sessions left that nothing recorded settles, each with its status. */
  leads: "Leads to verify (earlier sessions left these; memory_version opens a fact whole):",
  /** The scope's rules in force, and decisions a person recorded. */
  rules: "Settled in your scope (rules in force):",
  /** The questions open on this task. */
  questions: "Open questions on this task:",
  /** Notes on other tasks, recent writes that mention the task, and sources that moved. */
  related: "Related to this task:",
  /** At a boundary: a person's records, claims recorded evidence shows tested, and what the hook saw the last session do. */
  verified: "Verified (recorded by a person, or seen by the hook):",
  /** At a boundary: the hook's failed run, and what the handoff says still fails or is unfinished. */
  unfinished: "What still fails or is unfinished:",
  /** At a boundary: the handoff's decisions and rejected options, and the task's rejected options, with their reasons. */
  decided: "Decisions and rejected options, with their reasons:",
  /** At a boundary: plans, what the handoff did not check, its next step, and the agent's last message. */
  claims: "Claims to check before building on them (plans and the next step; memory_version opens a fact whole):",
} as const;

/** A recent write's line names the day after its writer: `- create fact <id> by builder, 10-15: ...`. */
const WRITE_DAY = /^(- \S+ \S+ \S+ by \S+), \d\d-\d\d(?=:|$)/;

/** A line that ends with a source: a rule's (`- [convention <id>]`, `- [decision <id>]`) or a fact's (` [fact <id>]`). */
export const SOURCED_LINE = /^- \[(?:convention|decision) |\[fact [^\]]+\]/;

/**
 * `block` with the source each line names taken out (mcp/task-start-notice.ts, sourceOf): a rule
 * or fact line from its last " — " to its end, and a recent write's day after its writer. Every
 * reader that parses a served line's text, rather than only its id, reads it through this, so the
 * source the block appends is never taken for part of the record. Stored text never holds " — "
 * where a source stands (the block rewrites it), so the last one on a line is always the source.
 */
export function withoutSources(block: string): string {
  return block
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) return line;
      const write = WRITE_DAY.exec(line);
      if (write) return line.replace(WRITE_DAY, write[1]!);
      // Only rule and fact lines end with a source; a note's or a stale flag's text is its own.
      if (!SOURCED_LINE.test(line)) return line;
      const at = line.lastIndexOf(" — ");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** The heading of the change notices that follow the block, or open the piggyback when there is none. */
export const CHANGE_NOTICES_HEADING = "Changed in your scope since your last call:";
