// The no-readable-match note's one rule is that it
// never tells a reader memory lacks what it holds (specific-values.ts header: "the error is
// to stay quiet"). Each case below is a stored text that holds the value the question
// names, verbatim or in a common spelling, and that textHoldsValue (and so the Postgres
// check, which runs the same pattern) does not count as held, so the note would fire.
import { describe, expect, it } from "vitest";
import { specificValuesIn, textHoldsValue } from "./specific-values";

const holds = (question: string, stored: string): boolean[] =>
  specificValuesIn(question).map((value) => textHoldsValue(stored, value));

describe("textHoldsValue never misses a value a text holds", () => {
  it("holds a value written exactly as the question writes it, titlecase digraphs included", () => {
    // eitherCase() builds [lower upper] and drops the character itself when it is neither:
    // "ǅ" (U+01C5) becomes [ǆǄ], so the verbatim text is not held.
    expect(holds('Was it "Miǅa"?', "Miǅa")).toEqual([true]);
    expect(holds('Was it "Ljiǈa"?', "Ljiǈa")).toEqual([true]);
    expect(holds('Did it say "ǲ desk"?', "ǲ desk")).toEqual([true]);
  });

  it("holds a number whose digits are joined by an underscore, a soft hyphen or a zero-width space", () => {
    expect(holds("Was it 415-555-0174?", "call_415_555_0174.wav")).toEqual([true]);
    expect(holds("Was it 415-555-0174?", "415­555­0174")).toEqual([true]);
    expect(holds("did it end in 0174?", "01​74")).toEqual([true]);
  });

  it("holds a name whose words are split by a zero-width space or a middle initial", () => {
    expect(holds("Was it Harbor House?", "Harbor​House")).toEqual([true]);
    expect(holds("Did Maya Bennett call back?", "Maya J. Bennett called back at 4pm.")).toEqual([true]);
  });

  it("does not ask for a title the stored text leaves out", () => {
    expect(holds("Did Dr Maya Bennett approve it?", "Maya Bennett approved the plan.")).toEqual([true]);
  });
});

// Spellings of a number a business record commonly uses
// that hold the value as a person reads it. Either the rule counts them as held, or the claim
// (tool description, PR body) names what it compares: digits as written, not amounts or dates.
describe("textHoldsValue holds an amount or a date written the way records write them", () => {
  it("holds 1,500,000 in an amount written with a scale letter or word", () => {
    expect(holds("Was the deal 1,500,000?", "The deal was $1.5M.")).toEqual([true]);
    expect(holds("Was the deal 1,500,000?", "The deal was 1.5 million.")).toEqual([true]);
  });

  it("holds 10/15/2026 in a date written with the month's name", () => {
    expect(holds("Was it 10/15/2026?", "On Oct 15, 2026 we met.")).toEqual([true]);
    expect(holds("Was it 10/15/2026?", "On 15 October 2026 we met.")).toEqual([true]);
  });
});

// A scale is a word or a letter on its own, never the
// first letter of another word. Without that, a round amount is held by any text with a digit
// before a word starting k, m, b or t, and the note goes quiet on most round amounts.
describe("textHoldsValue reads a scale only as a whole word", () => {
  it("does not hold a round amount in a count of something else", () => {
    expect(holds("Was the contract 3,000,000?", "Renewed for 3 months.")).toEqual([false]);
    expect(holds("Was the budget 1,500,000?", "We ran 1.5 miles.")).toEqual([false]);
    expect(holds("Was it 2000?", "She has 2 kids.")).toEqual([false]);
    expect(holds("Was invoice 5000 paid?", "Ordered 5 kg of flour.")).toEqual([false]);
    expect(holds("Was it 2,000,000,000,000?", "Bought 2 tickets.")).toEqual([false]);
  });

  it("still holds the amount with the scale at a word's end", () => {
    expect(holds("Was the deal 1,500,000?", "The deal was $1.5M.")).toEqual([true]);
    expect(holds("Was the deal 1,500,000?", "1.5m-dollar deal")).toEqual([true]);
    expect(holds("Was it 2000?", "about 2k")).toEqual([true]);
    expect(holds("Was the deal 3,000,000?", "3 million")).toEqual([true]);
  });
});
