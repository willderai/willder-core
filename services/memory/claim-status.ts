// A claim's status, derived from recorded evidence.
//
// A plan an agent wrote is not a decision because its writer called it one: an agent that
// labels untested plans "decision" leads the next agent to build on them. What a
// later session needs to know is what backs a claim: who recorded it, and what its own session
// was seen to do after writing it.
//
// The one rule this file enforces: a claim's status comes from recorded evidence only, never
// from its text or its writer's declared role. "verified" is only ever a person's own record;
// an agent's claim reaches at most "tested", and only from a passing run its own session's
// capture recorded after it, on files the claim names. A merge with green CI will verify too
// once that evidence is recorded. No
// model is asked anything.
//
// A claim is linked to its session by the session key recorded on its change event, and to a
// capture only when the capture's own change event carries the same key and the capture is
// stored in the claim's scope: a write a session made is judged by that session's capture,
// never by another session of the same task, nor by evidence in a scope its readers may not
// share. A claim
// with no recorded session, or whose session left no capture after it, is "proposed": nothing
// recorded says anything about it.
import { namesIn } from "./relevance";
import { changedFilesOf, unverifiedBy, type SessionStateFact, type UnverifiedReason } from "./session-state";

/** Who recorded a claim, as its change event says: a person, an agent, or not recorded. */
export type ClaimWriter = "person" | "agent" | "unknown";

/**
 * Whether a rule in force is settled, or a lead to verify: a convention is settled whoever
 * recorded it, a decision only when a person recorded it (directly or by confirming it). The
 * task-start block and every fact read that serves a rule's text decide it with this one rule.
 */
export function ruleIsSettled(rule: { kind: string; by?: ClaimWriter }): boolean {
  return rule.kind !== "decision" || rule.by === "person";
}

/**
 * How far recorded evidence backs a claim, weakest first after "failing":
 * - "proposed": nothing recorded tests it;
 * - "untested": its own session was captured after it and ran no test that counts;
 * - "failing": its own session's last test run after it failed;
 * - "tested": its own session's last test run after it passed, on files the claim names, with no
 *   sign the session bent the tests;
 * - "verified": a person recorded it.
 *
 * A claim another record has replaced is not given a status: every task-start read serves the
 * replacement in its place (services/memory/task-start.ts).
 */
export type ClaimStatus = "proposed" | "untested" | "failing" | "tested" | "verified";

/** Why a claim has its status: what was, or was not, recorded. */
export type ClaimStatusReason =
  | "recorded-by-person"
  | "no-session-recorded"
  | "no-capture-after-it"
  | "capture-unreadable"
  | "no-files-no-tests"
  | "no-tests"
  | UnverifiedReason
  | "run-not-after-it"
  | "files-not-named"
  | "passed";

/** A claim, as its change event and its own text record it. */
export interface Claim {
  by: ClaimWriter;
  /** The session its change event recorded; absent or "" when none was. */
  sessionKey?: string | null;
  /** When it was stored, as an ISO instant; absent when not known. */
  writtenAt?: string;
  /** Its text, read only for the file names it gives. */
  text: string;
  /** The scope it is stored in; absent where not known. */
  scopePath?: string;
}

/** A captured session state, with the session its own change event recorded. */
export interface SessionCapture extends SessionStateFact {
  /** The session the capture's change event recorded; absent or "" when none was. */
  sessionKey?: string | null;
  /** The scope the capture is stored in; absent where not known. */
  scopePath?: string;
}

/** A claim's status, why, and the captures read to decide it. */
export interface ClaimStatusOf {
  status: ClaimStatus;
  reason: ClaimStatusReason;
  /** The ids of the captures the status was decided from; empty when none was read. */
  captures: string[];
}

/**
 * The status of `claim`, from what was recorded of it and of its own session.
 *
 * - A person's own record is "verified".
 * - Anything else is judged by the captures of its own session ({@link SessionCapture.sessionKey}
 *   equal to the claim's) written at or after it. None, or no session recorded at all, leaves it
 *   "proposed".
 * - The newest of them decides: a capture that cannot be read leaves it "proposed"; one that
 *   recognised no test run makes it "untested", saying whether the session changed any file.
 * - With a recognised run: "failing" when the last run failed; "untested" when a pass comes with
 *   any of {@link unverifiedBy}'s problems (the session had edited the tests it passed on, or
 *   edited tests after); "proposed" when the run is not known to have happened after the claim
 *   was written, or touched no file the claim names; otherwise "tested".
 */
export function claimStatusOf(claim: Claim, captures: readonly SessionCapture[]): ClaimStatusOf {
  if (claim.by === "person") return { status: "verified", reason: "recorded-by-person", captures: [] };
  const session = claim.sessionKey ?? "";
  if (session === "" || claim.writtenAt === undefined)
    return { status: "proposed", reason: "no-session-recorded", captures: [] };
  const writtenAt = claim.writtenAt;
  const own = captures
    .filter(
      (capture) =>
        capture.sessionKey === session && sameScope(claim, capture) && (capture.writtenAt ?? "") >= writtenAt,
    )
    .sort((a, b) =>
      (a.writtenAt ?? "") > (b.writtenAt ?? "") ? -1 : (a.writtenAt ?? "") < (b.writtenAt ?? "") ? 1 : 0,
    );
  const ids = own.map(({ id }) => id);
  const newest = own[0];
  if (newest === undefined) return { status: "proposed", reason: "no-capture-after-it", captures: [] };
  const test = newest.state.lastTest;
  if (test === null) return { status: "proposed", reason: "capture-unreadable", captures: ids };
  if (test === "none") {
    const reason = newest.state.filesChanged === "none" ? "no-files-no-tests" : "no-tests";
    return { status: "untested", reason, captures: ids };
  }
  if (test.result === "failed") return { status: "failing", reason: "failed", captures: ids };
  const problem = unverifiedBy(own);
  if (problem !== null) return { status: "untested", reason: problem.reason, captures: ids };
  if (test.at === null || test.at < writtenAt) return { status: "proposed", reason: "run-not-after-it", captures: ids };
  if (!namesAChangedFile(claim.text, changedFilesOf(newest.state)))
    return { status: "proposed", reason: "files-not-named", captures: ids };
  return { status: "tested", reason: "passed", captures: ids };
}

/**
 * Whether a capture may speak for a claim: both stored in one scope, or a scope not known on
 * either. A capture in another scope is evidence its readers may not share, so it never backs a
 * claim served to someone who can read only the claim's.
 */
function sameScope(claim: Claim, capture: SessionCapture): boolean {
  return claim.scopePath === undefined || capture.scopePath === undefined || claim.scopePath === capture.scopePath;
}

/**
 * Whether `text` names one of `files`: the whole path, or a path's tail of at least a file name
 * with its extension (`connectors-panel.tsx` names `components/settings/connectors-panel.tsx`).
 * A bare word never does.
 */
function namesAChangedFile(text: string, files: readonly string[]): boolean {
  const names = [...namesIn(text)].filter((name) => name.includes(".") || name.includes("/"));
  return files.some((file) => {
    const path = file.toLowerCase();
    return names.some((name) => path === name || path.endsWith(`/${name}`));
  });
}
