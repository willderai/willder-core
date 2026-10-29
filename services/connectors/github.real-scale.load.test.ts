// github.real-scale.test.ts syncs a 900-item fake GitHub repository several times over, one
// awaited provider response after another, under vitest's default 5 s test timeout. On a loaded
// machine each await takes longer and its sync tests timed out while passing alone (the fix's
// notes: "a load timeout in GitHub sync that passes alone").
//
// This runs that file in its own vitest with every provider response body taking 40 ms to read
// (standing in for a loaded machine): its tests must still pass. They do once the file declares a
// ceiling for its sync tests, as the connect-repo script's test does (REAL_PROCESS_TIMEOUT_MS).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

describe("github.real-scale.test.ts on a loaded machine", { timeout: 600_000 }, () => {
  it("passes when every provider response takes 40 ms to read", () => {
    const out = join(mkdtempSync(join(tmpdir(), "github-scale-run-")), "result.json");
    // The inner vitest gets this process's environment minus vitest's own variables and the
    // database URLs: the file under test needs no database.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(__)?VITEST/.test(k) || k === "TEST" || k === "QA_DATABASE_URL" || k === "DATABASE_URL") delete env[k];
    }
    const r = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        "services/connectors/github.real-scale.load.vitest.config.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${out}`,
      ],
      { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const result = JSON.parse(readFileSync(out, "utf8")) as {
      numTotalTests: number;
      numPassedTests: number;
      testResults: Array<{ assertionResults: Array<{ status: string; fullName: string; failureMessages: string[] }> }>;
    };
    const failed = result.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed"));
    const timeouts = (r.stdout + r.stderr).match(/Test timed out in \d+ms/g) ?? [];
    const first = failed[0] ? failed[0].fullName : "";
    expect(
      failed.length,
      `${failed.length} failed tests, ${timeouts.length} of them "${timeouts[0] ?? "no timeout"}"; first: ${first}`,
    ).toBe(0);
    expect(r.status, r.stderr.slice(-2000)).toBe(0);
    expect(result.numPassedTests).toBe(result.numTotalTests);
    expect(result.numTotalTests).toBeGreaterThanOrEqual(6);
  });
});
