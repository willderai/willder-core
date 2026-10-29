import { describe, expect, it } from "vitest";
import { fuseTextRanking, opensWithPattern, quotedTextPattern } from "./text-match-fusion";

const base = Array.from({ length: 40 }, (_, i) => `r${i + 1}`);

describe("fuseTextRanking", () => {
  it.each([
    { name: "an empty text ranking leaves the order as it was", text: [], first: ["r1", "r2", "r3"] },
    {
      name: "the text leg's best match goes first from the bottom of the read",
      text: ["r40"],
      first: ["r40", "r1", "r2"],
    },
    // r20: 1/(60+2) + 1/(60+20) beats r30: 1/(60+1) + 1/(60+30). Both beat r1: 1/(60+1).
    {
      name: "two text matches go ahead of the rest, by their summed reciprocal ranks",
      text: ["r30", "r20"],
      first: ["r20", "r30", "r1"],
    },
    { name: "an item the read lacks is never added", text: ["absent", "r10"], first: ["r10", "r1", "r2"] },
  ])("$name", ({ text, first }) => {
    const fused = fuseTextRanking(base, text);

    expect(fused.slice(0, 3)).toEqual(first);
    expect([...fused].sort()).toEqual([...base].sort());
  });

  it("keeps the read's order between items the text leg does not rank", () => {
    const fused = fuseTextRanking(base, ["r25"]).filter((item) => item !== "r25");

    expect(fused).toEqual(base.filter((item) => item !== "r25"));
  });
});

const BREAK_CHARACTERS = "[:space:][:cntrl:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const BREAK = `[${BREAK_CHARACTERS}]+`;

describe("quotedTextPattern", () => {
  it.each([
    { query: "what about Acme", pattern: null },
    { query: "  Findings\t T-4c378528:\u0007Cause  ", pattern: null },
    { query: "a b c d e f g h", pattern: null },
    { query: "the renewal key lives here", pattern: ["the", "renewal", "key", "lives", "here"].join(BREAK) },
    { query: "Findings T-4c378528: Cause\n\tis", pattern: ["Findings", "T\\-4c378528\\:", "Cause", "is"].join(BREAK) },
    {
      query: "cost (USD) is 5.0* per_seat 100% a\\b",
      pattern: ["cost", "\\(USD\\)", "is", "5\\.0\\*", "per\\_seat", "100\\%", "a\\\\b"].join(BREAK),
    },
    {
      query: "x^2 + y? [a|b] {n} costs $5",
      pattern: ["x\\^2", "\\+", "y\\?", "\\[a\\|b\\]", "\\{n\\}", "costs", "\\$5"].join(BREAK),
    },
    { query: "Café façade — naïve résumé", pattern: ["Café", "façade", "—", "naïve", "résumé"].join(BREAK) },
    {
      query: "a line cut short at an emoji \ud83d",
      pattern: ["a", "line", "cut", "short", "at", "an", "emoji"].join(BREAK),
    },
    { query: `${"word ".repeat(100)}tail`, pattern: Array(40).fill("word").join(BREAK) },
  ])("$query", ({ query, pattern }) => {
    expect(quotedTextPattern(query)).toBe(pattern);
  });

  it("anchors the opening form after any leading whitespace", () => {
    expect(opensWithPattern("a")).toBe(`^[${BREAK_CHARACTERS}]*a`);
  });
});
