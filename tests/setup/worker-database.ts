// Vitest setup file: points this worker at its own databases before a test
// file is imported.
//
// It runs ahead of every test file, so a suite that reads QA_DATABASE_URL at
// module scope, or hoists `process.env.DATABASE_URL = QA_URL` above its
// imports, already sees this worker's copy. VITEST_POOL_ID is unique among the
// workers running at one time, so no two concurrent test files share a database.
// Without QA_DATABASE_URL the global setup publishes no plan and this does nothing.
import { PLAN_ENV, type WorkerDatabasePlan, workerDatabase } from "./test-databases";

const serialized = process.env[PLAN_ENV];
if (serialized) {
  const plan = JSON.parse(serialized) as WorkerDatabasePlan;
  const poolId = process.env.VITEST_POOL_ID;
  if (!poolId) throw new Error("VITEST_POOL_ID is unset: cannot choose this worker's test database.");
  process.env.QA_DATABASE_URL = await workerDatabase(plan, plan.qaBaseUrl, plan.qaSettings, poolId);
  if (plan.appBaseUrl) {
    process.env.DATABASE_URL = await workerDatabase(plan, plan.appBaseUrl, plan.appSettings, poolId);
  }
}
