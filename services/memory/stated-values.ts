// The words, terms and values of a record's text, read the same way on every side of a comparison.
//
// stated-changes.ts and update-links.ts compare what two records say about one thing. They need
// the text cut into words, the words reduced to terms ("Groceries," reads "grocery"), and the
// values read with their kind: "$5,000", "$5k" and "$5,000.00" are one sum, "Sept 1" and
// "September 1" one date, "12 hours" a count of hours. The one rule: a value is compared only
// with a value of its own kind, so every value here carries one.

export const wordSet = (list: string) => new Set(list.split(" "));

/** Words too common to say which thing a sentence is about. */
export const STOPWORDS = wordSet(
  "a an the of to in on for at by with from and or is are was were be been being am do does did " +
    "have has had i my me we our you your it its this that these those what which who whom when " +
    "where why how many much there their they them as into about over under than then so if not no " +
    "yes can could should would will shall may might must also just any some all each get got make made like",
);

/** A period a value is given for, by its spelling after the value or as a modifier: "per week", "/month", "monthly". */
const PERIOD_OF: Record<string, string> = {
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  quarter: "quarter",
  quarterly: "quarter",
  year: "year",
  yearly: "year",
  annual: "year",
  annually: "year",
};
/** A period after a value, past its unit if it has one: "$150 per week", "9 hours a day", "$550/month", "$600 annually". */
const PERIOD_AFTER =
  /(?:\s+\p{L}+)?\s*(?:(?:\/|per\s|a\s|an\s|each\s|every\s)\s*(day|week|month|quarter|year)\b|(daily|weekly|monthly|quarterly|yearly|annually)\b)/iuy;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
export const MONTH_WORD = new RegExp(`^${MONTH}$`, "i");
const MONTH_START = new RegExp(`^${MONTH}`, "i");

/** A sum ("$5,000", "$5k"), a share, a calendar date, a clock time, or a number or a range of numbers ("6-9"), tried in that order. */
const VALUE = new RegExp(
  [
    String.raw`\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[km]\b)?`,
    String.raw`\b\d[\d,]*(?:\.\d+)?\s?%`,
    String.raw`\b${MONTH}\.?\s+\d{1,2}\b`,
    String.raw`\b\d{1,2}(?::\d\d)?\s?[ap]\.?m\b\.?`,
    String.raw`\b\d[\d,]*(?:\.\d+)?(?:\s?[-–]\s?\d[\d,]*(?:\.\d+)?)?`,
  ].join("|"),
  "gi",
);
/** A year on its own says when, not how much, and is never the value compared. */
export const YEAR = /^(?:19|20)\d\d$/;

export interface Value {
  /** The value as written, normalized: "$5,000", "$5000", "$5k" and "$5,000.00" are one value, as are "Sept 1" and "September 1". */
  text: string;
  /** What it measures: "money", "share", "date", "time", or "count:<unit>" ("count:" for a bare number). */
  kind: string;
  /** The period it is given for ("day", "week", "month", "quarter", "year"), when its words say. */
  period?: string;
}

export interface Word {
  /** As written. */
  raw: string;
  /** Lower-cased, outer punctuation removed: `"Increased,"` reads `increased`, `hasn’t` reads `hasn't`. */
  bare: string;
  end: number;
}

/** Lower-cased and with combining marks removed, so "İNCOME" reads as "income" and "café" as "cafe". */
export function folded(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  for (const suffix of ["ion", "ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/**
 * Short codes: two characters written in capitals or with a digit ("UK", "LA", "HR", "H1", "Q3"),
 * capitals with dots ("U.K.", "I.T."), letters joined by "&" ("R&D", "r&d", "AT&T"), and capitals
 * joined by a spaced or dotted "&" ("R & D", "R.&D."). A code's term drops its dots and spaces.
 */
const SHORT_CODE =
  /(?<![\p{L}\p{N}])(?:\p{Lu}{2}|\p{Lu}\d|(?:\p{Lu}\.){2,3}|\p{L}{1,3}&\p{L}{1,3}|\p{Lu}{1,3}\.? ?& ?\p{Lu}{1,3}\.?)(?![\p{L}\p{N}&])/gu;

/**
 * Whether capitals in `text` are the writer's choice: it has a run of lower-case letters ("for IT"),
 * which all-caps text ("FOR IT", "TO $550k FOR ME") does not.
 */
export function capitalsChosen(text: string): boolean {
  return /\p{Ll}{2}/u.test(text);
}

/**
 * A text's terms worth matching: words of three or more characters, not stopwords, crudely
 * stemmed, and short codes ("UK", "H2", "R&D"), which name a place, team or period as much as a
 * longer word does.
 *
 * A code spelled like a stopword ("IT", "OR", "ME") is a code only where the text it is written
 * in, `writtenIn` (by default `text` itself), chose its capitals (`capitalsChosen`). All-caps text
 * reads as its lower-case spelling does.
 */
export function attributeTerms(text: string, writtenIn: string = text): string[] {
  const words = (folded(text).match(/\p{L}[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
  const keepStopwordCodes = capitalsChosen(writtenIn);
  const codes = (text.match(SHORT_CODE) ?? [])
    .map((code) => folded(code).replace(/[. ]/g, ""))
    .filter((code) => keepStopwordCodes || !STOPWORDS.has(code));
  return codes.length > 0 ? [...words, ...codes] : words;
}

/** The period a term names: "monthly" and "month" name "month". */
export function periodOf(term: string): string | undefined {
  return PERIOD_OF[folded(term)];
}

export function wordsOf(text: string): Word[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    raw: m[0],
    bare: folded(m[0])
      .replace(/’/g, "'")
      .replace(/[^\p{L}\p{N}'-]/gu, "")
      .replace(/^[-']+|[-']+$/g, ""),
    end: m.index + m[0].length,
  }));
}

/** A text's terms in order, with "" wherever a name cannot run on (a stopword, a number, a month, a clause end). */
export function termSequence(text: string): string[] {
  return wordsOf(text).flatMap((word) => {
    const terms = attributeTerms(word.bare);
    const breaks = terms.length === 0 || /\d/.test(word.bare) || MONTH_WORD.test(word.bare);
    return [...(breaks ? [""] : terms), ...(/[,;:.!?)]$/.test(word.raw) ? [""] : [])];
  });
}

/** The index of the first word in `list` that ends after `at`. */
export function firstWordAfter(list: readonly Word[], at: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].end <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function normalized(raw: string, kind: string): string {
  let text = folded(raw)
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/–/g, "-")
    .replace(/\.(?!\d)/g, "");
  if (kind === "date") return `${MONTHS.find((m) => text.startsWith(m))}${text.replace(/^\p{L}+/u, "")}`;
  if (kind === "money") {
    const thousands = text.endsWith("k") ? 1_000 : text.endsWith("m") ? 1_000_000 : 1;
    const amount = Number(text.replace(/^\$/, "").replace(/[km]$/, "")) * thousands;
    return Number.isFinite(amount) ? `$${amount}` : text;
  }
  // "78.0%" and "78%", "4.50" and "4.5" are one value.
  text = text.replace(/(\.\d*?)0+(?=%|$)/, "$1").replace(/\.(?=%|$)/, "");
  return text;
}

/** The value `match` in `sentence` is, or null when it is a year, a version or a fraction. */
function valueAt(match: RegExpExecArray, sentence: string): Value | null {
  const raw = match[0];
  const lower = raw.toLowerCase();
  const end = match.index + raw.length;
  PERIOD_AFTER.lastIndex = end;
  const after = PERIOD_AFTER.exec(sentence);
  const period = after ? periodOf(after[1] ?? after[2]) : undefined;
  const of = (text: string, kind: string): Value => ({ text, kind, ...(period ? { period } : {}) });
  if (lower.startsWith("$")) return of(normalized(raw, "money"), "money");
  if (lower.endsWith("%")) return of(normalized(raw, "share"), "share");
  if (MONTH_START.test(lower)) return { text: normalized(raw, "date"), kind: "date" };
  if (/[ap]\.?m\.?$/.test(lower)) return { text: normalized(raw, "time"), kind: "time" };
  const text = normalized(raw, "count");
  if (YEAR.test(text)) return null;
  // Versions ("v1.0", "1.0.0") and fractions ("3/4") are not amounts.
  if (/[v.\-–/]/i.test(sentence[match.index - 1] ?? "") || /^\.\d/.test(sentence.slice(end, end + 2))) return null;
  const next = /\s*(\S+)/y;
  next.lastIndex = end;
  const word = next.exec(sentence)?.[1] ?? "";
  const unit = /^\p{L}/u.test(word) ? stem(folded(word).replace(/[^\p{L}]/gu, "")) : "";
  return of(text, `count:${unit && !STOPWORDS.has(unit) ? unit : ""}`);
}

/** Every value in `sentence`, in order, with where it stands. */
export function valuesOf(sentence: string): { value: Value; match: RegExpExecArray }[] {
  const found: { value: Value; match: RegExpExecArray }[] = [];
  for (const match of sentence.matchAll(VALUE)) {
    const value = valueAt(match as RegExpExecArray, sentence);
    if (value) found.push({ value, match: match as RegExpExecArray });
  }
  return found;
}
