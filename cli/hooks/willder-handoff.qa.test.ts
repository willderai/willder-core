// The restart nudge is off for every value but "on", the checkpoint never reads the exit flag,
// and memory_ingest's completeness rule refuses each missing, empty or repeated heading by name.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDOFF_PARTS, handoffRefusal } from "@/services/memory/session-handoff";
import { HANDOFF_HEADINGS, RESTART_NUDGE, handoffContext, isCheckpoint } from "./willder-handoff.mjs";

const SESSION = "9f1e0c3b-case857";
let dir = "";
let transcript = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "willder-handoff-qa-"));
  transcript = join(dir, "session.jsonl");
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 130_000,
    cache_creation_input_tokens: 0,
    output_tokens: 5,
  };
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: "m1", usage } })}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const COMPLETE = [
  "Still failing or unfinished: tests/retry.test.ts still fails on the second attempt.",
  "Done and checked: npx vitest run ledger.test.ts: 12 passed",
  "Decisions: retry twice, because the gateway drops one request in fifty.",
  "Rejected: none",
  "Not yet checked: whether the webhook path retries too.",
  "Next step: verify the retry test fails on main, then wire it.",
].join("\n");
const storedCall = {
  tool_name: "mcp__willder__memory_ingest",
  tool_input: { name: "Handoff: WEB-1, session 9f1e0c3b", content: COMPLETE },
  tool_response: [{ type: "text", text: "Recorded fact. Version: v7." }],
};
const hook = (call: Record<string, unknown>, env: Record<string, string | undefined>) =>
  handoffContext({ hook_event_name: "PostToolUse", session_id: SESSION, transcript_path: transcript, ...call }, env, {
    stateDir: join(dir, "state"),
  });

describe("the restart nudge, for every value of its switch", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["1", "1"],
    ["true", "true"],
    ["ON", "ON"],
    ["On", "On"],
    ["yes", "yes"],
    ["garbage", "on;rm"],
    ["off", "off"],
  ])("stays off when WILLDER_RESTART_NUDGE is %s, a complete handoff stored", (_name, value) => {
    expect(hook(storedCall, { WILLDER_HANDOFF_AT: "120000", WILLDER_RESTART_NUDGE: value })).toBeNull();
  });

  it("is on for exactly on, once a complete handoff is stored", () => {
    expect(hook(storedCall, { WILLDER_HANDOFF_AT: "120000", WILLDER_RESTART_NUDGE: "on" })).toBe(RESTART_NUDGE);
  });

  it("stays off with the switch on when no handoff was stored, only asked for", () => {
    const run = {
      tool_name: "Bash",
      tool_input: { command: "npx vitest run | tail -3" },
      tool_response: { stdout: "Tests  4 passed (4)", stderr: "" },
    };
    expect(hook(run, { WILLDER_HANDOFF_AT: "120000", WILLDER_RESTART_NUDGE: "on" })).not.toBe(RESTART_NUDGE);
  });
});

describe("a checkpoint, by the runner's summary or git's commit line, never the exit flag", () => {
  const bash = (command: string, stdout: string) => ({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout, stderr: "" },
  });
  it.each([
    [
      "a piped vitest run",
      bash("npx vitest run 2>&1 | tail -5", " Test Files  2 passed (2)\n      Tests  31 passed (31)"),
      true,
    ],
    ["a piped pytest run", bash("pytest -q | tail -1", "31 passed in 0.42s"), true],
    ["a run behind || true that failed", bash("npm test || true", "Tests  1 failed | 30 passed (31)"), false],
    ["an exit-0 test command with no summary", bash("npm test | cat", "ok"), false],
    [
      "a failure count above a passing count",
      bash("npx vitest run | tail", " Test Files  1 failed | 1 passed (2)\n Tests  31 passed (31)"),
      false,
    ],
    [
      "a commit git made",
      bash("git commit -m 'retry twice'", "[claude/retry 3f2a9c1] retry twice\n 1 file changed"),
      true,
    ],
    ["git's commit line printed by echo", bash("echo '[main 3f2a9c1] x'", "[main 3f2a9c1] x"), false],
    ["a commit command that made none", bash("git commit -m x", "nothing to commit"), false],
  ])("%s", (_name, input, expected) => {
    expect(isCheckpoint(input)).toBe(expected);
  });
});

describe("the completeness refusal names each problem", () => {
  it.each(HANDOFF_PARTS.map((part) => [part.heading]))("refuses a handoff missing %s, by name", (heading) => {
    const without = COMPLETE.split("\n")
      .filter((line) => !line.startsWith(heading))
      .join("\n");
    expect(handoffRefusal(without)).toMatch(
      new RegExp(`^incomplete_handoff: nothing was stored\\. .*missing [^;]*${heading}`),
    );
  });
  it.each(HANDOFF_PARTS.map((part) => [part.heading]))("refuses a handoff with %s empty, by name", (heading) => {
    const empty = COMPLETE.split("\n")
      .map((line) => (line.startsWith(heading) ? heading : line))
      .join("\n");
    expect(handoffRefusal(empty)).toMatch(new RegExp(`missing [^;]*${heading}`));
  });
  it.each(HANDOFF_PARTS.map((part) => [part.heading]))("refuses a handoff with %s twice, by name", (heading) => {
    const line = COMPLETE.split("\n").find((l) => l.startsWith(heading))!;
    expect(handoffRefusal(`${COMPLETE}\n${line}`)).toContain(`${heading} opens more than one line`);
  });
  it("stores the complete one", () => {
    expect(handoffRefusal(COMPLETE)).toBeNull();
    expect(HANDOFF_HEADINGS).toEqual(HANDOFF_PARTS.map((part) => part.heading));
  });
});
