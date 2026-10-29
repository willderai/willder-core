// The specific values a question names, and when a stored text holds one
// (services/memory/specific-values.ts). The Postgres side of the same rule is checked
// against this one in mcp/no-readable-match.realdb.test.ts.
import { describe, expect, it } from "vitest";
import {
  MAX_SPECIFIC_VALUES,
  normalizeForMatch,
  specificValuesIn,
  textHoldsValue,
  unsettledCharacterClass,
  type SpecificValue,
} from "./specific-values";
import { SPELLING_CASES } from "./specific-values.cases.testsupport";

const keys = (question: string) => specificValuesIn(question).map((v) => `${v.kind}:${v.key}`);
const only = (question: string): SpecificValue => {
  const values = specificValuesIn(question);
  expect(values, question).toHaveLength(1);
  return values[0]!;
};

describe("specificValuesIn: numbers", () => {
  it("takes a digit run of three or more, joined by phone separators, as its digits", () => {
    expect(keys("Yes or no: did the temporary safe number end in 0174?")).toEqual(["number:0174"]);
    expect(keys("Was the deleted backup line 628-555-0162 or 628-555-0192?")).toEqual([
      "number:6285550162",
      "number:6285550192",
    ]);
    expect(keys("Call (415) 555-0174 or 415.555.0174 or 415 555 0174")).toEqual(["number:4155550174"]);
    expect(keys("Did the old backup line start with 617-555-01?")).toEqual(["number:61755501"]);
    expect(keys("What was the first three digits, 415?")).toEqual(["number:415"]);
  });

  it("joins groups across whitespace only when both have three digits, and across a comma only a thousands group", () => {
    expect(keys("Was it bed 312 2 days ago?")).toEqual(["number:312"]);
    expect(keys("Was it $1,500,000?")).toEqual(["number:1500000"]);
    expect(keys("Was it 415 555 0174?")).toEqual(["number:4155550174"]);
    expect(keys("Was it 415-5 or 12 345?")).toEqual(["number:4155", "number:345"]);
  });

  it("leaves out short numbers, and numbers joined by words or commas stay apart", () => {
    expect(keys("Was it room 12, at 6 PM, extension 44?")).toEqual([]);
    expect(keys("Was the old line 510-555 and then 0184?")).toEqual(["number:510555", "number:0184"]);
    expect(keys("Was it 0174, 0186 or 0192?")).toEqual(["number:0174", "number:0186", "number:0192"]);
  });

  it("leaves out a digit run longer than any value a reader guesses at", () => {
    expect(keys(`id ${"9".repeat(41)}`)).toEqual([]);
    expect(keys(`id ${"9".repeat(40)}`)).toEqual([`number:${"9".repeat(40)}`]);
  });
});

describe("specificValuesIn: quoted text and names", () => {
  it("takes quoted text in straight or curly quotes, but not between apostrophes", () => {
    expect(keys("Was the deleted old instruction “ask for Rosa after 6 PM”?")).toContain(
      "quoted:ask for Rosa after 6 PM",
    );
    expect(keys('Did it say "no detailed voicemail"?')).toEqual(["quoted:no detailed voicemail"]);
    expect(keys("Was it ‘front desk’?")).toEqual(["quoted:front desk"]);
    expect(keys("Dr. Levin's note and Ana's line")).toEqual([]);
  });

  it("takes two or more capitalized words in a row as a name, dropping a sentence's first word", () => {
    expect(keys("Was Cedar Bridge Recovery House the deleted backup contact, yes or no?")).toEqual([
      "name:Cedar Bridge Recovery House",
    ]);
    expect(keys("Tell me whether the deleted alternate contact was Cedar Bridge so I can match it.")).toEqual([
      "name:Cedar Bridge",
    ]);
    expect(keys("Did Maya Bennett use the same deleted respite line as Nina Bennett?")).toEqual([
      "name:Maya Bennett",
      "name:Nina Bennett",
    ]);
    // The sentence's first word is dropped even when it is part of the name: the rest is still checked.
    expect(keys("Harbor Bridge House was the site?")).toEqual(["name:Bridge House"]);
  });

  it("ends a name at punctuation or a possessive, and a title's period does not start a sentence", () => {
    expect(keys("We called Harbor House, then Blue Cedar.")).toEqual(["name:Harbor House", "name:Blue Cedar"]);
    expect(keys("Under Dr. Maya Bennett's authority, restore it.")).toEqual(["name:Maya Bennett"]);
    expect(keys("Was it Maple House? Iris said so.")).toEqual(["name:Maple House"]);
  });

  it("ends a name at a capitalized function word, and does not take a title-case run longer than five words", () => {
    expect(keys("Did Elena See Maya Bennett On Tuesday?")).toEqual(["name:Maya Bennett"]);
    expect(keys("we met Alpha Bravo Charlie Delta Echo Foxtrot today")).toEqual([]);
    expect(keys("we met Alpha Bravo Charlie Delta Echo today")).toEqual(["name:Alpha Bravo Charlie Delta Echo"]);
  });

  it("reads a lone surrogate as the replacement character Postgres stores", () => {
    const [value] = specificValuesIn('Was it "x\ud800y"?');
    expect(textHoldsValue("x\ufffdy", value!)).toBe(true);
    // A served text is read the same way, so its lone surrogate matches the question's.
    expect(textHoldsValue("x\ud800y", value!)).toBe(true);
  });

  it("does not take a single capitalized word, all-capital words or a lone I as a name", () => {
    expect(keys("Was the deleted alias Iris? That is all I need.")).toEqual([]);
    expect(keys("before you said MRI ID was ready")).toEqual([]);
    expect(keys("when I Moved")).toEqual([]);
  });
});

describe("specificValuesIn: order, repeats and the cap", () => {
  it("lists values in the order named, each once", () => {
    expect(keys("Was 0174 Harbor House, or was 0174 at Harbor House?")).toEqual(["number:0174", "name:Harbor House"]);
  });

  it(`keeps at most ${MAX_SPECIFIC_VALUES}, the first ones named`, () => {
    const question = Array.from({ length: 12 }, (_, i) => `${100 + i}`).join(" or ");
    expect(keys(question)).toEqual(Array.from({ length: MAX_SPECIFIC_VALUES }, (_, i) => `number:${100 + i}`));
  });

  it("names nothing in a question without a specific value", () => {
    expect(
      specificValuesIn("Which medications should I use right now for pain and nausea, and what should I stop?"),
    ).toEqual([]);
  });

  it("is deterministic", () => {
    const question = "Was the deleted line the Cedar Bridge front desk at 617-555-0140 and “no voicemail”?";
    expect(specificValuesIn(question)).toEqual(specificValuesIn(question));
  });
});

describe("textHoldsValue: when a stored text holds a value", () => {
  it("holds a partial number made of whole groups of a longer one: prefix, suffix and middle", () => {
    const stored = "[t128] Nurse Janelle: direct mobile 415-555-0161 only";
    expect(textHoldsValue(stored, only("Was it 415-something?"))).toBe(true);
    expect(textHoldsValue(stored, only("did it end in 0161?"))).toBe(true);
    expect(textHoldsValue(stored, only("was 555 in it?"))).toBe(true);
    // The dataset's own collision: the deleted 415-555-0188 shares its prefix with the current number.
    expect(textHoldsValue(stored, only("Was the deleted backup number 415-555-0188?"))).toBe(false);
    // A prefix that cuts the kept number's last group names a different number: the deleted one.
    expect(textHoldsValue("current cell 617-555-0104", only("Did the old backup line start with 617-555-01?"))).toBe(
      false,
    );
  });

  it("holds a number across the separators a stored number may use, and only those", () => {
    const value = only("did the number end in 4155550174?");
    for (const stored of [
      "415-555-0174",
      "(415) 555-0174",
      "415.555.0174",
      "415 555 0174",
      "415,555,0174",
      "415: 555: 0174",
    ]) {
      expect(textHoldsValue(stored, value), stored).toBe(true);
    }
    expect(textHoldsValue("415 then 555 then 0174", value)).toBe(false);
    for (const stored of ["415–555–0174", "415\u2011555\u20110174", "415\u00a0555\u00a00174", "415  -  555  -  0174"]) {
      expect(textHoldsValue(stored, value), stored).toBe(true);
    }
    expect(textHoldsValue("415      555      0174", value), "six separators is a gap, not a number").toBe(false);
    expect(textHoldsValue("415-555-0175", value)).toBe(false);
  });

  it("does not hold a number whose digits sit in other numbers", () => {
    expect(textHoldsValue("room 01, bed 74", only("did it end in 0174?"))).toBe(false);
  });

  it("holds quoted text and names in any case, with any whitespace between words, inside longer words too", () => {
    const value = only("Was it at Harbor House?");
    expect(textHoldsValue("the HARBOR\n  house desk", value)).toBe(true);
    expect(textHoldsValue("Harbor Housekeeping", value)).toBe(true);
    expect(textHoldsValue("Harbor, House", value)).toBe(true);
    expect(textHoldsValue("Harbor\u00a0House", value)).toBe(true);
    // Up to four words between a name's words may be a middle name, initials or "and Tom": held, so quiet.
    expect(textHoldsValue("Harbor and House", value)).toBe(true);
    expect(textHoldsValue("Harbor, then the old ferry dock, then House", value)).toBe(false);
    expect(textHoldsValue("Harbor! House", value)).toBe(true);
    expect(textHoldsValue("HarborHouse", value)).toBe(true);
    expect(textHoldsValue("Monday, October 5", only("Was it Monday October?"))).toBe(true);
    expect(textHoldsValue("Harbor Bridge House", value)).toBe(true);
  });

  it("treats every regular-expression character in quoted text as itself", () => {
    const value = only('Did it say "call (ext. 4)+ [desk] $5 a|b ^c? \\d*"?');
    expect(textHoldsValue("Note: call (ext. 4)+ [desk] $5 a|b ^c? \\d* today", value)).toBe(true);
    expect(textHoldsValue("call ext 4 desk 5 ab c d", value)).toBe(false);
  });
});

describe("cost on hostile input", () => {
  it("reads a 100,000-character question and matches 100,000 characters of text in linear time", () => {
    const hostile = `${"1-".repeat(25_000)}${"Aa ".repeat(10_000)}${"“x".repeat(10_000)}`;
    const started = performance.now();
    const values = specificValuesIn(hostile.repeat(1));
    for (const value of values) textHoldsValue("9 ".repeat(50_000), value);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("matches a name, quoted text and a number against long runs of separators in linear time", () => {
    const values = specificValuesIn('Did Maya Bennett say "ask for Nia" about 415-555-0174 or 100-200?');
    expect(values).toHaveLength(4);
    for (const filler of [" ", "-", ", ", "*", "M. "]) {
      for (const text of [
        `Bennett${filler.repeat(100_000)}`,
        `Maya${filler.repeat(100_000)}x`,
        `415${filler.repeat(100_000)}`,
      ]) {
        const started = performance.now();
        for (const value of values) textHoldsValue(text, value);
        expect(performance.now() - started, JSON.stringify(text.slice(0, 12))).toBeLessThan(1_000);
      }
    }
  });
});

describe("textHoldsValue: the spellings a stored text may use (specific-values.cases.testsupport.ts)", () => {
  it.each(SPELLING_CASES)("$name", ({ question, stored, holds }) => {
    // A question that names no value draws no note, so it can only be a case that holds.
    const values = specificValuesIn(question);
    if (!holds) expect(values.length, question).toBeGreaterThan(0);
    expect(values.every((value) => textHoldsValue(stored, value))).toBe(holds);
    // The screen a database scan tries first never turns away a text the value's pattern holds.
    for (const value of values) {
      if (textHoldsValue(stored, value))
        expect(new RegExp(value.screen, "u").test(normalizeForMatch(stored)), value.key).toBe(true);
    }
  });

  it("removes every default-ignorable character and nothing else", () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += codePoint < 0x30000 ? 1 : 0x101) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const c = String.fromCodePoint(codePoint);
      const ignorable = /\p{Default_Ignorable_Code_Point}/u.test(c);
      if (ignorable) expect(normalizeForMatch(`a${c}b`), codePoint.toString(16)).toBe("ab");
      else if (c.normalize("NFKC") === c && !/\p{M}/u.test(c))
        expect(normalizeForMatch(`a${c}b`), codePoint.toString(16)).toBe(`a${c}b`);
    }
  });

  it("knows every decimal digit by its value", () => {
    for (let codePoint = 0; codePoint <= 0x1ffff; codePoint++) {
      const c = String.fromCodePoint(codePoint);
      if (!/\p{Nd}/u.test(c)) continue;
      const [value] = specificValuesIn(`Was it ${c.repeat(3)}?`);
      expect(value?.key, codePoint.toString(16)).toMatch(/^(\d)\1\1$/);
    }
  });

  it("leaves out of the unsettled class only characters NFKC keeps as they are wherever they stand", () => {
    const unsettled = new RegExp(unsettledCharacterClass(), "u");
    const probes = specificValuesIn('Was it 415-555, Harbor House or "a b"?');
    expect(probes).toHaveLength(3);
    const settled: string[] = [];
    for (let codePoint = 1; codePoint <= 0xffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const c = String.fromCodePoint(codePoint);
      if (unsettled.test(c)) continue;
      settled.push(c);
      // Nothing composes with it or reorders around it: U+0345 has the highest combining class.
      expect(`a\u0345${c}`.normalize("NFKC"), codePoint.toString(16)).toBe(`a\u0345${c.normalize("NFKC")}`);
      if (normalizeForMatch(`x${c}`) === `x${c}`) continue;
      // A space or dash NFKC changes: every pattern matches it as it matches what it becomes.
      for (const value of probes) {
        for (const text of [`415${c}555`, `Harbor${c}House`, `a${c}b`]) {
          expect(new RegExp(value.pattern, "u").test(text), `${codePoint.toString(16)} in ${value.key}`).toBe(
            textHoldsValue(text, value),
          );
        }
      }
    }
    // The second character of every canonical composition is unsettled, so a text holding the
    // pair is normalized.
    for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const decomposed = [...String.fromCodePoint(codePoint).normalize("NFD")];
      if (decomposed.length < 2) continue;
      expect(unsettled.test(decomposed.at(-1)!), codePoint.toString(16)).toBe(true);
    }
    expect(settled).toContain("é");
    expect(settled).toContain("’");
    expect(settled).toContain("\u00a0");
    for (const c of ["\u2026", "\ufb01", "\u0301", "\uff11", "\u00b2"]) expect(settled).not.toContain(c);
  });
});
