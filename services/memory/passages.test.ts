// splitPassages: how a long memory row is cut into the windows that are embedded on
// their own (services/memory/passages.ts). Pure; no database, no embedding service.
import { describe, expect, it } from "vitest";
import { MAX_PASSAGES_PER_ROW, PASSAGE_CHARS, PASSAGE_OVERLAP_CHARS, splitPassages } from "./passages";

/** `n` numbered sentences of about 60 characters each. */
function sentences(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `Sentence number ${String(i).padStart(3, "0")} says one small thing here.`,
  ).join(" ");
}

describe("splitPassages", () => {
  it("returns no passages for content that fits in one, since the row's own embedding covers it", () => {
    expect(splitPassages("")).toEqual([]);
    expect(splitPassages("x".repeat(PASSAGE_CHARS))).toEqual([]);
  });

  it("covers every character of long content with windows no longer than PASSAGE_CHARS", () => {
    const content = sentences(80); // about 4,400 characters, the mean BEAM pair
    const passages = splitPassages(content);

    expect(passages.length).toBeGreaterThanOrEqual(3);
    expect(passages[0]!.start).toBe(0);
    expect(passages.at(-1)!.end).toBe(content.length);
    for (const passage of passages) {
      expect(passage.end - passage.start).toBeLessThanOrEqual(PASSAGE_CHARS);
      expect(passage.text).toBe(content.slice(passage.start, passage.end));
    }
    // No gap between neighbours: each starts before the previous one ends.
    for (let i = 1; i < passages.length; i++) expect(passages[i]!.start).toBeLessThan(passages[i - 1]!.end);
  });

  it("overlaps neighbours by about PASSAGE_OVERLAP_CHARS so a sentence on a cut is whole in one of them", () => {
    const passages = splitPassages(sentences(80));
    for (let i = 1; i < passages.length; i++) {
      const overlap = passages[i - 1]!.end - passages[i]!.start;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(PASSAGE_OVERLAP_CHARS);
    }
  });

  it("ends a passage at a sentence boundary and starts the next at a word", () => {
    const content = sentences(80);
    const passages = splitPassages(content);
    for (const passage of passages.slice(0, -1)) expect(passage.text.trimEnd()).toMatch(/\.$/);
    for (const passage of passages.slice(1)) expect(content[passage.start - 1]).toMatch(/\s/);
  });

  it("cuts text with no spaces at all at the window length instead of looping", () => {
    const content = "y".repeat(3 * PASSAGE_CHARS);
    const passages = splitPassages(content);
    expect(passages.at(-1)!.end).toBe(content.length);
    for (const [i, passage] of passages.entries()) {
      expect(passage.start).toBe(i * (PASSAGE_CHARS - PASSAGE_OVERLAP_CHARS));
      if (i < passages.length - 1) expect(passage.end - passage.start).toBe(PASSAGE_CHARS);
    }
  });

  it("stops at MAX_PASSAGES_PER_ROW passages from the start of a very long row", () => {
    const content = sentences(5_000); // about 300,000 characters, a pasted transcript
    const passages = splitPassages(content);
    expect(passages).toHaveLength(MAX_PASSAGES_PER_ROW);
    expect(passages[0]!.start).toBe(0);
    for (let i = 1; i < passages.length; i++) expect(passages[i]!.start).toBeLessThan(passages[i - 1]!.end);
  });

  it("never cuts between the two halves of a surrogate pair", () => {
    const content = "\u{1F600}".repeat(1_200); // 2,400 UTF-16 code units, no spaces
    for (const passage of splitPassages(content)) {
      expect(passage.text.codePointAt(0)).toBe(0x1f600);
      expect(passage.text.length % 2).toBe(0);
    }
  });
});
