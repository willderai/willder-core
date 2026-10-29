import { describe, expect, it } from "vitest";
import { createLatestResponseGuard } from "./latest-response-guard";

describe("createLatestResponseGuard", () => {
  it("marks each new start() current and supersedes the previous one", () => {
    const guard = createLatestResponseGuard();
    const first = guard.start();
    expect(guard.isCurrent(first)).toBe(true);

    const second = guard.start();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("stays current across repeated checks until a newer start() supersedes it", () => {
    const guard = createLatestResponseGuard();
    const token = guard.start();
    expect(guard.isCurrent(token)).toBe(true);
    expect(guard.isCurrent(token)).toBe(true);
    guard.start();
    expect(guard.isCurrent(token)).toBe(false);
  });

  it("drops an out-of-order slower response so only the latest is applied (the RunMemoryTrail stale-poll case)", () => {
    // Mirrors RunMemoryTrail's load(): guard.start() at request-issue time,
    // guard.isCurrent(token) gates whether a resolved response is applied to
    // state. Two requests fire back to back (a poll still in flight when the
    // next interval tick fires, same as setInterval(load, 4000) racing a slow
    // fetch); the OLDER request resolves LAST, carrying stale entries and a
    // stale 403 that would otherwise re-forbid a viewer whose access is
    // actually fine by the time it lands.
    const guard = createLatestResponseGuard();
    let state: { entries: string[]; forbidden: boolean } = { entries: [], forbidden: false };

    const applyResponse = (token: number, result: { entries: string[]; forbidden: boolean }) => {
      if (!guard.isCurrent(token)) return; // the fix under test
      state = result;
    };

    const staleToken = guard.start(); // slow: resolves last
    const freshToken = guard.start(); // fast: resolves first, fresher data

    applyResponse(freshToken, { entries: ["fresh-entry"], forbidden: false });
    expect(state.entries).toEqual(["fresh-entry"]);

    applyResponse(staleToken, { entries: [], forbidden: true });

    expect(state).toEqual({ entries: ["fresh-entry"], forbidden: false });
  });
});
