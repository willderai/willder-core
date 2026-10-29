// A captured session state is served from its opening, which states its last test
// run, whatever the session's words. The task's other writes are cut around those words; a
// capture cut the same way could open on the files it lists or its last message and drop the
// test run that decides whether the task's claims of completion stand.
import { describe, expect, it } from "vitest";
import { editedTestsOf, renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import { weighTaskFacts, type ServedFact } from "@/services/memory/task-start";
import { renderTaskStartBlock } from "./task-start-notice";

const TASK = "T-capture-opening";
const RUN = "npx vitest run app/robots.test.ts";
// Enough changed files that the capture runs well past its 1,300-character line.
const FILES = Array.from({ length: 60 }, (_, i) => `app/area-${i}/page-${i}.tsx`);

function longCapture(lastMessage: string): ServedFact {
  return {
    id: "cap1",
    entityName: sessionStateName(TASK, "qa-session"),
    role: "progress",
    writtenAt: "2026-10-14T12:44:01.000Z",
    ofTask: true,
    content: renderSessionState({
      trigger: "Stop",
      task: TASK,
      files: FILES,
      testFilesAfterRun: [],
      test: {
        command: RUN,
        passed: false,
        line: "Tests  2 failed | 8 passed (10)",
        at: "2026-10-14T12:43:30.000Z",
        edited: editedTestsOf(RUN, FILES),
      },
      lastMessage,
    }),
  };
}

const note: ServedFact = {
  id: "n1",
  entityName: "note n1",
  role: null,
  writtenAt: "2026-10-14T12:40:00.000Z",
  ofTask: true,
  content: "Started on the robots rules.",
};

describe("a captured session state among the task's ranked writes", () => {
  it("opens on its test run even when the session's words appear only at its end", () => {
    const capture = longCapture(
      "Walked through the robots rules, the sitemap entries and the redirect list one route at a time. ".repeat(8) +
        "Left the quokka zebra migration plan for the next session to pick up.",
    );
    expect(capture.content.length).toBeGreaterThan(1300);
    const facts = [capture, note];
    const factWeights = weighTaskFacts(`${TASK} quokka zebra migration plan`, facts, TASK);
    expect(factWeights.byTerm.size).toBeGreaterThan(0);

    const { text } = renderTaskStartBlock({ rules: [], writes: [], stale: [], facts, factWeights });
    const line = (text ?? "").split("\n").find((l) => l.includes("[fact cap1]"));
    expect(line).toBeDefined();
    expect(line).toContain("FAILED");
    expect(line).toContain("Last test run at");
  });
});
