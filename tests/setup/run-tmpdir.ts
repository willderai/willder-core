// One temporary directory per test run, removed when the run ends.
//
// Tests and the scripts they start make their scratch directories with
// mkdtemp(join(tmpdir(), ...)), and the shell scripts they spawn use
// ${TMPDIR:-/tmp}. Many of them never removed what they made, so a developer
// machine collected thousands of gatemem-*, cost-cap-cal-*, build-sh-stub-*
// and similar directories. os.tmpdir() reads TMPDIR on every call, so pointing
// TMPDIR at a directory of the run's own puts every one of them inside it, and
// removing that one directory at the end cleans up after all of them.
//
// Vitest copies process.env into each worker it starts after global setup
// returns, so every worker, and every child process a test spawns with the
// inherited environment, writes into the same run directory. Nothing is removed
// until the whole run has finished, so no worker can lose another's files.
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Names this run's directory, so a nested run or a second project reuses it. */
export const RUN_TMPDIR_ENV = "WILLDER_TEST_RUN_TMPDIR";
/** Set to 1 to keep the run directory for inspection; its path is printed at the end. */
export const KEEP_TMPDIR_ENV = "WILLDER_KEEP_TEST_TMPDIR";
export const RUN_TMPDIR_PREFIX = "willder-vitest-";

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"] as const;

/**
 * Make this run's temporary directory under `base`, point the temp variables in
 * `env` at it, and return the teardown that restores them and removes it. When
 * `env` already names a run directory that exists (the second project of the same
 * run, or a vitest a test started), it is reused and the teardown leaves it alone:
 * only the run that made it removes it.
 */
export function createRunTmpdir(
  env: Record<string, string | undefined>,
  base: string = tmpdir(),
  log: (line: string) => void = console.log,
): () => void {
  const inherited = env[RUN_TMPDIR_ENV];
  if (inherited && existsSync(inherited)) return () => {};

  const root = realpathSync(base);
  const dir = mkdtempSync(join(root, RUN_TMPDIR_PREFIX));
  const saved = Object.fromEntries(TEMP_VARS.map((name) => [name, env[name]]));
  for (const name of TEMP_VARS) env[name] = dir;
  env[RUN_TMPDIR_ENV] = dir;

  return () => {
    for (const name of TEMP_VARS) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    delete env[RUN_TMPDIR_ENV];
    if (env[KEEP_TMPDIR_ENV] === "1") {
      log(`Kept this run's temporary files in ${dir}`);
      return;
    }
    // Only ever the directory made above: a direct child of the base, with our prefix.
    if (dirname(dir) !== root || !basename(dir).startsWith(RUN_TMPDIR_PREFIX)) return;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
}
