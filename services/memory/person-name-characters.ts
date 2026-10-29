/**
 * The characters a person erasure reads a name by: what separates its words, what
 * continues it into a longer word, and when a hyphen joins it to another.
 *
 * The rule this file enforces: both of erasure's rules use this one definition. The
 * erasure matches names with regular expressions in Postgres (services/memory/person-erasure.ts);
 * after a backup restore, the suppression list matches them by digest in JavaScript
 * (services/memory/erasure-suppression.ts). Each class is written so both engines read
 * it alike: as a Postgres advanced regular expression under the "C" collation, and as a
 * JavaScript one with the `u` flag. services/memory/erasure-rule-agreement.realdb.test.ts
 * checks the classes code point by code point, and the hyphen rule case by case.
 */

import newerLetters from "./name-fold-newer-letters.json";

/** Whitespace between a name's words: ASCII whitespace, NBSP and the other Unicode spaces. */
export const NAME_SPACE = "[\\t\\n\\v\\f\\r \\u00a0\\u2000-\\u200a\\u202f\\u205f\\u3000]";

/**
 * {@link NAME_SPACE} within a line: no tab, line break, vertical tab or form feed, which part
 * two entries (two cells of a row, two lines of a list) rather than two words of one name.
 */
export const NAME_INLINE_SPACE = "[ \\u00a0\\u2000-\\u200a\\u202f\\u205f\\u3000]";

/**
 * A letter or digit that continues a name's word into a longer one, by code point, so the
 * answer is the same under every collation: a digit, or a letter (Latin, and every script
 * block past it, with the Latin-1 and general punctuation, symbols and spaces left out,
 * and combining accents in). An apostrophe does not: "Al Li's" names Al Li. Text is
 * lowercased before it is matched, so only lowercase ASCII is listed.
 */
export const NAME_LETTER =
  "[0-9a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u1fff\\u2070-\\u218f\\u2c00-\\u2dff\\u2e80-\\u2fff" +
  "\\u3040-\\ud7ff\\uf900-\\ufdff\\ufe70-\\ufefe\\uff10-\\uff19\\uff41-\\uff5a\\uff66-\\uffdc]";

/**
 * Words that, after a hyphen, make a name into a modifier ("the Dana Whitfield-approved
 * budget", "a Whitfield-led team") rather than a longer surname. The list is short on
 * purpose: a word on it can never end a hyphenated surname, so each is one no surname
 * plausibly is. memory-service/app/graph/name_patterns.py holds the same list for the graph.
 */
export const NAME_MODIFIER_WORDS = [
  "approved",
  "authored",
  "backed",
  "based",
  "built",
  "designed",
  "endorsed",
  "era",
  "funded",
  "led",
  "managed",
  "owned",
  "related",
  "reviewed",
  "run",
  "signed",
  "specific",
  "sponsored",
  "style",
  "written",
] as const;

/** A hyphen between words: ASCII, and the Unicode hyphen and non-breaking hyphen word processors insert. */
export const NAME_HYPHEN = "[-\\u2010\\u2011]";

/**
 * A dash that continues a word into the next when nothing parts them: the hyphens, the figure
 * and en dashes, the minus sign and the soft hyphen. Only {@link NAME_HYPHEN} joins a name's
 * own words; any of these joins a name to another word. The em dash and the horizontal bar are
 * punctuation, written without spaces ("Dana Whitfield\u2014she signed"), so they part words.
 * The en dash is read as a join, so "the Dana Whitfield\u2013Bo Wu agreement" is missed.
 */
export const NAME_DASH = "[-\\u00ad\\u2010-\\u2013\\u2212]";

/**
 * A dash run joining a name's word to another word: "-barnes", never "-approved" or a dash
 * with no word after it. Each of {@link NAME_DASH} joins alike, so "Whitfield\u2011Barnes"
 * and "Whitfield\u2013Barnes" are longer surnames too.
 */
const HYPHEN_JOIN = `${NAME_DASH}+(?!(?:${NAME_MODIFIER_WORDS.join("|")})(?!${NAME_LETTER}))`;

/**
 * A word of a name: letters and digits, and hyphen runs that join them to more
 * ("whitfield-barnes", "whitfield--barnes"). A hyphen at either end is not part of it, so
 * a bullet dash before a name ("-Dana Whitfield") or a modifier after it
 * ("Whitfield-approved") leaves the name its own words.
 */
export const NAME_WORD = `${NAME_LETTER}+(?:${HYPHEN_JOIN}${NAME_LETTER}+)*`;

/** Where a name may start: not inside a word, nor after a word and a hyphen that joins it on ("Mary-Dana"). */
export const NAME_START = `(?<!${NAME_LETTER})(?<!${NAME_LETTER}${NAME_DASH}+)`;

/** {@link NAME_LETTER} but the digits: a name written without spaces may start right after a digit. */
const NAME_LETTER_NOT_DIGIT = NAME_LETTER.replace("[0-9", "[");

/** Where a name may end: not inside a word, nor before a hyphen that joins it to another ("Whitfield-Barnes"). */
export const NAME_END = `(?!${NAME_LETTER})(?!${HYPHEN_JOIN}${NAME_LETTER})`;

const codePoint = (notation: string): string => String.fromCodePoint(Number.parseInt(notation.slice(2), 16));

/**
 * The letters Unicode assigned after version 15.0 that the fold changes, and what each folds to,
 * as two strings of one code point per letter, in the same order (services/memory/name-fold-newer-letters.json).
 * Engines fold by the Unicode version they ship, and production's Postgres lowercases with ICU at
 * 15.1 while Node may know 17.0, so every engine reads these letters from this list instead.
 */
export const NEWER_LETTERS = {
  letters: newerLetters.letters.map((l) => codePoint(l.letter)).join(""),
  folded: newerLetters.letters.map((l) => codePoint(l.folded)).join(""),
};

const NEWER_FOLD = new Map(newerLetters.letters.map((l) => [codePoint(l.letter), codePoint(l.folded)]));
const NEWER_LETTER = new RegExp(`[${NEWER_LETTERS.letters}]`, "gu");

/**
 * The letters of {@link NEWER_LETTERS} that have a compatibility form (NFKC), and that form, as
 * two strings in the same order: the outlined Latin letters and U+A7F1, each an ASCII letter
 * or digit in its own case.
 */
export const NEWER_COMPATIBILITY = (() => {
  const listed = newerLetters.letters.flatMap((l) =>
    "compatibility" in l && l.compatibility ? [{ letter: codePoint(l.letter), form: codePoint(l.compatibility) }] : [],
  );
  return { letters: listed.map((l) => l.letter).join(""), forms: listed.map((l) => l.form).join("") };
})();

const NEWER_COMPATIBLE = new Map(
  [...NEWER_COMPATIBILITY.letters].map((letter, i) => [letter, [...NEWER_COMPATIBILITY.forms][i]!]),
);
const NEWER_COMPATIBLE_LETTER = new RegExp(`[${NEWER_COMPATIBILITY.letters}]`, "gu");

/**
 * `text` with compatibility forms folded (NFKC), the letters of {@link NEWER_COMPATIBILITY}
 * included whatever Unicode version this engine knows. Case is kept, as markWordSteps needs it.
 */
export function compatibilityFolded(text: string): string {
  return text.replace(NEWER_COMPATIBLE_LETTER, (letter) => NEWER_COMPATIBLE.get(letter)!).normalize("NFKC");
}

/**
 * The letters {@link NEWER_LETTERS} names, as listed and as folded, for a character class that
 * must count them as letters: `\p{L}` counts only the letters of this engine's Unicode version.
 * The outlined digits are left out, and so is every ASCII fold, which `\p{L}` already reads.
 */
export const NEWER_LETTER_CHARACTERS = newerLetters.letters
  .filter((l) => !/^[0-9]$/.test(codePoint(l.folded)))
  .flatMap((l) => [codePoint(l.letter), ...(codePoint(l.folded) > "\u007f" ? [codePoint(l.folded)] : [])])
  .join("");

/**
 * Text as every name rule compares it, in this order:
 *  1. a letter Unicode assigned after 15.0 read as its fold ({@link NEWER_LETTERS}), so the
 *     result does not depend on which Unicode version the engine knows;
 *  2. compatibility forms folded (NFKC), so "ﬁ" is "fi", a fullwidth "Ｄａｎａ" is "Dana", and
 *     "I" followed by a combining dot above is "İ";
 *  3. lowercased by Unicode's own mapping, never a locale's;
 *  4. an "i" followed by a combining dot above read as "i", as the dot is the one "i" already
 *     has. Lowercasing turns the Turkish capital dotted "İ" into that pair, so it is "i"
 *     too ("DANA WHİTFİELD" is Dana Whitfield), where the dot would otherwise continue the word;
 *  5. composed (NFC), so an accent typed as a combining mark is the precomposed letter;
 *  6. the final sigma "ς" read as "σ", since lowercasing picks one or the other by where the
 *     letter stands ("ΝΊΚΟΣ" and "Νίκος" are one name);
 *  7. a curly apostrophe read as a straight one ("O’Brien" is "O'Brien").
 * Nothing else is folded: the dotless "ı" is not "i", "ß" is not "ss" and "Zoe" is not "Zoë",
 * as each may spell another person's name. Erasing "Zoë" reads "Zoe" as hers too, as a name
 * of its own ({@link asciiSpelling}); erasing "Zoe" never reads "Zoë".
 *
 * The erasure folds stored text the same way in Postgres (services/memory/person-erasure.ts,
 * foldedText) and, but for step 1, which Neo4j does as its Java version knows, the graph in
 * Cypher (memory-service/app/name_fold.py). services/memory/name-fold-spellings.json holds the spellings all three are tested on.
 */
export function foldName(text: string): string {
  return text
    .replace(NEWER_LETTER, (letter) => NEWER_FOLD.get(letter)!)
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("i\u0307", "i")
    .normalize("NFC")
    .replaceAll("\u03c2", "\u03c3")
    .replaceAll("\u2019", "'");
}

/**
 * The marks that join a name's words when it is written without spaces, as file names and
 * addresses write it: "dana_whitfield", "dana.whitfield", and a hyphen where her own name has one
 * ("anne-marie_dupont").
 */
export const NAME_JOINER = "[-\\u2010\\u2011_.]";

/**
 * A lowercase letter and an uppercase one, by code point, between which a name written in
 * camel case changes word ("DanaWhitfield"): ASCII, Latin-1, Greek and Cyrillic. A step
 * between letters of any other script is not read as one; nor is one between two capitals
 * ("DANAWhitfield"). A digit after either is a step too ("DanaWhitfield2026").
 * memory-service/app/graph/name_patterns.py holds the same two classes for the graph.
 */
export const CAMEL_LOWER = "[a-z\\u00df-\\u00f6\\u00f8-\\u00ff\\u03ac-\\u03ce\\u0430-\\u045f]";
export const CAMEL_UPPER =
  "[A-Z\\u00c0-\\u00d6\\u00d8-\\u00de\\u0386\\u0388-\\u038a\\u038c\\u038e\\u038f\\u0391-\\u03a1\\u03a3-\\u03ab\\u0400-\\u042f]";

/**
 * The character a camel-case step is marked with before text is lowercased, which would lose
 * it ("Dana@Whitfield", with @ for this mark). It is in no other class here, and
 * {@link markWordSteps} drops any the text already holds, so it reads only as a step it marked.
 */
export const CAMEL_STEP = "\u0001";

/**
 * Where to put {@link CAMEL_STEP}: after a lowercase letter that an uppercase one follows, or
 * a cased letter that a digit follows. Replace with `$1$2` and the mark.
 */
export const CAMEL_STEP_AT = `(${CAMEL_LOWER})(?=${CAMEL_UPPER})|(${CAMEL_LOWER}|${CAMEL_UPPER})(?=[0-9])`;

const CAMEL_STEP_AT_ALL = new RegExp(CAMEL_STEP_AT, "gu");

/**
 * `text` as the marked reading reads it, before it is folded: without any {@link CAMEL_STEP}
 * it held, each "%20" (a space in a link) a space, each "%27" and "%E2%80%99" (a straight and
 * a curly apostrophe in a link, the latter in either case) an apostrophe, and each camel-case step marked, so "DanaWhitfield%20offer" becomes "Dana", the
 * mark, "Whitfield offer". Postgres does the same in services/memory/person-erasure.ts,
 * markedFolded.
 */
export function markWordSteps(text: string): string {
  return text
    .replaceAll(CAMEL_STEP, "")
    .replaceAll("%20", " ")
    .replaceAll("%27", "'")
    .replaceAll("%E2%80%99", "'")
    .replaceAll("%e2%80%99", "'")
    .replace(CAMEL_STEP_AT_ALL, `$1$2${CAMEL_STEP}`);
}

/** One word of a name written without spaces: letters and digits, with an apostrophe inside ("o'brien"). */
const JOINED_PART = new RegExp(`^${NAME_LETTER}+(?:'${NAME_LETTER}+)*$`, "u");
const PART_BREAK = new RegExp(`((?:${NAME_SPACE}|${NAME_JOINER})+)`, "u");
const HAS_SPACE = new RegExp(NAME_SPACE, "u");

/**
 * A name as it is written without spaces: its words, and for each pair of neighbours whether
 * the name itself joins them by a mark (`marks[i]`, between `words[i]` and `words[i + 1]`), as
 * "anne-marie dupont" joins "anne" and "marie", rather than by whitespace.
 */
export interface JoinedName {
  words: string[];
  marks: boolean[];
  /**
   * A form of her name run together up to a hyphen of her own ({@link joinedNames}): its words
   * are joined by marks or camel-case steps only, never whitespace, as only a login, a handle or
   * a file name writes it so ("albert smith" in prose is Albert Smith, not Al Bert-Smith).
   */
  runTogether?: true;
}

/**
 * A folded name ({@link foldName}) split at its whitespace and at every joining mark, so
 * "anne-marie dupont" is "anne", "marie", "dupont", joined by a mark and then a space. Null
 * when a word holds any other character ("smith/jones", "'t"), or the name has fewer than two
 * words: such a name is matched only as written with spaces.
 */
export function joinedName(name: string): JoinedName | null {
  // Words and the runs between them, in turn: "anne", "-", "marie", " ", "dupont".
  const pieces = name.split(PART_BREAK);
  const words: string[] = [];
  const marks: boolean[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    if (pieces[i] === "") continue;
    if (words.length > 0) marks.push(!HAS_SPACE.test(pieces[i - 1]!));
    words.push(pieces[i]!);
  }
  return words.length >= 2 && words.every((word) => JOINED_PART.test(word)) ? { words, marks } : null;
}

/** `text` with every regular-expression metacharacter escaped, so it matches only itself. */
export function literal(text: string): string {
  return text.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

/**
 * A run of joining marks that is not hyphens alone: it holds a "_" or a ".". Only such a run,
 * whitespace or a camel-case step may stand where her own name has whitespace: hyphens alone
 * there spell another person's compound given name or double surname ("jean-pierre dupont" is
 * not Jean Pierre Dupont, "mary-ann_li_cv.pdf" is not Mary Ann Li's).
 */
const NOT_HYPHENS_ALONE = `(?=${NAME_JOINER}*[_.])${NAME_JOINER}+`;

/**
 * Her words joined as a name written without spaces may join them: where her own name has a
 * mark, by any joining marks or, when `spaces`, an inline space ("Anne Marie Dupont", never
 * "Anne", a tab, "Marie Dupont": two cells); where it has whitespace, by marks that are not
 * hyphens alone or, when `spaces`, any whitespace, as in the spaced rule; and in either place
 * by a camel-case step when `steps`.
 */
function joinedWords(
  { words, marks, runTogether }: JoinedName,
  options: { spaces: boolean; steps: boolean; inText: boolean },
): string {
  const { steps, inText } = options;
  const spaces = options.spaces && !runTogether;
  const step = steps ? `|${CAMEL_STEP}` : "";
  const joint = (mark: boolean) =>
    mark
      ? `(?:${NAME_JOINER}+${spaces ? `|${NAME_INLINE_SPACE}+` : ""}${step})`
      : `(?:${NOT_HYPHENS_ALONE}${spaces ? `|${NAME_SPACE}+` : ""}${step})`;
  const literals = words.map(literal);
  const joined = literals.map((word, i) => (i === 0 ? word : `${joint(marks[i - 1]!)}${word}`)).join("");
  // Run together, a camel-case step may stand between any two of its letters in marked text
  // ("RoryMcDonald2026" is "rory", a step, "mc", a step, "donald", a step, "2026").
  // In text, a run under the prose floor is read only beside an "@" (inTextRun).
  const runs = concatenatedNames({ words, marks }).map((run) => {
    const form = steps ? [...run].map(literal).join(`${CAMEL_STEP}?`) : literal(run);
    return inText ? inTextRun(run, form) : form;
  });
  return runs.length === 0 ? joined : `(?:${[joined, ...runs].join("|")})`;
}

/**
 * The fewest characters a name written with no separator at all must have to be read as hers:
 * "tomlee" (6) is Tom Lee in "tomlee@corp.example", "annli" (5) is never read as Ann Li. A run
 * shorter than {@link CONCATENATED_NAME_PROSE_MIN_LENGTH} is read only beside an "@"
 * ({@link SHORT_RUN_MARK}) or as a record's whole name.
 */
export const CONCATENATED_NAME_MIN_LENGTH = 6;

/**
 * The fewest characters a name run together must have to be read as hers anywhere
 * ("danawhitfield" in "Ask danawhitfield."). Shorter runs spell common words and code: 102 of
 * 200,000 real first-name and surname pairs run together into a 6- or 7-letter word ("kitchen"
 * for Kit Chen, "window" for Win Dow, "person" for Per Son). Read anywhere, erasing Win Dow
 * deleted 779 of 13,129 ordinary records; read beside "_", a digit or a ".", it still deleted
 * 113 of 14,657 records of third-party code ("window.location", "window_start").
 * memory-service/app/graph/name_patterns.py holds the same number for the graph.
 */
export const CONCATENATED_NAME_PROSE_MIN_LENGTH = 8;

/**
 * The one mark beside which a run under {@link CONCATENATED_NAME_PROSE_MIN_LENGTH} is read as
 * hers in text, on either side: "@kitchen" and "kitchen@x.com" are Kit Chen's handle and
 * address. Nothing else is, as prose and code write every other mark beside common words
 * ("in the kitchen.", "kitchen/counter", "window.location", "window_start", "person1"), so her
 * short name in a file name or a login is missed ("tomlee_cv.pdf", "2026tomlee", "/u/tomlee").
 * memory-service/app/graph/name_patterns.py holds the same mark for the graph.
 */
export const SHORT_RUN_MARK = "@";

/**
 * `form`, a regular expression for one run together, as text reads it: as itself when the run
 * is at least {@link CONCATENATED_NAME_PROSE_MIN_LENGTH} characters long, and otherwise only
 * with {@link SHORT_RUN_MARK} right before or after it.
 */
function inTextRun(run: string, form: string): string {
  return [...run].length >= CONCATENATED_NAME_PROSE_MIN_LENGTH
    ? form
    : `(?:(?<=${SHORT_RUN_MARK})${form}|${form}(?=${SHORT_RUN_MARK}))`;
}

/**
 * Her words run together with nothing between them, as a login, a handle or a file name writes
 * a name: as written ("danawhitfield", "siobhano'brien") and, when her words hold an
 * apostrophe, without it too ("siobhanobrien"), each only when at least
 * {@link CONCATENATED_NAME_MIN_LENGTH} characters long. The whole name only, never part of it
 * run together ("maryann_li" is not read as Mary Ann Li). A run of 8 or more characters erases
 * a word spelled the same as the person's whole name, whether another person's one-word name
 * ("Annmarie" for Ann Marie) or a common word ("willpower" for Will Power, "maryland" for Mary
 * Land): an over-erasure accepted, as missing the person asked about is worse. A shorter run is
 * read in text only beside an "@" ({@link SHORT_RUN_MARK}), so "Coffee is in the kitchen." and
 * "window.location" are kept when Kit Chen and Win Dow are erased, and "kitchen@x.com" is not.
 */
export function concatenatedNames({ words }: JoinedName): string[] {
  const run = words.join("");
  return [...new Set([run, run.replaceAll("'", "")])].filter(
    (form) => [...form].length >= CONCATENATED_NAME_MIN_LENGTH,
  );
}

const HYPHEN_RUN = new RegExp(`${NAME_HYPHEN}+`, "gu");
const SPACE_RUN = new RegExp(`${NAME_SPACE}+`, "gu");
const HAS_HYPHEN = new RegExp(NAME_HYPHEN, "u");

/**
 * A folded name as it is written without spaces ({@link joinedName}), and, when it has both
 * whitespace and a hyphen of its own, run together up to that hyphen too, each read as a name of
 * its own: her words run together where she has whitespace ("María López-García" as
 * "maríalópez" and "garcía", so "marialopez-garcia"; "Kim Ji-woo" as "kimji-woo"), and her
 * hyphenated words run together ("maría" and "lópezgarcía", so "maria_lopezgarcia"). A name
 * whose run is under {@link CONCATENATED_NAME_MIN_LENGTH}, or that holds a "_" or "." of its
 * own, has no such forms; nor does a name with two hyphens run together across one and up to
 * the other ("maryannlopez-garcia" for Mary-Ann Lopez-Garcia is missed). These forms are
 * {@link JoinedName.runTogether}: never read with whitespace between their words. They erase
 * another person written that way ("annemarie_dupont" for Anne-Marie Dupont, "albert.smith" for
 * Al Bert-Smith): an over-erasure accepted, as missing her is worse. Empty when
 * {@link joinedName} is null. memory-service/app/graph/name_patterns.py, _joined_parts_all, holds
 * the same rule for the graph.
 */
export function joinedNames(name: string): JoinedName[] {
  const joined = joinedName(name);
  if (!joined) return [];
  const runsUpToHyphen =
    HAS_HYPHEN.test(name) && HAS_SPACE.test(name) && !/[_.]/u.test(name) && concatenatedNames(joined).length > 0
      ? [joinedName(name.replace(SPACE_RUN, "")), joinedName(name.replace(HYPHEN_RUN, ""))]
      : [];
  return [joined, ...runsUpToHyphen.flatMap((form) => (form ? [{ ...form, runTogether: true as const }] : []))];
}

/** Letters with no decomposition that ASCII writes another way ("weiß" as "weiss", "yılmaz" as "yilmaz"), and the Unicode hyphens. */
const ASCII_LETTERS: Readonly<Record<string, string>> = {
  "\u2010": "-",
  "\u2011": "-",
  ħ: "h",
  ŧ: "t",
  ŋ: "ng",
  ß: "ss",
  ı: "i",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  æ: "ae",
  œ: "oe",
  þ: "th",
};
const ASCII_LETTER = new RegExp(`[${Object.keys(ASCII_LETTERS).join("")}]`, "gu");
const COMBINING_MARK = /\p{M}/gu;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

/**
 * A folded name ({@link foldName}) as a system that writes ASCII only spells it: accents left
 * off and the letters of {@link ASCII_LETTERS} spelled out, so "zoë ferrand" is "zoe ferrand",
 * "hans weiß" is "hans weiss" and "ayşe yılmaz" is "ayse yilmaz", and a Unicode hyphen as "-".
 * Null when that changes nothing, or leaves a letter outside ASCII ("νίκος παπάς", or a letter
 * with no decomposition missing from {@link ASCII_LETTERS}). The erasure reads this spelling as her name
 * too, in every form, so it erases another person whose name is spelled without the accent
 * ("Zoe Ferrand"): an over-erasure accepted, as logins and file names are mostly ASCII and
 * missing her there is worse. memory-service/app/graph/name_patterns.py, _ascii_spelling, holds the
 * same rule for the graph.
 */
export function asciiSpelling(name: string): string | null {
  const ascii = name
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .replace(ASCII_LETTER, (letter) => ASCII_LETTERS[letter]!);
  return ascii !== name && PRINTABLE_ASCII.test(ascii) ? ascii : null;
}

/**
 * The regular expression that finds a name written without spaces, with no letter on either
 * side. It is read twice, so a word of hers that holds a capital ("McDonald") is found either
 * way:
 *  - `marked`, in text folded after {@link markWordSteps}: her words joined by `_`, `.`,
 *    whitespace or camel-case steps, so "Dana_Whitfield_offer.pdf", "DanaWhitfield offer.pdf"
 *    and "Dana Whitfield2.pdf" name Dana Whitfield;
 *  - plain, in folded text without any U+0001: her words joined by marks only
 *    ("Rory.McDonald.pdf").
 * "Danaher" and "Dana/Whitfield" are not her. Three rules keep other people out, each at the
 * cost of missing her written the same way, as erasing a bystander is worse than missing her:
 *  - It may end at a camel-case step but never start at one: "JoAnnLi" is not Ann Li. In marked
 *    text it may start right after a digit: "2026danawhitfield" and "v2DanaWhitfield" are hers.
 *  - A dash on either side continues a word, as for a name written with spaces:
 *    "Dana_Whitfield-Barnes" and "anne-marie_laval" for Marie Laval are other people.
 *    A modifier word after the dash ("-approved") does not continue it.
 *  - Hyphens alone never stand where her own name has whitespace: "dana-whitfield.pdf",
 *    "jean-pierre dupont" and "(Dana-Whitfield, 2019)" are spelled as other people's double
 *    surnames and compound given names are, so they are missed. Her own name's hyphens stand
 *    for any mark ("anne_marie_dupont.pdf" and "anne-marie_dupont.pdf" for Anne-Marie Dupont).
 * Her whole name run together with nothing between its words ("danawhitfield") is the one
 * spelling read the other way, as hers even though a one-word name may be spelled the same
 * ({@link concatenatedNames}), within the same edges, and, when shorter than
 * {@link CONCATENATED_NAME_PROSE_MIN_LENGTH}, only beside an "@".
 * Postgres and JavaScript read it alike, as the classes above.
 */
export function joinedNamePattern(name: JoinedName, { marked }: { marked: boolean }): string {
  const end = `(?!${NAME_LETTER})(?!${HYPHEN_JOIN}${NAME_LETTER})`;
  const start = marked ? `(?<!${NAME_LETTER_NOT_DIGIT})(?<!${NAME_LETTER}${NAME_DASH}+)(?<!${CAMEL_STEP})` : NAME_START;
  return `${start}${joinedWords(name, { spaces: marked, steps: marked, inText: true })}${end}`;
}

/**
 * The regular expression that matches a record's whole name (the entity a chunk is filed
 * under) as a name written without spaces, her words joined as in text
 * ({@link joinedNamePattern}) and nothing else: "dana_whitfield", "DanaWhitfield". Given name
 * first only. A login "dana-whitfield" is missed, as another person's double surname is
 * written the same way.
 */
export function joinedRecordNamePattern(name: JoinedName, { marked }: { marked: boolean }): string {
  return `^${NAME_SPACE}*(${joinedWords(name, { spaces: false, steps: marked, inText: false })})${NAME_SPACE}*$`;
}
