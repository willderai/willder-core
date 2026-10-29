// Count lines on the Access tabs at zero, one and many, so a single hit never
// reads "1 matches" again.
import { describe, expect, it } from "vitest";
import { auditPageSummary, countOf, tabMatchCount } from "./count-copy";

describe("countOf", () => {
  it("agrees with zero, one and many", () => {
    expect(countOf(0, "match", "matches")).toBe("0 matches");
    expect(countOf(1, "match", "matches")).toBe("1 match");
    expect(countOf(2, "match", "matches")).toBe("2 matches");
    expect(countOf(1, "token")).toBe("1 token");
    expect(countOf(1200, "token")).toBe("1,200 tokens");
  });
});

describe("tabMatchCount", () => {
  it("agrees the noun with the total and the verb with the count shown", () => {
    expect(tabMatchCount(0, 12, "grant", "sales")).toBe("0 of 12 grants match “sales”");
    expect(tabMatchCount(1, 12, "grant", "sales")).toBe("1 of 12 grants matches “sales”");
    expect(tabMatchCount(1, 1, "token", " k2d8 ")).toBe("1 of 1 token matches “k2d8”");
    expect(tabMatchCount(0, 1, "scope", "x")).toBe("0 of 1 scope match “x”");
  });
});

describe("auditPageSummary", () => {
  const page = { first: 1, shown: 1, total: 1, allowed: 1, denied: 0, searching: true };

  it("says 1 match, not 1 matches, for a single hit", () => {
    expect(auditPageSummary(page)).toBe("1–1 of 1 match · 1 allowed · 0 denied");
    expect(auditPageSummary({ ...page, searching: false })).toBe("1–1 of 1 row · 1 allowed · 0 denied");
  });

  it("keeps the plural for zero and many, and drops the range when nothing is shown", () => {
    expect(auditPageSummary({ ...page, shown: 0, total: 0, allowed: 0 })).toBe("0 matches · 0 allowed · 0 denied");
    expect(
      auditPageSummary({ ...page, first: 51, shown: 50, total: 4999, allowed: 4987, denied: 12, searching: false }),
    ).toBe("51–100 of 4,999 rows · 4,987 allowed · 12 denied");
  });
});
