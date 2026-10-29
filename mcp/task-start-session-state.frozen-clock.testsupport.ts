// Freezes Date.now() for the session-state capture tests, which run the real hook against real git.
//
// The hook gives its git calls a budget measured on the real clock (willder-capture.mjs, GIT_BUDGET_MS).
// On a loaded machine a call can overrun it; the hook then records the session's baseline at a later
// event from git's reflog and file change times, dated by the injected `now`. These fixtures inject
// 2026-10-13 times against a repository made today, so that recovery finds nothing older and the
// tests fail, only under load. A frozen clock cannot run out of budget, so the first event always
// records the baseline. Import this file for its effect; only Date is faked, timers stay real.
import { afterEach, beforeEach, vi } from "vitest";

const FROZEN_AT = Date.parse("2026-10-13T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_AT);
});
afterEach(() => vi.useRealTimers());
