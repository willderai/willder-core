// The task-start block at a session boundary: for a task that
// holds a handoff, or a request that reports a compaction or a /clear, the block leads with what is
// verified, then what still fails, the decisions and why, live state and questions, and serves the
// plan and next step last, as claims to check. Every part of the handoff reaches the next session,
// each labelled by recorded evidence, never by its own words. The captures and the handoff are the
// ones the willder init hook and the handoff ask produce.
import { describe, expect, it } from "vitest";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedNote, ServedRule } from "@/services/memory/task-start";
import { HANDOFF_PARTS, handoffParts } from "@/services/memory/session-handoff";
import { COMMANDS_LINE_OPENING } from "@/services/memory/session-state";
import {
  BOUNDARY_TASK_START_MAX_TOKENS,
  BOUNDARY_TASK_START_TOKEN_BUDGET,
  estimateTokens,
  renderTaskStartBlock,
  TASK_START_TOKEN_BUDGET,
} from "./task-start-notice";
import {
  TASK_START_CAPTURE_LABEL,
  TASK_START_HEADINGS,
  TASK_START_OBSERVED_LABEL,
  TASK_START_PREMISE_CHECK,
  withoutSources,
} from "./task-start-headings";

const TASK = "WEB-412";
const SESSION = "5a1e0c3b-session";
const HANDOFF = [
  "Still failing or unfinished: the cross-agent overlap case in tests/overlap.test.ts still leaks a second agent's claim.",
  "Done and checked: npx vitest run tests/overlap.test.ts: 12 passed, commit 3f2a9c1 on services/claims.ts.",
  "Decisions: key possibleOverlap by org and agent, because agent ids repeat across orgs.",
  "Rejected: a global overlap cache, since it would leak claims across orgs.",
  "Not yet checked: whether the retry path in services/retry.ts needs the same key.",
  "Next step: verify the cross-agent case fails on main with tests/overlap.test.ts, then extend possibleOverlap.",
].join("\n");

const at = (minute: number) => `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const handoff = (content = HANDOFF, writtenAt = at(20), id = "h1"): ServedFact => ({
  id,
  entityName: `Handoff: ${TASK}, session ${SESSION.slice(0, 8)}`,
  content,
  role: "progress",
  writtenAt,
  ofTask: true,
  by: "agent",
  sessionKey: SESSION,
  writtenBy: "builder",
});
type Run = { command: string; passed: boolean; line: string; at?: string };
const passing: Run = {
  command: "npx vitest run tests/overlap.test.ts",
  passed: true,
  line: "Tests  12 passed (12)",
  at: at(15),
};
const failing: Run = {
  command: "npx vitest run tests/overlap.test.ts",
  passed: false,
  line: "Tests  1 failed | 11 passed (12)",
  at: at(15),
};
const captureState = (test: Run | undefined) => ({
  trigger: "Stop",
  task: TASK,
  files: ["services/claims.ts", "tests/overlap.test.ts"],
  functions: ["export function possibleOverlap(a, b) {"],
  testFilesAfterRun: [],
  test: test as never,
  lastMessage: "Overlap fixed for one agent; the cross-agent case is next.",
});
const capture = (test: Run | undefined, writtenAt = at(25)): ServedFact => ({
  id: "c1",
  entityName: sessionStateName(TASK, SESSION),
  role: "progress",
  writtenAt,
  ofTask: true,
  by: "agent",
  sessionKey: SESSION,
  writtenBy: "builder",
  content: renderSessionState(captureState(test)),
});
const plan: ServedFact = {
  id: "p1",
  entityName: "Overlap plan",
  content: "Plan: add a second index on (org, agent) in db/indexes.sql.",
  role: "decision",
  writtenAt: at(5),
  ofTask: true,
  by: "agent",
  sessionKey: SESSION,
  writtenBy: "builder",
};
const rejected: ServedFact = {
  id: "r1",
  entityName: "Overlap option",
  content: "Rejected: a database trigger, because it hides the rule from the code.",
  role: "rejected",
  writtenAt: at(6),
  ofTask: true,
  by: "agent",
  sessionKey: SESSION,
  writtenBy: "builder",
};
const personRule: ServedRule = {
  id: "d1",
  kind: "decision",
  subject: "Claims",
  text: "A claim never crosses orgs.",
  by: "person",
  ofTask: true,
  writtenBy: "person",
  writtenAt: at(1),
} as ServedRule;
const question: ServedNote = {
  id: "n1",
  agentId: "builder",
  scopePath: "org.web",
  task: TASK,
  kind: "question",
  body: "Should a released claim block re-claiming for an hour?",
  expiresAt: new Date(at(59)),
  ofTask: true,
};

const render = (
  facts: ServedFact[],
  extra: { boundary?: boolean; decisions?: ServedRule[]; notes?: ServedNote[] } = {},
) =>
  renderTaskStartBlock({
    rules: [],
    writes: [],
    stale: [],
    decisions: extra.decisions ?? [],
    facts,
    notes: { served: extra.notes ?? [], total: extra.notes?.length ?? 0 },
    boundary: extra.boundary,
  });

const headingsOf = (text: string) =>
  text.split("\n").filter((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
/** The section a line containing `needle` is served under. */
const sectionOf = (text: string, needle: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith("- ") && line.includes(needle));
  return at === -1
    ? null
    : lines
        .slice(0, at)
        .reverse()
        .find((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
};
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("a task that holds a handoff", () => {
  const block = render([plan, rejected, handoff(), capture(passing)], {
    decisions: [personRule],
    notes: [question],
  }).text!;

  it("is laid out verified first, the plan and next step last", () => {
    expect(headingsOf(block)).toEqual([
      TASK_START_HEADINGS.verified,
      TASK_START_HEADINGS.unfinished,
      TASK_START_HEADINGS.decided,
      TASK_START_HEADINGS.questions,
      TASK_START_HEADINGS.claims,
    ]);
    expect(block.split("\n")[block.split("\n").indexOf(TASK_START_HEADINGS.claims) + 1]).toBe(TASK_START_PREMISE_CHECK);
  });

  it.each([
    [
      "the hook's passing run, files and functions",
      `${TASK_START_OBSERVED_LABEL} Last test run at`,
      TASK_START_HEADINGS.verified,
    ],
    ["a person's decision", "[decision d1]", TASK_START_HEADINGS.verified],
    ["what still fails", "Still failing or unfinished: the cross-agent", TASK_START_HEADINGS.unfinished],
    ["the decisions", "Decisions: key possibleOverlap", TASK_START_HEADINGS.decided],
    ["the rejected options", "Rejected: a global overlap cache", TASK_START_HEADINGS.decided],
    ["a rejected option the task recorded", "Rejected: a database trigger", TASK_START_HEADINGS.decided],
    ["an open question", "[question n1]", TASK_START_HEADINGS.questions],
    [
      "what the handoff says was checked, which no evidence after it backs",
      "Done and checked: npx vitest",
      TASK_START_HEADINGS.claims,
    ],
    ["what it did not check", "Not yet checked: whether", TASK_START_HEADINGS.claims],
    ["the next step", "Next step: verify the cross-agent", TASK_START_HEADINGS.claims],
    ["the agent's last message", `${TASK_START_CAPTURE_LABEL} Agent's last message:`, TASK_START_HEADINGS.claims],
    ["an untested plan", "Plan: add a second index", TASK_START_HEADINGS.claims],
  ])("serves %s under its section", (_name, needle, heading) => {
    expect(sectionOf(block, needle)).toBe(heading);
  });

  it("carries every part of the handoff to the next session, each from its start (M1)", () => {
    const parts = handoffParts(HANDOFF);
    for (const { key } of HANDOFF_PARTS) expect(squash(block)).toContain(squash(parts[key]!).slice(0, 60));
  });

  it("labels each handoff line by what recorded evidence shows, never by its words, and names its source", () => {
    const lines = block.split("\n").filter((line) => line.includes("[fact h1]"));
    expect(lines).toHaveLength(6);
    for (const line of lines)
      expect(line).toMatch(
        /^- \[handoff · proposed: its session's last test run is not known to follow it\] .* — builder, 10-17$/,
      );
  });

  it("serves the agent's last message as whole as the hook keeps it, never shorter than a first block would", async () => {
    const { LAST_MESSAGE_MAX_CHARS } = await import("@/cli/hooks/willder-capture.mjs");
    const long = `${"word ".repeat(LAST_MESSAGE_MAX_CHARS / 5 - 1)}end.`.slice(0, LAST_MESSAGE_MAX_CHARS);
    const withMessage = {
      ...capture(passing),
      content: capture(passing).content.replace(/Agent's last message: .*$/, `Agent's last message: ${long}`),
    };
    const { text } = render([handoff(), withMessage]);
    expect(text!.split("\n").find((line) => line.includes("Agent's last message:"))).toContain(long.trim());
  });

  it("keeps the hook's observation apart from the agent's last message", () => {
    const observed = block.split("\n").find((line) => line.includes(TASK_START_OBSERVED_LABEL))!;
    expect(observed).toContain("PASSED");
    expect(observed).toContain("Functions touched since the session started: export function possibleOverlap(a, b) {");
    expect(observed).not.toContain("Agent's last message");
  });

  it("serves the hook's shell commands with the claims, never as observed: their words are the agent's own", () => {
    const commands = [
      { command: `git commit -m "Fixed the overlap; all tests pass, ready to merge"`, status: "exit 0" },
    ];
    const withCommands = { ...capture(passing), content: renderSessionState({ ...captureState(passing), commands }) };
    const text = render([handoff(), withCommands]).text!;
    const commandsLine = `${TASK_START_CAPTURE_LABEL} ${COMMANDS_LINE_OPENING}git commit -m`;
    expect(sectionOf(text, commandsLine)).toBe(TASK_START_HEADINGS.claims);
    expect(text.split("\n").find((line) => line.includes(TASK_START_OBSERVED_LABEL))).not.toContain("all tests pass");
  });

  it("leaves the shell commands out of a first block, which keeps to its smaller budget", () => {
    const commands = [
      { command: `git commit -m "Fixed the overlap; all tests pass, ready to merge"`, status: "exit 0" },
    ];
    const withCommands = { ...capture(passing), content: renderSessionState({ ...captureState(passing), commands }) };
    const text = render([withCommands]).text!;
    expect(text).toContain("PASSED");
    expect(text).not.toContain(COMMANDS_LINE_OPENING);
  });

  it("logs a record served on several lines once, at its first line", () => {
    const rendered = render([handoff(), capture(passing)]);
    const logged = rendered.lines.flat();
    expect(logged.filter((key) => key.startsWith("fact:h1@"))).toHaveLength(1);
    expect(logged.filter((key) => key.startsWith("fact:c1@"))).toHaveLength(1);
    expect(rendered.lines).toHaveLength(rendered.text!.split("\n").filter((line) => line.startsWith("- ")).length);
  });

  it("has a budget of its own, wider than a first block's, and keeps to it", () => {
    expect(BOUNDARY_TASK_START_TOKEN_BUDGET).toBeGreaterThan(TASK_START_TOKEN_BUDGET);
    const long = HANDOFF.replace(/\n/g, ` ${"detail ".repeat(120)}\n`);
    const { text } = render([plan, rejected, handoff(long), capture(passing)], {
      decisions: [personRule],
      notes: [question],
    });
    expect(estimateTokens(text!)).toBeLessThanOrEqual(BOUNDARY_TASK_START_MAX_TOKENS);
    expect(estimateTokens(withoutSources(text!.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
      BOUNDARY_TASK_START_TOKEN_BUDGET,
    );
    for (const { heading } of HANDOFF_PARTS) expect(text).toContain(`] ${heading} `);
  });
});

describe("the handoff's room", () => {
  it("keeps every part, the next step included, however many verified records come before it", () => {
    const long = HANDOFF.replace(/\n/g, ` ${"detail ".repeat(100)}\n`);
    const decisions = Array.from(
      { length: 10 },
      (_, i) =>
        ({
          ...personRule,
          id: `d${i}`,
          text: `A claim never crosses orgs, case ${i}: ${"because ".repeat(60)}`,
        }) as ServedRule,
    );
    const { text } = render([handoff(long), capture(passing)], {
      decisions,
      notes: [question, { ...question, id: "n2", kind: "claim" }],
    });
    for (const { heading } of HANDOFF_PARTS) expect(text).toContain(`] ${heading} `);
    expect(text).toMatch(/more left out/);
  });
});

describe("each handoff part is labelled by its own evidence", () => {
  // One part at a time names the only file its session's passing run after the handoff changed.
  const named = "services/only-here.ts";
  const after: Run = {
    command: "npx vitest run tests/only-here.test.ts",
    passed: true,
    line: "Tests  3 passed (3)",
    at: at(22),
  };
  const captureNaming = (): ServedFact => ({
    ...capture(after),
    content: renderSessionState({
      trigger: "Stop",
      task: TASK,
      files: [named],
      testFilesAfterRun: [],
      test: after as never,
      lastMessage: "Ran it.",
    }),
  });
  const naming = (heading: string) =>
    HANDOFF.split("\n")
      .map((line) =>
        line.startsWith(heading) ? `${line} See ${named}.` : line.replace(/\b[\w/.-]+\.ts\b/g, "the code"),
      )
      .join("\n");

  it.each([["Still failing or unfinished:"], ["Decisions:"], ["Rejected:"], ["Not yet checked:"], ["Next step:"]])(
    "never labels %s tested, even when a run after it passed on the file it names",
    (heading) => {
      const { text } = render([handoff(naming(heading)), captureNaming()]);
      const line = text!.split("\n").find((l) => l.includes(`] ${heading} `))!;
      expect(line).toMatch(/^- \[handoff · proposed: an open item or a choice, which a passing run does not settle\] /);
      expect(sectionOf(text!, "Done and checked:")).toBe(TASK_START_HEADINGS.claims);
    },
  );

  it("labels the checked work tested, and serves it as verified, only from the files its own text names", () => {
    const { text } = render([handoff(naming("Done and checked:")), captureNaming()]);
    expect(sectionOf(text!, "Done and checked:")).toBe(TASK_START_HEADINGS.verified);
    expect(text!.split("\n").find((l) => l.includes("] Done and checked: "))).toMatch(/^- \[handoff · tested: /);
  });
});

describe("what the evidence says moves a line", () => {
  it("serves the hook's failed run under what still fails, not as verified", () => {
    const { text } = render([handoff(), capture(failing)]);
    expect(sectionOf(text!, TASK_START_OBSERVED_LABEL)).toBe(TASK_START_HEADINGS.unfinished);
    expect(text).not.toContain(TASK_START_HEADINGS.verified);
  });

  it("serves what the handoff says was checked as verified only once its session's capture after it passed on a file it names", () => {
    const after: Run = { ...passing, at: at(22) };
    const { text } = render([handoff(), capture(after)]);
    expect(sectionOf(text!, "Done and checked:")).toBe(TASK_START_HEADINGS.verified);
    expect(text).toContain("[handoff · tested: its session's tests passed after it, on files it names]");
  });

  it("serves only the newest handoff by its parts; an older one is a claim like any other write", () => {
    const older = handoff(
      HANDOFF.replace("Next step: verify the cross-agent", "Next step: verify the older"),
      at(10),
      "h0",
    );
    const { text } = render([older, handoff()]);
    expect(text!.split("\n").filter((line) => line.includes("[fact h1]"))).toHaveLength(6);
    expect(text!.split("\n").filter((line) => line.includes("[fact h0]"))).toHaveLength(1);
    expect(sectionOf(text!, "[fact h0]")).toBe(TASK_START_HEADINGS.claims);
  });
});

describe("when the layout applies", () => {
  it.each([
    [
      "a handoff missing a part, as an older server stored it",
      [handoff(HANDOFF.replace(/^Rejected:.*\n/m, "")), capture(passing)],
      {},
    ],
    ["another task's handoff", [{ ...handoff(), ofTask: undefined }], {}],
    [
      "a handoff two writers stored under one name, which is served as a conflict instead",
      [
        { ...handoff(), scopePath: "org.web", writer: { actorType: "agent", actorId: "builder" } },
        {
          ...handoff(HANDOFF.replace("key possibleOverlap", "index possibleOverlap"), at(21), "h2"),
          scopePath: "org.web",
          writer: { actorType: "agent", actorId: "reviewer" },
        },
      ],
      {},
    ],
  ])("keeps the first block's layout for %s", (_name, facts, extra) => {
    const { text } = render(facts as ServedFact[], extra);
    expect(text).not.toContain(TASK_START_HEADINGS.verified);
    expect(text).not.toContain(TASK_START_HEADINGS.claims);
  });

  it("lays out a request that reports a boundary as one, even with no handoff", () => {
    const { text } = render([plan, capture(passing)], { boundary: true });
    expect(headingsOf(text!)).toEqual([TASK_START_HEADINGS.verified, TASK_START_HEADINGS.claims]);
    expect(sectionOf(text!, "Plan: add a second index")).toBe(TASK_START_HEADINGS.claims);
  });

  it("leaves a first block exactly as it was without a handoff or a boundary", () => {
    const first = render([plan, capture(passing)]);
    expect(first.text).toContain(TASK_START_HEADINGS.leads);
    expect(first.text).not.toContain(TASK_START_OBSERVED_LABEL);
  });
});
