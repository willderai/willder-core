// Vitest global setup: builds this run's template database once, before any
// worker starts, and drops every database the run created when it ends.
//
// The plan travels to the workers in an environment variable, which Vitest
// copies into each worker it starts after this function returns. Each worker
// then makes its own copy in tests/setup/worker-database.ts.
import { PLAN_ENV, dropRunDatabases, prepareTemplate } from "./test-databases";

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const plan = await prepareTemplate(process.env);
  if (!plan) return undefined;
  process.env[PLAN_ENV] = JSON.stringify(plan);
  return async () => {
    // WILLDER_TEST_KEEP_DATABASES=1 keeps them for inspection; a kept database lives until the next
    // test run on that server (dropAbandonedRunDatabases drops _r<deadpid>_ names).
    if (process.env.WILLDER_TEST_KEEP_DATABASES !== "1") await dropRunDatabases(plan);
  };
}
