// The sharded CI run's coverage check, against hand-built shard results: it
// has to fail on each way a shard split can quietly test less.
import { describe, expect, it } from "vitest";
import { readShardReport, shardCoverageProblems } from "./check-test-shards.mjs";

const suite = ["a.test.ts", "b.test.ts", "c.test.tsx", "d.test.ts"];

describe("shardCoverageProblems", () => {
  it("passes when every listed file ran in exactly one shard", () => {
    expect(
      shardCoverageProblems(suite, [
        { name: "shard 1", files: ["a.test.ts", "c.test.tsx"], tests: 5 },
        { name: "shard 2", files: ["b.test.ts", "d.test.ts"], tests: 3 },
      ]),
    ).toEqual([]);
  });

  it("fails when a shard's report is missing, naming every file it held", () => {
    expect(shardCoverageProblems(suite, [{ name: "shard 1", files: ["a.test.ts", "c.test.tsx"], tests: 5 }])).toEqual([
      "never ran: b.test.ts",
      "never ran: d.test.ts",
    ]);
  });

  it("fails when two shards ran the same file", () => {
    expect(
      shardCoverageProblems(suite, [
        { name: "shard 1", files: ["a.test.ts", "b.test.ts"], tests: 5 },
        { name: "shard 2", files: ["b.test.ts", "c.test.tsx", "d.test.ts"], tests: 3 },
      ]),
    ).toEqual(["ran in more than one shard (shard 1, shard 2): b.test.ts"]);
  });

  it("fails when a shard ran zero tests, even if the file sets add up", () => {
    expect(
      shardCoverageProblems(
        ["a.test.ts"],
        [
          { name: "shard 1", files: ["a.test.ts"], tests: 2 },
          { name: "shard 2", files: [], tests: 0 },
        ],
      ),
    ).toEqual(["shard 2 ran zero tests"]);
  });

  it("fails when a shard ran a file the suite does not list", () => {
    expect(
      shardCoverageProblems(["a.test.ts"], [{ name: "shard 1", files: ["a.test.ts", "stray.test.ts"], tests: 2 }]),
    ).toEqual(["ran but is not in the suite's file list: stray.test.ts"]);
  });
});

describe("readShardReport", () => {
  it("reads a Vitest JSON report into repo-relative files and counts", () => {
    const report = {
      numTotalTests: 4,
      numPassedTests: 2,
      numPendingTests: 1,
      numTodoTests: 1,
      numFailedTests: 0,
      testResults: [{ name: "/repo/services/x.test.ts" }, { name: "/repo/app/y.test.tsx" }],
    };
    expect(readShardReport("shard 3", report, "/repo")).toEqual({
      name: "shard 3",
      files: ["services/x.test.ts", "app/y.test.tsx"],
      tests: 4,
      passed: 2,
      skipped: 2,
      failed: 0,
    });
  });
});
