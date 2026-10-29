// The name stretches the suppression list hashes (services/memory/erasure-suppression.ts):
// each distinct stretch once, in the order it first appears, and exactly the stretches the
// one-per-occurrence enumeration it replaced produced. Hashing a stretch twice can only find
// the same erasure twice, so hashing it once decides the same; this pins that nothing else
// changed.
import { describe, expect, it } from "vitest";
import { NAME_WORD } from "./person-name-characters";
import { nameStretches } from "./erasure-suppression";

/** The plain enumeration nameStretches must agree with: every stretch at every position, repeats included. */
function everyStretch(lowered: string, maxWords: number): string[] {
  const words = [...lowered.matchAll(new RegExp(NAME_WORD, "gu"))];
  const stretches: string[] = [];
  for (let first = 0; first < words.length; first++) {
    for (let last = first; last < Math.min(words.length, first + maxWords); last++) {
      stretches.push(lowered.slice(words[first]!.index, words[last]!.index + words[last]![0].length));
    }
  }
  return stretches;
}

/** A deterministic generator, so every run sees the same texts. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const PIECES = [
  "orla",
  "brennick",
  "anne-marie",
  "o'neil",
  "zoë",
  "zoë",
  "dana",
  "whitfield",
  "whitfield-approved",
  "kai",
  "2026",
  "the",
  "review",
  "x@y.z",
  ",",
  ".",
  " ",
  "  ",
  "\t",
  " ",
  "\n",
  "-",
  "--",
  "规则",
  "قاعدة",
  "😀",
];

describe("nameStretches", () => {
  it("yields each stretch the old enumeration did, once, in the order it first appeared", () => {
    const next = sequence(42);
    for (let n = 0; n < 400; n++) {
      const text = Array.from(
        { length: 5 + Math.floor(next() * 60) },
        () => PIECES[Math.floor(next() * PIECES.length)],
      ).join(next() < 0.5 ? " " : "");
      const lowered = text.toLowerCase();
      for (const maxWords of [0, 1, 2, 3, 4]) {
        expect(nameStretches(lowered, maxWords)).toEqual([...new Set(everyStretch(lowered, maxWords))]);
      }
    }
  });

  it("hashes a name repeated a thousand times as often as one mentioned once", () => {
    const once = nameStretches("orla brennick signed it.", 3);
    expect(nameStretches("orla brennick signed it. ".repeat(1000).trim(), 3).length).toBeLessThanOrEqual(
      once.length + 3,
    );
  });
});
