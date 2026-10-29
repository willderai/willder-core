// A claim's status from recorded evidence (services/memory/claim-status.ts). The captures are
// rendered by the willder init hook itself and read back with the product's own reader, so the
// status is tested on the text the hook really writes.
import { describe, expect, it } from "vitest";
import { renderSessionState } from "@/cli/hooks/willder-capture.mjs";
import { claimStatusOf, type Claim, type SessionCapture } from "./claim-status";
import { capturedSessionState } from "./session-state";

const SESSION = "cli-session-a";
const WRITTEN_AT = "2026-10-15T01:10:00.000Z";
const CAPTURED_AT = "2026-10-15T01:12:00.000Z";
const PLAN = "PLAN: filter fetched sources in components/settings/connectors-panel.tsx load().";

type Run = {
  command: string;
  passed: boolean;
  line: string;
  at?: string;
  edited?: { files: string[]; named: string[] };
  existing?: string[];
};

/** A capture as the hook writes it, read back as the task-start read does. */
function capture(
  id: string,
  {
    test,
    files = [],
    writtenAt = CAPTURED_AT,
    sessionKey = SESSION,
    testFilesAfterRun = [],
  }: { test?: Run; files?: string[]; writtenAt?: string; sessionKey?: string; testFilesAfterRun?: string[] } = {},
): SessionCapture {
  const content = renderSessionState({
    trigger: "Stop",
    task: "T-1",
    files,
    testFilesAfterRun,
    test,
    lastMessage: "Done for now.",
  });
  const state = capturedSessionState({ entityName: "Session state: T-1, session cli-sess", role: "progress", content });
  if (state === null) throw new Error("the hook's own capture did not read back");
  return { id, writtenAt, sessionKey, state };
}

const claim = (overrides: Partial<Claim> = {}): Claim => ({
  by: "agent",
  sessionKey: SESSION,
  writtenAt: WRITTEN_AT,
  text: PLAN,
  ...overrides,
});
const passed: Run = {
  command: "npx vitest run components/settings",
  passed: true,
  line: "Tests  15 passed (15)",
  at: "2026-10-15T01:11:00.000Z",
};
const failed: Run = { ...passed, passed: false, line: "Tests  1 failed | 14 passed (15)" };
const FILE = "components/settings/connectors-panel.tsx";

describe("claimStatusOf", () => {
  it("is verified only for a person's own record, whatever any capture says", () => {
    expect(claimStatusOf(claim({ by: "person", sessionKey: null }), [])).toEqual({
      status: "verified",
      reason: "recorded-by-person",
      captures: [],
    });
    expect(claimStatusOf(claim({ by: "person" }), [capture("c1", { test: failed, files: [FILE] })]).status).toBe(
      "verified",
    );
  });

  it("never verifies an agent's claim, even one its session tested on the files it names", () => {
    expect(claimStatusOf(claim(), [capture("c1", { test: passed, files: [FILE] })])).toEqual({
      status: "tested",
      reason: "passed",
      captures: ["c1"],
    });
  });

  it("treats an unrecorded writer as an agent: not recorded is not a person", () => {
    expect(claimStatusOf(claim({ by: "unknown" }), [capture("c1", { files: [FILE] })]).status).toBe("untested");
    expect(claimStatusOf(claim({ by: "unknown", sessionKey: null }), []).status).toBe("proposed");
  });

  it("is proposed when no session was recorded on the claim, or its time is not known", () => {
    for (const sessionKey of [null, undefined, ""]) {
      expect(claimStatusOf(claim({ sessionKey }), [capture("c1", { sessionKey: "" })])).toEqual({
        status: "proposed",
        reason: "no-session-recorded",
        captures: [],
      });
    }
    expect(claimStatusOf(claim({ writtenAt: undefined }), [capture("c1")]).reason).toBe("no-session-recorded");
  });

  it("judges a claim by its own session only: another session's capture of the same task says nothing about it", () => {
    const other = capture("c-other", { sessionKey: "cli-session-b" });
    expect(claimStatusOf(claim(), [other])).toEqual({
      status: "proposed",
      reason: "no-capture-after-it",
      captures: [],
    });
    // And another session's passing run never lifts it.
    expect(
      claimStatusOf(claim(), [capture("c-other", { sessionKey: "cli-session-b", test: passed, files: [FILE] })]).status,
    ).toBe("proposed");
  });

  it("is judged only by a capture stored in its own scope: evidence in a sibling scope never backs it", () => {
    const sibling = { ...capture("c1", { test: passed, files: [FILE] }), scopePath: "org_a.web.billing" };
    expect(claimStatusOf(claim({ scopePath: "org_a.web.checkout" }), [sibling])).toEqual({
      status: "proposed",
      reason: "no-capture-after-it",
      captures: [],
    });
    expect(claimStatusOf(claim({ scopePath: "org_a.web.billing" }), [sibling]).status).toBe("tested");
  });

  it("ignores a capture of its own session written before the claim", () => {
    expect(claimStatusOf(claim(), [capture("c0", { writtenAt: "2026-10-15T01:09:00.000Z" })]).reason).toBe(
      "no-capture-after-it",
    );
  });

  it("is untested when its own session was captured after it with no test run, saying whether files changed", () => {
    expect(claimStatusOf(claim(), [capture("c1")])).toEqual({
      status: "untested",
      reason: "no-files-no-tests",
      captures: ["c1"],
    });
    expect(claimStatusOf(claim(), [capture("c1", { files: [FILE] })])).toEqual({
      status: "untested",
      reason: "no-tests",
      captures: ["c1"],
    });
  });

  it("is failing when its session's last run failed", () => {
    expect(claimStatusOf(claim(), [capture("c1", { test: failed, files: [FILE] })])).toEqual({
      status: "failing",
      reason: "failed",
      captures: ["c1"],
    });
  });

  it("decides from the newest capture of its session", () => {
    const early = capture("c1", { test: failed, files: [FILE], writtenAt: "2026-10-15T01:12:00.000Z" });
    const late = capture("c2", {
      test: { ...passed, at: "2026-10-15T01:13:00.000Z" },
      files: [FILE],
      writtenAt: "2026-10-15T01:14:00.000Z",
    });
    expect(claimStatusOf(claim(), [early, late])).toEqual({
      status: "tested",
      reason: "passed",
      captures: ["c2", "c1"],
    });
  });

  it("does not count a pass on tests its own session had edited, or tests edited after the pass", () => {
    const test = "components/settings/connectors-panel.test.tsx";
    const bent = capture("c1", {
      test: { ...passed, edited: { files: [test], named: [test] }, existing: [test] },
      files: [FILE, test],
    });
    expect(claimStatusOf(claim(), [bent])).toEqual({
      status: "untested",
      reason: "passed-on-edited-tests",
      captures: ["c1"],
    });
    const after = capture("c1", { test: passed, files: [FILE, test], testFilesAfterRun: [test] });
    expect(claimStatusOf(claim(), [after]).reason).toBe("tests-edited-after-pass");
  });

  it("is proposed when the passing run is not known to follow the claim", () => {
    expect(
      claimStatusOf(claim(), [capture("c1", { test: { ...passed, at: "2026-10-15T01:05:00.000Z" }, files: [FILE] })])
        .reason,
    ).toBe("run-not-after-it");
    const { at: _unknown, ...noTime } = passed;
    expect(claimStatusOf(claim(), [capture("c1", { test: noTime, files: [FILE] })]).reason).toBe("run-not-after-it");
  });

  it("is proposed when the passing run's session changed no file the claim names", () => {
    expect(claimStatusOf(claim(), [capture("c1", { test: passed, files: ["lib/other.ts"] })]).reason).toBe(
      "files-not-named",
    );
    expect(
      claimStatusOf(claim({ text: "PLAN: make the panel faster." }), [capture("c1", { test: passed, files: [FILE] })])
        .reason,
    ).toBe("files-not-named");
  });

  it("takes a file name with its extension as naming the file, and a bare word never", () => {
    const run = [capture("c1", { test: passed, files: [FILE] })];
    expect(claimStatusOf(claim({ text: "Changed connectors-panel.tsx only." }), run).status).toBe("tested");
    expect(claimStatusOf(claim({ text: "Changed the connectors panel only." }), run).status).toBe("proposed");
  });

  it("never reads the claim's own words as evidence", () => {
    const boasts = claim({ text: `${PLAN} Tests pass, verified, merged with CI green.` });
    expect(claimStatusOf(boasts, [capture("c1")]).status).toBe("untested");
    expect(claimStatusOf(boasts, []).status).toBe("proposed");
  });
});
