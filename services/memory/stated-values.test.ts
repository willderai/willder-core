// attributeTerms reads short codes ("UK", "H2", "R&D") as terms. A code spelled like a stopword
// ("IT", "OR", "ME") is a code only where its text has lower-case letters too.
import { describe, expect, it } from "vitest";
import { attributeTerms } from "./stated-values";

describe("attributeTerms", () => {
  it("reads two-character codes and capitals joined by '&' as terms", () => {
    expect(attributeTerms("The budget for the UK in H2")).toEqual(["budget", "uk", "h2"]);
    expect(attributeTerms("The budget for R&D and P&L, with AT&T")).toEqual(["budget", "r&d", "p&l", "at&t"]);
  });

  it("reads dotted capitals and a spaced or dotted '&' as the same code", () => {
    expect(attributeTerms("for the U.K. and I.T.")).toEqual(["uk", "it"]);
    expect(attributeTerms("for R & D, R.&D. and r&d")).toEqual(["r&d", "r&d", "r&d"]);
    expect(attributeTerms("rock & roll, you & me")).toEqual(["rock", "roll"]);
  });

  it("keeps a stopword-spelled code in mixed-case text, and drops it in all-caps text", () => {
    expect(attributeTerms("The budget for IT")).toEqual(["budget", "it"]);
    expect(attributeTerms("THE BUDGET FOR IT")).toEqual(["budget"]);
    expect(attributeTerms("THE BUDGET FOR HR")).toEqual(["budget", "hr"]);
    expect(attributeTerms("RAISED TO $550k FOR ME")).toEqual(["rais"]);
  });

  it("reads the case of the text a word is written in, when given", () => {
    expect(attributeTerms("IT.", "Raised to $10,000 for IT.")).toEqual(["it"]);
    expect(attributeTerms("IT.", "RAISED TO $10,000 FOR IT.")).toEqual([]);
  });

  it("never reads a lower-case word as a code", () => {
    expect(attributeTerms("the budget for it or me")).toEqual(["budget"]);
  });
});
