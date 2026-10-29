// Performance budget for the task-start block. Wall-clock bounds live here, apart from the
// functional tests, because a clock reading is only meaningful on a machine that is not busy.
//
// Skipped unless WILLDER_PERF_TESTS=1, which CI does not set: the shards run many workers at
// once, and one slow run there failed the bound while the code was unchanged (109 ms against
// 100 ms). The claim these budgets rest on is also pinned without a clock, in
// task-start-notice.test.ts ("cuts a rule's text before looking for its passage"), and that
// version runs in every CI shard.
//
// Run on a quiet machine:  WILLDER_PERF_TESTS=1 npx vitest run --project node mcp/task-start-notice.perf.test.ts
//
// Each budget is the fastest of several runs after a warm-up run. The fastest is what the code
// costs; the slower ones also count whatever else the machine was doing.
import { describe, expect, it } from "vitest";
import { termCountsOf, weighTaskTerms } from "@/services/memory/relevance";
import { renderTaskStartBlock } from "./task-start-notice";

const RUNS = 7;

/** The fastest of `RUNS` timed runs of `work`, in milliseconds, after one untimed warm-up. */
function fastestOf(work: () => void): number {
  work();
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe.skipIf(process.env.WILLDER_PERF_TESTS !== "1")("performance: the task-start block", () => {
  const task = "Fix invoices pagination in app/api/invoices/route.ts";
  const defect =
    "The defect is in app/api/invoices/route.ts: the cursor is read after the limit, so page two repeats a row.";

  it("renders a 400,000-character rule in under 100 ms", () => {
    const hugeRule = {
      id: "r-huge",
      kind: "convention" as const,
      subject: "Invoices",
      text: `${defect} `.repeat(4_000),
    };
    const weights = weighTaskTerms(task, [termCountsOf(hugeRule.text)]);
    const fastest = fastestOf(() => renderTaskStartBlock({ rules: [hugeRule], writes: [], stale: [], weights }));
    console.info(`task-start block, 400,000-character rule: fastest of ${RUNS} ${fastest.toFixed(2)} ms`);
    expect(fastest).toBeLessThan(100);
  });
});
