// The cleanup command's arguments and its reviewed file: a dry run lists one run by tag, and
// a removal takes only one reviewed dry run's output, always as a named user. Unit tests;
// the removal itself is proven in services/memory/run-tag-cleanup.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { parseCleanupArgs, reviewedInventory } from "./cleanup-run-tag";

const who = ["--org", "org_1", "--scope", "org_org_1.demo_a", "--as", "u_1"];
const TAG = "ltload-20261005213000";

describe("parseCleanupArgs", () => {
  it("is a dry run of one run unless --apply is given", () => {
    expect(parseCleanupArgs([...who, "--tag", TAG])).toEqual({
      mode: "list",
      orgId: "org_1",
      scopePath: "org_org_1.demo_a",
      actingUserId: "u_1",
      tag: TAG,
    });
    expect(() => parseCleanupArgs([...who, "--tag", TAG, "--tag", "ltconflict-202610052130"])).toThrow(
      "pass exactly one --tag",
    );
  });

  it("removes only what a reviewed file lists, never by tag", () => {
    expect(parseCleanupArgs([...who, "--apply", "--reviewed", "reviewed.jsonl"])).toMatchObject({
      mode: "apply",
      reviewedFile: "reviewed.jsonl",
    });
    expect(() => parseCleanupArgs([...who, "--apply", "--tag", TAG])).toThrow("pass --reviewed <file>, not --tag");
    expect(() => parseCleanupArgs([...who, "--apply"])).toThrow("--apply needs --reviewed <file>");
    expect(() => parseCleanupArgs([...who, "--reviewed", "reviewed.jsonl", "--tag", TAG])).toThrow(
      "--reviewed is for --apply",
    );
  });

  it("refuses a missing user, org or scope, a dry run with no tag, a flag without its value, and an unknown flag", () => {
    expect(() => parseCleanupArgs(["--org", "org_1", "--scope", "org_org_1.demo_a", "--tag", TAG])).toThrow(
      "--as <User.id> are required",
    );
    expect(() => parseCleanupArgs(who)).toThrow("pass exactly one --tag");
    expect(() => parseCleanupArgs([...who, "--tag"])).toThrow("--tag needs a value");
    expect(() => parseCleanupArgs([...who, "--tag", "--apply"])).toThrow("--tag needs a value");
    expect(() => parseCleanupArgs([...who, "--all"])).toThrow('unknown argument "--all"');
  });
});

describe("reviewedInventory", () => {
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      dryRun: true,
      orgId: "org_1",
      scopePath: "org_org_1.demo_a",
      tag: TAG,
      facts: [{ id: "c1" }],
      ...over,
    });

  it("reads the one dry run the file holds", () => {
    expect(reviewedInventory(`${line()}\n`)).toMatchObject({ tag: TAG, facts: [{ id: "c1" }] });
  });

  it("refuses a file covering more than one run, so the removal is always of the run it prints", () => {
    expect(() => reviewedInventory(`${line()}\n${line({ tag: "ltload-20261005213001" })}`)).toThrow(
      `holds 2 dry runs (${TAG}, ltload-20261005213001); review and remove one run per file`,
    );
  });

  it("names the line and the fix for an empty file, a line that is not JSON, a removal's output, and facts without ids", () => {
    expect(() => reviewedInventory("\n")).toThrow("holds no dry-run line; pass the dry run's output unchanged");
    expect(() => reviewedInventory(`\n${line().slice(0, -1)}`)).toThrow(
      "line 2 of the reviewed file is not JSON; pass the dry run's output unchanged",
    );
    expect(() => reviewedInventory(line({ dryRun: false }))).toThrow(
      "line 1 of the reviewed file is not a dry-run line of this command",
    );
    expect(() => reviewedInventory(line({ facts: [{ scopePath: "x" }] }))).toThrow(
      "line 1 of the reviewed file is not a dry-run line",
    );
  });
});
