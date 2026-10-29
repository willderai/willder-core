// Unit tests for query-focused excerpts: the matching sentence is kept even when it sits
// past the opening, neighbours give it context, gaps are always marked, the size limit
// always holds, and nothing is reordered or rewritten.
import { describe, expect, it } from "vitest";
import { excerptForQuery, queryTerms, splitSentences } from "./query-excerpt";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} says nothing much.`);

describe("queryTerms", () => {
  it("keeps numbers and words of three or more letters, drops stopwords, lower-cases and de-duplicates", () => {
    expect(queryTerms("What is the portal URL for Dana? Dana, 42")).toEqual(["portal", "url", "dana", "42"]);
  });
});

describe("splitSentences", () => {
  it("splits at sentence ends followed by whitespace and at line breaks, not inside a decimal or a version", () => {
    expect(splitSentences("Price is 3.5 dollars. Ship v1.2 now!\nNext line? Yes.").map((s) => s.text)).toEqual([
      "Price is 3.5 dollars.",
      "Ship v1.2 now!",
      "Next line?",
      "Yes.",
    ]);
  });
});

describe("excerptForQuery", () => {
  it("returns text that already fits unchanged", () => {
    expect(excerptForQuery("Short fact.", "anything", 100)).toBe("Short fact.");
  });

  it("keeps the matching sentence past the opening, with its neighbours, and marks the gaps", () => {
    const text = [
      ...filler(20),
      "Before the answer.",
      "The follow-up moved to Friday at 9 AM.",
      "After the answer.",
      ...filler(20),
    ].join(" ");

    const excerpt = excerptForQuery(text, "when is the follow-up", 120);

    expect(excerpt).toBe("… Before the answer. The follow-up moved to Friday at 9 AM. After the answer. …");
  });

  it("orders picked sentences as written, even when a later one matches more terms", () => {
    const text = [
      ...filler(10),
      "Portal access is managed by IT.",
      ...filler(10),
      "The portal URL is portal.example.com.",
      ...filler(10),
    ].join(" ");

    const excerpt = excerptForQuery(text, "portal url", 200);

    expect(excerpt.indexOf("Portal access")).toBeGreaterThan(-1);
    expect(excerpt.indexOf("Portal access")).toBeLessThan(excerpt.indexOf("The portal URL"));
    expect(excerpt).toContain(" … ");
  });

  it("serves the opening sentences, in order and without gaps, when nothing matches the query", () => {
    const text = filler(30).join(" ");

    const excerpt = excerptForQuery(text, "zebra", 100);

    expect(excerpt).toBe("Filler sentence number 0 says nothing much. Filler sentence number 1 says nothing much. …");
  });

  it("cuts one matching sentence longer than the limit to a window near its first match", () => {
    const text = `${"word ".repeat(300)}the secret code is 7731 ${"word ".repeat(300)}`.trim();

    const excerpt = excerptForQuery(text, "secret code", 80);

    expect(excerpt).toContain("secret code is 7731");
    expect(excerpt.startsWith("… ")).toBe(true);
    expect(excerpt.endsWith(" …")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(80);
  });

  it("never exceeds the limit, and every sentence it keeps is verbatim from the text", () => {
    const sentences = [...filler(15), "Dana approved the budget.", ...filler(15), "The budget is $40k.", ...filler(15)];
    const text = sentences.join(" ");

    for (const limit of [60, 90, 150, 300, 600]) {
      const excerpt = excerptForQuery(text, "Dana budget", limit);
      expect(excerpt.length).toBeLessThanOrEqual(limit);
      for (const part of excerpt.split(/\s*…\s*/).filter(Boolean)) expect(text).toContain(part);
    }
  });
});

describe("excerptForQuery on text that is not space-separated ASCII", () => {
  /** A UTF-16 code unit that is half of a surrogate pair with its other half missing. */
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const collapse = (text: string) => text.replace(/\s+/g, " ");

  it("never splits an emoji when a sentence with no spaces is cut to a window", () => {
    const text = `${"😀".repeat(500)}secret${"🎉".repeat(500)}`;

    for (let limit = 20; limit <= 61; limit++) {
      const excerpt = excerptForQuery(text, "secret", limit);
      expect(excerpt).not.toMatch(LONE_SURROGATE);
      expect(excerpt).toContain("secret");
      expect(excerpt.length).toBeLessThanOrEqual(limit);
    }
  });

  it("keeps the query term in the window when text without spaces has a space far from it", () => {
    const cases = [
      `${"東京".repeat(400)}secret${"東京".repeat(400)} end`,
      `${"東京".repeat(400)} a b secret${"京".repeat(800)}`,
    ];
    for (const text of cases) expect(excerptForQuery(text, "secret", 60)).toContain("secret");
  });

  // "İ".toLowerCase() is two code units, so positions found in the lower-cased text run
  // ahead of the original by one for every İ before the match.
  it("keeps the window on the query term when lower-casing changes the text's length", () => {
    const text = `${"İzmir ".repeat(150)}the release train leaves on Tuesday ${"İzmir ".repeat(150)}`.trim();

    const excerpt = excerptForQuery(text, "release train", 120);

    expect(excerpt).toContain("release train");
    expect(excerpt.length).toBeLessThanOrEqual(120);
  });

  it("holds the bound, keeps every part verbatim and splits no character, over seeded random text", () => {
    // A fixed-seed generator, so a failure reproduces.
    let seed = 0x5eed;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const pieces = [
      "😀",
      "👩‍💻",
      "𝔘",
      "漢字",
      "東京",
      "İ",
      "ı",
      "ß",
      "Ǆ",
      "word",
      "release",
      "train",
      " ",
      " ",
      ". ",
      "\n",
      "é",
    ];

    for (let run = 0; run < 2_000; run++) {
      const text = Array.from({ length: 20 + Math.floor(random() * 400) }, () => pick(pieces)).join("");
      const query = `${pick(["release", "train", "word", "東京", "İ"])} ${pick(["train", "zebra", "漢字"])}`;
      const limit = 10 + Math.floor(random() * 200);

      const excerpt = excerptForQuery(text, query, limit);

      expect(excerpt.length).toBeLessThanOrEqual(limit);
      expect(excerpt).not.toMatch(LONE_SURROGATE);
      // Adjacent sentences are rejoined with one space, so compare with whitespace collapsed.
      for (const part of excerpt.split(/\s*…\s*/).filter(Boolean)) expect(collapse(text)).toContain(collapse(part));
    }
  });
});
