// The per-run temporary directory: every test's scratch files land inside it, and
// the run's teardown removes it and nothing else.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEEP_TMPDIR_ENV, RUN_TMPDIR_ENV, RUN_TMPDIR_PREFIX, createRunTmpdir } from "./run-tmpdir";

describe("the run's temporary directory", () => {
  const bases: string[] = [];
  const freshBase = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "run-tmpdir-base-")));
    bases.push(base);
    return base;
  };
  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  it("is where this test run is writing", () => {
    const dir = process.env[RUN_TMPDIR_ENV];
    expect(dir).toBeTruthy();
    expect(tmpdir()).toBe(dir);
  });

  it("holds what tests make under tmpdir(), and is removed with all of it at teardown", () => {
    const base = freshBase();
    const sibling = join(base, "someone-elses");
    mkdirSync(sibling);
    const env: Record<string, string | undefined> = { TMPDIR: base };

    const teardown = createRunTmpdir(env, base);
    const dir = env[RUN_TMPDIR_ENV]!;
    expect(dir.startsWith(join(base, RUN_TMPDIR_PREFIX))).toBe(true);
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([dir, dir, dir]);
    const scratch = mkdtempSync(join(dir, "gatemem-"));
    writeFileSync(join(scratch, "episode.json"), "{}");

    teardown();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(base)).toEqual(["someone-elses"]);
    expect(env).toEqual({ TMPDIR: base });
  });

  it("is reused, not removed, by a second setup in the same run", () => {
    const base = freshBase();
    const env: Record<string, string | undefined> = {};
    const outer = createRunTmpdir(env, base);
    const dir = env[RUN_TMPDIR_ENV]!;

    createRunTmpdir(env, base)();
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(base)).toHaveLength(1);

    outer();
    expect(existsSync(dir)).toBe(false);
  });

  it("is kept, with its path printed, when asked to", () => {
    const base = freshBase();
    const env: Record<string, string | undefined> = { [KEEP_TMPDIR_ENV]: "1" };
    const lines: string[] = [];
    const teardown = createRunTmpdir(env, base, (line) => lines.push(line));
    const dir = env[RUN_TMPDIR_ENV]!;

    teardown();
    expect(existsSync(dir)).toBe(true);
    expect(lines).toEqual([`Kept this run's temporary files in ${dir}`]);
  });
});
