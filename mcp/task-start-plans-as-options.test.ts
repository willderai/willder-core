// The task-start block serves an earlier session's findings as leads and its approaches as options.
// In a paired study the block served agent A's untested plan above its own cause, both labelled the same way, and in both legs it misled, agent B followed the plan where the
// cause pointed at the precedent the shipped fix used. A plan no test run backs is now labelled an
// untested plan and served after the causes; one a test run backs is not; and the block says one
// test command, the narrowest, not a plan's verify list.
import { describe, expect, it } from "vitest";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import { testCommandsIn } from "@/services/memory/planned-test";
import { renderTaskStartBlock } from "./task-start-notice";
import { TASK_START_HEADINGS, TASK_START_PREMISE_CHECK, TASK_START_UNTESTED_PLAN } from "./task-start-headings";

const TASK = "T-b1741bc2";
const SESSION = "planning-session";
const WRITTEN_AT = "2026-10-20T10:00:00.000Z";
const CAPTURED_AT = "2026-10-20T10:05:00.000Z";

// Agent A's two writes on T-b1741bc2, shortened: the cause names the precedent the shipped fix
// mirrored; the plan prefers the option the shipped test rejects.
const CAUSE =
  "Cause: services/memory/guarded-store.ts removeEntity and removeFact check memory.delete on the caller's scope, then call the store with input.groupId. Compare transferEntity in the same file, which writes groupId: scope ?? input.groupId.";
const PLAN =
  "Plan: add a separate scopePath in graphiti-store removeEntity/removeFact and have guarded-store set scopePath: scope. This option is preferred over overwriting groupId.";

const fact = (id: string, content: string, role: ServedFact["role"], extra: Partial<ServedFact> = {}): ServedFact => ({
  id,
  entityName: `${TASK} ${id}`,
  content,
  role,
  writtenAt: WRITTEN_AT,
  ofTask: true,
  by: "agent",
  sessionKey: SESSION,
  ...extra,
});

/** The planning session's capture: what the hook recorded at Stop. */
function capture(
  id: string,
  {
    test,
    files = [],
  }: { test?: { command: string; passed: boolean; line: string; at: string }; files?: string[] } = {},
): ServedFact {
  return {
    id,
    entityName: sessionStateName(TASK, SESSION),
    role: "progress",
    writtenAt: CAPTURED_AT,
    ofTask: true,
    by: "agent",
    sessionKey: SESSION,
    content: renderSessionState({
      trigger: "Stop",
      task: TASK,
      files,
      testFilesAfterRun: [],
      test,
      lastMessage: "Recorded the cause and a plan.",
    }),
  };
}

const render = (facts: ServedFact[], decisions: ServedRule[] = []) =>
  renderTaskStartBlock({ rules: [], writes: [], stale: [], decisions, facts });
const recordLines = (text: string | null) => (text ?? "").split("\n").filter((line) => line.startsWith("- "));
const indexOf = (text: string | null, id: string) =>
  recordLines(text).findIndex((line) => line.includes(`[fact ${id}]`) || line.includes(` ${id}] `));

describe("findings as leads, plans as options", () => {
  it("labels an untested plan and serves it after the cause, even when the read ranked the plan first", () => {
    // The read ranks both as deciding and put the plan first, as it did in the study.
    const { text } = render([fact("plan", PLAN, "decision"), fact("cause", CAUSE, "cause"), capture("cap")]);
    const lines = recordLines(text);
    expect(indexOf(text, "cause")).toBe(0);
    expect(indexOf(text, "plan")).toBe(1);
    expect(lines[0]).toMatch(
      /^- \[cause · untested: its session changed no files and ran no tests, as captured\] Cause: /,
    );
    expect(lines[1]).toMatch(
      new RegExp(
        `^- \\[${TASK_START_UNTESTED_PLAN} · its session changed no files and ran no tests, as captured\\] Plan: `,
      ),
    );
    // The block still says once, under the leads' heading, that a plan is a hypothesis.
    expect(text!.split("\n").slice(1, 3)).toEqual([TASK_START_HEADINGS.leads, TASK_START_PREMISE_CHECK]);
  });

  it.each([
    ["a plan fact", (plan: ServedFact) => [plan, fact("cause", CAUSE, "cause")], []],
    [
      "an agent-recorded decision",
      () => [fact("cause", CAUSE, "cause")],
      [
        {
          id: "d-plan",
          kind: "decision",
          subject: "cache approach",
          text: PLAN,
          by: "agent",
          ofTask: true,
          sessionKey: SESSION,
          writtenAt: WRITTEN_AT,
        } as ServedRule,
      ],
    ],
  ] as const)(
    "serves %s with no session recorded as an untested plan, after the cause",
    (_case, factsFor, decisions) => {
      const plan = fact("plan", PLAN, "decision", { sessionKey: null });
      const { text } = render(factsFor(plan), [...decisions]);
      const lines = recordLines(text);
      expect(lines[0]).toMatch(/^- \[cause · proposed\] Cause: /);
      expect(lines[1]).toContain(`[${TASK_START_UNTESTED_PLAN}]`);
    },
  );

  it("does not down-weight an approach its own session tested: it keeps its role and goes ahead of an untested plan", () => {
    const tested = fact(
      "tested",
      "Approach: mirror transferEntity in services/memory/guarded-store.ts removeEntity and removeFact.",
      "decision",
    );
    const other = fact("other", PLAN, "decision", { sessionKey: "another-session" });
    const passing = capture("cap", {
      files: ["services/memory/guarded-store.ts"],
      test: {
        command: "npx vitest run services/memory/guarded-store.test.ts",
        passed: true,
        line: "Tests  12 passed (12)",
        at: "2026-10-20T10:04:00.000Z",
      },
    });
    // The read ranked the untested plan first.
    const { text } = render([other, tested, passing]);
    const lines = recordLines(text);
    const testedLine = lines[indexOf(text, "tested")]!;
    expect(testedLine).toMatch(/^- \[decision · tested: its session's tests passed after it, on files it names\] /);
    expect(testedLine).not.toContain(TASK_START_UNTESTED_PLAN);
    expect(indexOf(text, "tested")).toBeLessThan(indexOf(text, "other"));
    expect(lines[indexOf(text, "other")]).toContain(`[${TASK_START_UNTESTED_PLAN}]`);
  });

  it("serves a rejected option beside the plan, after the cause", () => {
    const rejected = fact(
      "rejected",
      "Rejected: overwriting groupId with the checked scope, since the pgvector delete keys on it.",
      "rejected",
    );
    const { text } = render([fact("plan", PLAN, "decision"), rejected, fact("cause", CAUSE, "cause")]);
    expect([indexOf(text, "cause"), indexOf(text, "plan"), indexOf(text, "rejected")]).toEqual([0, 1, 2]);
    expect(recordLines(text)[2]).toMatch(/^- \[rejected option · proposed\] /);
  });

  it("keeps a plan's own reason when a run passed but did not back it, rather than calling it untested", () => {
    const elsewhere = capture("cap", {
      files: ["services/memory/other.ts"],
      test: {
        command: "npx vitest run services/memory/other.test.ts",
        passed: true,
        line: "Tests  3 passed (3)",
        at: "2026-10-20T10:04:00.000Z",
      },
    });
    const { text } = render([
      fact("plan", "Approach: mirror transferEntity for the delete path.", "decision"),
      elsewhere,
    ]);
    expect(recordLines(text)[indexOf(text, "plan")]).toMatch(
      /^- \[plan · proposed: its session's passing run changed no file it names\] /,
    );
  });

  it("keeps a tested rejected option beside its plan, not ahead of the cause", () => {
    const rejected = fact("rejected", "Rejected: overwriting groupId in services/memory/guarded-store.ts.", "rejected");
    const passing = capture("cap", {
      files: ["services/memory/guarded-store.ts"],
      test: {
        command: "npx vitest run services/memory/guarded-store.test.ts",
        passed: true,
        line: "Tests  12 passed (12)",
        at: "2026-10-20T10:04:00.000Z",
      },
    });
    const other = { sessionKey: "another-session" };
    const { text } = render([
      rejected,
      fact("cause", CAUSE, "cause", other),
      fact("plan", PLAN, "decision", other),
      passing,
    ]);
    expect(indexOf(text, "cause")).toBe(0);
    expect(indexOf(text, "rejected")).toBeGreaterThan(indexOf(text, "cause"));
  });

  it("opens the leads with a disputed cause too, served with every version", () => {
    const a = fact("cause-a", CAUSE, "cause", {
      entityName: "scope drop",
      scopePath: "org_1.web",
      writtenBy: "agent-a",
      writer: { actorType: "agent", actorId: "agent-a" },
    });
    const b = fact("cause-b", `${CAUSE} It also drops it on update.`, "cause", {
      entityName: "scope drop",
      scopePath: "org_1.web",
      writtenBy: "agent-b",
      writer: { actorType: "agent", actorId: "agent-b" },
    });
    const { text } = render([fact("plan", PLAN, "decision"), a, b]);
    const lines = text!.split("\n");
    const conflictAt = lines.findIndex((line) => line.startsWith("Conflicting versions of"));
    expect(conflictAt).toBeGreaterThan(-1);
    expect(conflictAt).toBeLessThan(lines.findIndex((line) => line.includes("[fact plan]")));
  });

  it("keeps a failing plan's label, which says more than untested", () => {
    const failing = capture("cap", {
      files: ["services/memory/guarded-store.ts"],
      test: {
        command: "npx vitest run services/memory/guarded-store.test.ts",
        passed: false,
        line: "Tests  1 failed | 11 passed (12)",
        at: "2026-10-20T10:04:00.000Z",
      },
    });
    const { text } = render([fact("plan", PLAN, "decision"), failing]);
    expect(recordLines(text)[indexOf(text, "plan")]).toMatch(
      /^- \[plan · failing: its session's last test run after it FAILED\] /,
    );
  });
});

describe("one test command, the narrowest", () => {
  const VERIFY_LIST =
    "Plan: in services/access add listReadableScopes and gate GET /api/memory/scopes on it. Verify with: npx vitest run services/access app/api/memory ; npx tsc --noEmit ; npm run scope-gate:check ; npm test.";
  const NARROW = "Test command: npx vitest run services/access/check.test.ts.";

  it("says only the narrowest command any write names, once, and leaves the verify list out of the excerpt", () => {
    const { text } = render([
      fact("plan", VERIFY_LIST, "decision"),
      fact("cmd", NARROW, "progress"),
      fact("cause", CAUSE, "cause"),
    ]);
    expect(testCommandsIn(text!)).toEqual(["npx vitest run services/access/check.test.ts"]);
    expect(text).not.toContain("Verify with");
    expect(text).not.toContain("npx tsc");
    // The approach sentence is what the plan's line serves.
    expect(recordLines(text)[indexOf(text, "plan")]).toContain("Plan: in services/access add listReadableScopes");
  });

  it("with one write's verify list alone, says its narrowest command", () => {
    const { text } = render([fact("plan", VERIFY_LIST, "decision")]);
    expect(testCommandsIn(text!)).toEqual(["npx vitest run services/access app/api/memory"]);
  });

  it("says a command from a served line when the narrowest one's write does not fit", () => {
    const longCause = (i: number) =>
      fact(
        `cause-${i}`,
        `Cause ${i}: ${"services/memory/guarded-store.ts drops the checked scope on the write path, see removeEntity. ".repeat(3)}`,
        "cause",
      );
    const plan = fact(
      "plan",
      "Plan: mirror transferEntity. Test command: npx vitest run services/memory/guarded-store.test.ts.",
      "decision",
    );
    const progress = fact("progress", "Progress: half done. Verify with npx vitest run services/memory.", "progress");
    const { text } = render([plan, ...Array.from({ length: 8 }, (_, i) => longCause(i)), progress]);
    expect(indexOf(text, "plan")).toBe(-1);
    expect(testCommandsIn(text!)).toEqual(["npx vitest run services/memory"]);
  });

  it.each([
    ["a warning not to run it", "Plan: patch removeEntity. Never use npm test; it hangs.", "Never use npm test"],
    [
      "a test still failing",
      "Plan: patch removeEntity. Still failing: npx vitest run services/memory/guarded-store.test.ts.",
      "Still failing",
    ],
    [
      "a passing run",
      "Progress: 12/12 passing with npx vitest run services/memory/guarded-store.test.ts.",
      "12/12 passing",
    ],
  ])("keeps a plan's sentence that names a command beside %s", (_case, content, kept) => {
    const { text } = render([fact("w", content, "decision")]);
    expect(text).toContain(kept);
  });

  it("keeps a cause's sentence whole when it names the test that shows it", () => {
    const cause =
      "Cause: npx vitest run services/memory/guarded-store.test.ts fails because removeEntity drops the checked scope.";
    const { text } = render([fact("cause", cause, "cause")]);
    expect(text).toContain("removeEntity drops the checked scope");
  });
});
