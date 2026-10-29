import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// A component test waits for state (findBy, waitFor), never for time. The library's
// 1 s give-up and Vitest's 5 s test default are wall-clock bounds a busy CI shard
// breaks: on 2026-10-17 settings tests went red waiting on a list that was 250 ms of
// debounce plus a render away. These ceilings only stop a test that never reaches its
// state; they are not claims about speed. Keep the give-up below the test timeout
// (vitest.config.ts) so a failed wait still prints the screen it saw.
configure({ asyncUtilTimeout: 10_000 });

// testing-library's own auto-cleanup only fires when `afterEach` is a real
// global, which this repo doesn't enable (test.globals stays unset so the
// existing node-environment suite is unaffected). Do it explicitly instead,
// scoped to the "component" project only via vitest.config.ts's setupFiles.
afterEach(() => {
  cleanup();
});
