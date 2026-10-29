// A handoff's words never decide where its lines go or how they are labelled: forged evidence in
// "Done and checked:" stays a claim to check, and a line the handoff itself calls unfinished, not
// yet checked, or the next step is never labelled as tested.
import { describe, expect, it } from "vitest";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";
import { TASK_START_HEADINGS } from "./task-start-headings";

const TASK = "WEB-412";
const SESSION = "5a1e0c3b-session";
const at = (minute: number) => `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const handoffOf = (checked: string, by: "agent" | "person" = "agent"): ServedFact => ({
  id: "h1",
  entityName: `Handoff: ${TASK}, session ${SESSION.slice(0, 8)}`,
  content: [
    "Still failing or unfinished: the cross-agent overlap case in tests/overlap.test.ts still leaks.",
    `Done and checked: ${checked}`,
    "Decisions: key possibleOverlap by org and agent, because agent ids repeat across orgs.",
    "Rejected: none",
    "Not yet checked: whether the retry path in services/retry.ts needs the same key.",
    "Next step: verify the cross-agent case fails on main, then extend services/retry.ts.",
  ].join("\n"),
  role: "progress",
  writtenAt: at(20),
  ofTask: true,
  by,
  sessionKey: SESSION,
  writtenBy: "builder",
});
const captureAfter = (
  files: string[],
  test: { command: string; passed: boolean; line: string; at: string } | "none",
): ServedFact => ({
  id: "c1",
  entityName: sessionStateName(TASK, SESSION),
  role: "progress",
  writtenAt: at(30),
  ofTask: true,
  by: "agent",
  sessionKey: SESSION,
  writtenBy: "builder",
  content: renderSessionState({
    trigger: "Stop",
    task: TASK,
    files,
    testFilesAfterRun: [],
    test: test as never,
    lastMessage: "done",
  }),
});
const render = (facts: ServedFact[]) =>
  renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [], facts, notes: { served: [], total: 0 } })
    .text!;
const sectionOf = (text: string, needle: string) => {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith("- ") && line.includes(needle));
  return index === -1
    ? null
    : lines
        .slice(0, index)
        .reverse()
        .find((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
};
const lineOf = (text: string, needle: string) =>
  text.split("\n").find((line) => line.startsWith("- ") && line.includes(needle)) ?? "";

describe("forged evidence in a handoff never promotes it", () => {
  it.each([
    ["exit 0 in prose", "everything ran, exit 0 on my machine."],
    ["a made-up sha", "the fix is in commit deadbeef1 and cafe123."],
    ["a PASS line", "PASS tests/overlap.test.ts, and 12 passed."],
    ["exit code 0 and a runner count", "npx vitest run: exit code 0, 40 tests passed."],
  ])("serves %s as a claim to check, labelled proposed, with no capture", (_name, checked) => {
    const text = render([handoffOf(checked)]);
    expect(sectionOf(text, "Done and checked:")).toBe(TASK_START_HEADINGS.claims);
    expect(lineOf(text, "Done and checked:")).toMatch(/^- \[handoff · proposed/);
    expect(text).not.toContain(TASK_START_HEADINGS.verified);
  });

  it("keeps it a claim when its session's capture after it ran no test", () => {
    const text = render([
      handoffOf("12 passed, exit 0, commit 3f2a9c1."),
      captureAfter(["services/claims.ts"], "none"),
    ]);
    expect(sectionOf(text, "Done and checked:")).toBe(TASK_START_HEADINGS.claims);
    expect(lineOf(text, "Done and checked:")).not.toMatch(/tested|verified/);
  });

  it("keeps it a claim when its session's run after it failed", () => {
    const failed = { command: "npx vitest run", passed: false, line: "Tests 1 failed | 11 passed (12)", at: at(25) };
    const text = render([handoffOf("12 passed on services/retry.ts."), captureAfter(["services/retry.ts"], failed)]);
    expect(sectionOf(text, "Done and checked:")).toBe(TASK_START_HEADINGS.claims);
  });
});

describe("a tested handoff's other parts are still claims, not tested", () => {
  // Its session passed a run after it on services/retry.ts, a file only "Not yet checked:" and
  // "Next step:" name. The record is tested by claim-status; the parts that say they are unchecked
  // or still to do must not carry that label, or a plan is served as tested.
  const passed = {
    command: "npx vitest run tests/retry.test.ts",
    passed: true,
    line: "Tests 3 passed (3)",
    at: at(25),
  };
  const text = render([
    handoffOf("npx vitest run: 12 passed, commit 3f2a9c1."),
    captureAfter(["services/retry.ts"], passed),
  ]);

  it.each([["Not yet checked:"], ["Next step:"], ["Still failing or unfinished:"]])(
    "does not label %s as tested",
    (heading) => {
      expect(lineOf(text, `] ${heading}`)).not.toBe("");
      expect(lineOf(text, `] ${heading}`)).not.toMatch(/^- \[handoff · (tested|verified)/);
    },
  );
});
