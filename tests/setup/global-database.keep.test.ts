// A run can keep its worker databases, so a worker's store can still be read after teardown:
// with WILLDER_TEST_KEEP_DATABASES=1 the global teardown (global-database.ts) skips
// dropRunDatabases; otherwise it drops them. Tested without a Postgres, with test-databases.ts
// mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEEP_ENV = "WILLDER_TEST_KEEP_DATABASES";
const PLAN = {
  runId: "r1",
  template: "t_r1_tpl",
  qaBaseUrl: "postgresql://u@127.0.0.1:5432/qa",
  qaSettings: [],
  appBaseUrl: null,
  appSettings: [],
};
const dropRunDatabases = vi.fn(async () => undefined);

vi.mock("./test-databases", () => ({
  PLAN_ENV: "WILLDER_TEST_DATABASE_PLAN",
  prepareTemplate: vi.fn(async () => PLAN),
  dropRunDatabases: (...args: unknown[]) => (dropRunDatabases as (...a: unknown[]) => Promise<undefined>)(...args),
}));

const saved = { keep: process.env[KEEP_ENV], plan: process.env.WILLDER_TEST_DATABASE_PLAN };
beforeEach(() => {
  dropRunDatabases.mockClear();
  delete process.env[KEEP_ENV];
});
afterEach(() => {
  for (const [name, value] of [
    [KEEP_ENV, saved.keep],
    ["WILLDER_TEST_DATABASE_PLAN", saved.plan],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the global teardown", () => {
  it.each([
    { keep: undefined, drops: 1, why: "drops the run's databases by default" },
    { keep: "", drops: 1, why: "drops them when the variable is empty" },
    { keep: "0", drops: 1, why: "drops them when the variable is 0" },
    { keep: "1", drops: 0, why: "keeps them when the variable is 1" },
  ])("$why", async ({ keep, drops }) => {
    if (keep !== undefined) process.env[KEEP_ENV] = keep;
    const { default: setup } = await import("./global-database");
    const teardown = await setup();
    expect(teardown).toBeTypeOf("function");
    await teardown!();
    expect(dropRunDatabases).toHaveBeenCalledTimes(drops);
  });
});
