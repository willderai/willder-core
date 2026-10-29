// Repo-wide guard: a test suite that only runs when an environment variable is
// set must actually get that variable in CI, or say in one place why it cannot.
//
// Test files that gate on `describe.skipIf(!QA_URL)`, where QA_URL is
// QA_DATABASE_URL, are the real-Postgres suites for concurrent writes, source
// changes and access isolation. If ci.yml
// never provisions a database and never sets the variable, every one of them
// silently skips — CI then sees a smaller passing count than running the same
// tree with the variable set, and a green check proves nothing about the
// tests in between.
//
// A skipped suite is invisible in a way a failing one is not: the check stays
// green, so nothing prompts anyone to look. That is what these two tests fix.
// The first proves the provisioning chain really works, from inside CI, where
// a missing service or a dropped variable would otherwise just go quiet again.
// The second fails the moment a new suite invents a gate CI does not satisfy,
// rather than waiting for someone to notice a count that never grew.
//
// Limits worth knowing. The scan reads ci.yml as text and treats every
// SCREAMING_CASE key as a variable CI provides, so it does not distinguish the
// test job's environment from the service container's, and it would not catch
// a variable set to the wrong value. The connectivity test below covers the
// one variable where that actually matters. It also reads only a literal
// `process.env.NAME` in the gated file itself, so a gate that reads its
// variable through a shared helper is invisible to it.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const repoRoot = resolve(__dirname, "..");
const workflow = join(repoRoot, ".github/workflows/ci.yml");
const skipDirs = new Set(["node_modules", ".next", ".git", "generated", "public"]);

/**
 * Names the operating system, the runner and Vitest always provide, so no suite
 * can be gated on one. A gated file that spawns a child process has to hand it a
 * PATH and a HOME; without this they read as unsatisfied gates and the scan fails
 * on a suite that runs in CI perfectly well (lib/db-startup.realdb.test.ts).
 * Vitest sets VITEST_POOL_ID in every worker; tests/setup/test-databases.test.ts
 * reads it to name the database its own worker should be on.
 */
const AMBIENT_ENV = new Set(["CI", "HOME", "NODE_ENV", "PATH", "VITEST_POOL_ID"]);

/**
 * Gates CI deliberately does not satisfy, and the concrete reason. A suite
 * listed here is a decision someone made and can be argued with; a suite
 * missing from here is an accident nobody saw.
 */
const GATES_CI_CANNOT_SATISFY: Record<string, string> = {
  // app/api/handoff-gate-c-extension.live.test.ts's C.2b/C.2c drive the
  // contradiction scan in GET /api/briefs/:id/staleness, which is a real paid
  // LLM call (services/facts/conflicts.ts findScopeContradictions). Against a
  // CI-shaped database with the flag set, the two cases that exercise actual
  // contradiction detection fail on an empty contradictions array rather than
  // an error. CI holds no provider key and should not buy one per run, and
  // mocking the call would make both cases vacuous, since the detection is
  // the behaviour they test. The flag is this suite's alone:
  // app/api/handoff-e2e-lifecycle.live.test.ts keeps HANDOFF_E2E_LIVE and
  // runs in CI rather than skipping on this suite's account.
  HANDOFF_GATE_C_LIVE: "the contradiction cases need a real paid LLM call; CI holds no provider key",
  // Selects the Neon HTTP driver instead of the local TCP one, so it needs a
  // real Neon database rather than a service container.
  HANDOFF_E2E_NEON_HTTP: "selects the Neon HTTP driver, which needs a real Neon database",
  // services/access/scope-index-plan-shape.test.ts asks a real planner whether
  // the authorization predicate reaches an Index Cond, which needs the gist
  // indexes the hand-written migrations create. It runs in live-checks.yml
  // against a production-shaped database.
  LIVE_DB_TESTS: "asks the planner for an Index Cond, so it runs in live-checks.yml on a production-shaped database",
  // services/memory/fact-resolve-route.live.test.ts reads the DEPLOYED
  // memory-service, which is the only thing that can answer whether the
  // fact-resolve path is reachable there (a local service can serve it while
  // the deployed one answers 405). ci.yml holds no URL or key for it, and
  // pointing every PR's CI run at the live service would make the check depend
  // on that deployment being up. It runs in live-checks.yml instead, next to
  // the other checks that read real infrastructure.
  MEMORY_SERVICE_LIVE: "reads the deployed memory-service, so it runs in live-checks.yml",
  GRAPHITI_SERVICE_URL: "names the deployed memory-service, which ci.yml does not reach",
  GRAPHITI_SERVICE_API_KEY: "authenticates against the deployed memory-service, which ci.yml does not reach",
  // mcp/notice-burst.measure.realdb.test.ts is a measurement run by hand to compare two
  // revisions' notice rules on one burst; it prints numbers and checks no behaviour.
  MEASURE_NOTICE_BURST: "a by-hand measurement that prints numbers, not a check",
  // mcp/task-start-notice.perf.test.ts and mcp/derived-write.perf.realdb.test.ts hold wall-clock
  // budgets, which are only meaningful on a quiet machine: CI's shards run many workers at once,
  // and a bound failed there under load with the code unchanged. Each budget's claim also runs in
  // CI without a clock, in task-start-notice.test.ts and derived-write.realdb.test.ts.
  WILLDER_PERF_TESTS:
    "wall-clock budgets, run by hand on a quiet machine; CI's busy shards fail them with the code unchanged",
  // mcp/task-start-bench.perf.realdb.test.ts's run size, read only once WILLDER_PERF_TESTS lets it run.
  WILLDER_PERF_CHUNKS: "sizes a wall-clock bench that runs only by hand, under WILLDER_PERF_TESTS",
  WILLDER_PERF_PRIOR: "sizes a wall-clock bench that runs only by hand, under WILLDER_PERF_TESTS",
  WILLDER_PERF_PAIRS: "sizes a wall-clock bench that runs only by hand, under WILLDER_PERF_TESTS",
  // mcp/aggregate-digest-flag-off.realdb.test.ts runs in CI under QA_DATABASE_URL. It sets and
  // clears RETRIEVAL_QUERY_SHAPES itself to compare both pages, and writes its base capture only
  // when AGGREGATE_DIGEST_PARITY_WRITE is set by hand on the base commit.
  RETRIEVAL_QUERY_SHAPES: "set and cleared by the flag-off parity suite itself, which runs in CI either way",
  AGGREGATE_DIGEST_PARITY_WRITE:
    "set by hand on the base commit to recapture the parity suite's expected pages, never in CI",
};

/** Every `*.test.ts` in the repo except this file, whose own gate reads CI. */
function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) testFiles(full, found);
    } else if (entry.name.endsWith(".test.ts") && full !== __filename) {
      found.push(full);
    }
  }
  return found;
}

/** Whether `source` holds a suite that runs only when some condition holds. */
export function isGated(source: string): boolean {
  return /\.(skipIf|runIf)\s*\(/.test(source);
}

/** Every `process.env.NAME` read in `source`, deduplicated and sorted. */
export function envNamesRead(source: string): string[] {
  const names = source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
  return [...new Set([...names].map((match) => match[1]))].sort();
}

/**
 * Variable names ci.yml hands to a job. Workflow keys are lower case and
 * variable names are not, so a SCREAMING_CASE key is an environment entry.
 */
export function envNamesProvided(ciYaml: string): string[] {
  const keys = ciYaml.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm);
  return [...new Set([...keys].map((match) => match[1]))].sort();
}

describe("every gated test suite either runs in CI or says why it cannot", () => {
  it("finds no suite gated on a variable CI neither sets nor excuses", () => {
    const provided = new Set(envNamesProvided(readFileSync(workflow, "utf8")));
    const offenders: string[] = [];
    for (const file of testFiles(repoRoot)) {
      const source = readFileSync(file, "utf8");
      if (!isGated(source)) continue;
      for (const name of envNamesRead(source)) {
        if (provided.has(name) || AMBIENT_ENV.has(name) || name in GATES_CI_CANNOT_SATISFY) continue;
        offenders.push(`${relative(repoRoot, file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The detectors against hand-written samples, so the repo scan above cannot
  // pass merely because it found nothing to look at.
  it("reads the variables a gated suite depends on", () => {
    const source = [
      "const QA_URL = process.env.QA_DATABASE_URL;",
      'describe.skipIf(!QA_URL)("real Postgres", () => {});',
    ].join("\n");
    expect(isGated(source)).toBe(true);
    expect(envNamesRead(source)).toEqual(["QA_DATABASE_URL"]);
  });

  it("treats an ungated suite as nothing to check", () => {
    expect(isGated('describe("plain", () => {});')).toBe(false);
  });

  it("reads ci.yml's variables and not its workflow keys", () => {
    const yaml = [
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    env:",
      '      QA_DATABASE_URL: "postgresql://localhost:5433/willder_qa"',
      "    steps:",
      "      - name: Unit tests",
      "        run: npm test",
    ].join("\n");
    expect(envNamesProvided(yaml)).toEqual(["QA_DATABASE_URL"]);
  });

  it("would flag a suite gated on a variable ci.yml does not mention", () => {
    const provided = new Set(envNamesProvided("    env:\n      QA_DATABASE_URL: x\n"));
    const names = envNamesRead("const LIVE = process.env.SOME_NEW_FLAG;");
    expect(names.filter((name) => !provided.has(name) && !(name in GATES_CI_CANNOT_SATISFY))).toEqual([
      "SOME_NEW_FLAG",
    ]);
  });
});

// Outside CI this skips, the same way the suites it guards do. Inside CI it is
// the one check that cannot pass vacuously: it opens the connection the real-
// Postgres suites open, and fails if the service, the extensions, the schema or
// the variable ever go missing again.
describe.skipIf(!process.env.CI)("CI provisions the database the real-Postgres suites need", () => {
  it("reaches an isolated Postgres carrying ltree, vector and the schema", async () => {
    const url = process.env.QA_DATABASE_URL;
    expect(url, "CI must set QA_DATABASE_URL or 21 real-database suites skip in silence").toBeTruthy();
    expect(url, "QA_DATABASE_URL must name a database of its own, never the ambient one").not.toBe(
      process.env.DATABASE_URL,
    );

    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    try {
      const extensions = await db.$queryRaw<{ extname: string }[]>`
        SELECT extname FROM pg_extension ORDER BY extname
      `;
      expect(extensions.map((row) => row.extname)).toEqual(expect.arrayContaining(["ltree", "vector"]));
      // A connection alone proves nothing: the migrations have to have run, or every
      // suite below would fail on a missing table rather than skip.
      await expect(db.scope.count()).resolves.toBeTypeOf("number");
    } finally {
      await db.$disconnect();
    }
  });
});
