// The specific values a question names, and the one rule for whether a text holds one.
//
// A reader that asks "did the number end in 0174?" or "was it Cedar Bridge?" names a value
// it may be guessing. memory_query tells such a reader, in a fixed sentence that never
// repeats the value, when no memory it can read holds one (services/memory/readable-values.ts).
// This file decides which parts of a question count as specific values, and when a
// stored text holds one. Both are deterministic: no model takes part.
//
// The one rule this file enforces: matching is lenient, extraction is strict. A value
// that a record might hold under another spelling counts as held, and a part of the
// question that might not be a value is left out. Either way the error is to stay quiet,
// never to tell a reader that memory lacks something it holds.
//
// Both sides are normalized the same way before anything is compared: default-ignorable
// characters (soft hyphen, zero-width space and joiners, bidi controls, variation
// selectors) are removed, and the text is put in Unicode NFKC form, so fullwidth digits,
// ligatures, a titlecase digraph ("ǅ" is "Dž") and a decomposed accent compare as their
// plain forms. `normalizeForMatch` is the JavaScript side; readable-values.ts applies the
// same steps in Postgres (`normalize(..., NFKC)` and the same character class).
//
// What counts as a specific value, in the order the question names them:
//  - a number: digit groups joined by one to three of ( ) . / - or whitespace, holding at
//    least three digits ("415-555-0174", "(415) 555 0174", "0174", "415"). A gap with
//    whitespace joins only groups of three digits or more ("bed 312 2 days" is 312), but
//    for a shorter last group after two such groups ("617 555 01" is 61755501), and a
//    comma joins only a thousands group ("1,500,000"; "0174, 0186" stays two numbers).
//    Digits of any script the JavaScript runtime knows count, by their value;
//  - quoted text: what sits between double quotes, straight or curly, or curly single
//    quotes, 2 to 200 characters ("ask for House Manager Rosa after 6 PM"). A quote mark
//    right after a letter or digit opens nothing, nor does one right before one close
//    anything: `55" or 65"` is inches, not quoted text;
//  - a name: two to five capitalized words in a row, with nothing but one space between
//    them ("Cedar Bridge Recovery House", "Maya Bennett"). A sentence's first word is
//    dropped from a run it starts, since a capital there says nothing ("Was Cedar
//    Bridge" is "Cedar Bridge"); a possessive, punctuation or a capitalized function word
//    ("See", "On", "The") ends a run; a longer run is title case, not a name. A leading
//    title ("Dr", "Mr", "Ms", "Prof") and a trailing "Jr", "Sr", "PhD" or "Esq" are left
//    out of the name, which must keep two words.
// At most MAX_SPECIFIC_VALUES are kept, the first ones named; a repeat is kept once.
//
// When a normalized text holds a value. A separator here is whitespace (the Unicode
// spaces and next line included), a dash of any kind, or one of , . ; : / _ ! ? ( ) · the
// quote marks and apostrophes ' ’ ʼ ´ ` " “ ” ‘, and the Markdown marks * # ~ | < > [ ].
//  - A number, when its digits appear in order, each in any script, with at most five of
//    whitespace, dashes, , : ( ) . / _ * · and the thousands marks ' ’ ٬ ٫ between
//    neighbours. Part of a number is held by a longer one when it is whole groups of it:
//    "0174", "415" and "555" are all held by "415-555-0174". A run of digits is never cut,
//    since digits do not inflect as words do: no digit may stand right before the first
//    digit matched or right after the last, so "617-555-01" is not held by "617-555-0104",
//    "4471" not by "MRN-44712" or "94471". A part that cuts a run of digits names a
//    different number, and that number must not answer for it. Its end is the one cut a
//    person makes: four digits or more may end a run of seven or more, as a phone's,
//    card's or ID's last digits do ("0174" is held by "+14155550174"). Only a whole number
//    has last digits, ended by a digit run that is no part of a decimal: "1.255" is not held
//    by "9991.255", nor "0104" by "1230104.50" or "1.2340104". The rule
//    sees digits only: a mark between two digits ends a run, so "2,750" is still held by
//    "2,750,000" and "555" by "415.555.0174", where a mark may be a phone's separator.
//    A decimal part's trailing zeros and a whole part of zeros are not asked for ("1,500.00"
//    is held by "1,500", "1.250" by "1.25", "0.08" by ".08"), so what stands in their place
//    is not checked ("1,500.75" holds "1,500.00", "3.25" holds "0.25"); a decimal part may
//    go on with zeros ("1.25" by "1.250"). Up to three leading digits of a number of eight
//    digits or more are not asked for, for a country code or trunk zero the text may leave
//    out or write ("1-415-555-0174" is held by "(415) 555-0174", "415-555-0174" by
//    "14155550174"), so other digits there are not checked either ("212-555-0174" holds
//    "415-555-0174"); the last seven always must match. A round amount (ending in three zeros or
//    more) is also held written with a scale as a word of its own (k, thousand, M, mm, mn,
//    mio, mil, million, B, bn, billion, T, tn or trillion, plurals too, then no letter or
//    digit), leaving at most three decimals ("1,500,000" by "$1.5M",
//    "1.5 million" and "1,500K"). A number whose groups the question joins with a slash or
//    dash (a date, range, ratio or dose) is also held when each group appears anywhere, in
//    any order ("100-200" by "between 100 and 200", "120/80" by "120 over 80"); in one that
//    reads as a date, a part with or without its leading zero, and a month by its English
//    name, full or short ("10/15/2026" by "2026-10-15", "Oct 15, 2026" and "15 October
//    2026"), and a year written short by the year in full ("10/15/26" by "2026-10-15").
//    Each group cuts no run of digits either, and an amount with a scale is not the
//    decimal or thousands part of a larger one ("1,500,000" is not held by "$21.5M" nor
//    "2,000,000" by "$1.2M").
//  - Quoted text, when its words appear in order, anywhere in the text, with any run of
//    separators between them, or none, and between any two characters of a word too
//    ("Harbor House" is held by "harbor, HOUSE", "HarborHouse" and "Harbor Housekeeping";
//    "AB1234" by "AB-1234"). "and" and "&" stand for each other. Quoted text that starts or
//    ends with a digit cuts no run of digits there ("AB-1234" is not held by "AB-12345", nor
//    "jlee42" by "jlee421@example.com"); a word that ends in a letter may still go on, as a
//    plural or a longer word does.
//  - A name, when any two of its words appear in order, each spelled as quoted text's
//    words are: the earlier word, or its initial standing alone, with or without a
//    period, then up to four other words, then the later word; or the later word, any
//    separators, and the earlier word or its initial ("Maya Bennett" is held by "Maya J.
//    Bennett", "Maya and Tom Bennett", "M Bennett", "Bennett, M." and "Bennett (Maya)";
//    "Nurse Maya Bennett Monday" by "Maya Bennett called"; not by "Tom Bennett").
//  A letter matches any letter with the same base letter, in either case, with or without
//  accents or a stroke ("José" and "Jose", "İstanbul" and "ISTANBUL", "ς" and "Σ", "Søren"
//  and "Soren"), in a longer case form ("ß" matches "SS"), and as the two letters it is
//  often written as, both ways ("ü" and "ue", "ß" and "ss", "æ" and "ae", "þ" and "th").
//  Every other character matches as itself.
// The rule is one regular expression per value, which Postgres and JavaScript read the
// same way, so the database check and a check of served text cannot disagree.
//
// Where it stops, so the note can still fire on a text a person would say holds the value:
// a surname, first name or initial alone ("Ms. Bennett" or "Maya B." for "Maya Bennett");
// part of a run of digits written with no separator other than its last four or more of
// seven or more ("0174" of "0174999", "4471" of "004471", "10/15/2026" of "20261015"), or next to a digit the text's normalizing makes
// ("0174" of "0174¹", where NFKC turns the superscript into "1") or that encoding adds
// ("4471" of "MRN%204471"); a range whose second group is written short ("2020-25");
// more than four words between two words of a name; quoted text with other words inside
// it; a number in words ("five five five"); an amount with a scale this rule does not know
// ("15 lakh", "1.5 crore") or more than three decimals before it; a month in another
// language; a date the question writes with dots ("15.10.2026"), held only as written; an
// HTML entity between words ("Harbor&nbsp;House");
// a letter outside the Basic Multilingual Plane, matched only in its own case forms; and
// characters newer than the Unicode version both engines share (Postgres 17 has 15.1).

/** What kind of value a question names. */
export type SpecificValueKind = "number" | "quoted" | "name";

/** One specific value a question names. Its text never leaves the server. */
export interface SpecificValue {
  kind: SpecificValueKind;
  /** The value as compared: a number's digits, or the words of quoted text and names. */
  key: string;
  /**
   * A regular expression that matches a normalized text ({@link normalizeForMatch})
   * holding the value, written so that Postgres (`~`, an ARE) and JavaScript (with the `u`
   * flag) read it the same way: literal characters, character classes of literal
   * characters and ranges, non-capturing groups, bounded repeats and escaped syntax only.
   */
  pattern: string;
  /**
   * A cheaper pattern that every text `pattern` matches also matches, written the same
   * way: a database scan tries it first, and `pattern` only on the texts it matches.
   */
  screen: string;
}

/** The most values one question is checked for; the rest are not checked. */
export const MAX_SPECIFIC_VALUES = 8;
/** Fewer digits than this is not a specific number ("12", "4B"). */
const MIN_NUMBER_DIGITS = 3;
/** More digits than this is not a value a reader guesses at; it is left out. */
const MAX_NUMBER_DIGITS = 40;
/** The most characters of a question searched for values. */
const MAX_QUESTION_CHARACTERS = 4_000;

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const classOf = (ranges: readonly (readonly [number, number])[]): string =>
  `[${ranges.map(([from, to]) => (from === to ? char(from) : `${char(from)}-${char(to)}`)).join("")}]`;

/**
 * Unicode's default-ignorable code points (Default_Ignorable_Code_Point, Unicode 16):
 * soft hyphen, combining grapheme joiner, the zero-width space, joiners and marks, bidi
 * controls, invisible operators, Hangul fillers, variation selectors, the byte-order mark
 * and the tag characters. A text that holds one between two characters holds the two
 * characters side by side.
 */
const IGNORABLE_RANGES = [
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
] as const;
/** A class of the default-ignorable characters, read the same by Postgres and JavaScript. */
export const IGNORABLE_CLASS = classOf(IGNORABLE_RANGES);
const IGNORABLE = new RegExp(IGNORABLE_CLASS, "gu");
const NON_ASCII = /[^\u0001-\u007f]/u;

/**
 * `text` as the rule compares it: default-ignorable characters removed, in NFKC form, and
 * any default-ignorable character the NFKC step produced removed too. Postgres applies the
 * same steps (readable-values.ts, `matchTextSql`). An ASCII text is returned as it is.
 */
export function normalizeForMatch(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  return text.toWellFormed().replace(IGNORABLE, "").normalize("NFKC").replace(IGNORABLE, "");
}

/** Hangul jamo, which compose with the jamo or syllable before them. */
const HANGUL_JAMO = /[\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff]/u;
let unsettledClass: string | undefined;
/**
 * A class of every character that can change what a value's pattern matches once the text
 * is normalized ({@link normalizeForMatch}): any character outside ASCII except those of
 * the Basic Multilingual Plane that NFKC leaves as they are wherever they stand (not a
 * mark, which may compose or reorder, not a Hangul jamo, not default-ignorable), and the
 * spaces and dashes NFKC turns into another space or dash, since every pattern matches
 * all of those alike. A text with none of them matches as its normalized form does, so
 * Postgres runs its normalize(), which is slow, only on a text that has one. Built on first use.
 */
export function unsettledCharacterClass(): string {
  if (unsettledClass === undefined) {
    const mark = /\p{M}/u;
    const ignorable = new RegExp(IGNORABLE_CLASS, "u");
    const alike = (text: string, set: string) => [...text].length === 1 && set.includes(text);
    const sameSeparator = (c: string) =>
      (alike(c, WHITESPACE) && alike(c.normalize("NFKC"), WHITESPACE)) ||
      (alike(c, DASHES) && alike(c.normalize("NFKC"), DASHES));
    const settled: [number, number][] = [[0x01, 0x7f]];
    for (let codePoint = 0x80; codePoint <= 0xffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const c = char(codePoint);
      const keeps = c.normalize("NFKC") === c || sameSeparator(c);
      if (!keeps || mark.test(c) || ignorable.test(c) || HANGUL_JAMO.test(c)) continue;
      const last = settled.at(-1)!;
      if (last[1] === codePoint - 1) last[1] = codePoint;
      else settled.push([codePoint, codePoint]);
    }
    unsettledClass = classOf(settled).replace("[", "[^");
  }
  return unsettledClass;
}

/**
 * The decimal digits this runtime knows (Unicode Nd), built on first use: each script's ten
 * digits are consecutive code points, zero first, so a digit's value is its distance from its
 * script's zero. Read from the runtime, so a newer Unicode's digit scripts are known with no
 * change here. Every digit script is below U+20000.
 */
interface Digits {
  zeros: number[];
  /** For each value 0 to 9, a class of that digit in every script. */
  ofValue: string[];
  /** A class of every digit, in every script. */
  any: string;
  /** A run of digits in a question, in any script. */
  group: RegExp;
}
let knownDigits: Digits | undefined;
function digits(): Digits {
  if (knownDigits === undefined) {
    const decimal = /\p{Nd}/u;
    const zeros: number[] = [];
    for (let codePoint = 0x30, run = 0; codePoint < 0x20000; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      run = decimal.test(char(codePoint)) ? run + 1 : 0;
      if (run % 10 === 1) zeros.push(codePoint);
    }
    const any = classOf(zeros.map((zero) => [zero, zero + 9] as const));
    knownDigits = {
      zeros,
      ofValue: Array.from({ length: 10 }, (_, value) => `[${zeros.map((zero) => char(zero + value)).join("")}]`),
      any,
      group: new RegExp(`${any}+`, "gu"),
    };
  }
  return knownDigits;
}

/** The value of a digit of any script, or undefined for any other character. */
function digitValue(c: string): number | undefined {
  const codePoint = c.codePointAt(0)!;
  const zero = digits().zeros.find((z) => codePoint >= z && codePoint <= z + 9);
  return zero === undefined ? undefined : codePoint - zero;
}

/** What may join two digit groups of one number in a question. */
const JOIN_IN_QUESTION = /^[\s()./-]{1,3}$/;
/** A thousands separator: a comma followed by exactly three digits ("1,500,000"). */
const THOUSANDS = /^,$/;
/**
 * Quoted text: straight or curly double quotes, or curly single quotes. A quote mark right
 * after a letter or digit, or a closing one right before one, is a mark of another kind
 * (inches in `65"`, feet and inches in `6'2"`), not a quote.
 */
const QUOTED_IN_QUESTION = /(?<![\p{L}\p{N}])["“”]([^"“”]{2,200})["“”](?![\p{L}\p{N}])|‘([^‘’]{2,200})’/gu;
/** A capitalized word, as a name holds one ("O’Neil", "Smith-Jones"). */
const NAME_WORD = /^\p{Lu}[\p{L}\p{M}'’-]*$/u;
/** Punctuation that may lead a word without ending a name run. */
const LEADING_MARKS = /^[("“‘]+/u;
/** Punctuation that ends a word and the name run it is in. */
const TRAILING_MARKS = /[)"”’',.;:!?]+$/u;
/** A possessive ending: "Levin's" is a word that ends its run. */
const POSSESSIVE = /['’]s$/u;
/** At most this many capitalized words in a row are a name; a longer run is title case. */
const MAX_NAME_WORDS = 5;
/** Capitalized words that end a name run: "Did Elena See Maya Bennett On Tuesday" names Maya Bennett. */
const NOT_NAME_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "see",
  "so",
  "the",
  "their",
  "then",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "yes",
  "you",
  "your",
]);
/** Abbreviations whose period does not end a sentence. */
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "st", "jr", "sr", "prof"]);
/** Titles a question may put before a name that a stored text need not: "Dr Maya Bennett" names Maya Bennett. */
const LEADING_TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "miss", "prof", "sir", "dame", "rev", "fr"]);
/** Words a question may put after a name that a stored text need not: "Maya Bennett Jr" names Maya Bennett. */
const TRAILING_SUFFIXES = new Set(["jr", "sr", "phd", "esq"]);
/** Characters with a meaning in a regular expression, in Postgres and in JavaScript alike. */
const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|]/g;
/** Characters with a meaning inside a character class. */
const CLASS_SYNTAX = /[\\^\]\[-]/g;

/**
 * The whitespace a stored text may have between two words, and between two digits of a
 * number: space, tab, newline, carriage return, form feed, vertical tab, next line and the
 * Unicode spaces. Written as the characters themselves, so both engines read the class the same way.
 */
const WHITESPACE =
  " \t\n\r\f\v\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
/** Dashes a stored text may write in place of a hyphen: hyphen, non-breaking hyphen, figure dash, en and em dash, minus. */
const DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212-";
/**
 * Separators a stored number may have between two digits: whitespace, dashes and , : ( ) . / _ ·,
 * the thousands separators ' ’ and the Arabic ٬ and decimal ٫, and Markdown's *.
 */
const NUMBER_GAP = `[${WHITESPACE},:()./_*\u00b7'\u2019\u066b\u066c${DASHES}]{0,5}`;
/**
 * What may separate or join the words of quoted text or a name, in a question and in a stored
 * text: whitespace, dashes, punctuation, quote marks and apostrophes of every kind (the
 * acute accent ´ among them, which NFKC makes a space and a combining acute), and the marks
 * Markdown puts around words.
 */
const SEPARATOR_CHARACTERS = `${WHITESPACE},.;:/_'\u2019\u02bc\u00b4\u0301\`"\u201c\u201d\u2018()!?*#~|<>[]\u00b7`;
/** A class of the separators. The dashes come last, so a dash is no range. */
const SEPARATOR_CLASS = `[${SEPARATOR_CHARACTERS.replace(CLASS_SYNTAX, "\\$&")}${DASHES}]`;
const NOT_SEPARATOR_CLASS = SEPARATOR_CLASS.replace("[", "[^");
/** Any run of separators, or none. */
const SEPARATORS = `${SEPARATOR_CLASS}*`;
const SPLIT_ON_SEPARATORS = new RegExp(`${SEPARATOR_CLASS}+`, "u");
/** At most this many other words may sit between two words of a name: middle names, initials, "and Tom". */
const MAX_WORDS_BETWEEN = 4;

const escapeRegex = (text: string): string => text.replace(REGEX_SYNTAX, "\\$&");
const escapeInClass = (text: string): string => text.replace(CLASS_SYNTAX, "\\$&");
const MARKS = /\p{M}/gu;
/** Any character a normalized text can hold: the zero-width space is removed by normalizing. */
const ANY = "[^\u200b]";
/** Letters NFKD leaves whole that read as a plain letter with a stroke or bar ("ø" is "o", "ł" is "l"). */
const STROKED: Readonly<Record<string, string>> = {
  "\u00f8": "o",
  "\u0142": "l",
  "\u0111": "d",
  "\u0127": "h",
  "\u0167": "t",
  "\u0268": "i",
  "\u0180": "b",
  "\u01b6": "z",
};
/** Letters commonly written as two ("ü" as "ue", "ß" as "ss", "þ" as "th"), and those two letters back. */
const TRANSLITERATED: Readonly<Record<string, string>> = {
  "\u00e4": "ae",
  "\u00e6": "ae",
  "\u00f6": "oe",
  "\u0153": "oe",
  "\u00fc": "ue",
  "\u00df": "ss",
  "\u1e9e": "ss",
  "\u00fe": "th",
};
const TWO_LETTERS_AS_ONE = new Map<string, string>();
for (const [letter, pair] of Object.entries(TRANSLITERATED)) {
  const upper = letter.toUpperCase();
  TWO_LETTERS_AS_ONE.set(pair, `${TWO_LETTERS_AS_ONE.get(pair) ?? ""}${letter}${[...upper].length === 1 ? upper : ""}`);
}

/** The forms of `c` in either case, in NFKC form, `c` itself first. */
function caseForms(c: string): string[] {
  const lower = c.toLowerCase();
  const upper = c.toUpperCase();
  return [
    ...new Set([c, lower, upper, upper.toLowerCase(), lower.toUpperCase()].map((form) => form.normalize("NFKC"))),
  ];
}

/**
 * A letter's base letter, without accents, in lower case: "É" and "e" are "e", "ı" and "İ"
 * are "i", "ς" is "σ", "ẞ" is "ß", "Ø" is "o".
 */
function foldKey(c: string): string {
  const base = c.normalize("NFKD").replace(MARKS, "");
  const upper = base.toUpperCase();
  const key = ([...upper].length === 1 ? upper : base).toLowerCase();
  return STROKED[key] ?? key;
}

let foldClasses: Map<string, string> | undefined;
/**
 * For each base letter that more than one letter of the Basic Multilingual Plane folds to
 * ({@link foldKey}), those letters: "e" is "eEèéêëēĕėęěȅȇȩḕ…" and their capitals. Built on first use.
 */
function lettersFoldingTo(key: string): string | undefined {
  if (foldClasses === undefined) {
    const letter = /\p{L}/u;
    const members = new Map<string, string[]>();
    for (let codePoint = 0x41; codePoint <= 0xffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const c = char(codePoint);
      if (!letter.test(c)) continue;
      const folded = foldKey(c);
      if ([...folded].length !== 1) continue;
      const list = members.get(folded);
      if (list) list.push(c);
      else members.set(folded, [c]);
    }
    foldClasses = new Map(
      [...members].filter(([, list]) => list.length > 1).map(([folded, list]) => [folded, list.join("")]),
    );
  }
  return foldClasses.get(key);
}

/** A letter as any letter with the same base letter, in either case, accented or not; any other character as itself. */
function letterClass(c: string): string {
  const folded = foldKey(c);
  const members = [...folded].length === 1 ? lettersFoldingTo(folded) : undefined;
  if (members !== undefined && members.includes(c)) return `[${escapeInClass(members)}]`;
  const forms = caseForms(c).filter((form) => [...form].length === 1);
  return forms.length <= 1 ? escapeRegex(c) : `[${forms.map(escapeInClass).join("")}]`;
}

/**
 * One character of a value: a digit in any script, a letter as {@link letterClass} matches
 * it and in a longer form too (its case form "SS" for "ß", the two letters "ue" for "ü"),
 * and anything else as itself.
 */
function characterPattern(c: string): string {
  const digit = digitValue(c);
  if (digit !== undefined) return digits().ofValue[digit]!;
  const transliterated = TRANSLITERATED[c.toLowerCase()];
  const longer = [...caseForms(c).filter((form) => [...form].length > 1), ...(transliterated ? [transliterated] : [])];
  if (longer.length === 0) return letterClass(c);
  return `(?:${[letterClass(c), ...new Set(longer.map((form) => [...form].map(letterClass).join(SEPARATORS)))].join("|")})`;
}

/**
 * One word of quoted text or a name. Separators may sit between any two of its characters
 * ("AB1234" is held by "AB-1234", "Maryann" by "Mary-Ann"), and its digits may be spaced as
 * a number's are.
 */
function wordPattern(word: string): string {
  const characters = [...word];
  const isDigit = (i: number) => digitValue(characters[i]!) !== undefined;
  let pattern = "";
  for (let i = 0; i < characters.length; i++) {
    if (i > 0) pattern += isDigit(i) && isDigit(i - 1) ? NUMBER_GAP : SEPARATORS;
    // Two letters a text may write as one ("ss" as "ß", "ae" as "æ").
    const asOne =
      i + 1 < characters.length
        ? TWO_LETTERS_AS_ONE.get(`${characters[i]}${characters[i + 1]}`.toLowerCase())
        : undefined;
    if (asOne === undefined) {
      pattern += characterPattern(characters[i]!);
      continue;
    }
    pattern += `(?:${characterPattern(characters[i]!)}${SEPARATORS}${characterPattern(characters[i + 1]!)}|[${escapeInClass(asOne)}])`;
    i++;
  }
  return pattern;
}

/** The words of quoted text or a name, split on separators. */
const wordsOf = (text: string): string[] => text.split(SPLIT_ON_SEPARATORS).filter(Boolean);

/** A number's digits as a pattern with no separator inside it: one unbroken run. */
const unbrokenDigits = (value: string): string => [...value].map((d) => digits().ofValue[Number(d)]!).join("");
/** A number's digits as a pattern, a number's separators allowed between them. */
const digitsPattern = (value: string): string => [...value].map((d) => digits().ofValue[Number(d)]!).join(NUMBER_GAP);
/** No digit right before here: a match starts no later than its run of digits does. */
const noDigitBefore = (): string => `(?<!${digits().any})`;
/** No digit right after here: a match ends no earlier than its run of digits does. */
const noDigitAfter = (): string => `(?!${digits().any})`;
/** The fewest digits a number's last digits may be, to end a longer run ("0104" of "6175550104"). */
const MIN_TRAILING_DIGITS = 4;
/** A decimal mark, or the thousands mark a decimal may carry: a mark that follows a digit and precedes one. */
const DECIMAL_MARK = "[.,\u066b]";
/**
 * The start of a run of digits that is neither a decimal's fraction nor, with its mark, part
 * of one: the text's start, or a character that is no digit and no decimal mark, or a decimal
 * mark that no digit stands before ("1.2340104" is a fraction, "see .2340104" is not). Consumed,
 * not looked behind: lookbehinds make the Postgres scan slower.
 */
const runStart = (): string => {
  const notDigit = digits().any.replace("[", "[^");
  return `(?:^|${notDigit.replace("]", `.,\u066b]`)}|(?:^|${notDigit})${DECIMAL_MARK})`;
};
/** No decimal part right after here: "0104" ending "1230104.50" is the whole part of an amount, not a run's last digits. */
const noDecimalPartAfter = (): string => `(?!${DECIMAL_MARK}${digits().any})`;
/** No digit and decimal or thousands mark right before here: "2" in "1.2M" is part of a larger amount. */
const noAmountPartBefore = (): string => `(?<!${digits().any}[.,\u066b\u066c'\u2019])`;
/** `pattern` as a whole run of digits: never a cut through a longer one ("01" is not in "0104"). */
const wholeDigits = (pattern: string): string => `${noDigitBefore()}${pattern}${noDigitAfter()}`;

/** Month names a text may write a date's month as, by month: English, in full and short. */
const MONTH_NAMES = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sept", "sep"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
] as const;

/** Words and letters a text may write an amount's scale with, by its power of ten. */
const SCALE_WORDS: readonly [number, readonly string[]][] = [
  [3, ["thousands", "thousand", "k"]],
  [6, ["millions", "million", "mil", "mio", "mn", "mm", "m"]],
  [9, ["billions", "billion", "bn", "b"]],
  [12, ["trillions", "trillion", "tn", "t"]],
];

/** Letters in either case and with any accent, as {@link letterClass} matches them. */
const lettersPattern = (word: string): string => [...word].map(letterClass).join("");

/**
 * One group of a number a question joins with a slash or dash, as a text may write it on its
 * own. In a date (`dateLike`), a one- or two-digit part is also held without its leading zero,
 * and a part that could be a month (1 to 12) by the month's name.
 */
function groupPattern(group: string, dateLike: boolean, shortYear = false): string {
  // A year written short ("26") is held by the year in full ("2026").
  if (shortYear)
    return wholeDigits(`(?:${digits().any}${NUMBER_GAP}${digits().any}${NUMBER_GAP})?${digitsPattern(group)}`);
  if (!dateLike || group.length > 2) return wholeDigits(digitsPattern(group));
  const month = Number(group);
  const plain = wholeDigits(`${digits().ofValue[0]}?${digitsPattern(String(month))}`);
  return month >= 1 && month <= 12 ? `(?:${plain}|${MONTH_NAMES[month - 1]!.map(lettersPattern).join("|")})` : plain;
}

/**
 * Whether groups read as a date: two or three groups, every one but a year of one or two
 * digits, a year of two or four, and one that could be a month ("10/15", "10/15/2026",
 * "2026-10-15", "15.10.26").
 */
function isDateLike(groups: readonly string[]): boolean {
  if (groups.length < 2 || groups.length > 3) return false;
  const short = groups.filter((g) => g.length <= 2);
  const year = groups.filter((g) => g.length === 4);
  return (
    short.length + year.length === groups.length &&
    year.length <= 1 &&
    short.some((g) => Number(g) >= 1 && Number(g) <= 12)
  );
}

/**
 * The amount `digits` stands for, written with a scale: "1.5M", "1.5 million", "1,500K" for
 * 1500000. Only for a round amount, one ending in three zeros or more, and only a scale that
 * leaves at most three decimal digits.
 */
function scaledSpellings(digits: string): string[] {
  if (!/000$/.test(digits)) return [];
  return SCALE_WORDS.flatMap(([power, words]) => {
    if (digits.length <= power) return [];
    const whole = digits.slice(0, digits.length - power);
    const fraction = digits.slice(digits.length - power).replace(/0+$/, "");
    if (fraction.length > 3) return [];
    const point = fraction ? `[.,\u066b]${digitsPattern(fraction)}0*` : "(?:[.,\u066b]0+)?";
    // The scale is a word of its own: "3 months" and "2 kids" are counts, not amounts.
    // Nor the decimal or thousands part of a larger amount ("1.2M" is not 2,000,000).
    return [
      `${noDigitBefore()}${noAmountPartBefore()}${digitsPattern(whole)}${point}[${WHITESPACE}]*(?:${words.map(lettersPattern).join("|")})(?!${NOT_SEPARATOR_CLASS})`,
    ];
  });
}

/**
 * A number, by its digit groups as the question writes them, and how many of its digits are
 * a decimal part. The pattern asks for the shortest spelling the rule accepts, as a whole run
 * of digits: a decimal part's trailing zeros and a whole part of zeros left out ("1,500.00"
 * is held by "1,500", "12.50" by "12.5", "0.08" by ".08") and any zeros after a decimal part
 * allowed, and, when eight digits or more remain, up to three leading digits left open, as a
 * country code or trunk zero ("1-415-555-0174" is held by "(415) 555-0174"), keeping seven.
 * No other digit may follow it, nor, when no leading digit is left open, come before it.
 * A round whole number is also held as an amount with a scale ("1,500,000" by "$1.5M" and
 * "1.5 million"). A number whose groups the question joins with a slash or dash (a date, a
 * range, a ratio, a dose) is also held by a text holding each of its groups, anywhere and in
 * any order, each a whole run of digits; in a date, a part with or without its leading zero
 * and a month by its name too ("10/15/2026" by "2026-10-15" and "Oct 15, 2026", "120/80" by
 * "120 over 80").
 */
function numberValue(groups: readonly string[], decimals: number, slashOrDash: boolean): SpecificValue {
  const all = groups.join("");
  const whole = all.slice(0, all.length - decimals).replace(/^0+$/, "");
  const fraction = all.slice(all.length - decimals).replace(/0+$/, "");
  const shortest = `${whole}${fraction}`;
  const cut = Math.max(0, Math.min(3, shortest.length - 7));
  const kept = digitsPattern(shortest.slice(cut));
  // A decimal part may go on with zeros ("1.25" in "1.250"); no other digit may follow.
  const end = `${fraction === "" ? "" : `${digits().ofValue[0]}*`}${noDigitAfter()}`;
  // Where leading digits may be left out, they may also stand there, written another way or
  // not, so the start is open: a country code or trunk zero ("1" in "14155550174"). Four
  // digits or more may also end a run of seven or more, as a number's last digits do
  // ("0104" in "+16175550104", a card's or an ID's last four); a shorter run's end is
  // another number ("4471" in "94471").
  const wholeRun = `${noDigitBefore()}${kept}${end}`;
  // The last digits of a longer run are a second spelling, the run's digits matched rather
  // than looked behind: two lookbehinds in one alternation made the Postgres scan ten times slower.
  const lastDigits = `${runStart()}${digits().any}{3,}${unbrokenDigits(shortest)}${noDigitAfter()}${noDecimalPartAfter()}`;
  // Only a whole number has last digits: a decimal ("1.255" in "9991.255") is an amount, whose
  // whole and decimal parts a run's start and end do not cut.
  const joined =
    cut > 0
      ? `${kept}${end}`
      : decimals === 0 && shortest.length >= MIN_TRAILING_DIGITS
        ? `(?:${wholeRun}|${lastDigits})`
        : wholeRun;
  const spellings = [joined, ...(fraction === "" ? scaledSpellings(whole) : [])];
  // Every spelling but the groups apart is cheap enough to try first: the bare digits, which
  // every spelling of the number holds.
  const screens = [kept, ...spellings.slice(1)];
  if (slashOrDash) {
    // Each group, as a lookahead from the text's start, so their order does not matter.
    const dateLike = isDateLike(groups);
    // In a date of three groups none of which is four digits long, the last is a year written short.
    const shortYearAt = dateLike && groups.length === 3 && groups.every((g) => g.length <= 2) ? 2 : -1;
    const group = (g: string, i: number) => groupPattern(g, dateLike, i === shortYearAt);
    spellings.push(`^${groups.map((g, i) => `(?=${ANY}*${group(g, i)})`).join("")}`);
    // A text holding every group holds the longest; a date's every part may be a name, so any.
    const longest = groups.reduce((a, b) => (b.length > a.length ? b : a));
    screens.push(...(dateLike ? groups.map((g, i) => group(g, i)) : [digitsPattern(longest)]));
  }
  return { kind: "number", key: all, pattern: `(?:${spellings.join("|")})`, screen: `(?:${screens.join("|")})` };
}

/** "and" and "&" for each other, in quoted text. */
const isAnd = (word: string) => word === "&" || word.toLowerCase() === "and";
const quotedWordPattern = (word: string) => (isAnd(word) ? `(?:&|${wordPattern("and")})` : wordPattern(word));

function quotedValue(words: readonly string[]): SpecificValue {
  // Text that starts or ends with a digit cuts no run of digits there ("AB-1234" is not in
  // "AB-12345"); one that ends in a letter may go on, as a plural does.
  const isDigit = (c: string | undefined) => c !== undefined && digitValue(c) !== undefined;
  const before = isDigit([...words[0]!][0]) ? noDigitBefore() : "";
  const after = isDigit([...words.at(-1)!].at(-1)) ? noDigitAfter() : "";
  const pattern = `${before}${words.map(quotedWordPattern).join(SEPARATORS)}${after}`;
  // Every text holding the words holds the longest of them, but for "and", which "&" may stand for.
  const plain = words.filter((word) => !isAnd(word));
  const screen =
    plain.length === 0 ? pattern : wordPattern(plain.reduce((a, b) => ([...b].length > [...a].length ? b : a)));
  return { kind: "quoted", key: words.join(" "), pattern, screen };
}

/**
 * A name. It is held when any two of its words are, in order, so a word the question puts
 * around or inside the name ("Nurse", "Monday", a middle name) never makes it unheld: the
 * earlier word, or its initial standing alone with or without a period, then up to
 * {@link MAX_WORDS_BETWEEN} other words, then the later word; or the later word, any
 * separators, and the earlier or its initial ("Bennett, Maya", "Bennett, M.", "Bennett (Maya)").
 */
function nameValue(words: readonly string[]): SpecificValue {
  // A name's word may hold separators of its own ("Smith-Jones", "O'Neil").
  const parts = words.map((word) => wordsOf(word).map(wordPattern).join(SEPARATORS));
  const between = `(?:${SEPARATOR_CLASS}+${NOT_SEPARATOR_CLASS}+){0,${MAX_WORDS_BETWEEN}}`;
  const pairs = parts.flatMap((first, i) => {
    // An initial stands alone: no letter before it ("Tom Bennett") or after it ("Reed may").
    const initial = `(?<!${NOT_SEPARATOR_CLASS})${characterPattern([...words[i]!][0]!)}(?!${NOT_SEPARATOR_CLASS})`;
    return parts
      .slice(i + 1)
      .flatMap((second) => [
        `(?:${first}|${initial})${between}${SEPARATORS}${second}`,
        `${second}${SEPARATORS}(?:${first}|${initial})`,
      ]);
  });
  // Every spelling above holds a word of the name other than its first.
  return {
    kind: "name",
    key: words.join(" "),
    pattern: `(?:${pairs.join("|")})`,
    screen: `(?:${parts.slice(1).join("|")})`,
  };
}

/**
 * Whether digit groups already read as one grouped number, two groups of three digits or
 * more ("617 555"): a shorter group after a space then ends it ("617 555 01"), where after a
 * single group it is a count of its own ("bed 312 2 days").
 */
const isGroupedNumber = (groups: readonly string[]): boolean =>
  groups.length >= 2 && groups.every((g) => g.length >= 3);

/** Numbers named in `question`, with where each starts. */
function numbersIn(question: string): { at: number; value: SpecificValue }[] {
  // Digit groups are joined into one number by a short separator. A gap holding whitespace
  // joins only groups of three digits or more on both sides ("415 555 0174", not "bed 312
  // 2 days"), and a comma only a thousands group ("1,500,000", not "0174, 0186").
  const groups = [...question.matchAll(digits().group)].map((m) => ({
    at: m.index,
    end: m.index + m[0].length,
    digits: [...m[0]].map((d) => String(digitValue(d))).join(""),
  }));
  // `decimals`: how many of the digits follow a final period with one to three digits after
  // it ("1,500.00"); `slashOrDash`: whether a slash or dash joined two of its groups.
  const numbers: { at: number; groups: string[]; decimals: number; slashOrDash: boolean }[] = [];
  groups.forEach((group, i) => {
    const previous = numbers.at(-1);
    const gap = i > 0 ? question.slice(groups[i - 1]!.end, group.at) : "";
    const joins =
      previous !== undefined &&
      ((JOIN_IN_QUESTION.test(gap) &&
        (!/\s/.test(gap) ||
          (previous.groups.at(-1)!.length >= 3 && (group.digits.length >= 3 || isGroupedNumber(previous.groups))))) ||
        (THOUSANDS.test(gap) && group.digits.length === 3));
    if (joins) {
      previous.groups.push(group.digits);
      previous.decimals = gap === "." && group.digits.length <= 3 ? group.digits.length : 0;
      previous.slashOrDash ||= /[/-]/.test(gap);
    } else {
      numbers.push({ at: group.at, groups: [group.digits], decimals: 0, slashOrDash: false });
    }
  });
  return numbers.flatMap(({ at, groups, decimals, slashOrDash }) => {
    const length = groups.join("").length;
    return length < MIN_NUMBER_DIGITS || length > MAX_NUMBER_DIGITS
      ? []
      : [{ at, value: numberValue(groups, decimals, slashOrDash) }];
  });
}

/** Quoted text named in `question`, with where each starts. */
function quotedIn(question: string): { at: number; value: SpecificValue }[] {
  return [...question.matchAll(QUOTED_IN_QUESTION)].flatMap((m) => {
    const words = wordsOf(m[1] ?? m[2] ?? "");
    return words.length > 0 ? [{ at: m.index, value: quotedValue(words) }] : [];
  });
}

/** A name run without the titles before it and the suffixes after it ("Dr Maya Bennett Jr" is "Maya Bennett"). */
function withoutTitles<T extends { word: string }>(words: readonly T[]): T[] {
  let from = 0;
  let to = words.length;
  while (from < to && LEADING_TITLES.has(words[from]!.word.toLowerCase())) from++;
  while (to > from && TRAILING_SUFFIXES.has(words[to - 1]!.word.toLowerCase())) to--;
  return words.slice(from, to);
}

/** Names named in `question`: runs of two or more capitalized words, with where each starts. */
function namesIn(question: string): { at: number; value: SpecificValue }[] {
  const found: { at: number; value: SpecificValue }[] = [];
  let run: { at: number; word: string }[] = [];
  // A run starts after a sentence's end, or at the question's start.
  let sentenceStart = true;
  let runStartsSentence = false;
  const close = () => {
    const capitalized = runStartsSentence ? run.slice(1) : run;
    const words = capitalized.length <= MAX_NAME_WORDS ? withoutTitles(capitalized) : [];
    if (words.length >= 2) found.push({ at: words[0]!.at, value: nameValue(words.map((w) => w.word)) });
    run = [];
  };
  for (const token of question.matchAll(/\S+/g)) {
    const raw = token[0];
    const lead = raw.match(LEADING_MARKS)?.[0] ?? "";
    const trail = raw.match(TRAILING_MARKS)?.[0] ?? "";
    let word = raw.slice(lead.length, raw.length - trail.length);
    const possessive = POSSESSIVE.test(word);
    if (possessive) word = word.replace(POSSESSIVE, "");
    const isName =
      word.length >= 2 &&
      NAME_WORD.test(word) &&
      word !== word.toUpperCase() &&
      !NOT_NAME_WORDS.has(word.toLowerCase());
    // Leading punctuation, such as an opening bracket, starts a new run.
    if (lead) close();
    if (isName) {
      if (run.length === 0) runStartsSentence = sentenceStart;
      run.push({ at: token.index + lead.length, word });
    } else {
      close();
    }
    if (trail || possessive) close();
    const endsSentence = /[.!?:]/.test(trail) && !(trail.startsWith(".") && TITLES.has(word.toLowerCase()));
    sentenceStart = endsSentence;
  }
  close();
  return found;
}

/**
 * The specific values `question` names, in the order it names them, each once, at most
 * {@link MAX_SPECIFIC_VALUES}. Empty when it names none. Only the first
 * MAX_QUESTION_CHARACTERS characters are read, once normalized.
 */
export function specificValuesIn(question: string): SpecificValue[] {
  // A lone surrogate reaches Postgres as U+FFFD, so it is made one here too.
  const text = normalizeForMatch(question.slice(0, MAX_QUESTION_CHARACTERS).toWellFormed());
  const all = [...numbersIn(text), ...quotedIn(text), ...namesIn(text)].sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const values: SpecificValue[] = [];
  for (const { value } of all) {
    const id = `${value.kind === "number" ? "n" : "w"}:${value.key.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    values.push(value);
    if (values.length === MAX_SPECIFIC_VALUES) break;
  }
  return values;
}

/**
 * Whether `text` holds `value`, by the rule in this file's header. The Postgres check
 * applies the same `value.pattern` to the text normalized the same way
 * (services/memory/readable-values.ts).
 */
export function textHoldsValue(text: string, value: SpecificValue): boolean {
  return new RegExp(value.pattern, "u").test(normalizeForMatch(text));
}
