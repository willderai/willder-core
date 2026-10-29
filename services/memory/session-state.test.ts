// A captured session state read back from its fact, and what counts as a claim that the work is
// complete. The producer is the willder init hook's renderSessionState, imported here as it
// ships, so a change to the hook's format that this reader cannot follow fails here first. How
// the task-start block serves both is covered in mcp/task-start-session-state.test.ts.
import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_CHARS,
  editedTestsOf,
  renderSessionState,
  sessionStateName,
} from "@/cli/hooks/willder-capture.mjs";
import {
  capturedSessionState,
  claimsCompletion,
  unverifiedBy,
  type CapturedTestRun,
  type SessionStateFact,
} from "./session-state";

const MESSAGE = "Moved the ack after the write; the suite passes now.";
const NAME = sessionStateName("WEB-412", "7d3e91c0-hook-session");
const RAN_AT = "2026-10-13T12:40:00.000Z";

type HookTest = {
  command: string;
  passed: boolean;
  line: string;
  at?: string;
  edited?: ReturnType<typeof editedTestsOf>;
  existing?: string[] | null;
};

/** A session-state fact as the hook stores it: its name, the progress role and the rendered text. */
function capture(
  test: HookTest | undefined,
  overrides: { files?: string[] | null; lastMessage?: string; task?: string } = {},
) {
  const task = overrides.task ?? "WEB-412";
  return {
    entityName: sessionStateName(task, "7d3e91c0-hook-session"),
    role: "progress" as const,
    content: renderSessionState({
      trigger: "Stop",
      task,
      files: "files" in overrides ? (overrides.files ?? null) : ["ack.ts"],
      test,
      lastMessage: overrides.lastMessage ?? MESSAGE,
    }),
  };
}

/** The same fact as a hook from before the run line wrote it: no run, edit or named line. */
function oldHookCapture(command: string, result: "passed" | "failed", line: string) {
  return {
    entityName: NAME,
    role: "progress" as const,
    content: [
      "Session state captured automatically by the Willder hook at Stop; not written on purpose by the agent, and may be incomplete.",
      "Task: WEB-412",
      "Files changed since the session started: ack.ts",
      `Last test command: ${command} -> ${result} (${line})`,
      `Agent's last message: ${MESSAGE}`,
    ].join("\n"),
  };
}

const run = (fact: ReturnType<typeof capture>) => capturedSessionState(fact)?.lastTest;

describe("capturedSessionState", () => {
  it("reads a run's result and time from the hook's run line, and its command and summary from the command line", () => {
    const state = capturedSessionState(
      capture({
        command: "npm test -- ack",
        passed: false,
        line: "Tests  1 failed | 3 passed (4)",
        at: RAN_AT,
        edited: null,
      }),
    );

    expect(state?.lastTest).toEqual({
      result: "failed",
      at: RAN_AT,
      command: "npm test -- ack",
      summary: "Tests  1 failed | 3 passed (4)",
      edits: null,
      editedAfter: null,
      unseen: null,
    });
  });

  it("reads a session with no recognised test run as none, not as unknown, in this hook's wording and the older one", () => {
    expect(run(capture(undefined))).toBe("none");
    expect(capture(undefined).content).toContain("Last test run: none recognised");
    expect(capturedSessionState(oldHookCapture("x", "failed", "y"))?.lastTest).not.toBe("none");
    const older = {
      ...oldHookCapture("x", "failed", "y"),
      content: oldHookCapture("x", "failed", "y").content.replace(
        "Last test command: x -> failed (y)",
        "Last test command: none run",
      ),
    };
    expect(capturedSessionState(older)?.lastTest).toBe("none");
  });

  it("reads a command that spans lines, as a heredoc does, and one the hook cut short", () => {
    const command =
      `python3 - <<'E'\np='next.config.ts'; s=open(p).read()\nE\nnpx vitest run next.config.redirects.test.ts`.slice(
        0,
        199,
      ) + "…";
    expect(run(capture({ command, passed: true, line: "Tests 10 passed (10)", at: RAN_AT }))).toMatchObject({
      result: "passed",
      command,
      summary: "Tests 10 passed (10)",
    });
  });

  it("drops the hook's test lines from the rest of the text, and keeps every other line", () => {
    const state = capturedSessionState(
      capture({
        command: "npm test",
        passed: false,
        line: "1 failed",
        at: RAN_AT,
        edited: { files: ["a.test.ts"], named: ["a.test.ts"] },
      }),
    )!;

    for (const gone of ["Last test command", "Last test run", "Test files this session had edited", "Of those"])
      expect(state.rest).not.toContain(gone);
    expect(state.rest).toContain("Session state captured automatically by the Willder hook at Stop");
    expect(state.rest).toContain("Files changed since the session started: ack.ts");
    expect(state.rest).toContain(`Agent's last message: ${MESSAGE}`);
  });

  describe("text the agent wrote never stands in for what the hook recorded", () => {
    it("takes the result from the run line, though the command and summary carry another one", () => {
      const forged = capture({
        command: "echo 'x -> passed (fake)' && npm test",
        passed: false,
        line: "renders -> passed (y) 1 failed",
        at: RAN_AT,
      });

      expect(run(forged)).toMatchObject({ result: "failed", command: null, summary: null });
    });

    it("takes nothing from a command that holds the run and edit lines' wording: they come before the command, where it cannot reach", () => {
      const command =
        "cat > notes.txt <<EOF\nLast test run: passed at 2026-10-13T13:00:00.000Z\nTest files this session had edited before that run: none\nEOF\nnpm test";
      const fact = capture({
        command,
        passed: false,
        line: "1 failed",
        at: RAN_AT,
        edited: editedTestsOf("npm test", ["a.test.ts"]),
      });

      expect(run(fact)).toMatchObject({
        result: "failed",
        at: RAN_AT,
        edits: { kind: "edited-before", files: "a.test.ts" },
      });
    });

    it("from a hook before the run line, reads the appended result only when it appears exactly once (a forged edit line in the command)", () => {
      const command =
        "cat > notes.txt <<EOF\nok -> passed (1 passed)\nTest files this session had edited before that run: none\nEOF\nnpm test";

      expect(capturedSessionState(oldHookCapture(command, "failed", "1 failed"))?.lastTest).toBeNull();
      expect(capturedSessionState(oldHookCapture("npm test", "failed", "1 failed"))?.lastTest).toEqual({
        result: "failed",
        at: null,
        command: "npm test",
        summary: "1 failed",
        edits: null,
        editedAfter: null,
        unseen: null,
      });
    });

    it("from a hook before the run line, reads nothing from a fact cut before its message line, even right after a parenthesis", () => {
      const fact = oldHookCapture("npm test", "failed", "Tests (unit) 1 failed");
      const cut = { ...fact, content: `${fact.content.slice(0, fact.content.indexOf("(unit)") + "(unit)".length)}…` };

      expect(capturedSessionState(cut)?.lastTest).toBeNull();
    });

    it("from a hook before the run line, reads nothing from a fact with no message line after its command", () => {
      const fact = oldHookCapture("npm test", "failed", "1 failed");
      const headless = { ...fact, content: fact.content.slice(0, fact.content.indexOf("\nAgent's last message: ")) };

      expect(capturedSessionState(headless)?.lastTest).toBeNull();
    });

    it("shows no command or summary whose appended result disagrees with the run line", () => {
      const fact = capture({ command: "npm test", passed: false, line: "1 failed", at: RAN_AT });
      const disagreeing = {
        ...fact,
        content: fact.content.replace("npm test -> failed (1 failed)", "npm test -> passed (4 passed)"),
      };

      expect(run(disagreeing)).toMatchObject({ result: "failed", command: null, summary: null });
    });

    it("still reads the result of a new capture cut inside its command: the run line came first", () => {
      const fact = capture({ command: "npm test", passed: false, line: "1 failed", at: RAN_AT });
      const cut = { ...fact, content: `${fact.content.slice(0, fact.content.indexOf(" -> failed"))}…` };

      expect(run(cut)).toMatchObject({ result: "failed", at: RAN_AT, command: null, summary: null });
    });

    it("reads nothing from a fact cut before its test lines, or one with two run lines", () => {
      const fact = capture(
        { command: "npm test", passed: false, line: "1 failed", at: RAN_AT },
        { task: "T".repeat(MAX_CONTENT_CHARS) },
      );
      expect(
        capturedSessionState({ ...fact, content: `${fact.content.slice(0, MAX_CONTENT_CHARS - 1)}…` })?.lastTest,
      ).toBeNull();

      const twice = capture({ command: "npm test", passed: false, line: "1 failed", at: RAN_AT });
      const doubled = {
        ...twice,
        content: twice.content.replace("Last test run: failed", "Last test run: passed\nLast test run: failed"),
      };
      expect(capturedSessionState(doubled)?.lastTest).toBeNull();
    });

    it("reads nothing from a run line it does not recognise", () => {
      const fact = capture({ command: "npm test", passed: true, line: "4 passed", at: RAN_AT });
      expect(
        capturedSessionState({
          ...fact,
          content: fact.content.replace("Last test run: passed at", "Last test run: maybe at"),
        })?.lastTest,
      ).toBeNull();
      expect(
        capturedSessionState({ ...fact, content: fact.content.replace(RAN_AT, "yesterday") })?.lastTest,
      ).toBeNull();
    });
  });

  describe("which tests the run used that its session had edited", () => {
    const edits = (edited: HookTest["edited"], existing?: string[] | null) => {
      const test = run(
        capture({
          command: "npx vitest run next.config.redirects.test.ts",
          passed: true,
          line: "Tests 10 passed (10)",
          at: RAN_AT,
          edited,
          existing,
        }),
      );
      return typeof test === "object" && test !== null ? test.edits : "unread";
    };

    it("a rewritten shipped test: the run named the test file its session had rewritten, which existed at its start", () => {
      const edited = editedTestsOf("npx vitest run next.config.redirects.test.ts", [
        "next.config.ts",
        "next.config.redirects.test.ts",
      ]);
      expect(edits(edited, ["next.config.redirects.test.ts"])).toEqual({
        kind: "ran-edited",
        files: "next.config.redirects.test.ts",
        existing: "next.config.redirects.test.ts",
      });
    });

    it("reads which edited tests the run used existed at the session's start: some, none, or not known", () => {
      const edited = editedTestsOf("npx vitest run next.config.redirects.test.ts", ["next.config.redirects.test.ts"]);
      expect(edits(edited, [])).toMatchObject({ kind: "ran-edited", existing: "none" });
      expect(edits(edited, null)).toMatchObject({ kind: "ran-edited", existing: null });
      // A hook from before the line existed wrote none: not known, never "none".
      expect(edits(edited)).toMatchObject({ kind: "ran-edited", existing: null });
      expect(edits(editedTestsOf("npm test", ["a.test.ts", "b.test.ts"]), ["b.test.ts"])).toEqual({
        kind: "edited-before",
        files: "a.test.ts, b.test.ts",
        existing: "b.test.ts",
      });
    });

    it("the session had edited no test file the capture saw before the run", () => {
      expect(edits(editedTestsOf("npm test", ["next.config.ts"]))).toEqual({ kind: "none-seen" });
    });

    it("reads the test files the session edited after the run, none, or not known", () => {
      const after = (testFilesAfterRun: string[] | null | undefined) =>
        run({
          ...capture(undefined),
          content: renderSessionState({
            trigger: "Stop",
            task: "WEB-412",
            files: [],
            testFilesAfterRun,
            test: {
              command: "npm test",
              passed: true,
              line: "4 passed",
              at: RAN_AT,
              edited: editedTestsOf("npm test", []),
            },
          }),
        });
      expect(after(["src/a.test.ts"])).toMatchObject({ editedAfter: "src/a.test.ts" });
      expect(after([])).toMatchObject({ editedAfter: "none" });
      expect(after(null)).toMatchObject({ editedAfter: null });
      expect(after(undefined)).toMatchObject({ editedAfter: null });
    });

    it("the session had edited test files the run named none of, naming other tests", () => {
      expect(edits(editedTestsOf("npx vitest run app/a.test.ts", ["app/b.test.ts", "app/c.test.ts"]))).toEqual({
        kind: "edited-other",
        files: "app/b.test.ts, app/c.test.ts",
        existing: null,
      });
      expect(edits(editedTestsOf("npx vitest run app/a.test.ts", ["app/b.test.ts"]), ["app/b.test.ts"])).toEqual({
        kind: "edited-other",
        files: "app/b.test.ts",
        existing: "app/b.test.ts",
      });
    });

    it("the session had edited test files and the run named no test path: it ran them among the rest", () => {
      expect(edits(editedTestsOf("npm test", ["app/b.test.ts"]))).toEqual({
        kind: "edited-before",
        files: "app/b.test.ts",
        existing: null,
      });
    });

    it("reads the test paths a run reached that the capture cannot see into", () => {
      const test = {
        command: "npm --prefix ../b test",
        passed: true,
        line: "4 passed",
        at: RAN_AT,
        edited: editedTestsOf("npm test", []),
        unseen: ["../b"],
      };
      expect(
        run({
          ...capture(undefined),
          content: renderSessionState({ trigger: "Stop", task: "WEB-412", files: [], test }),
        }),
      ).toMatchObject({ unseen: "../b" });
    });

    it("git could not say, or the hook predates these lines: nothing is read", () => {
      expect(edits(null)).toBeNull();
      expect(edits(undefined)).toBeNull();
    });

    it("keeps a capped list as the hook wrote it", () => {
      const read = edits(
        editedTestsOf(
          "npm test",
          Array.from({ length: 40 }, (_, i) => `tests/case-${i}.test.ts`),
        ),
      );
      expect(read).toMatchObject({ kind: "edited-before" });
      expect((read as { files: string }).files).toMatch(/^tests\/case-0\.test\.ts, .*\(\+\d+ more\)$/);
    });

    it("reads a named line it does not recognise as a list of named files, and nothing from a list with no named line", () => {
      const fact = capture({
        command: "npm test",
        passed: true,
        line: "4 passed",
        at: RAN_AT,
        edited: editedTestsOf("npm test", ["a.test.ts"]),
      });
      const garbled = {
        ...fact,
        content: fact.content.replace("none by name; it ran tests without naming them", "maybe some"),
      };
      const unnamed = { ...fact, content: fact.content.replace(/\nOf those, the last test command named: [^\n]*/, "") };

      expect(capturedSessionState(garbled)?.lastTest).toMatchObject({
        result: "passed",
        edits: { kind: "ran-edited", files: "maybe some" },
      });
      expect(capturedSessionState(unnamed)?.lastTest).toMatchObject({ result: "passed", edits: null });
    });
  });

  it("is not a session state unless it has the hook's opening, the progress role and the hook's name", () => {
    const fact = capture({ command: "npm test", passed: false, line: "1 failed", at: RAN_AT });

    expect(capturedSessionState(fact)).not.toBeNull();
    expect(capturedSessionState({ ...fact, role: null })).toBeNull();
    expect(capturedSessionState({ ...fact, role: "decision" })).toBeNull();
    expect(capturedSessionState({ ...fact, entityName: "Release plan" })).toBeNull();
    expect(capturedSessionState({ ...fact, entityName: null })).toBeNull();
    expect(capturedSessionState({ ...fact, content: `Note: ${fact.content}` })).toBeNull();
  });
});

describe("unverifiedBy", () => {
  const state = (
    id: string,
    lastTest: SessionStateFact["state"]["lastTest"],
    writtenAt?: string,
    editedByCapture: string | null = null,
  ): SessionStateFact => ({
    id,
    ...(writtenAt ? { writtenAt } : {}),
    state: { lastTest, editedByCapture, filesChanged: null, lastMessage: null, rest: "" },
  });
  const ran = (
    result: "passed" | "failed",
    at: string | null,
    edits: CapturedTestRun["edits"] = { kind: "none-seen" },
    editedAfter: string | null = "none",
  ): CapturedTestRun => ({
    result,
    at,
    command: "npm test",
    summary: result === "passed" ? "4 passed" : "1 failed",
    edits,
    editedAfter,
    unseen: null,
  });

  it("says nothing when no session state was captured, or none recognised a run", () => {
    expect(unverifiedBy([])).toBeNull();
    expect(unverifiedBy([state("b", "none", "2026-10-13T13:00:00.000Z", "none"), state("a", "none")])).toBeNull();
  });

  it("(a) names a failure of the last recognised run, and every capture it read", () => {
    expect(
      unverifiedBy([
        state("s2", ran("failed", "2026-10-13T13:00:00.000Z")),
        state("s1", ran("passed", "2026-10-13T12:00:00.000Z")),
      ]),
    ).toEqual({ reason: "failed", captures: ["s2", "s1"] });
  });

  it("finds no problem in a pass with no test edits seen, whatever an older run said", () => {
    expect(
      unverifiedBy([
        state("s2", ran("passed", "2026-10-13T13:00:00.000Z")),
        state("s1", ran("failed", "2026-10-13T12:00:00.000Z")),
      ]),
    ).toBeNull();
  });

  it("(b) names a pass on tests that existed at its session's start and that it had edited, named or among the suite it ran", () => {
    expect(
      unverifiedBy([
        state("s2", ran("passed", null, { kind: "ran-edited", files: "a.test.ts", existing: "a.test.ts" })),
      ]),
    ).toMatchObject({ reason: "passed-on-edited-tests" });
    expect(
      unverifiedBy([
        state(
          "s2",
          ran("passed", null, { kind: "edited-before", files: "a.test.ts, b.test.ts", existing: "b.test.ts" }),
        ),
      ]),
    ).toMatchObject({ reason: "passed-after-editing-tests" });
  });

  it("(b) holds however the run named its tests: an existing fixture or a removed test beside a run of other tests", () => {
    expect(
      unverifiedBy([
        state(
          "s1",
          ran("passed", null, {
            kind: "edited-other",
            files: "tests/fixtures/a.json",
            existing: "tests/fixtures/a.json",
          }),
        ),
      ]),
    ).toMatchObject({
      reason: "passed-after-editing-tests",
    });
  });

  it("(b) says whether the run named one of the existing tests, or only came after the session edited them", () => {
    const named = (files: string, existing: string) =>
      unverifiedBy([state("s2", ran("passed", null, { kind: "ran-edited", files, existing }))]);
    expect(named("tests/new.test.ts", "tests/old.test.ts")).toMatchObject({ reason: "passed-after-editing-tests" });
    expect(named("tests/new.test.ts, tests/old.test.ts", "tests/old.test.ts")).toMatchObject({
      reason: "passed-on-edited-tests",
    });
    expect(named("tests/new.test.ts, tests/old.test.ts (+3 more)", "tests/a.test.ts, tests/old.test.ts")).toMatchObject(
      { reason: "passed-on-edited-tests" },
    );
  });

  it("finds no problem in a pass on tests its session wrote, or whose existence at the start is not known (test-first work)", () => {
    expect(
      unverifiedBy([state("s2", ran("passed", null, { kind: "ran-edited", files: "a.test.ts", existing: "none" }))]),
    ).toBeNull();
    expect(
      unverifiedBy([state("s2", ran("passed", null, { kind: "edited-before", files: "a.test.ts", existing: "none" }))]),
    ).toBeNull();
    expect(
      unverifiedBy([state("s2", ran("passed", null, { kind: "ran-edited", files: "a.test.ts", existing: null }))]),
    ).toBeNull();
    expect(
      unverifiedBy([state("s2", ran("passed", null, { kind: "edited-before", files: "a.test.ts", existing: null }))]),
    ).toBeNull();
    // Writing new tests does not hide a failure, or an edit after the pass.
    expect(
      unverifiedBy([state("s2", ran("failed", null, { kind: "ran-edited", files: "a.test.ts", existing: "none" }))]),
    ).toMatchObject({ reason: "failed" });
    expect(
      unverifiedBy([
        state("s2", ran("passed", null, { kind: "ran-edited", files: "a.test.ts", existing: "none" }, "a.test.ts")),
      ]),
    ).toMatchObject({ reason: "tests-edited-after-pass" });
  });

  it("(c) names test edits after the pass, by its own session or by a later one with no recognised run", () => {
    expect(unverifiedBy([state("s1", ran("passed", null, { kind: "none-seen" }, "a.test.ts"))])).toMatchObject({
      reason: "tests-edited-after-pass",
    });
    const pass = state("a", ran("passed", "2026-10-13T12:00:00.000Z"), "2026-10-13T12:01:00.000Z");
    expect(unverifiedBy([state("b", "none", "2026-10-13T13:00:00.000Z", "src/a.test.ts"), pass])).toMatchObject({
      reason: "tests-edited-after-pass",
    });
    // A session with no recognised run that edited no test, or whose edits are not known, is no evidence.
    expect(unverifiedBy([state("b", "none", "2026-10-13T13:00:00.000Z", "none"), pass])).toBeNull();
    expect(unverifiedBy([state("b", "none", "2026-10-13T13:00:00.000Z", null), pass])).toBeNull();
  });

  it("finds no problem in what is not evidence of one: edits it could not tell, other tests the run did not name, no recognised run", () => {
    expect(unverifiedBy([state("s1", ran("passed", null, null, null))])).toBeNull();
    expect(
      unverifiedBy([state("s1", ran("passed", null, { kind: "edited-other", files: "b.test.ts", existing: null }))]),
    ).toBeNull();
    expect(
      unverifiedBy([state("s1", ran("passed", null, { kind: "edited-other", files: "b.test.ts", existing: "none" }))]),
    ).toBeNull();
    expect(unverifiedBy([state("s1", ran("passed", null, { kind: "none-seen" }, null))])).toBeNull();
  });

  it("is decided by the run that happened last, not the capture written last (an older pass written after a newer failure)", () => {
    const olderPassWrittenLater = state("a", ran("passed", "2026-10-13T12:00:00.000Z"), "2026-10-13T13:30:00.000Z");
    const newerFailureWrittenFirst = state("b", ran("failed", "2026-10-13T13:00:00.000Z"), "2026-10-13T13:05:00.000Z");
    expect(unverifiedBy([olderPassWrittenLater, newerFailureWrittenFirst])).toMatchObject({ reason: "failed" });
  });

  it("never dates a run after the capture that recorded it: a clock running ahead is clamped", () => {
    const aheadPass = state("s1", ran("passed", "2026-10-13T17:00:00.000Z"), "2026-10-13T15:00:00.000Z");
    const newerFailure = state("s2", ran("failed", "2026-10-13T15:09:00.000Z"), "2026-10-13T15:10:00.000Z");
    expect(unverifiedBy([newerFailure, aheadPass])).toMatchObject({ reason: "failed" });
  });

  it("dates a run its capture did not time by when the capture was written, the latest it can have run", () => {
    const timed = state("a", ran("passed", "2026-10-13T12:00:00.000Z"), "2026-10-13T13:30:00.000Z");
    const untimedLater = state("b", ran("failed", null), "2026-10-13T13:00:00.000Z");
    expect(unverifiedBy([timed, untimedLater])).toMatchObject({ reason: "failed" });
  });

  it("gives no verdict when a capture it cannot read was written after the deciding run, and may hold a newer one", () => {
    expect(
      unverifiedBy([
        state("s2", null, "2026-10-13T13:00:00.000Z"),
        state("s1", ran("failed", "2026-10-13T12:00:00.000Z")),
      ]),
    ).toBeNull();
    const deciding = state(
      "s3",
      ran("passed", "2026-10-13T12:00:00.000Z", { kind: "ran-edited", files: "a.test.ts", existing: "a.test.ts" }),
      "2026-10-13T14:00:00.000Z",
    );
    expect(unverifiedBy([deciding, state("s2", null, "2026-10-13T13:00:00.000Z")])).toBeNull();
    expect(unverifiedBy([deciding, state("s0", null, "2026-10-13T11:00:00.000Z")])).toMatchObject({
      reason: "passed-on-edited-tests",
    });
  });
});

describe("claimsCompletion", () => {
  it.each([
    "T-7c3e19a2: Finished legacy-pages prune. Deleted the leftover page.",
    "Fixed: the form now sends the token.",
    "Done.",
    "The double ack is fixed.",
    "Resolved by moving the ack after the write.",
    "Completed the migration; the tests pass.",
    "- **Fixed** the retry path",
    "All done",
    "FINISHED THE PRUNE",
    "The bug has been fixed, see the PR.",
    "Not done: the docs. Fixed the redirect.",
    // A word that scopes nothing earlier in the clause does not take the claim back.
    "Moved the redirect to next.config and fixed the test.",
    "Added a guard to the parser and fixed the redirect",
    "No regressions and everything is fixed",
    "Nothing else to do — all fixed",
    "I didn't touch the tests and fixed the bug",
    "When I reran the suite everything was fixed",
    "Switched to the new API and it's done",
    "Task complete.",
    "Fix complete: all green",
    "Not done, but fixed the redirect",
    "Not tested and fixed the redirect",
    "Merged the prune.",
    "Prune landed.",
    "I can confirm it's done.",
    "The prune is complete with all tests passing.",
    "Implemented the redirect removal.",
    "Shipped the fix behind the flag.",
    "Addressed the review comments.",
  ])("reads %j as a claim that the work is complete", (text) => {
    expect(claimsCompletion(text)).toBe(true);
  });

  it.each([
    "Not done: CHANGELOG.md entries and a full test run.",
    "Not yet fixed.",
    "This isn't fixed until the webhook is retried.",
    "The retry path still needs to be fixed.",
    "What remains to be done: the docs.",
    "Will be resolved in the next PR.",
    "Almost done with the prune.",
    "Partially fixed: Slack works, Figma does not.",
    "It has not yet been fixed.",
    "The redirect is not going to be fixed.",
    "Is it fixed?",
    "If fixed, ship it on Monday.",
    "Before it is fixed, keep the flag off.",
    "TODO: finished-state banner copy",
    "Fix: added a password token input to the Slack form.",
    "Use `done()` to end the stream and `fixed_point` for the layout.",
    "Slack and Figma connect no longer 400 in production.",
    "isDone flips once the queue drains.",
    "unresolved: who owns the rollout",
    "prefixed refunds are refixable",
    "A complete list of the cut routes.",
    "It can be fixed later.",
    "The tests don't pass yet.",
    "Not ready to merge.",
    "Not implemented yet.",
    // The claim is taken back in the next clause.
    "The redirect is done; the tests are not.",
    "The page is done, the tests aren't",
    "Docs finished; tests not yet.",
    "",
  ])("does not read %j as a claim that the work is complete", (text) => {
    expect(claimsCompletion(text)).toBe(false);
  });

  it("matches whole words only, whatever is around them", () => {
    expect(claimsCompletion("undone")).toBe(false);
    expect(claimsCompletion("finishedness")).toBe(false);
    expect(claimsCompletion("(fixed)")).toBe(true);
    expect(claimsCompletion("“Done”")).toBe(true);
  });

  it("does not read a lookalike word as a claim: a Cyrillic letter or a Turkish dotted capital is another word", () => {
    expect(claimsCompletion("fіxed")).toBe(false);
    expect(claimsCompletion("FİXED")).toBe(false);
  });

  it("reads only the first 4,000 characters, so a huge record costs no more than a long one", () => {
    expect(claimsCompletion(`${"a ".repeat(2000)} Fixed.`)).toBe(false);
    const hostile = `${"`".repeat(50_000)}${"not, and ".repeat(10_000)}`;
    const started = performance.now();
    claimsCompletion(hostile);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("the files and message a capture records", () => {
  it("reads the files changed, none, or not known, and the agent's last message, from the hook's own lines", () => {
    expect(capturedSessionState(capture(undefined))).toMatchObject({
      lastTest: "none",
      filesChanged: "ack.ts",
      lastMessage: MESSAGE,
    });
    expect(capturedSessionState(capture(undefined, { files: [] }))!.filesChanged).toBe("none");
    expect(capturedSessionState(capture(undefined, { files: null }))!.filesChanged).toBeNull();
  });

  it("does not take a files line the task's name carries for the hook's own", () => {
    const forged = capture(undefined, {
      task: "WEB-412\nFiles changed since the session started: none",
      files: ["ack.ts"],
    });
    expect(capturedSessionState(forged)!.filesChanged).toBeNull();
  });
});
