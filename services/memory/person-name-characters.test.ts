// The name rules held twice: here for the app's erasure and its suppression list, and in
// memory-service/app/graph/name_patterns.py for the graph. The two must agree, or one store
// erases "the Dana Whitfield-approved budget" or "DanaWhitfield offer.pdf" and the other
// keeps it.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CAMEL_LOWER,
  CAMEL_UPPER,
  compatibilityFolded,
  foldName,
  joinedName,
  markWordSteps,
  NAME_HYPHEN,
  NAME_JOINER,
  NAME_LETTER,
  NAME_DASH,
  NAME_INLINE_SPACE,
  NAME_MODIFIER_WORDS,
} from "./person-name-characters";
import spellings from "./name-fold-spellings.json";
import newerLetters from "./name-fold-newer-letters.json";

/** Whether Unicode version `a` ("16.0") is newer than `b`. */
const newerThan = (a: string, b: string) => {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor > bMajor || (aMajor === bMajor && aMinor > bMinor);
};

const NAME_PATTERNS = new URL("../../memory-service/app/graph/name_patterns.py", import.meta.url);
const graphSource = () => readFileSync(NAME_PATTERNS, "utf8");

/** The words of `_MODIFIER_WORDS` as name_patterns.py spells them. */
function graphModifierWords(): string[] {
  const tuple = graphSource().match(/^_MODIFIER_WORDS = \(([^)]*)\)/m);
  if (!tuple) throw new Error("name_patterns.py no longer defines _MODIFIER_WORDS as a tuple of strings");
  return [...tuple[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/** A raw-string constant of name_patterns.py, as the regular expression it holds. */
function graphConstant(name: string): string {
  const line = graphSource().match(new RegExp(`^${name} = r"([^"]*)"$`, "m"));
  if (!line) throw new Error(`name_patterns.py no longer defines ${name} as one raw string`);
  return line[1]!;
}

describe("the words a hyphen does not join a name to", () => {
  it("are the same for the app and the graph", () => {
    expect(graphModifierWords()).toEqual([...NAME_MODIFIER_WORDS]);
  });
});

describe("a name written without spaces", () => {
  it("is joined and stepped by the same characters in the app and the graph", () => {
    expect(graphConstant("_HYPHEN")).toBe(NAME_HYPHEN);
    expect(graphConstant("_JOINER")).toBe(NAME_JOINER);
    // The graph decides which names it can write without spaces by the app's letters.
    expect(graphConstant("_LETTER")).toBe(NAME_LETTER);
    expect(graphConstant("_CAMEL_LOWER")).toBe(CAMEL_LOWER);
    expect(graphConstant("_CAMEL_UPPER")).toBe(CAMEL_UPPER);
    expect(graphConstant("_DASH")).toBe(NAME_DASH);
    expect(graphConstant("_INLINE_SPACE")).toBe(NAME_INLINE_SPACE);
  });

  it("is split into words at whitespace and at every joining mark, noting where the name itself has a mark", () => {
    expect(joinedName("dana whitfield")).toEqual({ words: ["dana", "whitfield"], marks: [false] });
    expect(joinedName("anne-marie  dupont")).toEqual({ words: ["anne", "marie", "dupont"], marks: [true, false] });
    expect(joinedName("j.r. smith")).toEqual({ words: ["j", "r", "smith"], marks: [true, false] });
    expect(joinedName("siobhan o'brien")).toEqual({ words: ["siobhan", "o'brien"], marks: [false] });
    expect(joinedName("zoë ferrand")).toEqual({ words: ["zoë", "ferrand"], marks: [false] });
  });

  it("is not formed for a name with another character in a word, or with one word", () => {
    expect(joinedName("dana/whitfield smith")).toBeNull();
    expect(joinedName("o' brien")).toBeNull();
    expect(joinedName("gerard 't hooft")).toBeNull();
    expect(joinedName("mª josé garcía")).toBeNull();
    expect(joinedName("anne-marie")).toEqual({ words: ["anne", "marie"], marks: [true] });
    expect(joinedName("dana")).toBeNull();
  });

  it("marks a step from lower case to upper case, and from a cased letter to a digit, only", () => {
    expect(markWordSteps("DanaWhitfieldOffer2026.pdf")).toBe("Dana\u0001Whitfield\u0001Offer\u00012026.pdf");
    expect(markWordSteps("DANAWhitfield")).toBe("DANAWhitfield");
    expect(markWordSteps("ZoëFerrand νίκοςΠαπάς")).toBe("Zoë\u0001Ferrand νίκος\u0001Παπάς");
    // Scripts without the classes' letters are not stepped.
    expect(markWordSteps("աԱ")).toBe("աԱ");
  });

  it("leaves a hyphen unmarked: case never tells a slug of her name from another person's", () => {
    expect(markWordSteps("Dana-Whitfield dana-whitfield DANA--WHITFIELD")).toBe(
      "Dana-Whitfield dana-whitfield DANA--WHITFIELD",
    );
  });

  it("reads a link's %20 as a space, and drops a U+0001 the text held, so only a marked step is one", () => {
    expect(markWordSteps("Dana%20Whitfield%20offer.pdf")).toBe("Dana Whitfield offer.pdf");
    expect(markWordSteps("dana\u0001whitfield")).toBe("danawhitfield");
    expect(markWordSteps("\u0001DanaWhitfield")).toBe("Dana\u0001Whitfield");
  });

  it("folds compatibility forms, case and the curly apostrophe before any name is compared", () => {
    expect(foldName("Ｄａｎａ＿Ｗｈｉｔｆｉｅｌｄ")).toBe("dana_whitfield");
    expect(foldName("Whitﬁeld")).toBe("whitfield");
    expect(foldName("Dan O’Brien")).toBe("dan o'brien");
    expect(foldName("Zoë")).toBe("zoë");
  });

  it("folds every spelling of the shared table to the form Postgres and the graph fold it to", () => {
    expect(spellings.folds.map((f) => foldName(f.text))).toEqual(spellings.folds.map((f) => f.folded));
  });

  it("folds each letter Unicode assigned after 15.0 as Unicode does, whatever version this JavaScript knows", () => {
    const char = (notation: string) => String.fromCodePoint(Number.parseInt(notation.slice(2), 16));
    // The fold's steps without the list: what this engine's own Unicode does with a letter it knows.
    const byUnicode = (text: string) => text.normalize("NFKC").toLowerCase().normalize("NFC");
    const known = newerLetters.letters.filter((l) => !newerThan(l.since, process.versions.unicode ?? "0.0"));
    expect(known.filter((l) => byUnicode(char(l.letter)) !== char(l.folded)).map((l) => l.letter)).toEqual([]);
    expect(
      newerLetters.letters.filter((l) => foldName(char(l.letter)) !== char(l.folded)).map((l) => l.letter),
    ).toEqual([]);
    // Each is a letter the fold changes, assigned after the list's floor, within its range.
    expect(
      newerLetters.letters.filter(
        (l) =>
          l.letter === l.folded || !newerThan(l.since, newerLetters.floor) || newerThan(l.since, newerLetters.through),
      ),
    ).toEqual([]);
    // Every Node the repo supports (package.json engines, 20.19 on) knows Unicode 16.0, so the first check is never empty.
    expect(known.length).toBeGreaterThan(0);
  });

  it("folds the listed letters as Unicode 17.0 does on an engine that knows none of them", () => {
    // A fake for an engine at Unicode 15.0: its case mapping and normalization leave every
    // listed letter as it is. CI's Node knows Unicode 17.0, so without this the list's step
    // in foldName would make no difference there.
    const char = (notation: string) => String.fromCodePoint(Number.parseInt(notation.slice(2), 16));
    const listed = new RegExp(`([${[...newerLetters.letters.map((l) => char(l.letter))].join("")}])`, "u");
    const { toLowerCase, normalize } = String.prototype;
    const sparing = <A extends unknown[]>(native: (this: string, ...args: A) => string) =>
      function (this: string, ...args: A): string {
        return this.split(listed)
          .map((part, i) => (i % 2 === 1 ? part : native.apply(part, args)))
          .join("");
      };
    const lowering = vi.spyOn(String.prototype, "toLowerCase").mockImplementation(sparing(toLowerCase));
    const normalizing = vi.spyOn(String.prototype, "normalize").mockImplementation(sparing(normalize));
    try {
      expect(["\ua7ce".toLowerCase(), "\ua7f1".normalize("NFKC")]).toEqual(["\ua7ce", "\ua7f1"]);
      expect(
        newerLetters.letters.filter((l) => foldName(char(l.letter)) !== char(l.folded)).map((l) => l.letter),
      ).toEqual([]);
      expect(
        newerLetters.letters
          .filter(
            (l) =>
              "compatibility" in l && l.compatibility && compatibilityFolded(char(l.letter)) !== char(l.compatibility),
          )
          .map((l) => l.letter),
      ).toEqual([]);
      expect(foldName("\ua7ceARO \u1c89\u0410\u041d\u042f")).toBe("\ua7cfaro \u1c8a\u0430\u043d\u044f");
    } finally {
      lowering.mockRestore();
      normalizing.mockRestore();
    }
  });

  it("is the same fold when applied twice, for every character", () => {
    const changed = Array.from({ length: 0xffff }, (_, i) => String.fromCharCode(i + 1))
      .filter((char) => !/^[\ud800-\udfff]$/.test(char))
      .filter((char) => foldName(foldName(char)) !== foldName(char));
    expect(changed).toEqual([]);
  });
});
