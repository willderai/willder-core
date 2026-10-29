// Regression coverage for the check-script wrapper (`scripts/run-check.sh`).
//
// Every one of the ~20 `*:check` npm scripts (and `eval:drafts`, and `mcp`) goes
// through this one wrapper, so its behavior is load-bearing far beyond any one
// script.
//
// The wrapper must not default `ENV_FILE` to `.env` and pass it to node
// unconditionally: in any checkout without a `.env` on disk — which is every
// fresh Routine clone, since the repo ships only `.env.example` — node would
// die `node: .env: not found` at exit 9 *before a single line of check code
// ran*, making `npm run deploy-errors:check`, the mandatory pre-merge gate,
// unrunnable unless someone hand-fed it an `ENV_FILE` pointing at a throwaway
// file.
//
// Two things are asserted here, and the second is the one that keeps the fix honest:
//
//  1. WHICH FLAGS the wrapper passes, in each of the four env-file states. Asserted
//     against a stub `npx` on PATH (same technique as `build-script.test.ts`) so the
//     cases run offline and don't depend on any check script's own behavior.
//  2. THAT A REAL `.env` IS STILL LOADED. Case 1 alone would still pass if the flag
//     were spelled wrong or node silently ignored it, which is exactly the "the flag
//     was passed" tautology this fix could hide behind. One case therefore runs the
//     real `npx tsx` against a real env file and asserts the *value* arrives in the
//     child's `process.env` — an independent source of truth for "unchanged when a
//     real env file is present," not a restatement of the diff.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");
const wrapper = join(repoRoot, "scripts", "run-check.sh");

/** Stubs the executables the wrapper could plausibly reach, each recording how it was
 * called. Argv is written one element per line, never flattened, so assertions can
 * compare the *complete* invocation — executable, argument order, and script path —
 * rather than probing a joined string for substrings. A wrapper that reordered its
 * arguments, dropped the script, or shelled out to `node`/`tsx` directly would satisfy
 * substring checks while breaking all ~20 `*:check` scripts; it cannot satisfy these. */
function makeStubBin(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "run-check-stub-"));
  const logPath = join(binDir, "calls.log");
  writeFileSync(logPath, "");
  for (const name of ["npx", "node", "tsx"]) {
    writeFileSync(
      join(binDir, name),
      `#!/usr/bin/env bash\n{ echo "exe=${name}"; printf '%s\\n' "$@"; echo "--end--"; } >> ${JSON.stringify(logPath)}\nexit 0\n`,
    );
    chmodSync(join(binDir, name), 0o755);
  }
  return { binDir, logPath };
}

/** The wrapper's single child process, as `{ exe, argv }`. Throws if it made more (or
 * fewer) than exactly one call, which is itself a regression worth failing on. */
function soleInvocation(logPath: string): { exe: string; argv: string[] } {
  const lines = readFileSync(logPath, "utf8").split("\n");
  const calls: { exe: string; argv: string[] }[] = [];
  let current: { exe: string; argv: string[] } | undefined;
  for (const line of lines) {
    if (line.startsWith("exe=")) current = { exe: line.slice(4), argv: [] };
    else if (line === "--end--" && current) {
      calls.push(current);
      current = undefined;
    } else if (current && line !== "") current.argv.push(line);
  }
  expect(calls, `expected exactly one child process, got ${JSON.stringify(calls)}`).toHaveLength(1);
  return calls[0];
}

/** Runs the wrapper from a throwaway cwd, so the `.env` the default path resolves
 * to is the test's own file and never the developer's real repo-root `.env`. */
function runWrapper(opts: { envFileContents?: string; ENV_FILE?: string } = {}): {
  status: number;
  exe: string;
  argv: string[];
  stderr: string;
} {
  const { binDir, logPath } = makeStubBin();
  const cwd = mkdtempSync(join(tmpdir(), "run-check-cwd-"));
  if (opts.envFileContents !== undefined) {
    writeFileSync(join(cwd, ".env"), opts.envFileContents);
  }
  const res = spawnSync("bash", [wrapper, "scripts/check-deploy-errors.ts"], {
    cwd,
    encoding: "utf8",
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      ...(opts.ENV_FILE === undefined ? {} : { ENV_FILE: opts.ENV_FILE }),
    },
  });
  const { exe, argv } = soleInvocation(logPath);
  return { status: res.status ?? -1, exe, argv, stderr: res.stderr ?? "" };
}

const SCRIPT_ARG = "scripts/check-deploy-errors.ts";

// Every test below spawns bash, and the last two boot a real `npx tsx`. On a loaded
// CI runner that takes longer than Vitest's 5 s default, so each test carries an
// explicit bound.
const SPAWN_TEST_TIMEOUT_MS = 30_000;

describe("run-check.sh — env file resolution", () => {
  // Exit 9 is node's own "bad --env-file" status; without this fix that
  // happens on every fresh clone, and no check script's code ever gets to run.
  it(
    "no .env on disk: runs the check anyway instead of dying at exit 9",
    () => {
      const { status, exe, argv } = runWrapper();
      expect(status).toBe(0);
      expect(exe).toBe("npx");
      expect(argv).toEqual(["tsx", SCRIPT_ARG]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "a real .env present: still passes --env-file (behavior unchanged)",
    () => {
      const { status, exe, argv, stderr } = runWrapper({ envFileContents: "FOO=bar\n" });
      expect(status).toBe(0);
      expect(exe).toBe("npx");
      expect(argv).toEqual([
        "tsx",
        "--env-file=.env",
        "--import",
        join(repoRoot, "scripts", "lib", "require-local-env-database.ts"),
        SCRIPT_ARG,
      ]);
      expect(stderr).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ENV_FILE pointing at a file that exists: honors the override",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "run-check-envfile-"));
      const custom = join(dir, ".env.prod");
      writeFileSync(custom, "FOO=bar\n");
      const { status, exe, argv, stderr } = runWrapper({ ENV_FILE: custom });
      expect(status).toBe(0);
      expect(exe).toBe("npx");
      expect(argv).toEqual(["tsx", `--env-file=${custom}`, SCRIPT_ARG]);
      // The warning is for a missing file only; a valid override stays quiet.
      expect(stderr).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  // An explicitly named ENV_FILE that does not exist is probably a typo in the
  // prod-check workflow (`ENV_FILE=.env.prod npm run check`). The check still runs on
  // the ambient env, as the default case above requires, but it must say so on
  // stderr: otherwise it reports CLEAN for whatever DATABASE_URL happens to be set.
  it(
    "ENV_FILE pointing at a missing path: runs on ambient env and warns on stderr",
    () => {
      const { status, exe, argv, stderr } = runWrapper({ ENV_FILE: "/nope/does-not-exist.env" });
      expect(status).toBe(0);
      expect(exe).toBe("npx");
      expect(argv).toEqual(["tsx", SCRIPT_ARG]);
      expect(stderr).toBe(
        "run-check: ENV_FILE=/nope/does-not-exist.env not found; running on the ambient environment instead\n",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "no ENV_FILE and no .env: stays silent (a fresh clone is not a typo)",
    () => {
      const { stderr } = runWrapper();
      expect(stderr).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ENV_FILE set but empty: treated as unset, silent",
    () => {
      const { status, argv, stderr } = runWrapper({ ENV_FILE: "" });
      expect(status).toBe(0);
      expect(argv).toEqual(["tsx", SCRIPT_ARG]);
      expect(stderr).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("run-check.sh — a present env file is genuinely loaded, not just flagged", () => {
  // Guards against the tautology in the suite above: asserting `--env-file=...` is in
  // the argv proves the flag was passed, not that node read the file. This runs the
  // real `npx tsx` and reads the value back out of the child's own process.env.
  it(
    "values from the env file reach the check script's process.env",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "run-check-real-"));
      const envFile = join(dir, ".env.probe");
      writeFileSync(envFile, "WILLDER_ENVFILE_PROBE=probe-ok\n");
      const probe = join(dir, "probe.ts");
      writeFileSync(probe, "console.log('PROBE=' + (process.env.WILLDER_ENVFILE_PROBE ?? '<unset>'))\n");

      const res = spawnSync("bash", [wrapper, probe], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ENV_FILE: envFile, WILLDER_ENVFILE_PROBE: undefined },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("PROBE=probe-ok");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  // The same run without the file present must NOT produce the value — otherwise the
  // test above would pass for reasons having nothing to do with the env file.
  it(
    "...and are absent when no env file is involved at all",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "run-check-real-neg-"));
      const probe = join(dir, "probe.ts");
      writeFileSync(probe, "console.log('PROBE=' + (process.env.WILLDER_ENVFILE_PROBE ?? '<unset>'))\n");

      const res = spawnSync("bash", [wrapper, probe], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ENV_FILE: join(dir, "no-such.env"), WILLDER_ENVFILE_PROBE: undefined },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("PROBE=<unset>");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("run-check.sh — the default .env must point at a local database", () => {
  const HOSTED = "postgresql://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb";
  const LOCAL = "postgresql://postgres:willder@localhost:5432/willder";

  /** Runs the real wrapper and `npx tsx` from a throwaway cwd holding `.env`, so the
   * developer's own repo-root `.env` is never read. The cwd links the repo's
   * node_modules so `npx tsx` resolves locally instead of downloading. The probe
   * prints the URL it would connect to, so a run that should have been refused shows
   * up as output, not just an exit code. */
  function runWithDotEnv(dotEnv: string, extraEnv: Record<string, string> = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "run-check-dotenv-"));
    symlinkSync(join(repoRoot, "node_modules"), join(cwd, "node_modules"));
    writeFileSync(join(cwd, ".env"), dotEnv);
    const probe = join(cwd, "probe.ts");
    writeFileSync(probe, "console.log('PROBE=' + (process.env.DATABASE_URL ?? '<unset>'))\n");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_URL_UNPOOLED;
    delete env.ENV_FILE;
    Object.assign(env, extraEnv);
    return spawnSync("bash", [wrapper, probe], { cwd, encoding: "utf8", env });
  }

  it(
    "refuses a hosted DATABASE_URL in .env before the script runs",
    () => {
      const res = runWithDotEnv(`DATABASE_URL=${HOSTED}\n`);
      expect(res.status).toBe(1);
      expect(res.stdout).not.toContain("PROBE=");
      expect(res.stderr).toContain(
        "run-check: refusing to run: DATABASE_URL points at ep-cool-name-123.us-east-2.aws.neon.tech, not this machine (from .env)",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "runs with a local DATABASE_URL in .env",
    () => {
      const res = runWithDotEnv(`DATABASE_URL=${LOCAL}\n`);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`PROBE=${LOCAL}`);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "runs against an exported URL, which wins over the hosted one in .env",
    () => {
      const res = runWithDotEnv(`DATABASE_URL=${HOSTED}\n`, { DATABASE_URL: LOCAL });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`PROBE=${LOCAL}`);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "runs against a hosted URL from an env file named with ENV_FILE",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "run-check-named-"));
      const named = join(dir, ".env.prod");
      writeFileSync(named, `DATABASE_URL=${HOSTED}\n`);
      const res = runWithDotEnv(`DATABASE_URL=${HOSTED}\n`, { ENV_FILE: named });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`PROBE=${HOSTED}`);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
