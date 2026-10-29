// Regression coverage for the build pipeline (`npm run build` -> build.sh).
// Two separate things are tested here, and the second one is the reason
// this file exists at all:
//
//  1. BEHAVIOR — the environment gate itself. `prisma migrate deploy` runs in
//     the build so a merged migration can never silently fail to reach prod;
//     it is gated so a target with no DB configured skips instead of failing
//     the whole build. Both halves are load-bearing and neither had any
//     test: deleting the production guard, or dropping `set -e`, both leave
//     the full suite green while quietly reintroducing a build that goes
//     green having applied no migrations.
//
//  2. DEPLOYABILITY — that the build command's own files actually ship to Vercel.
//     `.vercelignore` excludes `scripts/`, so a build command that depends on
//     a file under `scripts/` (such as `bash scripts/build.sh`) depends on a
//     file Vercel is explicitly told not to upload — `bash:
//     scripts/build.sh: No such file or directory`, exit 127, before any
//     build work, on EVERY target including production. A build script that
//     is correct but never shipped is worse than no fix at all, and no
//     amount of behavior testing catches it, so it gets its own assertion
//     here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");

/** A stub `npx` that records each invocation (and the DATABASE_URL it saw) to a
 * log file, so we assert on what the script actually ran rather than on its
 * stdout wording. `failMigrate` makes `npx prisma migrate deploy` exit non-zero,
 * standing in for a migration that genuinely fails against the real DB. A stub
 * `sleep` records each wait the script asks for and returns at once, so the
 * lock-retry cases check the real default wait without sitting through it. */
function makeStubBin(failMigrate = false, lockTimeouts = 0): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "build-sh-stub-"));
  const logPath = join(binDir, "calls.log");
  // `lockTimeouts` makes the first N migrate calls exit with P1002, the way a
  // deploy behaves while another deploy holds the advisory lock. Counted off the
  // call log, so it survives the script invoking npx more than once.
  const migrateBehavior = failMigrate
    ? 'echo "P3009: migration failed" >&2; exit 1'
    : `if [ "$(grep -c '^prisma migrate deploy' ${JSON.stringify(logPath)})" -le ${lockTimeouts} ]; then
    echo "Error: P1002 The database server was reached but timed out." >&2
    exit 1
  fi
  exit 0`;
  const npx = `#!/usr/bin/env bash
echo "$* | DATABASE_URL=\${DATABASE_URL-<unset>}" >> ${JSON.stringify(logPath)}
if [ "$1" = "prisma" ] && [ "$2" = "migrate" ]; then
  ${migrateBehavior}
fi
exit 0
`;
  const sleep = `#!/usr/bin/env bash
echo "sleep $*" >> ${JSON.stringify(logPath)}
`;
  writeFileSync(logPath, "");
  writeFileSync(join(binDir, "npx"), npx);
  chmodSync(join(binDir, "npx"), 0o755);
  writeFileSync(join(binDir, "sleep"), sleep);
  chmodSync(join(binDir, "sleep"), 0o755);
  return { binDir, logPath };
}

function runBuild(
  env: Record<string, string | undefined>,
  opts: { failMigrate?: boolean; lockTimeouts?: number } = {},
): { status: number; calls: string[]; stdout: string } {
  const { binDir, logPath } = makeStubBin(opts.failMigrate, opts.lockTimeouts ?? 0);
  // Start from a clean env so a DATABASE_URL in the developer's own shell can't
  // silently flip which branch is under test.
  const res = spawnSync("bash", ["build.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      ...env,
    },
  });
  const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return { status: res.status ?? -1, calls, stdout: res.stdout };
}

const ranMigrate = (calls: string[]) => calls.some((c) => c.startsWith("prisma migrate deploy"));
const ranNextBuild = (calls: string[]) => calls.some((c) => c.startsWith("next build"));
const migrateCalls = (calls: string[]) => calls.filter((c) => c.startsWith("prisma migrate deploy"));
const sleeps = (calls: string[]) => calls.filter((c) => c.startsWith("sleep "));

describe("build.sh — migrate-deploy environment gate", () => {
  it("preview with no DB configured: skips migrate deploy and still builds", () => {
    const { status, calls } = runBuild({ VERCEL_ENV: "preview" });
    expect(status).toBe(0);
    expect(ranMigrate(calls)).toBe(false);
    expect(ranNextBuild(calls)).toBe(true);
  });

  it("no VERCEL_ENV at all with no DB (local/CI): skips migrate deploy and still builds", () => {
    const { status, calls } = runBuild({});
    expect(status).toBe(0);
    expect(ranMigrate(calls)).toBe(false);
    expect(ranNextBuild(calls)).toBe(true);
  });

  // The half that keeps the environment gate from becoming a silent
  // skip-migration-in-prod path. Without it, prod/no-DB builds GREEN having
  // applied nothing.
  it("production with no DB configured: fails loud and never builds", () => {
    const { status, calls } = runBuild({ VERCEL_ENV: "production" });
    expect(status).toBe(1);
    expect(ranMigrate(calls)).toBe(false);
    expect(ranNextBuild(calls)).toBe(false);
  });

  it("production with DATABASE_URL set: runs migrate deploy, then builds", () => {
    const { status, calls } = runBuild({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://pooled/db",
    });
    expect(status).toBe(0);
    expect(calls.some((c) => c.includes("prisma migrate deploy") && c.includes("postgres://pooled/db"))).toBe(true);
    expect(ranNextBuild(calls)).toBe(true);
  });

  // build.sh fixed migrate deploy timing out on Neon's POOLED connection (P1002) by
  // preferring the unpooled URL. Ordinary refactoring of this script must not lose it.
  it("prefers DATABASE_URL_UNPOOLED over DATABASE_URL (keeps the Neon P1002 fix)", () => {
    const { calls } = runBuild({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://pooled/db",
      DATABASE_URL_UNPOOLED: "postgres://unpooled/db",
    });
    const migrate = calls.find((c) => c.startsWith("prisma migrate deploy"));
    expect(migrate).toContain("postgres://unpooled/db");
    expect(migrate).not.toContain("postgres://pooled/db");
  });

  // A pooled URL in DATABASE_URL_UNPOOLED (or no unpooled URL at all) would put
  // migrate back on the pooler, where the advisory lock leaks onto a pooled server
  // connection and blocks every later deploy with P1002.
  it("migrates through Neon's direct host when the configured URL names the -pooler host", () => {
    const { status, calls, stdout } = runBuild({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgresql://u:p@ep-cool-lab-a1-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    });
    expect(status).toBe(0);
    expect(migrateCalls(calls)[0]).toContain(
      "DATABASE_URL=postgresql://u:p@ep-cool-lab-a1.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(stdout).toContain("Migrating through Neon's direct host");
    // Only migrate moves off the pooler; the app build keeps the URL it was given.
    expect(calls.find((c) => c.startsWith("next build"))).toContain("ep-cool-lab-a1-pooler.");
  });

  it("leaves a direct Neon host and any non-Neon host exactly as configured", () => {
    for (const url of [
      "postgresql://u:p@ep-cool-lab-a1.c-2.eu-central-1.aws.neon.tech/neondb",
      "postgresql://u:p@db-pooler.example.com/app",
    ]) {
      const { calls, stdout } = runBuild({ VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: url });
      expect(migrateCalls(calls)[0]).toContain(`DATABASE_URL=${url}`);
      expect(stdout).not.toContain("Migrating through Neon's direct host");
    }
  });

  // Each half of the host match must hold on its own: a -pooler host outside
  // neon.tech, and a neon.tech -pooler host that is not an ep- endpoint, are
  // both left alone. One fixture failing both halves would let either drop.
  it("rewrites only a host that is both an ep- endpoint and under neon.tech", () => {
    for (const url of [
      "postgresql://u:p@ep-cool-lab-a1-pooler.db.example.com/app",
      "postgresql://u:p@db-pooler.c-2.eu-central-1.aws.neon.tech/neondb",
    ]) {
      const { calls } = runBuild({ VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: url });
      expect(migrateCalls(calls)[0]).toContain(`DATABASE_URL=${url}`);
    }
  });

  // The actual guarantee: a migration that FAILS must fail the build, not
  // ship an app against a schema that never got migrated.
  it("a failing migrate deploy aborts the build (next build never runs)", () => {
    const { status, calls } = runBuild(
      { VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db" },
      { failMigrate: true },
    );
    expect(status).not.toBe(0);
    expect(ranNextBuild(calls)).toBe(false);
  });
});

describe("the build command's own files must actually ship to Vercel", () => {
  /** Minimal gitignore-style match, which is the semantics `.vercelignore` uses:
   * a `dir/` (or bare `dir`) entry excludes the directory and everything under it. */
  function isIgnored(path: string, patterns: string[]): string | undefined {
    return patterns.find((p) => {
      const rule = p.replace(/\/+$/, "");
      return path === rule || path.startsWith(`${rule}/`);
    });
  }

  it("no file referenced by package.json's build script is excluded by .vercelignore", () => {
    const buildCmd: string = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts.build;
    const patterns = readFileSync(join(repoRoot, ".vercelignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    // Every repo-relative script file the build command invokes.
    const referenced = (buildCmd.match(/[\w./-]+\.(?:sh|mjs|cjs|js|ts)\b/g) ?? []).map((p) => p.replace(/^\.\//, ""));

    for (const file of referenced) {
      expect(existsSync(join(repoRoot, file)), `${file} is referenced by the build but missing`).toBe(true);
      const rule = isIgnored(file, patterns);
      expect(
        rule,
        `package.json's build runs "${file}", but .vercelignore excludes it via "${rule}". ` +
          `It will not exist in the Vercel build container, so EVERY deploy (production included) ` +
          `fails with "No such file or directory" (exit 127) before any build work. ` +
          `Move it outside the ignored directory or inline the command. Note a negation ` +
          `("!${file}") will NOT rescue it — gitignore semantics ignore re-inclusion under an excluded parent.`,
      ).toBeUndefined();
    }
  });
});

// PRODUCTION DATA SAFETY. The gate above answers "is a DB configured?". It
// does not answer "is this build allowed to migrate it?", and those are
// different questions. A verification sandbox can carry a live production
// DATABASE_URL, and `npm run build` is a mandated step in the pre-merge QA
// gate -- so the standard way to verify a feature branch could also become
// the way to apply that branch's unreviewed migrations to production, unless
// the script itself refuses. Relying on the sandbox having no Postgres TCP
// egress would be network policy, not a control, and the kind of incidental
// block that can disappear without anyone deciding to remove it. These cases
// pin the decision down in the script itself.
describe("build.sh — migrating requires being a deploy, not just having a DB URL", () => {
  it("a plain build with a production DATABASE_URL does not migrate, and still builds", () => {
    const { status, calls } = runBuild({ DATABASE_URL: "postgres://neondb_owner@ep-royal-lab/prod" });
    expect(ranMigrate(calls), "a non-deploy build must never apply migrations to the DB it is pointed at").toBe(false);
    expect(ranNextBuild(calls)).toBe(true);
    expect(status).toBe(0);
  });

  // DB_URL prefers the unpooled URL, so the guard has to cover that spelling too
  // or the QA path keeps its write access under a different variable name.
  it("the same is true when only DATABASE_URL_UNPOOLED is set", () => {
    const { status, calls } = runBuild({ DATABASE_URL_UNPOOLED: "postgres://neondb_owner@ep-royal-lab/prod" });
    expect(ranMigrate(calls)).toBe(false);
    expect(ranNextBuild(calls)).toBe(true);
    expect(status).toBe(0);
  });

  // The escape hatch has to actually work, or someone will delete the guard
  // instead of using it.
  it("ALLOW_PRISMA_MIGRATE_DEPLOY=1 opts a non-deploy build back in", () => {
    const { status, calls } = runBuild({
      DATABASE_URL: "postgres://pooled/db",
      ALLOW_PRISMA_MIGRATE_DEPLOY: "1",
    });
    expect(status).toBe(0);
    expect(calls.some((c) => c.startsWith("prisma migrate deploy") && c.includes("postgres://pooled/db"))).toBe(true);
  });

  // Real deploys are unchanged: Vercel sets VERCEL_ENV on every deploy build and
  // nothing else does, so preview keeps migrating its own branch DB as before.
  it("a preview deploy with a DB still migrates (VERCEL_ENV is the deploy signal)", () => {
    const { calls } = runBuild({ VERCEL_ENV: "preview", DATABASE_URL: "postgres://preview/db" });
    expect(ranMigrate(calls)).toBe(true);
  });
});

// CONCURRENT DEPLOYS.
// Prisma takes a Postgres advisory lock around `migrate deploy` and gives up
// waiting for it after 10s with P1002. When several PRs merge within minutes
// of each other, each merge starts its own Vercel build, and the builds can
// collide on that lock, failing and leaving production frozen on an older
// commit while `main` moves on. The lock itself is correct and must stay --
// it is what stops two deploys applying the same migration at once -- so the
// build waits for its turn instead, by retrying the command.
//
// The distinction these cases exist to pin: a LOCK timeout is worth retrying, a
// real migration failure never is. Retrying the latter would turn one honest
// red build into six, and delay it by a minute before failing anyway.
describe("build.sh — waits its turn for the migrate advisory lock", () => {
  it("retries past a P1002 lock timeout and goes on to build", () => {
    const { status, calls } = runBuild(
      { VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db" },
      { lockTimeouts: 2 },
    );
    expect(status).toBe(0);
    expect(calls.filter((c) => c.startsWith("prisma migrate deploy"))).toHaveLength(3);
    expect(ranNextBuild(calls)).toBe(true);
  });

  it("gives up after a bounded number of attempts rather than hanging the build", () => {
    const { status, calls } = runBuild(
      { VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db", MIGRATE_LOCK_ATTEMPTS: "3" },
      { lockTimeouts: 99 },
    );
    expect(status).not.toBe(0);
    expect(calls.filter((c) => c.startsWith("prisma migrate deploy"))).toHaveLength(3);
    expect(ranNextBuild(calls), "a build that never migrated must not ship").toBe(false);
  });

  // The one that keeps the retry honest. A migration that genuinely fails is not
  // a lock contention, and burying it under retries would hide a real outage
  // behind a minute of waiting.
  it("does not retry a real migration failure", () => {
    const { status, calls } = runBuild(
      { VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db" },
      { failMigrate: true },
    );
    expect(status).not.toBe(0);
    expect(calls.filter((c) => c.startsWith("prisma migrate deploy"))).toHaveLength(1);
    expect(ranNextBuild(calls)).toBe(false);
  });

  // build-sh-migrate-lock-wait-too-short-20261001: a one-minute wait (6 x 10s)
  // still lost to a neighbouring build merged about two minutes earlier on
  // 2026-10-01, so the default has to cover that build's whole migrate step.
  it("by default waits 20 attempts, 15 seconds apart, before giving up", () => {
    const { status, calls } = runBuild(
      { VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db" },
      { lockTimeouts: 99 },
    );
    expect(status).not.toBe(0);
    expect(migrateCalls(calls)).toHaveLength(20);
    expect(sleeps(calls)).toEqual(Array(19).fill("sleep 15"));
    expect(ranNextBuild(calls)).toBe(false);
  });

  // The build log is the only record of how long a deploy queued for the lock,
  // so it names the attempt both while waiting and when the migrate goes through.
  it("logs the attempt count on every retry and on success", () => {
    const { status, stdout } = runBuild(
      { VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db" },
      { lockTimeouts: 2 },
    );
    expect(status).toBe(0);
    expect(stdout).toContain("(P1002), attempt 1/20.");
    expect(stdout).toContain("(P1002), attempt 2/20.");
    expect(stdout).toContain("prisma migrate deploy succeeded on attempt 3/20.");
  });

  it("logs attempt 1 when the migrate goes through first time", () => {
    const { status, calls, stdout } = runBuild({ VERCEL_ENV: "production", DATABASE_URL: "postgres://real/db" });
    expect(status).toBe(0);
    expect(sleeps(calls)).toHaveLength(0);
    expect(stdout).toContain("prisma migrate deploy succeeded on attempt 1/20.");
  });
});
