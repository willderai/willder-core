// Regression coverage for scripts/check-route-collision.sh.
//
// On a fresh clone with no production build (`.next` absent), the script
// must not print "OK: next start booted clean, no dynamic-route slug
// collision." and exit 0. Next's `next start` can print "Ready in ..."
// BEFORE it discovers there is no build, then error with "Could not find a
// production build in the .next directory" -- a Ready grep and settle loop
// that only ever look for the slug-collision string make a dead build
// indistinguishable from a clean boot. CI itself is not exposed to this
// (`next build` runs as its own prior CI step and fails loud), but every
// local/manual run is, and builders cite this gate as PR evidence.
//
// These tests stub `npx` the same way scripts/build-script.test.ts does,
// so they exercise the real script's control flow without paying for an
// actual `next build`/`next start` (which the settle-window sleeps in the
// script already make these tests take real wall-clock seconds).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(__dirname, "check-route-collision.sh");

type StubMode =
  | "ready"
  | "collision"
  | "no_build_late"
  | "startup_env_failed"
  | "exits_after_ready"
  | "exits_before_ready";

/** A stub `npx` standing in for `next start`. `ready` mimics a real clean
 * boot; `collision` and `no_build_late` mimic the two failure lines the
 * script watches for, each printed a moment after "Ready in ..." the same
 * way Next actually emits them (both confirmed-live timing quirks noted in
 * the script's own comments). The stub never actually binds $PORT -- the
 * script only ever inspects the log file and the process's liveness. */
function makeStubNpx(mode: StubMode): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "route-collision-stub-"));
  const logPath = join(binDir, "calls.log");
  const body: Record<StubMode, string> = {
    ready: `echo "Ready in 148ms"\nsleep 60\n`,
    collision: `echo "Ready in 148ms"\nsleep 1\necho "Error: You cannot use different slug names for the same dynamic path"\nsleep 60\n`,
    no_build_late: `echo "Ready in 148ms"\nsleep 1\necho "Error: Could not find a production build in the .next directory"\nsleep 60\n`,
    // instrumentation.ts's register() runs after Ready and exits 1 on a missing variable.
    startup_env_failed: `echo "Ready in 148ms"\necho "willder web server failed: GRAPHITI_SERVICE_URL is not set." >&2\nexit 1\n`,
    exits_after_ready: `echo "Ready in 148ms"\nsleep 1\nexit 1\n`,
    exits_before_ready: `exit 1\n`,
  };
  const npx = `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(logPath)}
${body[mode]}`;
  writeFileSync(logPath, "");
  writeFileSync(join(binDir, "npx"), npx);
  chmodSync(join(binDir, "npx"), 0o755);
  return { binDir, logPath };
}

/** An isolated cwd standing in for the repo root, so the script's relative
 * `.next/BUILD_ID` check never touches this repo's own `.next`. */
function makeProjectDir(withBuild: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "route-collision-project-"));
  if (withBuild) {
    mkdirSync(join(dir, ".next"), { recursive: true });
    writeFileSync(join(dir, ".next", "BUILD_ID"), "test-build-id\n");
  }
  return dir;
}

// run() bounds the script at 30 s; each test's own bound sits above that, so a slow
// `next start` on a loaded runner is judged by the script's exit status, never cut
// off first by Vitest.
const SPAWN_TEST_TIMEOUT_MS = 45_000;

function run(projectDir: string, stub?: { binDir: string }): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bash", [scriptPath], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: stub ? `${stub.binDir}:${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
      HOME: process.env.HOME ?? "",
      PORT: "0",
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("check-route-collision.sh -- no production build must fail, not pass vacuously", () => {
  it(
    "a fresh clone with .next entirely absent exits non-zero without ever booting next start",
    () => {
      const projectDir = makeProjectDir(false);
      const stub = makeStubNpx("ready");
      try {
        const { status, stderr } = run(projectDir, stub);
        expect(status).not.toBe(0);
        expect(stderr).toContain("no production build found");
        // The fail-fast check must happen before `next start` ever runs --
        // the stub's call log staying empty proves npx was never invoked.
        expect(readFileSync(stub.logPath, "utf8").trim()).toBe("");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(stub.binDir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "a build directory with BUILD_ID missing (e.g. a partial/aborted build) also fails fast",
    () => {
      const projectDir = makeProjectDir(false);
      mkdirSync(join(projectDir, ".next"), { recursive: true });
      writeFileSync(join(projectDir, ".next", "some-other-artifact.txt"), "");
      try {
        const { status, stderr } = run(projectDir);
        expect(status).not.toBe(0);
        expect(stderr).toContain("no production build found");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "Next reporting 'Could not find a production build' mid-boot (build present at start but dies) also fails, not just BUILD_ID-missing",
    () => {
      const projectDir = makeProjectDir(true);
      const stub = makeStubNpx("no_build_late");
      try {
        const { status, stderr } = run(projectDir, stub);
        expect(status).not.toBe(0);
        expect(stderr).toContain("no production build present at boot");
        expect(stderr).toContain("Could not find a production build");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(stub.binDir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("check-route-collision.sh -- existing checks still work (regression)", () => {
  it(
    "a real clean boot (build present, no collision) still exits 0",
    () => {
      const projectDir = makeProjectDir(true);
      const stub = makeStubNpx("ready");
      try {
        const { status, stdout } = run(projectDir, stub);
        expect(status).toBe(0);
        expect(stdout).toContain("OK: next start booted clean");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(stub.binDir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "a real slug collision (build present) still fails, unweakened by the no-build fix",
    () => {
      const projectDir = makeProjectDir(true);
      const stub = makeStubNpx("collision");
      try {
        const { status, stderr } = run(projectDir, stub);
        expect(status).not.toBe(0);
        expect(stderr).toContain("dynamic-route slug collision detected");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(stub.binDir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("check-route-collision.sh -- a server that dies is never a clean boot", () => {
  // Next prints Ready before instrumentation.ts checks the startup environment, so a
  // server missing a required variable prints Ready and then exits. Read as a clean
  // boot, that hid every collision from CI (the server never lived to report one).
  it("fails on the startup environment line printed after Ready", () => {
    const projectDir = makeProjectDir(true);
    const stub = makeStubNpx("startup_env_failed");
    try {
      const { status, stdout, stderr } = run(projectDir, stub);
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("OK:");
      expect(stderr).toContain("startup environment check failed");
      expect(stderr).toContain("willder web server failed: GRAPHITI_SERVICE_URL is not set.");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stub.binDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails when the server exits after Ready without printing any known line", () => {
    const projectDir = makeProjectDir(true);
    const stub = makeStubNpx("exits_after_ready");
    try {
      const { status, stdout, stderr } = run(projectDir, stub);
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("OK:");
      expect(stderr).toContain("reported Ready, then exited");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stub.binDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails when the server exits before Ready", () => {
    const projectDir = makeProjectDir(true);
    const stub = makeStubNpx("exits_before_ready");
    try {
      const { status, stderr } = run(projectDir, stub);
      expect(status).not.toBe(0);
      expect(stderr).toContain("exited before reporting Ready");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stub.binDir, { recursive: true, force: true });
    }
  }, 20_000);
});
