// The task-start block and a task's captured session state: the latest capture is
// served first among the task's progress notes, opening with its last test run stated plainly,
// and a completion claim of the task's own that the captured tests do not back is marked so.
// The case is agent A's on task T-7c3e19a2: it rewrote the shipped regression test, ran it, saw it pass, and recorded "Finished"; agent B
// was served that and stopped. The captures are rendered by the willder init hook itself, so the
// block is tested on the text the hook really writes. The database side is in
// mcp/task-start-session-state.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { editedTestsOf, renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import type { ServedFact, ServedRule, ServedWrite } from "@/services/memory/task-start";
import {
  TASK_START_MAX_TOKENS,
  TASK_START_TOKEN_BUDGET,
  estimateTokens,
  renderTaskStartBlock,
} from "./task-start-notice";
import { withoutSources } from "./task-start-headings";
import { TASK_START_HEADER, TASK_START_HEADINGS, TASK_START_PREMISE_CHECK } from "./task-start-headings";

const TASK = "T-7c3e19a2";
const T_HANDOFF_DECISION: ServedRule = {
  id: "cmdecision0000000000007c3e",
  kind: "decision",
  subject: "legacy-pages prune",
  text: "T-7c3e19a2: Finished legacy-pages prune. Deleted leftover app/(app)/activity page, removed the next.config redirects() for /campaigns,/contacts,/inbox,/activity (they now 404), and dropped those paths from app/robots.ts and proxy.ts. next.config.redirects.test.ts rewritten to assert no redirects, no page dirs, no stale route-list entries. Not done: CHANGELOG.md entries and a full test run; tsc clean.",
  ofTask: true,
};
const T_HANDOFF_RUN =
  "npx vitest run next.config.redirects.test.ts 2>&1 | tail -15; npx tsc --noEmit 2>&1 | tail -5; git diff --stat";
const T_HANDOFF_CHANGED = [
  "app/(app)/activity/page.tsx",
  "app/robots.ts",
  "next.config.redirects.test.ts",
  "next.config.ts",
  "proxy.ts",
];
const CAPTURED_AT = "2026-10-13T12:44:01.000Z";
const RAN_AT = "2026-10-13T12:43:30.000Z";

type Run =
  | {
      command: string;
      passed: boolean;
      line: string;
      at?: string;
      edited?: ReturnType<typeof editedTestsOf>;
      existing?: string[] | null;
    }
  | undefined;

/** A session-state fact as the hook writes it and the task-start read returns it: the task's own. */
function capture(
  id: string,
  test: Run,
  writtenAt = CAPTURED_AT,
  session = "1d0a9876-session",
  files = T_HANDOFF_CHANGED,
  testFilesAfterRun: string[] | null = [],
): ServedFact {
  return {
    id,
    entityName: sessionStateName(TASK, session),
    role: "progress",
    writtenAt,
    ofTask: true,
    content: renderSessionState({
      trigger: "Stop",
      task: TASK,
      files,
      testFilesAfterRun,
      test,
      lastMessage: "The legacy-pages prune is finished: the rewritten test passes (10 tests).",
    }),
  };
}
/** A capture of a session that changed only app/robots.ts: no test edits seen, before the run or after. */
const untouchedCapture = (id: string, writtenAt = CAPTURED_AT, session = "1d0a9876-session") =>
  capture(id, passedOnUntouchedTests, writtenAt, session, ["app/robots.ts"]);
// Agent A rewrote a test the task had shipped: it existed when the session started.
const passedOnRewrittenTest: Run = {
  command: T_HANDOFF_RUN,
  passed: true,
  line: "Tests  10 passed (10)",
  at: RAN_AT,
  edited: editedTestsOf(T_HANDOFF_RUN, T_HANDOFF_CHANGED),
  existing: ["next.config.redirects.test.ts"],
};
const passedOnUntouchedTests: Run = {
  command: "npx vitest run app/robots.test.ts",
  passed: true,
  line: "Tests  3 passed (3)",
  at: RAN_AT,
  edited: editedTestsOf("npx vitest run app/robots.test.ts", ["app/robots.ts"]),
};
const passedAfterEditingTests: Run = {
  command: "npm test",
  passed: true,
  line: "Tests  40 passed (40)",
  at: RAN_AT,
  edited: editedTestsOf("npm test", T_HANDOFF_CHANGED),
  existing: ["next.config.redirects.test.ts"],
};
const passedBeforeEditsWereRecorded: Run = { command: "npm test", passed: true, line: "Tests  40 passed (40)" };
const failed: Run = {
  command: "npx vitest run next.config.redirects.test.ts",
  passed: false,
  line: "Tests  2 failed | 8 passed (10)",
  at: RAN_AT,
  edited: editedTestsOf("npx vitest run next.config.redirects.test.ts", ["next.config.ts"]),
};

const fact = (
  id: string,
  content: string,
  role: ServedFact["role"] = "progress",
  writtenAt = "2026-10-13T12:43:00.000Z",
): ServedFact => ({
  id,
  entityName: `note ${id}`,
  content,
  role,
  writtenAt,
  ofTask: true,
});
const write = (id: string, summary: string, ofTask: boolean): ServedWrite => ({
  id,
  recordType: "brief",
  recordId: `brief-${id}`,
  op: "create",
  actorId: "agent-a",
  summary,
  ...(ofTask ? { ofTask: true as const } : {}),
});
const items = (text: string | null) => (text ?? "").split("\n").filter((line) => line.startsWith("- "));
const render = (sections: Partial<Parameters<typeof renderTaskStartBlock>[0]>, budget?: number) =>
  renderTaskStartBlock({ rules: [], writes: [], stale: [], ...sections }, budget);

describe("the session-state line", () => {
  it("on agent A's T-7c3e19a2 handoff: says the pass used the test the same session rewrote, and marks the Finished decision", () => {
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", passedOnRewrittenTest)] });

    expect(items(text)).toEqual([
      expect.stringMatching(
        /^- \[decision cmdecision0000000000007c3e\] \[untested plan: verify before following\] legacy-pages prune: \[unverified: the last captured passing run used existing tests its own session had edited\] T-7c3e19a2: Finished legacy-pages prune\. /,
      ),
      expect.stringMatching(
        /^- \[run state · unverified: as the hook saw it\] Last test run at 2026-10-13T12:43:30Z: PASSED \(Tests 10 passed \(10\)\), but before it that session had edited tests that existed when it started: next\.config\.redirects\.test\.ts\. Command: npx vitest run next\.config\.redirects\.test\.ts 2>&1 \| tail -15; npx tsc --noEmit 2>&1 \| tail -5; git diff --stat\. Session state captured automatically by the Willder hook at Stop/,
      ),
    ]);
  });

  it("serves none of the hook's own test lines in the capture's text: the opening states them once", () => {
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", passedOnRewrittenTest)] });
    expect(text).not.toMatch(
      /Test files this session|Of those|these existed when the session started|Last test command:/,
    );
  });

  it("states a pass with no test edits seen, scoped to this repository, and marks nothing; never 'edited no test'", () => {
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [untouchedCapture("s1")] });

    expect(text).toContain(
      "Last test run at 2026-10-13T12:43:30Z: PASSED (Tests 3 passed (3)); no test edits seen in this repo. Command: npx vitest run app/robots.test.ts.",
    );
    expect(text).not.toMatch(/\[unverified|edited no test/);
  });

  it("(c) says tests were edited after a pass, and marks the claim", () => {
    const { text } = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [
        capture("s1", passedOnUntouchedTests, CAPTURED_AT, undefined, T_HANDOFF_CHANGED, [
          "next.config.redirects.test.ts",
        ]),
      ],
    });

    expect(text).toContain(
      "PASSED (Tests 3 passed (3)), but tests were edited after it: next.config.redirects.test.ts. Command:",
    );
    expect(text).toContain("[unverified: tests were edited after the last captured passing run] T-7c3e19a2: Finished");
    expect(text).not.toContain("no test edits seen");
  });

  it("(b) says a pass of the whole suite came after the session edited tests, and marks the claim", () => {
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", passedAfterEditingTests)] });

    expect(text).toContain(
      "PASSED (Tests 40 passed (40)), but before it that session had edited tests that existed when it started: next.config.redirects.test.ts. Command: npm test.",
    );
    expect(text).toContain(
      "[unverified: the last captured passing run came after its session edited existing tests] T-7c3e19a2: Finished",
    );
  });

  it("states a pass on tests the session wrote without a mark, and with one only when tests were edited after it", () => {
    const wrote: Run = { ...passedOnRewrittenTest!, existing: [] };
    const plain = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", wrote)] }).text;
    expect(plain).toContain(
      "PASSED (Tests 10 passed (10)); it passed on tests that session wrote: next.config.redirects.test.ts. Command:",
    );
    expect(plain).not.toContain("[unverified");

    const editedAfter = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [capture("s1", wrote, CAPTURED_AT, undefined, T_HANDOFF_CHANGED, ["app/robots.test.ts"])],
    }).text;
    expect(editedAfter).toContain(
      "; it passed on tests that session wrote: next.config.redirects.test.ts, but tests were edited after it: app/robots.test.ts. Command:",
    );
    expect(editedAfter).toContain(
      "[unverified: tests were edited after the last captured passing run] T-7c3e19a2: Finished",
    );
  });

  it("says tests were also edited after a pass on existing tests it had edited", () => {
    const { text } = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [capture("s1", passedOnRewrittenTest, CAPTURED_AT, undefined, T_HANDOFF_CHANGED, ["app/robots.test.ts"])],
    });
    expect(text).toContain(
      ", but before it that session had edited tests that existed when it started: next.config.redirects.test.ts; tests were also edited after it: app/robots.test.ts. Command:",
    );
    expect(text).toContain(
      "[unverified: the last captured passing run used existing tests its own session had edited] T-7c3e19a2: Finished",
    );
  });

  it("names the edited tests without a verdict when which existed is not known", () => {
    const { text } = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [capture("s1", { ...passedOnRewrittenTest!, existing: null })],
    });
    expect(text).toContain(
      "PASSED (Tests 10 passed (10)); that session had edited tests it ran: next.config.redirects.test.ts. Command:",
    );
    expect(text).not.toMatch(/\[unverified|that session wrote/);
  });

  it("names tests the session wrote but the run did not name as written, and marks nothing; an existing one it edited is marked", () => {
    const command = "npx vitest run app/robots.test.ts";
    const wrote: Run = {
      command,
      passed: true,
      line: "Tests  3 passed (3)",
      at: RAN_AT,
      edited: editedTestsOf(command, ["app/proxy.test.ts"]),
      existing: [],
    };
    const plain = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", wrote)] }).text;
    expect(plain).toContain(
      "PASSED (Tests 3 passed (3)); that session had written other tests, which it did not name: app/proxy.test.ts. Command:",
    );
    expect(plain).not.toContain("[unverified");

    const fixture: Run = {
      command,
      passed: true,
      line: "Tests  3 passed (3)",
      at: RAN_AT,
      edited: editedTestsOf(command, ["app/fixtures/robots.json"]),
      existing: ["app/fixtures/robots.json"],
    };
    const marked = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", fixture)] }).text;
    expect(marked).toContain(
      ", but before it that session had edited tests that existed when it started: app/fixtures/robots.json. Command:",
    );
    expect(marked).toContain(
      "[unverified: the last captured passing run came after its session edited existing tests] T-7c3e19a2: Finished",
    );
  });

  it("says a pass named only other tests than the ones the session edited, and marks nothing for it", () => {
    const otherTests: Run = {
      command: "npx vitest run app/robots.test.ts",
      passed: true,
      line: "Tests  3 passed (3)",
      at: RAN_AT,
      edited: editedTestsOf("npx vitest run app/robots.test.ts", ["app/proxy.test.ts"]),
    };
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", otherTests)] });

    expect(text).toContain(
      "PASSED (Tests 3 passed (3)); that session had edited other tests, which it did not name: app/proxy.test.ts. Command:",
    );
    expect(text).not.toContain("[unverified");
  });

  it("(a) states a failed run in capitals and marks the claim", () => {
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", failed)] });

    expect(text).toContain(
      "Last test run at 2026-10-13T12:43:30Z: FAILED (Tests 2 failed | 8 passed (10)). Command: npx vitest run next.config.redirects.test.ts.",
    );
    expect(text).toContain("[unverified: the last captured test run FAILED] T-7c3e19a2: Finished");
  });

  it("states that no run was recognised, neutrally, and marks nothing", () => {
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [capture("s1", undefined)] });

    expect(text).toContain(
      "- [run state · unverified: as the hook saw it] Last test run, captured 2026-10-13T12:44:01Z: none recognised. Session state captured automatically",
    );
    expect(text).not.toMatch(/\[unverified|ran no tests|may not have run/);
  });

  it("says no test edits were seen only when the edits after the run are known too", () => {
    const { text } = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [capture("s1", passedOnUntouchedTests, CAPTURED_AT, undefined, ["app/robots.ts"], null)],
    });

    expect(text).toContain("PASSED (Tests 3 passed (3)). Command:");
    expect(text).not.toMatch(/no test edits seen|\[unverified/);
  });

  it("says nothing about test edits or run time a hook from before they were recorded did not write, and marks nothing", () => {
    const { text } = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [capture("s1", passedBeforeEditsWereRecorded, CAPTURED_AT, undefined, undefined, null)],
    });

    expect(text).toContain(
      "Last test run, captured 2026-10-13T12:44:01Z: PASSED (Tests 40 passed (40)). Command: npm test. Session state captured",
    );
    expect(text).not.toMatch(/edited|no test edits seen|\[unverified/);
  });

  it("does not mark a claim for files that are not tests changed after a pass, as a docs file is", () => {
    const docsAfter = capture(
      "s1",
      passedOnUntouchedTests,
      CAPTURED_AT,
      undefined,
      ["app/robots.ts", "docs/CHANGELOG.md"],
      [],
    );
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [docsAfter] });

    expect(text).toContain("PASSED (Tests 3 passed (3)); no test edits seen in this repo. Command:");
    expect(text).not.toContain("[unverified");
  });

  it("states a run that reached tests the capture cannot see into, backs nothing, and marks nothing for it", () => {
    const outside = renderSessionState({
      trigger: "Stop",
      task: TASK,
      files: [],
      testFilesAfterRun: [],
      test: { ...passedOnUntouchedTests!, edited: { files: [], named: [] }, unseen: ["../shared/tests"] },
      lastMessage: "Done.",
    });
    const { text } = render({
      decisions: [T_HANDOFF_DECISION],
      facts: [{ ...capture("s1", undefined), content: outside }],
    });

    expect(text).toContain(
      "PASSED (Tests 3 passed (3)); it ran tests outside what the capture can see: ../shared/tests. Command:",
    );
    expect(text).not.toMatch(/no test edits seen|\[unverified/);
  });

  it("does not repeat the hook's own test lines after the plain statement", () => {
    const { text } = render({ facts: [capture("s1", passedOnRewrittenTest)] });

    for (const gone of [
      "Last test command:",
      "Last test run: passed",
      "Test files this session had edited",
      "Of those",
    ])
      expect(text).not.toContain(gone);
    expect(text).toContain("Files changed since the session started:");
    expect(text).toContain("Agent's last message:");
  });

  it("leaves a capture whose test lines it cannot read exactly as written, and marks nothing", () => {
    const unreadable = {
      ...capture("s1", failed),
      content: capture("s1", failed).content.replace("Last test run: failed at", "Last test run: maybe at"),
    };
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [unreadable] });

    expect(text).not.toContain("Last test run at");
    expect(text).not.toContain("[unverified");
    expect(text).toContain("Last test command:");
  });

  it("omits the time when neither the run's nor the capture's can be read", () => {
    for (const writtenAt of [undefined, "not a time"]) {
      const untimed = { ...capture("s1", { ...failed!, at: undefined }), writtenAt };
      expect(render({ facts: [untimed] }).text).toContain(
        "- [run state · unverified: as the hook saw it] Last test run: FAILED (",
      );
    }
  });
});

describe("never inventing a status", () => {
  it("with no capture, says nothing about tests and marks no claim, whatever the claims say", () => {
    const facts = [fact("f1", "Fixed the double ack.", null), fact("f2", "Done.", "progress")];
    const writes = [write("w1", "Finished the prune.", true)];
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts, writes });

    expect(text).not.toMatch(/test run|\[unverified/i);
  });

  it("does not take a progress note in another shape for a capture", () => {
    const lookalike = fact("f1", "Session state: we ran the tests -> failed (3 failed).", "progress");
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [lookalike] });

    expect(text).not.toMatch(/Last test run|\[unverified/);
  });

  it("judges nothing by a capture another task wrote under the same name, and marks no version the task did not write", () => {
    const othersCapture = { ...capture("s-other", failed), ofTask: undefined };
    const { text } = render({ decisions: [T_HANDOFF_DECISION], facts: [othersCapture] });
    expect(text).not.toContain("[unverified");
    expect(text).not.toContain("Last test run at");

    const othersParts: ServedFact[] = [
      {
        id: "o1",
        entityName: "Era prune status",
        role: null,
        writtenAt: "2026-10-13T12:40:00.000Z",
        content: "T-other: cleaned the shared redirects.",
      },
      {
        id: "o2",
        entityName: "Era prune status",
        role: null,
        writtenAt: "2026-10-13T12:40:00.000Z",
        content: "Finished the shared cleanup.",
      },
    ];
    for (const budget of [undefined, 100]) {
      expect(
        items(render({ facts: [...othersParts, capture("s1", failed)] }, budget).text).filter((line) =>
          line.includes("[unverified"),
        ),
      ).toEqual([]);
    }

    const othersVersion = { ...fact("f-other", "T-other: Finished the shared cleanup.", null), ofTask: undefined };
    const replacedDecision = { ...T_HANDOFF_DECISION, id: "d-replaced", ofTask: undefined };
    const marked = render({ decisions: [replacedDecision], facts: [othersVersion, capture("s1", failed)] }).text!;
    expect(items(marked).filter((line) => line.includes("[unverified"))).toEqual([]);
  });
});

describe("the latest capture first among the task's progress notes", () => {
  it("serves deciding facts, then facts with no role, then the newest capture, then the other progress notes", () => {
    const facts = [
      fact("cause", "Redirects keep dead routes alive.", "cause"),
      fact("plain", "Robots list names the cut paths.", null),
      fact("note-newer", "Started on proxy.ts.", "progress", "2026-10-13T12:45:00.000Z"),
      capture("s-old", failed, "2026-10-13T11:00:00.000Z", "aaaaaaaa-old"),
      capture("s-new", passedOnRewrittenTest, "2026-10-13T12:44:01.000Z", "bbbbbbbb-new"),
    ];
    const ids = items(render({ facts }).text).map((line) => line.match(/\[fact (\S+)\]/)?.[1]);

    expect(ids).toEqual(["cause", "plain", "s-new", "note-newer", "s-old"]);
  });

  it("takes the newest capture by when it was written, and the read's order between two written at once", () => {
    const facts = [
      capture("s-a", failed, CAPTURED_AT, "aaaaaaaa-a"),
      untouchedCapture("s-b", CAPTURED_AT, "bbbbbbbb-b"),
    ];
    const ids = items(render({ facts }).text).map((line) => line.match(/\[fact (\S+)\]/)?.[1]);

    expect(ids).toEqual(["s-a", "s-b"]);
  });

  it("(c) marks a claim when a later session with no recognised run edited tests after the last pass, and not when it edited none", () => {
    const decision = { ...T_HANDOFF_DECISION, text: "T-7c3e19a2: Rewrote the redirects. Done." };
    const laterEditsTests = capture("s-new", undefined, "2026-10-13T13:00:00.000Z", "bbbbbbbb-new", [
      "src/redirects.ts",
      "src/redirects.test.ts",
    ]);
    const laterEditsCode = capture("s-new", undefined, "2026-10-13T13:00:00.000Z", "bbbbbbbb-new", [
      "src/redirects.ts",
    ]);
    const earlierPass = untouchedCapture("s-old", "2026-10-13T12:00:00.000Z", "aaaaaaaa-old");

    expect(render({ decisions: [decision], facts: [laterEditsTests, earlierPass] }).text).toContain(
      "[unverified: tests were edited after the last captured passing run] T-7c3e19a2: Rewrote",
    );
    expect(render({ decisions: [decision], facts: [laterEditsCode, earlierPass] }).text).not.toContain("[unverified");
  });
});

describe("which lines are marked", () => {
  const facts = [capture("s1", failed)];

  it("marks the task's own facts and decisions that claim completion, and leaves the rest alone", () => {
    const { text } = render({
      decisions: [
        T_HANDOFF_DECISION,
        { id: "d2", kind: "decision", subject: "Retry policy", text: "Use exponential backoff.", ofTask: true },
      ],
      facts: [fact("f1", "Fixed the double ack.", null), fact("f2", "Not done: the docs.", "progress"), ...facts],
    });

    expect(items(text)).toEqual([
      expect.stringContaining(
        `[decision ${T_HANDOFF_DECISION.id}] [untested plan: verify before following] legacy-pages prune: [unverified: the last captured test run FAILED] T-7c3e19a2`,
      ),
      "- [decision d2] [untested plan: verify before following] Retry policy: Use exponential backoff. — unknown",
      "- [plan · proposed] [unverified: the last captured test run FAILED] Fixed the double ack. [fact f1] note f1 — unknown, 10-13",
      expect.stringContaining("- [run state · unverified: as the hook saw it] Last test run at"),
      "- [plan · proposed] Not done: the docs. [fact f2] note f2 — unknown, 10-13",
    ]);
  });

  it("marks a recent write of the same task, never one of another task, a scope rule or a working note", () => {
    const { text } = render({
      facts,
      rules: [{ id: "r1", kind: "convention", subject: "Prune", text: "Finished pages are deleted, not hidden." }],
      writes: [write("w-own", "Finished the prune.", true), write("w-other", "Fixed the robots list.", false)],
      notes: {
        served: [
          {
            id: "n1",
            agentId: "agent-c",
            scopePath: "org_a.eng",
            task: TASK,
            kind: "claim",
            body: "Finished the prune, picking up docs.",
            expiresAt: new Date("2026-10-13T14:00:00Z"),
            ofTask: true,
          },
        ],
        total: 1,
      },
    });

    expect(text).toContain(
      "- create brief brief-w-own by agent-a: [unverified: the last captured test run FAILED] Finished the prune.",
    );
    expect(text).toContain("- create brief brief-w-other by agent-a: Fixed the robots list.");
    expect(text).toContain("- [convention r1] Prune: Finished pages are deleted, not hidden. — unknown");
    expect(text).not.toMatch(/n1\].*\[unverified/);
  });

  it("marks a superseded write's line before its superseded mark", () => {
    const own: ServedWrite & { supersededById: string } = {
      ...write("w1", "Finished the prune.", true),
      recordType: "fact",
      recordId: "v1",
      content: "Finished the prune.",
      supersededById: "v2",
    };
    const { text } = render({ facts, writes: [own] });

    expect(text).toContain(
      "- create fact v1 by agent-a: [unverified: the last captured test run FAILED] [superseded by v2] Finished the prune.",
    );
  });

  it("marks a write split in parts when a later part claims completion, and never serves its parts apart", () => {
    const parts: ServedFact[] = [
      {
        id: "p1",
        entityName: "Prune log",
        role: null,
        writtenAt: "2026-10-13T12:40:00.000Z",
        content: "Removed the redirects from next.config.ts.",
        ofTask: true,
      },
      {
        id: "p2",
        entityName: "Prune log",
        role: null,
        writtenAt: "2026-10-13T12:40:00.000Z",
        content: "Finished the prune.",
        ofTask: true,
      },
    ];
    const whole = render({ facts: [...parts, ...facts] }).text;
    expect(whole).toContain(
      "- [plan · proposed] [unverified: the last captured test run FAILED] Removed the redirects from next.config.ts. Finished the prune. [fact p1] (+1 parts) Prune log — unknown, 10-13",
    );

    // Too little room for the write's line: it is left out whole, so no part is served without
    // the mark another part earned.
    const short: ServedFact = {
      id: "q1",
      entityName: "Q",
      role: null,
      writtenAt: "2026-10-13T12:41:00.000Z",
      content: "Queued.",
      ofTask: true,
    };
    // The header and the leads' heading; the premise check takes no room from the records (recordRoom).
    const opening = estimateTokens(TASK_START_HEADER) + estimateTokens(`\n${TASK_START_HEADINGS.leads}`);
    const tight = items(render({ facts: [short, ...parts] }, opening + 30).text);
    expect(tight).toEqual(["- [plan · proposed] Queued. [fact q1] Q — unknown, 10-13"]);
  });
});

describe("the block's budget, revision and erasure check", () => {
  const decisions = Array.from({ length: 30 }, (_, i) => ({
    id: `d${i}`,
    kind: "decision" as const,
    subject: `Step ${i}`,
    text: `Finished step ${i}. ${"Detail. ".repeat(20)}`,
    ofTask: true as const,
  }));

  it("stays within the budget with every line marked, and leaves whole lines out rather than cutting a mark", () => {
    const { text } = render({ decisions, facts: [capture("s1", failed)] });

    // The records within the budget; the premise check, a line that shows no record, on top of it.
    expect(estimateTokens(withoutSources(text!.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
      TASK_START_TOKEN_BUDGET,
    );
    expect(estimateTokens(text!)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
    for (const line of items(text).filter((l) => l.startsWith("- [decision")))
      expect(line).toContain("[unverified: the last captured test run FAILED]");
    expect(text).toMatch(/\(\d+ more left out: ask memory_query for them\)$/);
  });

  it("names the captures behind a mark among the facts it shows, even when their own lines are left out", () => {
    const { text, shownFactIds, revision } = render({
      decisions,
      facts: [
        capture("s-new", undefined, "2026-10-13T13:00:00.000Z", "bbbbbbbb", ["src/a.ts"]),
        capture("s-old", failed),
      ],
    });

    expect(text).not.toContain("[fact s-new]");
    expect(text).not.toContain("[fact s-old]");
    expect(shownFactIds).toEqual(expect.arrayContaining(["s-new", "s-old"]));
    // The revision names what decided the marks, though their lines were left out.
    expect(revision).not.toBe(render({ decisions, facts: [] }).revision);
  });

  it("names no capture among the facts it shows when no line is marked", () => {
    const { shownFactIds } = render(
      {
        decisions: [
          { id: "d2", kind: "decision", subject: "Retry policy", text: "Use exponential backoff.", ofTask: true },
        ],
        facts: [capture("s1", failed)],
      },
      70,
    );

    expect(shownFactIds).not.toContain("s1");
  });
});
