#!/usr/bin/env node
// Proves the sharded CI test run covered the whole suite: every test file Vitest
// lists ran in exactly one shard, and no shard ran nothing.
//
// Splitting `npm test` across parallel jobs adds a way to go green while testing
// less: a shard that never starts, a report that never uploads, or a shard
// count changed in one place and not the other each drop files silently, and
// every remaining job still passes. This check compares what the shards
// reported with what `vitest list` says the suite is, so a missing or doubled
// file fails the build instead of shrinking it.
//
// Usage: node scripts/check-test-shards.mjs <vitest-list.json> <shard-report.json>...
// The list comes from `vitest list --filesOnly --json`; each report from a
// shard's `--reporter=json` output.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compares the files Vitest lists with the files each shard ran.
 *
 * @param {string[]} listedFiles every test file in the suite, repo-relative
 * @param {{ name: string, files: string[], tests: number }[]} shards what each shard ran
 * @returns {string[]} one line per problem; empty when the shards cover the suite exactly
 */
export function shardCoverageProblems(listedFiles, shards) {
  const problems = [];
  const ranIn = new Map();
  for (const shard of shards) {
    if (shard.tests === 0) problems.push(`${shard.name} ran zero tests`);
    for (const file of shard.files) ranIn.set(file, [...(ranIn.get(file) ?? []), shard.name]);
  }
  const listed = new Set(listedFiles);
  for (const file of [...listed].sort()) {
    if (!ranIn.has(file)) problems.push(`never ran: ${file}`);
  }
  for (const [file, names] of [...ranIn].sort()) {
    if (names.length > 1) problems.push(`ran in more than one shard (${names.join(", ")}): ${file}`);
    if (!listed.has(file)) problems.push(`ran but is not in the suite's file list: ${file}`);
  }
  return problems;
}

/** A shard's report reduced to what the comparison needs, with repo-relative paths. */
export function readShardReport(name, report, repoRoot) {
  return {
    name,
    files: report.testResults.map((result) => relative(repoRoot, result.name)),
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    failed: report.numFailedTests,
  };
}

function main(argv) {
  const [listPath, ...reportPaths] = argv;
  if (!listPath || reportPaths.length === 0) {
    console.error("usage: node scripts/check-test-shards.mjs <vitest-list.json> <shard-report.json>...");
    return 2;
  }
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const listed = JSON.parse(readFileSync(listPath, "utf8")).map((entry) => relative(repoRoot, entry.file));
  const shards = reportPaths.map((path) =>
    readShardReport(relative(process.cwd(), path), JSON.parse(readFileSync(path, "utf8")), repoRoot),
  );

  for (const shard of shards) {
    console.log(
      `${shard.name}: ${shard.files.length} files, ${shard.tests} tests ` +
        `(${shard.passed} passed, ${shard.skipped} skipped, ${shard.failed} failed)`,
    );
  }
  const sum = (key) => shards.reduce((total, shard) => total + shard[key], 0);
  console.log(
    `all shards: ${sum("tests")} tests (${sum("passed")} passed, ${sum("skipped")} skipped, ${sum("failed")} failed) ` +
      `in ${shards.reduce((total, shard) => total + shard.files.length, 0)} files; vitest lists ${listed.length} files`,
  );

  const problems = shardCoverageProblems(listed, shards);
  if (problems.length > 0) {
    console.error(`The shards did not cover the suite exactly (${problems.length} problems):`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log("Every listed test file ran in exactly one shard.");
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
