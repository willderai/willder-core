// The task-start block and an earlier session's untested plan: a plan of the task's own is served
// as a hypothesis, labelled by what its own session's capture recorded after it
// (services/memory/claim-status.ts), the block then says to check the plan's premises, and the test
// a plan names is said after its excerpt so no cut drops it. The case: agent A planned without
// running anything, wrote its plan as a "(decision)", and agent B built on it without checking
// what it rested on. The captures are rendered by the willder init hook itself, so the block is tested on the text the
// hook really writes.
import { describe, expect, it } from "vitest";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import {
  estimateTokens,
  renderTaskStartBlock,
  SOURCE_ALLOWANCE_TOKENS,
  TASK_START_TOKEN_BUDGET,
} from "./task-start-notice";
import { withoutSources } from "./task-start-headings";
import {
  TASK_START_CAPTURE_LABEL,
  TASK_START_HEADER,
  TASK_START_HEADINGS,
  TASK_START_PREMISE_CHECK,
} from "./task-start-headings";

const TASK = "T-4c378528";
const PLANNED_AT = "2026-10-15T01:10:00.000Z";
const CAPTURED_AT = "2026-10-15T01:12:00.000Z";
const UNTESTED =
  "[untested plan: verify before following · its session changed no files and ran no tests, as captured]";
const UNTESTED_WITH_FILES = "[untested plan: verify before following · its session ran no tests, as captured]";
/** A progress note no test run backs: a plan, but not an approach, so not labelled an untested plan. */
const UNTESTED_PROGRESS = "[plan · untested: its session changed no files and ran no tests, as captured]";
/** The session agent A wrote its plan in, as the plan's and its capture's change events record it. */
const SESSION = "a1b2c3d4-session";

// A's plan on T-4c378528, as the study served it: the premise was wrong, and the option it
// rejected was the shipped fix.
const BADGE_PLAN =
  "PLAN (chosen): ConnectorsPanel (components/settings/connectors-panel.tsx, rendered right after SourcesPanel) already owns slack/figma/posthog with BADGE S/F/P, so filter fetched sources to type gdrive|website in load(). Rejected: adding S/F/P badges to the sources panel, because it would show those rows twice.";

// A's plan on T-1653a3af: right, with its test plan past the first 200 characters.
const CANVAS_PLAN =
  "PLAN: (1) Lower MAX_DPR 2 -> 1.5 in both files. (2) Add a delta-time gate of about 30fps; the sphere advances its angles per frame, so those steps must be scaled by elapsed time. Reset the last-draw time in start(). Rejected: grain-background.tsx, it draws once. TESTS: existing components/silk-shader-background.test.tsx and components/memory-graph-sphere.test.tsx stub rAF; add tests with a fake rAF driving timestamps. Command: npx vitest run components/silk-shader-background.test.tsx components/memory-graph-sphere.test.tsx";

type Run = { command: string; passed: boolean; line: string; at?: string } | undefined;

/** The task's session-state fact as the hook writes it: no run recognised unless `test` is given. */
function capture(
  id: string,
  {
    test,
    files = [],
    writtenAt = CAPTURED_AT,
    session = SESSION,
    lastMessage = "Plan written; nothing implemented.",
  }: { test?: Run; files?: string[]; writtenAt?: string; session?: string; lastMessage?: string } = {},
): ServedFact {
  return {
    id,
    entityName: sessionStateName(TASK, session),
    role: "progress",
    writtenAt,
    ofTask: true,
    by: "agent",
    sessionKey: session,
    content: renderSessionState({ trigger: "Stop", task: TASK, files, testFilesAfterRun: [], test, lastMessage }),
  };
}

/** A plan agent A wrote in {@link SESSION}, unless told otherwise. */
const plan = (
  id: string,
  content: string,
  role: ServedFact["role"] = "decision",
  writtenAt = PLANNED_AT,
  ofTask = true,
  session: string | null = SESSION,
): ServedFact => ({
  id,
  entityName: `plan ${id}`,
  content,
  role,
  writtenAt,
  by: "agent",
  sessionKey: session,
  ...(ofTask ? { ofTask: true as const } : {}),
});

const passed: Run = {
  command: "npx vitest run components/settings",
  passed: true,
  line: "Tests  15 passed (15)",
  at: "2026-10-15T01:11:00.000Z",
};
const failed: Run = {
  command: "npx vitest run components/settings",
  passed: false,
  line: "Tests  1 failed | 14 passed (15)",
  at: "2026-10-15T01:11:00.000Z",
};

const render = (facts: ServedFact[], budget?: number) =>
  renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [], facts }, budget);
const lineOf = (text: string | null, id: string) =>
  (text ?? "").split("\n").find((line) => line.includes(`[fact ${id}]`));

describe("an earlier session's plan, as the captures recorded it", () => {
  it("on agent A's T-4c378528 handoff: serves the plan as untested in place of its writer's (decision), and says to check its premises", () => {
    const { text } = render([plan("k5u", BADGE_PLAN), capture("v7l")]);
    const lines = text!.split("\n");
    expect(lines[0]).toBe(TASK_START_HEADER);
    expect(lines[1]).toBe(TASK_START_HEADINGS.leads);
    expect(lines[2]).toBe(TASK_START_PREMISE_CHECK);
    expect(lineOf(text, "k5u")).toMatch(new RegExp(`^- ${escape(UNTESTED)} `));
    expect(text).not.toContain("(decision)");
    expect(text).not.toContain(TASK_START_HEADINGS.settled);
  });

  it("serves a decision its own session tested after it, on a file it names, by its role, and says nothing of premises", () => {
    const { text } = render([
      plan("k5u", BADGE_PLAN),
      capture("v7l", { test: passed, files: ["components/settings/connectors-panel.tsx"] }),
    ]);
    expect(lineOf(text, "k5u")).toMatch(
      /^- \[decision · tested: its session's tests passed after it, on files it names\] /,
    );
    expect(text).not.toContain(TASK_START_PREMISE_CHECK);
  });

  it("keeps a tested decision a lead: only a person's record is settled", () => {
    const { text } = render([
      plan("k5u", BADGE_PLAN),
      capture("v7l", { test: passed, files: ["components/settings/connectors-panel.tsx"] }),
    ]);
    expect(text).not.toContain(TASK_START_HEADINGS.settled);
    expect(text!.indexOf(TASK_START_HEADINGS.leads)).toBeLessThan(text!.indexOf("[fact k5u]"));
  });

  it("serves it as a failing plan when its session's last run failed, and as proposed when the passing run touched no file it names", () => {
    const failing = render([
      plan("k5u", BADGE_PLAN),
      capture("v7l", { test: failed, files: ["components/settings/connectors-panel.tsx"] }),
    ]).text;
    expect(lineOf(failing, "k5u")).toMatch(/^- \[plan · failing: its session's last test run after it FAILED\] /);
    const elsewhere = render([
      plan("k5u", BADGE_PLAN),
      capture("v7l", { test: passed, files: ["components/settings/sources-panel.tsx"] }),
    ]).text;
    expect(lineOf(elsewhere, "k5u")).toMatch(
      /^- \[plan · proposed: its session's passing run changed no file it names\] /,
    );
    for (const text of [failing, elsewhere]) expect(text).toContain(TASK_START_PREMISE_CHECK);
  });

  it("says only that no test ran when the session changed files", () => {
    const { text } = render([
      plan("k5u", BADGE_PLAN),
      capture("v7l", { files: ["components/settings/sources-panel.tsx"] }),
    ]);
    expect(lineOf(text, "k5u")).toMatch(new RegExp(`^- ${escape(UNTESTED_WITH_FILES)} `));
  });

  it("labels a decision untested, a progress note and a write that declared no role as plans, a cause and a constraint by their role, and a rejected option as one", () => {
    const facts = (role: ServedFact["role"]) => [plan("p", BADGE_PLAN, role), capture("v7l")];
    expect(lineOf(render(facts("decision")).text, "p")).toMatch(new RegExp(`^- ${escape(UNTESTED)} `));
    for (const role of ["progress", null] as const) {
      expect(lineOf(render(facts(role)).text, "p")).toMatch(
        /^- \[plan · untested: its session changed no files and ran no tests, as captured\] /,
      );
    }
    for (const role of ["cause", "constraint", "rejected"] as const) {
      const { text } = render(facts(role));
      const type = role === "rejected" ? "rejected option" : role;
      expect(lineOf(text, "p")).toMatch(
        new RegExp(`^- \\[${type} · untested: its session changed no files and ran no tests, as captured\\] `),
      );
      expect(text).not.toContain(TASK_START_PREMISE_CHECK);
    }
  });

  it("is proposed when no capture of its session was written at or after it: that session may not be captured yet", () => {
    const { text } = render([plan("k5u", BADGE_PLAN, "decision", "2026-10-15T02:00:00.000Z"), capture("v7l")]);
    expect(lineOf(text, "k5u")).toMatch(/^- \[untested plan: verify before following\] /);
  });

  it("is proposed with no capture at all, with no session recorded on it, or with a time not known", () => {
    expect(lineOf(render([plan("k5u", BADGE_PLAN)]).text, "k5u")).toMatch(
      /^- \[untested plan: verify before following\] /,
    );
    expect(
      lineOf(render([plan("k5u", BADGE_PLAN, "decision", PLANNED_AT, true, null), capture("v7l")]).text, "k5u"),
    ).toMatch(/^- \[untested plan: verify before following\] /);
    const { writtenAt: _unknown, ...timeless } = plan("k5u", BADGE_PLAN);
    expect(lineOf(render([timeless, capture("v7l")]).text, "k5u")).toMatch(
      /^- \[untested plan: verify before following\] /,
    );
  });

  it("judges a plan by its own session's capture only, whatever another session of the task ran", () => {
    const facts = [
      plan("k5u", BADGE_PLAN),
      capture("v7l"),
      capture("w8m", {
        test: passed,
        files: ["components/settings/connectors-panel.tsx"],
        session: "e5f6a7b8-session",
      }),
    ];
    expect(lineOf(render(facts).text, "k5u")).toMatch(new RegExp(`^- ${escape(UNTESTED)} `));
    // And another session's run never makes it tested, nor its silence untested.
    const otherOnly = [plan("k5u", BADGE_PLAN), capture("w8m", { session: "e5f6a7b8-session" })];
    expect(lineOf(render(otherOnly).text, "k5u")).toMatch(/^- \[untested plan: verify before following\] /);
  });

  it("is proposed when its session's capture cannot be read", () => {
    const unreadable = {
      ...capture("v7l"),
      content: capture("v7l").content.replace("Last test command: ", "Last test cmd: "),
    };
    expect(lineOf(render([plan("k5u", BADGE_PLAN), unreadable]).text, "k5u")).toMatch(
      /^- \[plan · proposed: its session's capture could not be read\] /,
    );
  });

  it("judges another task's version under the same name by its own session too, and never marks it", () => {
    const { text } = render([
      plan("other", BADGE_PLAN, "decision", PLANNED_AT, false, "another-task-session"),
      capture("v7l"),
    ]);
    expect(lineOf(text, "other")).toMatch(/^- \[untested plan: verify before following\] /);
  });

  it("is decided from the captures, not the plan's words: a plan that says it was tested is still labelled untested", () => {
    const claim = `${BADGE_PLAN} I ran npx vitest run components/settings and all tests pass; tested and verified.`;
    expect(lineOf(render([plan("k5u", claim), capture("v7l")]).text, "k5u")).toMatch(
      new RegExp(`^- ${escape(UNTESTED)} `),
    );
  });

  it("names the captures it stated in the revision and the shown facts, though their own lines did not fit", () => {
    const big = capture("v7l", { lastMessage: "x ".repeat(2000) });
    const budget =
      estimateTokens(`${TASK_START_HEADER}\n${TASK_START_HEADINGS.leads}\n${TASK_START_PREMISE_CHECK}`) + 120;
    const block = render([plan("k5u", BADGE_PLAN), big], budget);
    expect(lineOf(block.text, "v7l")).toBeUndefined();
    expect(lineOf(block.text, "k5u")).toContain(UNTESTED);
    expect(block.shownFactIds).toContain("v7l");
    // A plan whose status no capture decided states none.
    const undecided = render(
      [plan("k5u", BADGE_PLAN, "decision", PLANNED_AT, true, "another-session"), capture("v7l", { test: passed })],
      budget,
    );
    expect(undecided.shownFactIds).not.toContain("v7l");
  });

  it("stays within its budget on any budget, the premise check added on top of it", () => {
    const facts = [plan("k5u", BADGE_PLAN), plan("c1", CANVAS_PLAN, "progress"), capture("v7l")];
    const premiseCost = estimateTokens(`\n${TASK_START_PREMISE_CHECK}`);
    for (let budget = 20; budget <= TASK_START_TOKEN_BUDGET; budget++) {
      const { text } = render(facts, budget);
      if (text === null) continue;
      expect(estimateTokens(withoutSources(text.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
        budget,
      );
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget + premiseCost + SOURCE_ALLOWANCE_TOKENS);
    }
  });

  it("takes no room from the records for the premise check: on a full block they fill the budget to within less than its cost", () => {
    // Reserved out of the records' room, the premise check would end their lines at least its own
    // cost short of the budget; one-word rules leave far less slack than that when the block is full.
    const rules = Array.from(
      { length: 60 },
      (_, i): ServedRule => ({ id: `conv-${i}`, kind: "convention", subject: `Rule ${i}`, text: `R${i}.` }),
    );
    const { text } = renderTaskStartBlock({
      rules,
      writes: [],
      stale: [],
      decisions: [],
      facts: [plan("k5u", BADGE_PLAN), capture("v7l")],
    });
    // The premise check sits under the leads' heading; the records' cost is everything else.
    const lines = text!.split("\n");
    expect(lines.slice(1, 3)).toEqual([TASK_START_HEADINGS.leads, TASK_START_PREMISE_CHECK]);
    const [header, ...rest] = lines.filter((line) => line !== TASK_START_PREMISE_CHECK);
    expect(rest.at(-1)).toMatch(/more left out/);
    // Counted as the renderer counts: the header, then each line with its line break.
    const recordsCost = rest.reduce(
      (tokens, line) => tokens + estimateTokens(`\n${withoutSources(line)}`),
      estimateTokens(header!),
    );
    expect(recordsCost).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
    expect(recordsCost).toBeGreaterThan(TASK_START_TOKEN_BUDGET - estimateTokens(`\n${TASK_START_PREMISE_CHECK}`));
  });
});

describe("the test a plan names, said after its excerpt", () => {
  it("on agent A's T-1653a3af handoff: serves the command the 200-character excerpt used to cut", () => {
    const line = lineOf(render([plan("bhv", CANVAS_PLAN)]).text, "bhv")!;
    expect(line).toContain(
      "Planned test: npx vitest run components/silk-shader-background.test.tsx components/memory-graph-sphere.test.tsx. [fact bhv]",
    );
  });

  it("names the test files a plan names outside its command, and none the command already names", () => {
    const line = lineOf(
      render([plan("stn", "TESTS: add to app/api/sources/[id]/sync/route.test.ts a spy on console.error.")]).text,
      "stn",
    )!;
    expect(line).toContain("Test files it names: app/api/sources/[id]/sync/route.test.ts. [fact stn]");
  });

  it("reads a capture's planned test from its agent's last message when it recognised no run, and says it once", () => {
    const message = "Plan: gate on elapsed time. Command: npx vitest run components/silk-shader-background.test.tsx";
    const { text } = render([capture("v7l", { lastMessage: message }), plan("bhv", CANVAS_PLAN, "progress")]);
    expect(lineOf(text, "v7l")).toContain(
      "Planned test: npx vitest run components/silk-shader-background.test.tsx. [fact v7l]",
    );
    expect(text!.split("Planned test: npx vitest run components/silk-shader-background.test.tsx.")).toHaveLength(2);
  });

  it("says a planned test once, on the first line that names it, though two writes name it", () => {
    const { text } = render([
      plan("bhv", CANVAS_PLAN, "decision"),
      plan("bhw", `Still to do. ${CANVAS_PLAN}`, "progress"),
    ]);
    expect(lineOf(text, "bhv")).toContain("Planned test:");
    expect(lineOf(text, "bhw")).not.toContain("Planned test:");
  });

  it("says no planned test on a capture that recorded a run: its line states the command that ran", () => {
    const { text } = render([capture("v7l", { test: passed, lastMessage: "Ran npm test." })]);
    expect(text).not.toContain("Planned test:");
  });

  it("says nothing for a write that names no test, or another task's write", () => {
    expect(render([plan("k5u", BADGE_PLAN)]).text).not.toMatch(/Planned test|Test files it names/);
    expect(render([plan("other", CANVAS_PLAN, "decision", PLANNED_AT, false)]).text).not.toContain("Planned test:");
  });
});

describe("the captures that decide the label, read apart from the served facts", () => {
  // The read serves at most a few of the task's facts, and a task's later notes can push a
  // capture out of them; the label is decided from every capture the read found.
  const renderWith = (facts: ServedFact[], captures: { read: ServedFact[]; all: boolean }) =>
    renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions: [], facts, captures });

  it("decides from its session's capture when the read holds it, served or not", () => {
    const tested = capture("t1", {
      test: passed,
      files: ["components/settings/connectors-panel.tsx"],
      writtenAt: "2026-10-15T01:11:30.000Z",
    });
    const { text, shownFactIds } = renderWith([plan("k5u", BADGE_PLAN)], { read: [tested], all: true });
    expect(lineOf(text, "k5u")).toMatch(/^- \[decision · tested: /);
    // The status states what the capture recorded, so the erased-person check reads it.
    expect(shownFactIds).toContain("t1");
  });

  it("decides from the newest capture of its session, and states every one it read", () => {
    const older = capture("u0", {
      test: failed,
      files: ["components/settings/connectors-panel.tsx"],
      writtenAt: "2026-10-15T01:11:00.000Z",
    });
    const untested = capture("v7l", { files: ["components/settings/connectors-panel.tsx"] });
    const { text, shownFactIds } = renderWith([plan("k5u", BADGE_PLAN), untested], {
      read: [untested, older],
      all: true,
    });
    expect(lineOf(text, "k5u")).toMatch(new RegExp(`^- ${escape(UNTESTED_WITH_FILES)} `));
    expect(shownFactIds).toEqual(expect.arrayContaining(["v7l", "u0"]));
  });

  it("is proposed when the read holds no capture of its session", () => {
    const { text } = renderWith([plan("k5u", BADGE_PLAN)], {
      read: [capture("w8m", { session: "e5f6a7b8-session" })],
      all: false,
    });
    expect(lineOf(text, "k5u")).toMatch(/^- \[untested plan: verify before following\] /);
  });
});

/** `text` as a regular expression that matches it literally. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the deciding plan and the capture, under the block's budget", () => {
  // On T-2ee2eaff in study 15b, A wrote its plan as a progress note and its session's capture
  // recorded no test run. The capture was served first among the task's progress notes, at its
  // full length and then with its planned test after it, and with the scope's rules held room for
  // and the premise check reserved, A's plan no longer fit: the deciding record left the block.
  const ROUTES_PLAN =
    "PLAN: apply normalizeScopePath() in the handoff and architecture routes before any lookup, the way app/api/sources/route.ts already does, so a scope with a trailing dot or doubled separator resolves to the same grant. Rejected: normalizing inside check(), which every caller would then pay for. TESTS: extend app/api/architecture-routes.test.ts and app/api/handoff-routes.test.ts with a non-canonical scope. Command: npx vitest run app/api/architecture-routes.test.ts app/api/handoff-routes.test.ts";
  const LAST_MESSAGE = `${"Investigated the handoff and architecture routes; both pass the caller's scope straight to check() without normalizing it. ".repeat(7)}Command: npx vitest run app/api/architecture-routes.test.ts app/api/handoff-routes.test.ts`;
  const scopeRule = (id: string): ServedRule => ({
    id,
    kind: "convention",
    subject: `Scope paths rule ${id}`,
    text: `Every route that takes a scope path canonicalizes it before a lookup or a cast; rule ${id} records where the canonical form is defined and who owns it.`,
  });
  const renderWithRules = (facts: ServedFact[]) =>
    renderTaskStartBlock({ rules: ["r1", "r2", "r3"].map(scopeRule), writes: [], stale: [], decisions: [], facts });

  it("serves the untested plan before the capture, so the capture's planned test cannot push it out", () => {
    const { text } = renderWithRules([
      capture("cap", { lastMessage: LAST_MESSAGE }),
      plan("pln", ROUTES_PLAN, "progress"),
    ]);
    const lines = text!.split("\n");
    const planAt = lines.findIndex((line) => line.includes("[fact pln]"));
    expect(planAt).toBeGreaterThan(-1);
    expect(lines[planAt]).toMatch(new RegExp(`^- ${escape(UNTESTED_PROGRESS)} `));
    const captureAt = lines.findIndex((line) => line.includes("[fact cap]"));
    if (captureAt !== -1) expect(captureAt).toBeGreaterThan(planAt);
    expect(estimateTokens(text!)).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
  });

  // A plan its own session's capture does not speak to is proposed, not untested: one written
  // before sessions were recorded, by a client that names none, or in another session.
  it.each([null, "e5f6a7b8-other-session"])("serves a plan whose session is %s before the capture too", (session) => {
    const { text } = renderWithRules([
      capture("cap", { lastMessage: LAST_MESSAGE }),
      plan("pln", ROUTES_PLAN, "progress", PLANNED_AT, true, session),
    ]);
    const lines = text!.split("\n");
    const planAt = lines.findIndex((line) => line.includes("[fact pln]"));
    expect(planAt).toBeGreaterThan(-1);
    expect(lines[planAt]).toMatch(/^- \[plan · proposed\] /);
    const captureAt = lines.findIndex((line) => line.includes("[fact cap]"));
    if (captureAt !== -1) expect(captureAt).toBeGreaterThan(planAt);
  });

  // The capture's line quotes its agent's last message, which can restate the very plan a later
  // session must not take as settled. It is a lead like the rest: labelled unverified, under the
  // leads' heading, and the label is said within the capture's length, so it costs no record room.
  it("labels the capture's line unverified, under the leads, within the capture's length", () => {
    const long = capture("cap", { lastMessage: `${LAST_MESSAGE} ${"More of the plan, restated. ".repeat(60)}` });
    const lines = renderTaskStartBlock({
      rules: [],
      writes: [],
      stale: [],
      decisions: [],
      facts: [long, plan("pln", ROUTES_PLAN, "progress")],
    }).text!.split("\n");
    const captureLine = lines.find((line) => line.includes("[fact cap]"))!;
    expect(TASK_START_CAPTURE_LABEL).toMatch(/^\[run state · unverified: /);
    expect(captureLine.startsWith(`- ${TASK_START_CAPTURE_LABEL} `)).toBe(true);
    expect(lines.indexOf(captureLine)).toBeGreaterThan(lines.indexOf(TASK_START_HEADINGS.leads));
    // "- ", then the label, the excerpt and any planned test: at most CAPTURE_MAX_CHARS (1300).
    expect(Array.from(captureLine.slice(2, captureLine.indexOf(" [fact cap]"))).length).toBeLessThanOrEqual(1300);
  });

  it("says the planned test on the plan, the first line that names it, and not again on the capture", () => {
    const { text } = renderWithRules([
      capture("cap", { lastMessage: LAST_MESSAGE }),
      plan("pln", ROUTES_PLAN, "progress"),
    ]);
    expect(lineOf(text, "pln")).toContain(
      "Planned test: npx vitest run app/api/architecture-routes.test.ts app/api/handoff-routes.test.ts.",
    );
    expect(text!.split("Planned test:")).toHaveLength(2);
  });

  it("keeps a capture that recorded a run first among the progress notes: only an open plan goes before it", () => {
    const tested = capture("cap", {
      test: passed,
      files: ["app/api/handoff-routes.test.ts"],
      lastMessage: "Ran the route tests.",
    });
    const { text } = renderWithRules([tested, plan("pln", ROUTES_PLAN, "progress")]);
    const lines = text!.split("\n");
    expect(lines.findIndex((line) => line.includes("[fact cap]"))).toBeLessThan(
      lines.findIndex((line) => line.includes("[fact pln]")),
    );
  });

  it("serves a capture's line, planned test included, no longer than the capture alone was served", () => {
    const command = " Command: npx vitest run app/api/handoff-routes.test.ts";
    const files = Array.from({ length: 12 }, (_, i) => `app/api/handoff/nested/segment-${i}/route-handler.ts`);
    const planned = capture("cap", { files, lastMessage: `${"x".repeat(900)}${command}` });
    const unplanned = capture("cap", { files, lastMessage: "x".repeat(900 + command.length) });
    const line = lineOf(render([planned], 2000).text, "cap")!;
    expect(line).toContain("Planned test: npx vitest run app/api/handoff-routes.test.ts.");
    expect(line.length).toBeLessThanOrEqual(lineOf(render([unplanned], 2000).text, "cap")!.length);
  });

  it("serves the capture after an untested plan that a later progress note is served ahead of", () => {
    // A note written after the capture is not an untested plan, so it is the first progress note;
    // the capture must still go after the older untested plan behind it, not just before the note.
    const later = plan(
      "late",
      "Picked up the routes after A's session; reading the handoff route first.",
      "progress",
      "2026-10-15T01:20:00.000Z",
    );
    const { text } = renderWithRules([
      capture("cap", { lastMessage: LAST_MESSAGE }),
      later,
      plan("pln", ROUTES_PLAN, "progress"),
    ]);
    const lines = text!.split("\n");
    const planAt = lines.findIndex((line) => line.includes("[fact pln]"));
    expect(planAt).toBeGreaterThan(-1);
    expect(lines[planAt]).toMatch(new RegExp(`^- ${escape(UNTESTED_PROGRESS)} `));
    const captureAt = lines.findIndex((line) => line.includes("[fact cap]"));
    if (captureAt !== -1) expect(captureAt).toBeGreaterThan(planAt);
  });
});
