// A session's handoff: what one session of a task leaves the next one, in a fixed shape.
//
// A long task runs as several sessions: Claude Code compacts the context, a person types /clear,
// or a runner starts a fresh session. The hook asks the agent, at a checkpoint past a context
// threshold (cli/hooks/willder-handoff.mjs), for one memory_ingest named `Handoff: <task>,
// session <id8>` whose content has six headings, each opening a line: what still fails or is
// unfinished, what was done and checked (with its evidence), the decisions and the options
// rejected, each with its reason, what is not yet checked, and the next step, phrased as what to
// verify first. The design names five parts; decisions and rejected options are one part under
// two headings.
//
// memory_ingest refuses a handoff that is not complete and says what is missing
// (mcp/tools/memory-ingest.ts), so a stored handoff always has every part, and the next session's
// task-start block can lay each part out where it belongs (mcp/task-start-notice.ts). The
// handoff's text never decides its own status: what backs it is worked out from recorded evidence
// (services/memory/claim-status.ts), and its plan and next step are served as claims to check.
//
// The one rule this file enforces: a handoff is complete only when every heading opens exactly one
// line, with something under it, the done-and-checked part names its evidence or says none, and
// the next step opens with what to verify. The headings are a format: the hook's ask spells them out too
// (HANDOFF_HEADINGS in cli/hooks/willder-handoff.mjs), and session-handoff.test.ts holds the two
// equal.

/** How a handoff's name opens: `Handoff: <task>, session <id8>`. */
export const HANDOFF_NAME_OPENING = "Handoff:";

/** The six headings of a handoff, in the order the hook asks for them. */
export const HANDOFF_PARTS = [
  { key: "unfinished", heading: "Still failing or unfinished:" },
  { key: "checked", heading: "Done and checked:" },
  { key: "decisions", heading: "Decisions:" },
  { key: "rejected", heading: "Rejected:" },
  { key: "unchecked", heading: "Not yet checked:" },
  { key: "next", heading: "Next step:" },
] as const;

/** One part of a handoff, by its key. */
export type HandoffPart = (typeof HANDOFF_PARTS)[number]["key"];

/** Each part's text, or null when its heading opens no line. */
export type HandoffParts = Record<HandoffPart, string | null>;

/**
 * Whether a fact's name says it is a handoff. Case and leading spaces are ignored, so a name
 * spelled `handoff: ...` is checked as one and cannot be stored incomplete under a near spelling.
 */
export function isHandoffName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.trimStart().toLowerCase().startsWith(HANDOFF_NAME_OPENING.toLowerCase());
}

/** A heading opening a line, after optional spaces and one list marker. Each heading is plain words and a colon, safe in a pattern as written. */
const headingAt = (heading: string) => new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${heading}`, "m");

/**
 * Each part's text, keyed by part. A heading counts only where it opens a line, so the same words
 * inside a part ("the form's Next step: field") are not read as one. A part runs from its heading
 * to the next heading in the text, whatever order they were written in; a heading that opens no
 * line maps to null.
 */
export function handoffParts(content: string): HandoffParts {
  const found = HANDOFF_PARTS.map((part) => {
    const match = headingAt(part.heading).exec(content);
    return { key: part.key, index: match ? match.index : -1, start: match ? match.index + match[0].length : -1 };
  })
    .filter((at) => at.index !== -1)
    .sort((a, b) => a.index - b.index);
  const parts = Object.fromEntries(HANDOFF_PARTS.map((part) => [part.key, null])) as HandoffParts;
  found.forEach((at, i) => {
    parts[at.key] = content.slice(at.start, found[i + 1]?.index ?? content.length).trim();
  });
  return parts;
}

/** A part that says there is nothing under it. */
const SAYS_NONE = /^(?:none|nothing|n\/a)\b/i;

/** The next step opens with what to check: one of these words, first, or after "First,". */
const VERIFY_FIRST = /^(?:first[,:]?\s+)?(?:verify|check|confirm|run|test|re-run|rerun)\b/i;

/**
 * Evidence for something checked: a commit sha (hex with a digit and a letter, so neither a word
 * like "defaced" nor a date reads as one), or a runner's result (`12 passed`, `3 passing`,
 * `PASS src/x.test.ts`, `exit 0`). Only the form is read; whether the run happened is what the session's
 * capture records, never this text.
 */
const EVIDENCE =
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\b\d+\s+(?:passed|passing|tests? passed)\b|\bPASS\s+\S+\.\w+|\bexit(?: code)? 0\b/;

/** The headings that open more than one line: which line is the part would be a guess. */
function repeatedHeadings(content: string): string[] {
  return HANDOFF_PARTS.filter(
    (part) => (content.match(new RegExp(headingAt(part.heading).source, "gm")) ?? []).length > 1,
  ).map((part) => part.heading);
}

/**
 * What a handoff lacks, one item per problem, or an empty list when it is complete: a heading that
 * opens no line or has nothing under it, a heading that opens more than one line, a done-and-checked
 * part that names no evidence and does not say none, and a next step that does not open with what to
 * verify.
 */
export function handoffProblems(content: string): string[] {
  const parts = handoffParts(content);
  const missing = HANDOFF_PARTS.filter((part) => !parts[part.key]).map((part) => part.heading);
  const problems = missing.length === 0 ? [] : [`missing ${missing.join(", ")}`];
  const repeated = repeatedHeadings(content);
  if (repeated.length > 0)
    problems.push(
      `${repeated.join(", ")} opens more than one line: write each heading once, and reword a line inside a part that starts like one`,
    );
  if (parts.checked && !SAYS_NONE.test(parts.checked) && !EVIDENCE.test(parts.checked)) {
    problems.push(
      `"Done and checked:" names no evidence: give the test command with its runner's result (for example "npx vitest run x.test.ts: 12 passed") or the commit sha, or write "none"`,
    );
  }
  if (parts.next && !VERIFY_FIRST.test(parts.next)) {
    problems.push(
      `"Next step:" does not open with what to verify: start it with verify, check, confirm, run or test, for example "verify the overlap test fails on main, then ..."`,
    );
  }
  return problems;
}

/**
 * The refusal memory_ingest answers an incomplete handoff with, or null when it is complete. It
 * names every problem and the whole shape, so one more write can fix all of them.
 */
export function handoffRefusal(content: string): string | null {
  const problems = handoffProblems(content);
  if (problems.length === 0) return null;
  const shape = HANDOFF_PARTS.map((part) => part.heading).join(" / ");
  return `incomplete_handoff: nothing was stored. This handoff is not complete: ${problems.join("; ")}. Write it again with every part, each heading opening its own line exactly as written, in plain text (no **bold**, # or numbering; a "- " before it is fine): ${shape}. Write "none" under a part with nothing in it.`;
}
