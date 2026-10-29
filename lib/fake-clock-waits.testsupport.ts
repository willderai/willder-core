// Runs testing-library's waits (findBy*, waitFor) on vitest's fake clock, for component tests
// whose waits failed on a loaded runner while the state they waited for was on its way.
//
// By default a wait gives up after 1,000 real milliseconds, so how far a render gets in that time
// decides the test, not what it renders. On the fake clock each poll advances fake time by 50 ms,
// running whatever timers fall due (a debounce, a deferred fetch), and lets the promises they
// start settle before checking again: a wait now gives up after 20 polls, however long each takes,
// and a debounce or timeout in the code under test still runs in its own order.
//
// The component project's real-clock give-up (vitest.setup.component.ts) is 10 s, which on this
// clock would be 200 polls that run every timer due in the next 10 fake seconds. Here a wait keeps
// its 1,000 fake milliseconds; the whole test's real-clock bound is the project's.
import { configure, getConfig } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/** Fake milliseconds a wait polls before giving up: 20 polls of 50 ms. */
const FAKE_CLOCK_WAIT_MS = 1_000;

/** Call at the top of a test file: every test in it waits on the fake clock. */
export function waitOnFakeClock(): void {
  let realClockWaitMs: number;
  beforeEach(() => {
    realClockWaitMs = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: FAKE_CLOCK_WAIT_MS });
    // Timers only: Date stays real, so dates built at import time and those read while
    // rendering agree.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    // testing-library drives fake timers only when it finds jest's global; vitest's clock is the
    // same @sinonjs clock jest uses, so this is the one call it needs.
    vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  });
  afterEach(() => {
    configure({ asyncUtilTimeout: realClockWaitMs });
    vi.useRealTimers();
  });
}
