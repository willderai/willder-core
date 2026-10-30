import { describe, expect, it } from "vitest";
import {
  compareSpanHits,
  extractLiteralSpans,
  literalSpanPattern,
  MAX_SPANS,
  mostSelectiveFirst,
  probeBudgetMs,
  spanHits,
  spanMatchCap,
  spanSimilarityFloor,
  textSpansEnabled,
} from "./text-spans";

const BREAK = "[[:space:][:cntrl:]   -     　﻿]+";
const HEAD = "(^|[^[:alnum:]_-])";
const TAIL = "($|[^[:alnum:]_-])";

describe("extractLiteralSpans", () => {
  it.each([
    // Prose has no literal span, so the read is ordered exactly as without them.
    { query: "what went wrong with the billing service when it was pulling invoices?", spans: [] },
    { query: "Why did we pick the cheaper option last spring?", spans: [] },
    { query: "WHY IS THE API DOWN AGAIN", spans: [] },
    { query: "what's the plan, and who's on it? don't guess", spans: [] },
    // Error codes, identifiers, paths, flags, variables, issues, versions, numbers.
    { query: "how did we resolve ENOSPC: no space left on embed-svc?", spans: ["ENOSPC", "embed-svc"] },
    {
      query: "what did we set MAX_POOL_SIZE to in deploy/billing-api/values.prod.yaml?",
      spans: ["MAX_POOL_SIZE", "deploy/billing-api/values.prod.yaml"],
    },
    {
      query: "does retrieveText run with --max-old-space-size=4096?",
      spans: ["retrieveText", "--max-old-space-size=4096"],
    },
    { query: "is $DATABASE_URL set for @dana in PR #712?", spans: ["$DATABASE_URL", "@dana", "#712"] },
    { query: "which incident had p95 hit 1234 ms after release-2026.10?", spans: ["p95", "1234", "release-2026.10"] },
    {
      query: "what changed in services/memory/hybrid-store.ts (fuseTextRanking)?",
      spans: ["services/memory/hybrid-store.ts", "fuseTextRanking"],
    },
    { query: "tell me about D-1058, then INC-2213.", spans: ["D-1058", "INC-2213"] },
    // Quoted text, in every quote style, with its whitespace folded; a token it holds is not repeated.
    { query: 'who said "keep the  row\ton retry" about ERR_X?', spans: ["keep the row on retry", "ERR_X"] },
    {
      query: "find “no score calibration” and `fuse()` and ‘the drawer’",
      spans: ["no score calibration", "fuse()", "the drawer"],
    },
    { query: "don't use 'quoted text here' it's fine", spans: ["quoted text here"] },
    { query: 'grep "MAX_POOL_SIZE=12" not MAX_POOL_SIZE=12', spans: ["MAX_POOL_SIZE=12"] },
    // Too short for the trigram index, a repeat in another case, or quotes around nothing.
    { query: "v2 or #9 or a_b or x.y, then Foo_Bar and foo_bar", spans: ["Foo_Bar"] },
    { query: 'an empty "" or "ab" quote', spans: [] },
    // No three letters or digits in a row: the trigram index could not narrow the search.
    { query: 'v1.2.3 a-b-c x_y_z 10.0.0.1 "a b c" 1.5x', spans: [] },
    // Only an exact repeat is dropped: a span inside a longer one matches other rows.
    { query: "worker-170 then worker-17", spans: ["worker-170", "worker-17"] },
    { query: "worker-17 then worker-170", spans: ["worker-17", "worker-170"] },
  ])("$query", ({ query, spans }) => {
    expect(extractLiteralSpans(query)).toEqual(spans);
  });

  it(`returns at most ${MAX_SPANS}, the first in the query`, () => {
    const query = Array.from({ length: 10 }, (_, i) => `ERR_${i}00`).join(" ");

    expect(extractLiteralSpans(query)).toEqual(["ERR_000", "ERR_100", "ERR_200", "ERR_300", "ERR_400", "ERR_500"]);
  });

  it("cuts a long quote at its last whole word within 120 code points", () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(3, "0")}x`);
    // Each word is 5 code points and a space: the 21st word ends at 125, so the cut keeps 20.
    expect(extractLiteralSpans(`"${words.join(" ")}"`)).toEqual([words.slice(0, 20).join(" ")]);
    // A cut that falls on a space keeps every word before it.
    const exact = `${"\u{1F600}".repeat(5)}${"a".repeat(114)} tail`;
    expect(extractLiteralSpans(`"${exact}"`)).toEqual([`${"\u{1F600}".repeat(5)}${"a".repeat(114)}`]);
  });
});

describe("literalSpanPattern", () => {
  it.each([
    { span: "ECONNRESET", pattern: `${HEAD}ECONNRESET${TAIL}` },
    { span: "--max-old-space-size=4096", pattern: `\\-\\-max\\-old\\-space\\-size\\=4096${TAIL}` },
    { span: "fuse()", pattern: `${HEAD}fuse\\(\\)` },
    { span: "no space left", pattern: `${HEAD}no${BREAK}space${BREAK}left${TAIL}` },
    { span: "100% a.b*c", pattern: `${HEAD}100\\%${BREAK}a\\.b\\*c${TAIL}` },
    { span: "Café", pattern: `${HEAD}Café${TAIL}` },
  ])("$span", ({ span, pattern }) => {
    expect(literalSpanPattern(span)).toBe(pattern);
  });
});

describe("spanHits", () => {
  it("counts the spans each row holds, a rarer span weighing more, and ignores a span past the cap", () => {
    const hits = spanHits([["a", "b"], ["a"], ["c", "d", "e", "f"]], 3);

    expect(hits).toEqual(
      new Map([
        ["a", { spans: 2, weight: 1.5 }],
        ["b", { spans: 1, weight: 0.5 }],
      ]),
    );
  });

  it("orders more spans first, then the rarer", () => {
    const rows = [
      { id: "one-common", hit: { spans: 1, weight: 0.1 } },
      { id: "none", hit: undefined },
      { id: "two", hit: { spans: 2, weight: 0.2 } },
      { id: "one-rare", hit: { spans: 1, weight: 1 } },
    ];

    expect(rows.sort((a, b) => compareSpanHits(a.hit, b.hit)).map((r) => r.id)).toEqual([
      "two",
      "one-rare",
      "one-common",
      "none",
    ]);
  });

  it("caps at thirty rows or three pages, whichever is more", () => {
    expect([spanMatchCap(5), spanMatchCap(10), spanMatchCap(50)]).toEqual([30, 30, 150]);
  });
});

describe("textSpansEnabled", () => {
  it.each([
    { value: undefined, on: false },
    { value: "", on: false },
    { value: "0", on: false },
    { value: "false", on: false },
    { value: "1", on: true },
    { value: " TRUE ", on: true },
    { value: "on", on: true },
  ])("RETRIEVAL_TEXT_SPANS=$value is $on", ({ value, on }) => {
    expect(textSpansEnabled({ RETRIEVAL_TEXT_SPANS: value })).toBe(on);
  });
});

describe("spanSimilarityFloor", () => {
  it("holds a row of a query mostly in prose to within 0.1 of the read's best", () => {
    const floor = spanSimilarityFloor(
      "when the search indexer got slow after one customer imported a lot, how did we fix it, around INC-2265?",
      0.8,
    );

    expect([floor(0.71), floor(0.69)]).toEqual([true, false]);
  });

  it("sets no floor for a query mostly made of its spans", () => {
    expect(spanSimilarityFloor("which incident had p95 hit 1234 ms?", 0.8)(0.1)).toBe(true);
    expect(spanSimilarityFloor('who said "keep the row on retry"?', 0.8)(0.1)).toBe(true);
  });
});

describe("probeBudgetMs", () => {
  it.each([
    { left: 300, remaining: 7, budget: 42 },
    { left: 300, remaining: 1, budget: 300 },
    // An unused share passes on: what is left is shared again by the probes after it.
    { left: 290, remaining: 6, budget: 48 },
    // Never below 25 ms while that much is left, never above what is left.
    { left: 60, remaining: 6, budget: 25 },
    { left: 12.7, remaining: 3, budget: 12 },
    { left: 4, remaining: 1, budget: null },
    { left: -10, remaining: 2, budget: null },
  ])("$left ms left for $remaining probes: $budget", ({ left, remaining, budget }) => {
    expect(probeBudgetMs(left, remaining)).toBe(budget);
  });
});

describe("mostSelectiveFirst", () => {
  it("probes the span with the most letters and digits first, ties in the query's order", () => {
    expect(mostSelectiveFirst(["p95", "deploy/billing-api/values.prod.yaml", "4242", "#712", "ECONNRESET"])).toEqual([
      1, 4, 2, 0, 3,
    ]);
  });
});
