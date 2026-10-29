import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANGE_NOTICES_HEADING,
  SINCE_LAST_SESSION_OPENING,
  TASK_START_HEADER,
  TASK_START_HEADINGS,
  TASK_START_OPENING,
  taskStartBlockAt,
} from "./task-start-headings";

// No source file spells out a line of the task-start block or the change notices; each
// imports it from mcp/task-start-headings.ts.
//
// A reader keyed on its own copy of a heading reads nothing the day the heading changes,
// and fails quietly: once the task's facts heading was reworded, a handoff measure keyed
// on the old text found no fact ids in any served block. This test fails on a copy
// in any source file, comments included. Test files are left out: a test that pins what
// the product prints spells the text on purpose, so a reworded heading fails it loudly.

const repoRoot = resolve(__dirname, "..");
const headingsFile = resolve(__dirname, "task-start-headings.ts");

/** Directories that never hold source, at any depth. */
const SKIP_ANYWHERE = new Set([".git", ".next", "node_modules", "coverage", ".venv", "__pycache__"]);
/** Directories, relative to the repo root, that hold generated code. */
const SKIP_PATHS = new Set(["lib/generated"]);

/** The file types a reader of a tool result could be written in. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$/;

/**
 * Each fixed line, without its closing colon or full stop, so a copy written as a prefix or
 * inside a regular expression is caught too.
 */
const LINES = [
  TASK_START_HEADER,
  SINCE_LAST_SESSION_OPENING,
  ...Object.values(TASK_START_HEADINGS),
  CHANGE_NOTICES_HEADING,
].map((line) => line.replace(/[:.]$/, ""));

/** The fixed lines `text` spells out. */
function headingsSpelledOutIn(text: string): string[] {
  return LINES.filter((line) => text.includes(line));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return SKIP_ANYWHERE.has(entry.name) || SKIP_PATHS.has(relative(repoRoot, path)) ? [] : sourceFiles(path);
    return entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !TEST_FILE.test(relative(repoRoot, path)) &&
      path !== headingsFile
      ? [path]
      : [];
  });
}

describe("the task-start block's and change notices' fixed lines", () => {
  it("are spelled out only in mcp/task-start-headings.ts", () => {
    const copies = sourceFiles(repoRoot).flatMap((path) =>
      headingsSpelledOutIn(readFileSync(path, "utf8")).map(
        (line) => `${relative(repoRoot, path)}: "${line}" (import it from mcp/task-start-headings.ts)`,
      ),
    );
    expect(copies).toEqual([]);
  });

  it("are found as a copy whole, as a prefix without the colon, and inside a regular expression", () => {
    expect(headingsSpelledOutIn(`const at = text.indexOf("${TASK_START_HEADINGS.leads}");`)).toEqual([
      TASK_START_HEADINGS.leads.replace(/:$/, ""),
    ]);
    expect(
      headingsSpelledOutIn(
        'const BLOCK = "Before you start: what Willder holds for this task; each line says what backs it";',
      ),
    ).toHaveLength(1);
    expect(headingsSpelledOutIn("const NOTICE = /^Changed in your scope since your last call:$/m;")).toHaveLength(1);
    expect(headingsSpelledOutIn('import { TASK_START_HEADINGS } from "@/mcp/task-start-headings";')).toEqual([]);
  });

  it("walk this repository's source, and leave test files out", () => {
    const files = sourceFiles(repoRoot).map((path) => relative(repoRoot, path));
    expect(files).toContain("mcp/task-start-notice.ts");
    expect(files).toContain("scripts/selfhost-smoke.ts");
    expect(files).not.toContain("mcp/task-start-notice.test.ts");
    expect(files).not.toContain("mcp/task-start-headings.ts");
    expect(files.some((path) => path.startsWith("node_modules/") || path.startsWith("lib/generated/"))).toBe(false);
  });
});

describe("the block's opening", () => {
  // Readers find a block by its opening, so a block served under an earlier header, as stored
  // study transcripts and older deploys carry, is still found. Rewording the header keeps it.
  it("is how the current header and the one served before it both start", () => {
    expect(TASK_START_HEADER.startsWith(TASK_START_OPENING)).toBe(true);
    expect("Before you start: the rules and open run state for this task.".startsWith(TASK_START_OPENING)).toBe(true);
  });

  it("is found at a line's start only, so an answer quoting it inside a line is not the block", () => {
    expect(taskStartBlockAt(`${TASK_START_HEADER}\n- x`)).toBe(0);
    expect(taskStartBlockAt(`Found 1 fact.\n\n${TASK_START_HEADER}`)).toBe("Found 1 fact.\n\n".length);
    const quoted = `• note: the prompt said "${TASK_START_OPENING} read the rules" [fact f1]`;
    expect(taskStartBlockAt(quoted)).toBe(-1);
    expect(taskStartBlockAt(`${quoted}\n\n${TASK_START_HEADER}`)).toBe(quoted.length + 2);
  });
});
