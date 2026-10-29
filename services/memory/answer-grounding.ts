// Whether an answer written from memory states only what the memory it was served holds.
//
// Ask hands a model the facts a search returned, numbered, and the model answers citing them
// as [n]. Nothing in that loop stops a confident answer citing a fact about something else,
// or a date no fact holds. So this file decides two things, lexically and with no model, and
// the route enforces them:
//
//   1. Whether a served fact is about the question at all (`isAboutTheQuestion`). When no
//      served fact is, Ask says memory has nothing on it instead of letting the model answer.
//   2. What of an answer to remove (`AnswerGrounder`, `groundAnswer`), by precise rules only:
//      a citation to a fact that was not served, and a sentence stating a date or figure that
//      its cited facts (or, when it cites none, every served fact) and the question do not
//      hold. Sentences are checked as the model writes them, so the answer still streams.
//
// The one rule: an answer never cites a fact, or states a date or figure, that memory did not
// serve it. Nothing is removed for sharing few words with its fact: a correct paraphrase
// shares few words, and on BEAM's reference answers a word-overlap rule removed about a third
// of correctly cited sentences. A cited sentence that reuses a fact's words to say something
// else, with no date or figure, is not caught here; the relevance floor and the prompt are
// what stand against it. The floors were set on the BEAM benchmark's questions as a whole,
// not on any one question.
import { termsOf } from "./relevance";

/**
 * A fact is about a question when it holds more than this share of the question's terms.
 *
 * Set on the BEAM benchmark, 100K conversations 1 to
 * 10, read as Ask reads (limit 15): at more than a third, none of the 159 answerable questions
 * whose gold evidence was served was told memory had nothing, in either half of the
 * conversations, while 26% of 179 questions asked of another conversation's memory were. At
 * 0.4, two answerable questions were lost.
 */
const QUESTION_COVERAGE_FLOOR = 1 / 3;

/**
 * Cosine similarity at which a vector hit is about the question whatever words it shares. On
 * the same lab run the gold evidence's median similarity was 0.79 and the best hit of a
 * question asked of another conversation's memory 0.70. The guarded store's own floor for
 * reserving page slots, 0.5, is below almost every hit, so it cannot tell them apart.
 */
const SIMILARITY_FLOOR = 0.75;

/**
 * Words that frame a question or an answer rather than say what it is about: how a person
 * asks ("can you walk me through the different aspects I brought up"), how an answer
 * attributes ("according to the facts stored"), connectives, and counts written as words.
 * Neither a question's subject nor a fact needs to hold them.
 */
const FRAMING_WORDS = stemmedSet(
  "does did doing done tell know remember recall say said says mention mentioned give list show please describe explain " +
    "walk through throughout across brought discuss discussed talk talked conversation conversations aspect aspects different item items many much " +
    "memory memories org organization according fact facts record records stored found shows states notes noted " +
    "between while during since until because despite both each every first second " +
    "one two three four five six seven eight nine ten eleven twelve",
);

/** A citation as the answer writes it: `[2]`, `[2, 5]`. */
const CITATION_GROUP = /\s*\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** A number as written: digits, with thousands separators or a decimal part. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_NUMBERS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A day written beside its month, either way round: `November 5`, `5th of Nov`, `November-05`. */
const DAY_BESIDE_MONTH = new RegExp(
  `\\b(?:(${MONTHS})[\\s.-]+(\\d{1,2})(?!\\d)|(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(?:of\\s+)?(${MONTHS})\\b)`,
  "gi",
);
/** A date written as numbers, year first: `2024-03-15`. */
const ISO_DATE = /\b\d{4}-(\d{1,2})-(\d{1,2})\b/g;
/** A figure: three digits or more (a year among them), a decimal or dotted version, a percentage, an amount of money. */
const FIGURE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)+|\d+\s?%|\d{3,})/g;

/** `text`'s number, as a fact or an answer could write it: no thousands separators, no leading zeros. */
function normalizedNumber(text: string): string {
  return text.replace(/,(?=\d{3}\b)/g, "").replace(/^0+(?=\d)/, "");
}

/** Every number written in `text`, normalized. */
function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER) ?? []).map(normalizedNumber));
}

/** Every day of a month `text` writes, as `month-day` (`11-5` for November 5), however it is written. */
function datesIn(text: string): Set<string> {
  const dates = new Set<string>();
  for (const match of text.matchAll(DAY_BESIDE_MONTH)) {
    const month = MONTH_NUMBERS.indexOf((match[1] ?? match[4]!).slice(0, 3).toLowerCase()) + 1;
    dates.add(`${month}-${normalizedNumber(match[2] ?? match[3]!)}`);
  }
  for (const match of text.matchAll(ISO_DATE))
    dates.add(`${normalizedNumber(match[1]!)}-${normalizedNumber(match[2]!)}`);
  return dates;
}

/** The numbers and dates `text` writes, as `figuresIn` names them, for a fact to be checked against. */
function valuesIn(text: string): Set<string> {
  return new Set([...numbersIn(text), ...datesIn(text)]);
}

/**
 * The dates and figures `text` states: each day of a month as `month-day`, and each number of
 * three digits or more (a year among them), decimal, percentage or amount. A small bare number
 * is left out: an answer may count or subtract what its facts say ("4 weeks between them"), and
 * a count is not a value it could have copied from a fact.
 */
export function figuresIn(text: string): Set<string> {
  const figures = datesIn(text);
  for (const match of text.match(FIGURE) ?? []) figures.add(normalizedNumber(match.replace(/[^\d.,]/g, "")));
  return figures;
}

/**
 * `term` reduced to the stem its inflections share, so `ships` matches `ship` and `scheduled`
 * matches `schedule`. A term holding a digit or an identifier's punctuation is kept whole.
 * Both sides of every comparison are reduced the same way, so a crude stem is enough.
 */
function stem(term: string): string {
  if (/[\d\-_.#/[\]]/.test(term)) return term;
  let s = term;
  for (const suffix of ["ies", "ing", "ed", "es", "s", "ly"]) {
    if (s.endsWith(suffix) && s.length - suffix.length >= 3) {
      s = suffix === "ies" ? `${s.slice(0, -3)}y` : s.slice(0, -suffix.length);
      break;
    }
  }
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  if (s.length > 3 && s.at(-1) === s.at(-2) && !"aeiou".includes(s.at(-1)!)) s = s.slice(0, -1);
  return s;
}

/** `words`, stemmed, as a set. */
function stemmedSet(words: string): Set<string> {
  return new Set(words.split(" ").map(stem));
}

/** The stemmed terms of `text`, without framing words. */
function wordTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const term of termsOf(text)) {
    const stemmed = stem(term);
    if (!FRAMING_WORDS.has(stemmed)) terms.add(stemmed);
  }
  return terms;
}

/** What a served fact is matched by. */
export interface ServedFactTerms {
  /** Every term of the fact, numbers among them. */
  terms: Set<string>;
  /** Every number the fact writes, and every day of a month, as `figuresIn` names them. */
  values: Set<string>;
}

/** The terms and values of a served fact's text. */
export function servedFactTerms(text: string): ServedFactTerms {
  return { terms: new Set([...wordTerms(text), ...numbersIn(text)]), values: valuesIn(text) };
}

/** The terms a question asks about: its words and the numbers it writes, without framing words. */
export function questionTerms(question: string): Set<string> {
  return new Set([...wordTerms(question), ...numbersIn(question)]);
}

/** The share of `wanted` that `held` holds; 1 when nothing is wanted. */
function coverage(wanted: ReadonlySet<string>, held: { has(term: string): boolean }): number {
  if (wanted.size === 0) return 1;
  let count = 0;
  for (const term of wanted) if (held.has(term)) count++;
  return count / wanted.size;
}

/**
 * Whether a served fact is about a question: it holds more than QUESTION_COVERAGE_FLOOR of the
 * question's terms, or the vector search found it at SIMILARITY_FLOOR or above. `questions` are
 * every wording of the question asked, the person's and the search's own (which resolves "it"
 * from the conversation); being about any one is enough. A question with no terms at all
 * cannot be judged, so every fact counts as about it.
 */
export function isAboutTheQuestion(
  questions: readonly ReadonlySet<string>[],
  fact: { terms: ReadonlySet<string>; similarity?: number },
): boolean {
  if ((fact.similarity ?? 0) >= SIMILARITY_FLOOR) return true;
  return questions.some((wanted) => coverage(wanted, fact.terms) > QUESTION_COVERAGE_FLOOR);
}

/** An answer after grounding, and what was taken out of it. */
export interface GroundedAnswer {
  /** The answer's kept sentences, in order; empty when none was. */
  text: string;
  /** Sentences removed for stating a date or figure the memory they rely on does not hold. */
  removedSentences: number;
  /** Citations removed for naming a fact that was not served. */
  removedCitations: number;
}

/**
 * Where a segment of an answer ends: a sentence's closing mark with any citations written after
 * it, then whitespace before more text (so a citation after the full stop stays with its
 * sentence), or a line break. A full stop between digits ends nothing.
 */
const SEGMENT_END = /[.!?]+(?:\s*\[\d+(?:\s*,\s*\d+)*\])*(?:\s*\n|\s+(?=[^\s[]))|\n/;

/** A numbered list's marker standing alone as a segment (`1.`), held for the sentence it numbers. */
const NUMBERED_MARKER = /^\s*\d+[.)]$/;

/** The citation numbers `sentence` writes, in order, each once. */
function citationsIn(sentence: string): number[] {
  const numbers: number[] = [];
  for (const match of sentence.matchAll(CITATION_GROUP)) {
    for (const n of match[1]!.split(",")) numbers.push(Number(n.trim()));
  }
  return [...new Set(numbers)];
}

/** `sentence` with its citations replaced by `kept`, written once where the first one was. */
function withCitations(sentence: string, kept: readonly number[]): string {
  let first = true;
  return sentence
    .replace(CITATION_GROUP, () => {
      if (!first) return "";
      first = false;
      return kept.length === 0 ? "" : ` ${kept.map((n) => `[${n}]`).join("")}`;
    })
    .replace(/\s+([.!?,;:])/g, "$1")
    .trim();
}

/**
 * Grounds an answer as the model writes it, one sentence at a time. `push` takes the next text
 * written and returns what is checked and ready to send; `end` returns the rest. Fact n is
 * `served[n - 1]`, read when a sentence is checked, so a fact served by a later search counts.
 *
 * A citation to a fact that was not served is removed. A sentence stating a date or figure
 * (`figuresIn`) is removed unless every one is held by a fact it cites, or, when it cites no
 * served fact, by any served fact, or by the question. The whitespace after a kept sentence is
 * sent with the next one, so a removed sentence leaves no gap and the answer no trailing space.
 */
export class AnswerGrounder {
  /** Sentences removed for stating a date or figure the memory they rely on does not hold. */
  removedSentences = 0;
  /** Citations removed for naming a fact that was not served. */
  removedCitations = 0;
  /** Whether any text has been returned to send. */
  sentAnything = false;
  private pending = "";
  private marker = "";
  private gap = "";
  private lineHasText = false;
  private readonly questionValues: Set<string>;

  constructor(
    private readonly served: readonly ServedFactTerms[],
    question: string,
  ) {
    this.questionValues = new Set([...figuresIn(question), ...valuesIn(question)]);
  }

  /** Take the next text the model wrote; return the sentences it completed, checked. */
  push(text: string): string {
    this.pending += text;
    let out = "";
    for (let end = SEGMENT_END.exec(this.pending); end; end = SEGMENT_END.exec(this.pending)) {
      const cut = end.index + end[0].length;
      out += this.release(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
    }
    return out;
  }

  /** The rest of the answer, checked, once the model has finished. */
  end(): string {
    const rest = this.pending;
    this.pending = "";
    const out = rest.trim() === "" ? "" : this.release(rest);
    const marker = this.marker.trim();
    this.marker = "";
    return marker === "" ? out : out + this.send(marker, "");
  }

  /** One segment checked: what to send now. */
  private release(segment: string): string {
    const body = segment.trimEnd();
    const trailing = segment.slice(body.length);
    if (body.trim() === "") {
      if (this.sentAnything) this.gap += trailing;
      return "";
    }
    if (NUMBERED_MARKER.test(body)) {
      this.marker += segment;
      return "";
    }
    const sentence = this.check(this.marker + body);
    this.marker = "";
    if (sentence === null) {
      this.removedSentences++;
      if (trailing.includes("\n") && this.lineHasText) {
        this.gap = trailing.replace(/[^\n]/g, "");
        this.lineHasText = false;
      }
      return "";
    }
    return this.send(sentence, trailing);
  }

  /** Send `text`, after the whitespace the last sent sentence was followed by. */
  private send(text: string, trailing: string): string {
    const out = (this.sentAnything ? this.gap : "") + text;
    this.sentAnything = true;
    this.gap = trailing;
    this.lineHasText = !trailing.includes("\n");
    return out;
  }

  /** `sentence` with its unserved citations removed, or null when it states a value its memory does not hold. */
  private check(sentence: string): string | null {
    const cited = citationsIn(sentence);
    const served = cited.filter((n) => n >= 1 && n <= this.served.length);
    this.removedCitations += cited.length - served.length;
    const sources = served.length > 0 ? served.map((n) => this.served[n - 1]!) : this.served;
    for (const figure of figuresIn(withCitations(sentence, []))) {
      if (!this.questionValues.has(figure) && !sources.some((fact) => fact.values.has(figure))) return null;
    }
    return served.length === cited.length ? sentence : withCitations(sentence, served);
  }
}

/** `answer` grounded whole, as `AnswerGrounder` would stream it. */
export function groundAnswer(answer: string, served: readonly ServedFactTerms[], question: string): GroundedAnswer {
  const grounder = new AnswerGrounder(served, question);
  const text = grounder.push(answer) + grounder.end();
  return { text, removedSentences: grounder.removedSentences, removedCitations: grounder.removedCitations };
}
