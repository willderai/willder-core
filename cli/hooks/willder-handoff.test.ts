// The handoff ask's contract with Claude Code: when the hook asks for a handoff, what it asks for,
// when it suggests a restart, and that it never does either on what it cannot read.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDOFF_PARTS } from "@/services/memory/session-handoff";
import { handoffProblems } from "@/services/memory/session-handoff";
import {
  DEFAULT_HANDOFF_AT,
  HANDOFF_HEADINGS,
  HANDOFF_RESTART_LINE,
  RESTART_NUDGE,
  handoffComplete,
  handoffContext,
  handoffThreshold,
} from "./willder-handoff.mjs";

const SESSION = "5a1e0c3b-2f4d-4e8a-9b1c-0d2e3f4a5b6c";
const ON = { WILLDER_HANDOFF_AT: "120000", WILLDER_TASK: "WEB-412" };

let dir = "";
let transcript = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "willder-handoff-test-"));
  transcript = join(dir, "session.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a transcript whose last model turn re-sent `tokens` of context. */
function contextIs(tokens: number) {
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: tokens - 10,
    cache_creation_input_tokens: 0,
    output_tokens: 5,
  };
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "assistant", message: { id: "m1", usage } })}\n${JSON.stringify({ type: "user", message: { content: [] } })}\n`,
  );
}

const bash = (command: string, stdout: string) => ({
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "" },
});
const PASSING_RUN = bash(
  "npx vitest run src/ledger.test.ts 2>&1 | tail -5",
  " Test Files  1 passed (1)\n      Tests  12 passed (12)",
);
const COMPLETE = HANDOFF_HEADINGS.map(
  (heading) =>
    `${heading} ${heading === "Next step:" ? "verify the retry test, then wire it" : heading === "Done and checked:" ? "npx vitest run ledger.test.ts: 12 passed" : "something real here"}`,
).join("\n");
const ingest = (content: string, reply: string, name = "Handoff: WEB-412, session 5a1e0c3b") => ({
  tool_name: "mcp__willder__memory_ingest",
  tool_input: { name, content },
  tool_response: [{ type: "text", text: reply }],
});
const STORED_REPLY = "Stored and readable now; graph extraction continues in the background. Version: v42.";

const hook = (call: Record<string, unknown>, env: Record<string, string | undefined> = ON, event = "PostToolUse") =>
  handoffContext({ hook_event_name: event, session_id: SESSION, transcript_path: transcript, ...call }, env, {
    stateDir: join(dir, "state"),
  });

describe("handoffThreshold", () => {
  it.each([
    ["unset, capture off", {}, 0],
    ["unset, capture on", { WILLDER_CAPTURE: "session-state" }, DEFAULT_HANDOFF_AT],
    ["set", { WILLDER_HANDOFF_AT: " 200000 " }, 200_000],
    ["zero turns it off, even with capture on", { WILLDER_HANDOFF_AT: "0", WILLDER_CAPTURE: "session-state" }, 0],
    ["not a whole number turns it off", { WILLDER_HANDOFF_AT: "120k", WILLDER_CAPTURE: "session-state" }, 0],
    ["negative turns it off", { WILLDER_HANDOFF_AT: "-5" }, 0],
    ["blank reads as unset", { WILLDER_HANDOFF_AT: "  ", WILLDER_CAPTURE: "session-state" }, DEFAULT_HANDOFF_AT],
  ])("%s", (_name, env, expected) => {
    expect(handoffThreshold(env)).toBe(expected);
  });
});

describe("the handoff ask", () => {
  it("asks once, past the threshold at a checkpoint, for a handoff named for the task and session with all six headings", () => {
    contextIs(130_000);
    const ask = hook(PASSING_RUN);

    expect(ask).toContain('"Handoff: WEB-412, session 5a1e0c3b"');
    expect(ask).toContain("130k tokens");
    for (const heading of HANDOFF_HEADINGS)
      expect(ask!.split("\n").some((line) => line.startsWith(heading))).toBe(true);
    expect(hook(PASSING_RUN)).toBeNull();
  });

  it.each([
    ["a run under the threshold", 119_999, PASSING_RUN],
    [
      "a run whose output also counts a failure",
      130_000,
      bash("npx vitest run", " Test Files  1 failed | 2 passed (3)\n      Tests  20 passed (20)"),
    ],
    ["a command that exits 0 with no runner summary", 130_000, bash("npm test | tail -1", "done")],
    ["a call that is not a test run or a commit", 130_000, bash("ls", "a.ts")],
    ["a git commit that made no commit", 130_000, bash("git commit -m wip", "nothing to commit, working tree clean")],
    ["a transcript with no usage to read", null, PASSING_RUN],
  ])("does not ask on %s", (_name, tokens, call) => {
    if (tokens === null) writeFileSync(transcript, "not json\n");
    else contextIs(tokens);
    expect(hook(call)).toBeNull();
  });

  it("asks at a git commit that made a commit, with git's global options before it", () => {
    contextIs(130_000);
    expect(hook(bash("git -C . commit -m 'ledger retry'", "[main 3f2a9c1] ledger retry\n 1 file changed"))).toContain(
      "Handoff:",
    );
  });

  it("asks again after a compaction brings the context back under the threshold", () => {
    contextIs(130_000);
    expect(hook(PASSING_RUN)).not.toBeNull();
    contextIs(40_000);
    expect(hook(PASSING_RUN)).toBeNull();
    contextIs(125_000);
    expect(hook(PASSING_RUN)).not.toBeNull();
  });

  it("redacts the task's name it repeats, and bounds it", () => {
    contextIs(130_000);
    const ask = hook(PASSING_RUN, {
      ...ON,
      WILLDER_TASK: `fix login with gh${""}p_abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(12_000)}`,
    })!;
    expect(ask).not.toContain("gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(ask.length).toBeLessThan(2_000);
  });

  it("is not re-armed by a subagent's smaller turn in the transcript, and ignores a subagent's own tool calls", () => {
    contextIs(130_000);
    expect(hook({ ...PASSING_RUN, agent_id: "sub-1", agent_type: "general" })).toBeNull();
    expect(hook(PASSING_RUN)).not.toBeNull();
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "assistant", isSidechain: true, message: { usage: { input_tokens: 2_000 } } })}\n`,
      { flag: "a" },
    );
    expect(hook(PASSING_RUN)).toBeNull();
    contextIs(130_000);
    expect(hook(PASSING_RUN)).toBeNull();
  });

  it("is silent when it is off, on other events, and without a session id", () => {
    contextIs(130_000);
    expect(hook(PASSING_RUN, { WILLDER_HANDOFF_AT: "0" })).toBeNull();
    expect(hook(PASSING_RUN, {})).toBeNull();
    expect(hook(PASSING_RUN, ON, "UserPromptSubmit")).toBeNull();
    expect(
      handoffContext({ hook_event_name: "PostToolUse", transcript_path: transcript, ...PASSING_RUN }, ON, {
        stateDir: join(dir, "state"),
      }),
    ).toBeNull();
  });
});

describe("the restart nudge", () => {
  const NUDGE = { ...ON, WILLDER_RESTART_NUDGE: "on" };

  it("is off by default: a stored handoff gets no restart line", () => {
    contextIs(130_000);
    hook(PASSING_RUN);
    expect(hook(ingest(COMPLETE, STORED_REPLY))).toBeNull();
  });

  it("with the switch on, is given once, and only after a complete handoff is stored", () => {
    contextIs(130_000);
    expect(hook(PASSING_RUN, NUDGE)).not.toContain(HANDOFF_RESTART_LINE);
    expect(hook(ingest(COMPLETE, STORED_REPLY), NUDGE)).toBe(RESTART_NUDGE);
    expect(RESTART_NUDGE).toContain(HANDOFF_RESTART_LINE);
    expect(hook(ingest(COMPLETE, STORED_REPLY), NUDGE)).toBeNull();
    expect(hook(PASSING_RUN, NUDGE)).toBeNull();
  });

  it.each([
    ["the server refused it", ingest(COMPLETE, "incomplete_handoff: nothing was stored.")],
    ["a heading is missing", ingest(COMPLETE.replace("Rejected:", "Turned down:"), STORED_REPLY)],
    ["it is not named as a handoff", ingest(COMPLETE, STORED_REPLY, "Ledger retry notes")],
    ["its parts are empty, though a server stored it", ingest(HANDOFF_HEADINGS.join("\n"), STORED_REPLY)],
    [
      "its next step and checked work say nothing to verify, though a server stored it",
      ingest(
        COMPLETE.replace("verify the retry test", "carry on").replace(
          "npx vitest run ledger.test.ts: 12 passed",
          "I think it works",
        ),
        STORED_REPLY,
      ),
    ],
    [
      "it is a rule, not a fact",
      { ...ingest(COMPLETE, STORED_REPLY), tool_input: { name: "Handoff: x", content: COMPLETE, kind: "decision" } },
    ],
    ["it went to another tool", { ...ingest(COMPLETE, STORED_REPLY), tool_name: "mcp__willder__memory_note" }],
  ])("is not given when %s", (_name, call) => {
    contextIs(130_000);
    expect(hook(call, NUDGE)).toBeNull();
  });

  it("is given for a handoff stored before the checkpoint came, and the ask is then not made", () => {
    contextIs(130_000);
    expect(hook(ingest(COMPLETE, STORED_REPLY), NUDGE)).toBe(RESTART_NUDGE);
    expect(hook(PASSING_RUN, NUDGE)).toBeNull();
  });
});

describe("the handoff's format", () => {
  it("has the headings memory_ingest checks", () => {
    expect(HANDOFF_HEADINGS).toEqual(HANDOFF_PARTS.map((part) => part.heading));
  });

  it.each([
    ["complete", COMPLETE],
    ["a part empty", COMPLETE.replace("something real here", "")],
    ["a heading missing", COMPLETE.replace("Rejected:", "Turned down:")],
    ["a heading twice", `${COMPLETE}\n- Next step: again`],
    ["checked work with no evidence", COMPLETE.replace("npx vitest run ledger.test.ts: 12 passed", "it works")],
    ["checked work that says none", COMPLETE.replace("npx vitest run ledger.test.ts: 12 passed", "none yet")],
    [
      "a next step that does not open with a check",
      COMPLETE.replace("verify the retry test", "then verify the retry test"),
    ],
    ["a heading in bold", COMPLETE.replace("Decisions:", "**Decisions:**")],
    ["CRLF line ends", COMPLETE.replaceAll("\n", "\r\n")],
  ])("is judged complete by the hook exactly when memory_ingest stores it: %s", (_name, content) => {
    expect(handoffComplete(content)).toBe(handoffProblems(content).length === 0);
  });
});

describe("the hook as Claude Code runs it", () => {
  const hookPath = fileURLToPath(new URL("./willder-changes.mjs", import.meta.url));

  it("asks for the handoff on the long-run study's probe input, with no server and capture off", async () => {
    contextIs(130_000);
    const input = {
      hook_event_name: "PostToolUse",
      session_id: "probe-PostToolUse",
      cwd: dir,
      transcript_path: transcript,
      ...bash("npx vitest run", " Test Files  1 passed (1)\n      Tests  3 passed (3)"),
    };
    const stdout = await new Promise<string>((done) => {
      const child = execFile(
        process.execPath,
        [hookPath],
        {
          env: {
            NODE_ENV: "test",
            TMPDIR: dir,
            WILLDER_TOKEN: "wcap_test",
            WILLDER_URL: "http://127.0.0.1:9",
            WILLDER_TASK: "probe-1",
            WILLDER_HANDOFF_AT: "120000",
          },
        },
        (_e, out) => done(out),
      );
      child.stdin!.end(JSON.stringify(input));
    });
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    for (const heading of HANDOFF_HEADINGS) expect(context).toContain(heading);
  }, 30_000);
});
