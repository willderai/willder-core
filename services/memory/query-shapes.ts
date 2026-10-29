// Answer shapes: two kinds of question whose evidence a plain page of whole chunks serves badly,
// and the deterministic reads that serve them better, behind RETRIEVAL_QUERY_SHAPES.
//
// - aggregate ("how many", "in total", "how often", "list all"): the answer is spread over many
//   records, and a page of ten whole transcript turns holds few of them in many characters.
//   Such a read is asked wider, and served as compact dated snippets: from each record the
//   sentences that share terms with the question, its date line kept, deduplicated across the
//   page, in date order, packed into no more characters than today's page of whole records.
// - advice ("recommend", "what should I", "any tips"): the answer must fit what the person said
//   they like or are doing, which often shares no word with the question. memory_query asks a
//   second, guarded read for the person's own statements of preference (`preferenceQuery`) and
//   serves the matching sentences of their own turns as one labelled block (`preferenceBlock`).
//
// The one rule this file enforces: with the flag off, `answerShapeOfQuery` answers null and no
// caller does anything new. Nothing here reads a store or calls a model: it only picks
// sentences out of facts a guarded read already returned, so it can never serve a row that read
// did not (erased, removed and out-of-scope rows are dropped before any of this runs). Like
// query-excerpt.ts, a snippet only removes text: sentences keep their written order and every
// gap is marked.
//
// What counts as a stated preference (the conservative reading, chosen deliberately): a
// first-person sentence of like, dislike, habit or ongoing activity ("I like", "I prefer",
// "my favorite", "I'm into", "I've been …ing", "I usually", "I'm learning"), taken only from a
// turn the record labels as the user's ("user: …"), or from a record a human wrote with no
// speaker labels. An assistant's "I'd suggest" is never a preference of the user's.

import type { MemoryFact } from "@/types/memory";
import { queryTerms, splitSentences } from "./query-excerpt";

/** The flag. Not a secret: a plain variable, off by default. */
export const RETRIEVAL_QUERY_SHAPES_FLAG = "RETRIEVAL_QUERY_SHAPES";

/** True when RETRIEVAL_QUERY_SHAPES is 1, true, on or yes. */
export function queryShapesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env[RETRIEVAL_QUERY_SHAPES_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export type AnswerShape = "aggregate" | "advice";

const AGGREGATE_WORDS =
  /\b(how\s+many|how\s+much|how\s+often|how\s+many\s+times|in\s+total|total|altogether|combined|number\s+of|list\s+(?:all|every|each)|all\s+the\s+\w+\s+i(?:'ve|\s+have)?)\b/i;
const ADVICE_WORDS =
  /\b(recommend\w*|suggest\w*|advice|advise|tips?|ideas?\s+(?:for|on|about)|what\s+should\s+i|should\s+i|can\s+you\s+(?:help\s+me\s+)?(?:find|pick|choose|plan)|help\s+me\s+(?:choose|pick|decide|plan|find)|any\s+(?:good|ideas|thoughts)|what\s+(?:would|could)\s+(?:be\s+a\s+good|i))\b/i;

/**
 * The answer shape of a question, or null when it has none of the two or the flag is off.
 * Aggregate wins a tie: "how many should I buy" counts.
 */
export function answerShapeOfQuery(
  query: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AnswerShape | null {
  if (!queryShapesEnabled(env)) return null;
  if (isAggregateQuestion(query)) return "aggregate";
  if (ADVICE_WORDS.test(query)) return "advice";
  return null;
}

/** Whether a question asks for a count, total or list over many records, whatever any flag says. */
export function isAggregateQuestion(query: string): boolean {
  return AGGREGATE_WORDS.test(query);
}

/** The question's topic: its terms, less the words that only say what shape it is. */
const SHAPE_TERMS = new Set([
  "many",
  "much",
  "often",
  "times",
  "total",
  "altogether",
  "combined",
  "number",
  "list",
  "every",
  "each",
  "recommend",
  "recommendation",
  "recommendations",
  "suggest",
  "suggestion",
  "suggestions",
  "advice",
  "advise",
  "tip",
  "tips",
  "idea",
  "ideas",
  "should",
  "help",
  "find",
  "pick",
  "choose",
  "plan",
  "decide",
  "good",
  "thoughts",
  "could",
  "would",
  "some",
  "give",
  "tell",
  "know",
  "need",
  "want",
  "like",
  "get",
]);

export function topicTerms(query: string): string[] {
  return queryTerms(query).filter((t) => !SHAPE_TERMS.has(t));
}

/** A word's crude stem, so "puzzles" matches "puzzle" and "dinners" "dinner". */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("es") && /(?:ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Whether `word[i]` is a consonant: "y" is one only where no consonant comes before it. */
function consonantAt(word: string, i: number): boolean {
  const c = word[i]!;
  if (/[aeiou]/.test(c)) return false;
  return c === "y" ? i === 0 || !consonantAt(word, i - 1) : true;
}

/** How many vowel-then-consonant runs `word` holds: "plan" 1, "replac" 2. */
function measure(word: string): number {
  let m = 0;
  let afterVowel = false;
  for (let i = 0; i < word.length; i += 1) {
    const consonant = consonantAt(word, i);
    if (consonant && afterVowel) m += 1;
    afterVowel = !consonant;
  }
  return m;
}

/** Whether `word` ends consonant, vowel, consonant, the last not w, x or y ("hop", "dat"; not "fix"). */
function endsShortSyllable(word: string): boolean {
  const n = word.length;
  return (
    n >= 3 &&
    consonantAt(word, n - 3) &&
    !consonantAt(word, n - 2) &&
    consonantAt(word, n - 1) &&
    !/[wxy]/.test(word[n - 1]!)
  );
}

/**
 * A word's stem with its inflections taken off, for the aggregate digest (`SnippetPolicy.inflections`):
 * "replace", "replaced" and "replacing" share one, as do "date" and "dated", "bike" and "biked".
 * A final "e" goes only where what is left is unlikely to be another word ("replace" →
 * "replac", but "plane", "note" and "here" stay apart from "plan", "not" and "her"), and an
 * "-ed" or "-ing" taken off a short syllable gives its "e" back ("hoped" → "hope", "hopped" → "hop").
 * {@link stem}, which the RETRIEVAL_QUERY_SHAPES page matches on, is unchanged.
 */
export function inflectionStem(word: string): string {
  if (word.length <= 3 || /\p{N}/u.test(word)) return word;
  let w = word;
  let inflected = false;
  if (w.length > 4) {
    if (w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith("eed")) w = measure(w.slice(0, -3)) > 0 ? w.slice(0, -1) : w;
    else if (w.endsWith("ing") && w.length > 5 && /[aeiouy]/.test(w.slice(0, -3)))
      [w, inflected] = [w.slice(0, -3), true];
    else if (w.endsWith("ed") && /[aeiouy]/.test(w.slice(0, -2))) [w, inflected] = [w.slice(0, -2), true];
    else if (/(?:ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
    else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  }
  if (inflected) {
    if (/(?:at|bl|iz)$/.test(w)) w = `${w}e`;
    else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && endsShortSyllable(w)) w = `${w}e`;
  }
  if (w.length >= 4 && w.endsWith("e")) {
    const rest = w.slice(0, -1);
    const m = measure(rest);
    // One syllable left: only after a "c", "g", "s", "v" or "z" ("change" → "chang", "raise" →
    // "rais"), since "past", "aid" and "bath" are words of their own beside "paste", "aide" and "bathe".
    if (m > 1 || (m === 1 && !endsShortSyllable(rest) && /[cgsvz]$/.test(rest))) w = rest;
  }
  return w;
}

/** How many of `terms` one sentence's words hold, matched by stem. */
function overlap(
  terms: readonly string[],
  words: ReadonlySet<string>,
  stemOf: (word: string) => string = stem,
): number {
  const stems = new Set([...words].map(stemOf));
  return [...new Set(terms.map(stemOf))].filter((t) => stems.has(t)).length;
}

// --- Records as turns ------------------------------------------------------------------------

const DATE_LINE = /^(?:session\s+)?date:\s*\S.*$/i;
const SPEAKER = /(?:^|\n)[ \t]*(user|assistant)[ \t]*:[ \t]*/gi;

interface Turn {
  /** "user" for a turn the record labels as the user's, "other" for another label, "unlabelled" for a record with none. */
  speaker: "user" | "other" | "unlabelled";
  label: string | null;
  text: string;
}

/** A record's date line (its first line, when it is one) and its turns. */
export function turnsOf(text: string): { dateLine: string | null; turns: Turn[] } {
  const firstBreak = text.indexOf("\n");
  const firstLine = (firstBreak < 0 ? text : text.slice(0, firstBreak)).trim();
  const dateLine = DATE_LINE.test(firstLine) ? firstLine : null;
  const body = dateLine ? text.slice(firstBreak < 0 ? text.length : firstBreak + 1) : text;
  const marks = [...body.matchAll(SPEAKER)];
  if (marks.length === 0)
    return { dateLine, turns: body.trim() ? [{ speaker: "unlabelled", label: null, text: body.trim() }] : [] };
  const turns: Turn[] = [];
  const lead = body.slice(0, marks[0]!.index).trim();
  if (lead) turns.push({ speaker: "unlabelled", label: null, text: lead });
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : body.length;
    const label = m[1]!.toLowerCase();
    const turnText = body.slice(start, end).trim();
    if (turnText) turns.push({ speaker: label === "user" ? "user" : "other", label, text: turnText });
  });
  return { dateLine, turns };
}

/** The key two copies of one sentence share, so a page serves it once. */
export function sentenceKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// --- Aggregate: compact dated snippets -------------------------------------------------------

/** The most one record's snippet may hold. */
export const SNIPPET_MAX_CHARS = 700;
/** With no sentence matching, the opening of the user's turn, at most this long. */
const OPENING_MAX_CHARS = 280;
/** What memory_query adds to each served fact besides its text: citation, date, version, excerpt marker. */
export const SERVED_FACT_OVERHEAD_CHARS = 150;
/** How much wider an aggregate read is asked than its page. */
export const AGGREGATE_WIDEN = 5;

/** The page an aggregate read chooses its snippets from, for a page of `limit`, asked `widen` times wider. */
export function aggregateCandidateLimit(limit: number | undefined, widen = AGGREGATE_WIDEN): number {
  return (limit ?? 10) * widen;
}

/**
 * How an aggregate page picks sentences beyond its shared topic terms. Each is off on the page
 * RETRIEVAL_QUERY_SHAPES serves; the aggregate digest (aggregate-digest.ts) turns them all on.
 */
export interface SnippetPolicy {
  /**
   * A matching sentence of the user's own turn ranks higher when it states something in the
   * first person ("I bought", "my tank holds") and when it holds a quantity, and lower when it
   * only asks something: a count or a total is built from what people said they did and how
   * much, not from what they asked the assistant.
   */
  statementsFirst?: boolean;
  /**
   * With `statementsFirst`: a record's sentence of the user's own that states a quantity in the
   * first person ("I got a 50-pound bag", "I rode it three times") is served after the matching
   * sentences, though it shares no topic term: the thing counted is often named in one sentence
   * and its amount given in the next.
   */
  statedQuantities?: boolean;
  /**
   * A sentence that restates one already served for a record of the same day is not served
   * again: one conversation often repeats a fact, and a reader counting events should see it once.
   */
  restatementsOnce?: boolean;
  /**
   * A topic term that most of the candidate records hold ("music", asked about a person's music
   * albums, on a page of their music conversations) says little about which sentence answers:
   * a sentence is matched on the question's other terms, and on every term only when all of
   * them are that common.
   */
  informativeTerms?: boolean;
  /** Words are matched by {@link inflectionStem}, not {@link stem}: "replaced" matches "replace". */
  inflections?: boolean;
}

/** The stem a page under `policy` matches words on. */
function stemmerOf(policy: SnippetPolicy): (word: string) => string {
  return policy.inflections ? inflectionStem : stem;
}

/** A topic term held by more than this share of an aggregate read's candidates is too common to match on. */
export const PERVASIVE_TERM_SHARE = 0.5;
/** Below this many candidates, every topic term is matched on: a share of a few records says little. */
const PERVASIVE_MIN_CANDIDATES = 10;

/**
 * The question's topic terms to match sentences on, among `candidates`: those held by at most
 * {@link PERVASIVE_TERM_SHARE} of them, or every term when none or all are that rare.
 */
export function informativeTopic(
  candidates: readonly MemoryFact[],
  query: string,
  stemOf: (word: string) => string = stem,
): string[] {
  const terms = topicTerms(query);
  if (candidates.length < PERVASIVE_MIN_CANDIDATES) return terms;
  const stems = candidates.map((f) => new Set((f.fact.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stemOf)));
  const rare = terms.filter(
    (t) => stems.filter((s) => s.has(stemOf(t))).length / candidates.length <= PERVASIVE_TERM_SHARE,
  );
  return rare.length === 0 ? terms : rare;
}

const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we've|we're|our)\b/i;
const QUANTITY =
  /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|dozen|couple|half|once|twice)\b/i;

/**
 * What `statementsFirst` adds to a matching sentence's score: +1 for a first-person statement,
 * +1 for a quantity; a question gets -1, or 0 when it holds a quantity ("is 32 young?" still
 * says how old someone is).
 */
export function statementWeight(sentence: string): number {
  const text = sentence.replace(/[’‘]/g, "'");
  const quantity = QUANTITY.test(text) ? 1 : 0;
  if (/\?["')\]]*$/.test(text.trim())) return quantity - 1;
  return (FIRST_PERSON.test(text) ? 1 : 0) + quantity;
}

const MIN_CONTENT_WORD = 3;
const RESTATEMENT_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "was",
  "were",
  "have",
  "has",
  "had",
  "just",
  "really",
  "also",
  "been",
  "about",
  "from",
  "they",
  "them",
  "you",
  "your",
  "but",
  "its",
  "way",
]);
/** Whether a word states a number: it holds a digit or is a number word. */
const NUMBER_WORDS = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "dozen",
  "couple",
  "half",
  "once",
  "twice",
  "first",
  "second",
  "third",
]);
function isNumberWord(word: string): boolean {
  return /\p{N}/u.test(word) || NUMBER_WORDS.has(word);
}
/**
 * A sentence's content words, by stem: numbers (as written, unstemmed), and words three or more
 * long that are not stopwords.
 */
function contentWords(words: ReadonlySet<string>, stemOf: (word: string) => string = stem): Set<string> {
  const content = new Set<string>();
  for (const w of words) {
    if (isNumberWord(w)) content.add(w);
    else if (w.length >= MIN_CONTENT_WORD && !RESTATEMENT_STOPWORDS.has(w)) content.add(stemOf(w));
  }
  return content;
}
/** At least this share of a sentence's content words already served on its day makes it a restatement. */
export const RESTATEMENT_OVERLAP = 0.75;
/** A served sentence must have at least this many content words for a longer one holding it to count as restating it. */
const RESTATEMENT_MIN_HELD = 3;

function numbersOf(words: ReadonlySet<string>): string {
  return [...words].filter(isNumberWord).sort().join(" ");
}

/**
 * Whether `words` restates one of `served` (content-word sets of sentences already served):
 * most of its content words were served in one sentence, or it holds most of one served sentence
 * ("Like I said, I built a cedar birdhouse" after "I built a cedar birdhouse"), whichever ranked
 * first. Never when the two state different numbers: "puzzle number 5" and "puzzle number 6"
 * are two events.
 */
export function restates(words: ReadonlySet<string>, served: readonly ReadonlySet<string>[]): boolean {
  if (words.size === 0) return false;
  const numbers = numbersOf(words);
  return served.some((s) => {
    if (s.size === 0 || numbersOf(s) !== numbers) return false;
    let shared = 0;
    for (const w of words) if (s.has(w)) shared += 1;
    return (
      shared / words.size >= RESTATEMENT_OVERLAP ||
      (s.size >= RESTATEMENT_MIN_HELD && shared / s.size >= RESTATEMENT_OVERLAP)
    );
  });
}

/** The characters a page of whole facts is served in, which an aggregate page must not exceed. */
export function servedCharsOf(page: readonly MemoryFact[]): number {
  return page.reduce((sum, f) => sum + f.fact.length + SERVED_FACT_OVERHEAD_CHARS, 0);
}

interface Candidate {
  turn: number;
  index: number;
  text: string;
  key: string;
  score: number;
  user: boolean;
  content: Set<string>;
  /** Whether the sentence is the user's own first-person statement of a quantity. */
  statedQuantity: boolean;
}

/**
 * The part of one record that answers an aggregate question: its date line, then the
 * sentences that share the most topic terms with the question (the user's own first on a
 * tie), in written order with every gap marked, at most `maxChars` long. A sentence whose key
 * is in `seen` is not served again. With no sentence matching, the opening of the user's turn.
 * Null when nothing new is left to serve.
 */
export function compactSnippet(
  text: string,
  query: string,
  maxChars = SNIPPET_MAX_CHARS,
  seen: ReadonlySet<string> = new Set(),
): string | null {
  return snippetOf(text, query, maxChars, seen)?.text ?? null;
}

/** An assistant's sentence is served only when it shares at least this many topic terms: one shared word is mostly chatter. */
const OTHER_TURN_MIN_SCORE = 2;

interface SnippetOptions {
  /**
   * For a candidate past the page an ordinary read would serve: nothing is served unless a
   * sentence of the user's own turn shares a topic term, and there is no opening to fall back to.
   */
  strict?: boolean;
  policy?: SnippetPolicy;
  /** With `policy.restatementsOnce`: the content words of the sentences already served for this record's day. */
  servedToday?: readonly ReadonlySet<string>[];
  /** The terms to match sentences on, in place of the question's topic terms. */
  topic?: readonly string[];
}

function snippetOf(
  text: string,
  query: string,
  maxChars: number,
  seen: ReadonlySet<string>,
  { strict = false, policy = {}, servedToday = [], topic }: SnippetOptions = {},
): { text: string; keys: string[]; content: Set<string>[] } | null {
  const { dateLine, turns } = turnsOf(text);
  const terms = topic ?? topicTerms(query);
  const stemOf = stemmerOf(policy);
  const all: Candidate[] = [];
  turns.forEach((turn, t) => {
    splitSentences(turn.text).forEach((s, index) => {
      const key = sentenceKey(s.text);
      if (!key) return;
      const user = turn.speaker !== "other";
      const shared = overlap(terms, s.words, stemOf);
      // A statement's weight only moves sentences that already share a topic term, up or down.
      const score =
        policy.statementsFirst && user && shared > 0 ? Math.max(0, shared + statementWeight(s.text)) : shared;
      const statedQuantity = user && statementWeight(s.text) === 2;
      all.push({
        turn: t,
        index,
        text: s.text,
        key,
        score,
        user,
        content: contentWords(s.words, stemOf),
        statedQuantity,
      });
    });
  });
  const restated = (c: Candidate) => policy.restatementsOnce === true && restates(c.content, servedToday);
  const fresh = all.filter((c) => !seen.has(c.key) && !restated(c));
  const room = maxChars - (dateLine ? dateLine.length + 1 : 0);
  const picked: Candidate[] = [];
  let used = 0;
  const take = (c: Candidate, cap: number) => {
    if (c.text.length + 3 > cap - used) return;
    // Nor a restatement of a sentence this snippet already holds.
    if (
      policy.restatementsOnce &&
      restates(
        c.content,
        picked.map((p) => p.content),
      )
    )
      return;
    picked.push(c);
    used += c.text.length + 3;
  };
  const matching = fresh
    .filter((c) => c.score >= (c.user ? 1 : OTHER_TURN_MIN_SCORE))
    .sort((a, b) => b.score - a.score || Number(b.user) - Number(a.user) || a.turn - b.turn || a.index - b.index);
  if (strict && !matching.some((c) => c.user)) return null;
  for (const c of matching) take(c, room);
  if (policy.statementsFirst && policy.statedQuantities)
    for (const c of fresh) if (c.statedQuantity && !matching.includes(c)) take(c, room);
  if (picked.length === 0 && !strict) {
    const firstUser = fresh.find((c) => c.user);
    const opening = firstUser ? fresh.filter((c) => c.turn === firstUser.turn) : [];
    for (const c of opening) take(c, Math.min(room, OPENING_MAX_CHARS));
  }
  if (picked.length === 0) return null;
  picked.sort((a, b) => a.turn - b.turn || a.index - b.index);
  const lines: string[] = [];
  let line = "";
  picked.forEach((c, i) => {
    const prev = picked[i - 1];
    if (!prev || prev.turn !== c.turn) {
      if (line) lines.push(prev && sentencesInTurn(all, prev.turn) > prev.index + 1 ? `${line} …` : line);
      const label = turns[c.turn]!.label;
      line = `${label ? `${label}: ` : ""}${c.index > 0 ? "… " : ""}${c.text}`;
    } else {
      line += c.index === prev.index + 1 ? ` ${c.text}` : ` … ${c.text}`;
    }
  });
  const last = picked[picked.length - 1]!;
  lines.push(sentencesInTurn(all, last.turn) > last.index + 1 ? `${line} …` : line);
  return {
    text: [...(dateLine ? [dateLine] : []), ...lines].join("\n"),
    keys: picked.map((c) => c.key),
    content: picked.map((c) => c.content),
  };
}

function sentencesInTurn(all: readonly Candidate[], turn: number): number {
  return all.filter((c) => c.turn === turn).length;
}

/** When a record happened, for ordering: its date line's date, else its stored date; null when it has neither. */
export function recordDate(fact: MemoryFact): string | null {
  const line = turnsOf(fact.fact).dateLine;
  const m = line ? /(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/.exec(line) : null;
  if (m)
    return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}`;
  return fact.validAt ? fact.validAt.slice(0, 16) : null;
}

/**
 * An aggregate read's page: from `candidates`, in their ranked order, each record's compact
 * snippet while it fits in `budgetChars` (each fact costing its text plus
 * {@link SERVED_FACT_OVERHEAD_CHARS}), with no sentence served twice; then ordered by when each
 * record happened, oldest first, so one session's records sit together. A record served whole
 * keeps its text; a cut one says how long it was (`excerptOfChars`). A candidate ranked past
 * `pageLimit` (the page an ordinary read serves) is served only where the user's own words share
 * a topic term with the question, so reading wider adds evidence, not chatter.
 */
export function compactAggregatePage(
  candidates: readonly MemoryFact[],
  query: string,
  budgetChars: number,
  pageLimit = candidates.length,
  policy: SnippetPolicy = {},
): MemoryFact[] {
  const seen = new Set<string>();
  const topic = policy.informativeTerms ? informativeTopic(candidates, query, stemmerOf(policy)) : undefined;
  // With `restatementsOnce`: the content words of every sentence served so far, by the day of its record.
  const servedByDay = new Map<string, Set<string>[]>();
  const chosen: { fact: MemoryFact; at: number }[] = [];
  let used = 0;
  for (const [rank, fact] of candidates.entries()) {
    const day = recordDate(fact)?.slice(0, 10) ?? "";
    const today = servedByDay.get(day) ?? [];
    const served = snippetOf(fact.fact, query, SNIPPET_MAX_CHARS, seen, {
      strict: rank >= pageLimit,
      policy,
      servedToday: day ? today : [],
      topic,
    });
    if (served === null) continue;
    const snippet = served.text;
    const cost = snippet.length + SERVED_FACT_OVERHEAD_CHARS;
    if (used + cost > budgetChars) continue;
    used += cost;
    for (const key of served.keys) seen.add(key);
    if (day) servedByDay.set(day, [...today, ...served.content]);
    const whole = snippet === fact.fact;
    chosen.push({
      fact: whole ? fact : { ...fact, fact: snippet, excerptOfChars: fact.excerptOfChars ?? fact.fact.length },
      at: chosen.length,
    });
  }
  const dated = chosen.map((c) => ({ ...c, date: recordDate(c.fact) }));
  dated.sort((a, b) =>
    a.date === b.date ? a.at - b.at : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1,
  );
  return dated.map((c) => c.fact);
}

// --- Advice: the user's stated preferences ---------------------------------------------------

const PREFERENCE_CUE = new RegExp(
  [
    String.raw`\bi\s+(?:really\s+|also\s+|just\s+|absolutely\s+|especially\s+)?(?:like|love|enjoy|prefer|adore|hate|dislike|can'?t\s+stand)\b`,
    String.raw`\bi\s+(?:don'?t|do\s+not|never)\s+(?:like|enjoy|eat|drink|watch)\b`,
    String.raw`\bi'?m\s+(?:really\s+|also\s+|currently\s+)?(?:into|a\s+(?:big\s+|huge\s+)?fan\s+of|obsessed\s+with|allergic\s+to|vegetarian|vegan|learning|working\s+on|planning|training|trying\s+to|getting\s+into)\b`,
    String.raw`\bi\s+am\s+(?:really\s+|also\s+|currently\s+)?(?:into|a\s+(?:big\s+)?fan\s+of|learning|working\s+on|allergic\s+to|vegetarian|vegan)\b`,
    String.raw`\bmy\s+(?:all-time\s+)?(?:favou?rite|go-to)\b`,
    String.raw`\bi'?ve\s+(?:been\s+\w+ing|always\s+(?:liked|loved|enjoyed|wanted)|started|recently\s+started|got(?:ten)?\s+into)\b`,
    String.raw`\bi\s+(?:usually|always|often|tend\s+to|mostly|regularly|normally)\b`,
  ].join("|"),
  "i",
);

/** Whether one sentence states a preference, habit or ongoing activity in the first person. */
export function statesPreference(sentence: string): boolean {
  return PREFERENCE_CUE.test(sentence.replace(/[’‘]/g, "'"));
}

/** The words the preference read is asked with, beside the question's topic. */
export const PREFERENCE_QUERY_CUES = "I like I love I prefer my favorite I'm into I've been I usually I enjoy";

/** The query of the preference read: the question's topic, and the words people state preferences in. */
export function preferenceQuery(query: string): string {
  const topic = topicTerms(query).join(" ");
  return topic ? `${topic} ${PREFERENCE_QUERY_CUES}` : PREFERENCE_QUERY_CUES;
}

export const PREFERENCE_BLOCK_LABEL = "What this user has said they prefer or are doing:";
export const PREFERENCE_BLOCK_MAX_LINES = 8;
export const PREFERENCE_BLOCK_MAX_CHARS = 1_200;
const PREFERENCE_SENTENCE_MAX_CHARS = 300;

export interface PreferenceBlock {
  text: string;
  /** The facts a line of the block was taken from, in the block's order. */
  facts: MemoryFact[];
}

/**
 * The labelled block of the user's stated preferences among `facts` (in ranked order): each
 * sentence of the user's own turns that states one, those sharing more of the question's
 * topic first, then by the rank of the fact they came from, each once, dated by its record.
 * Null when no fact holds one.
 */
export function preferenceBlock(facts: readonly MemoryFact[], query: string): PreferenceBlock | null {
  const terms = topicTerms(query);
  const seen = new Set<string>();
  const found: { line: string; fact: MemoryFact; score: number; at: number }[] = [];
  const uuids = new Set<string>();
  for (const fact of facts) {
    if (uuids.has(fact.uuid)) continue;
    uuids.add(fact.uuid);
    const { turns } = turnsOf(fact.fact);
    const own = turns.filter((t) => t.speaker === "user" || (t.speaker === "unlabelled" && fact.actorType === "human"));
    for (const turn of own) {
      for (const s of splitSentences(turn.text)) {
        if (!statesPreference(s.text)) continue;
        const key = sentenceKey(s.text);
        if (seen.has(key)) continue;
        seen.add(key);
        const text =
          s.text.length > PREFERENCE_SENTENCE_MAX_CHARS
            ? `${s.text.slice(0, PREFERENCE_SENTENCE_MAX_CHARS).replace(/\s+\S*$/, "")} …`
            : s.text;
        const date = recordDate(fact)?.slice(0, 10);
        found.push({
          line: `- ${date ? `(${date}) ` : ""}${text}`,
          fact,
          score: overlap(terms, s.words),
          at: found.length,
        });
      }
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.score - a.score || a.at - b.at);
  const lines: string[] = [];
  const used: MemoryFact[] = [];
  let chars = PREFERENCE_BLOCK_LABEL.length;
  for (const f of found) {
    if (lines.length >= PREFERENCE_BLOCK_MAX_LINES) break;
    if (chars + f.line.length + 1 > PREFERENCE_BLOCK_MAX_CHARS) continue;
    lines.push(f.line);
    chars += f.line.length + 1;
    if (!used.includes(f.fact)) used.push(f.fact);
  }
  if (lines.length === 0) return null;
  return { text: [PREFERENCE_BLOCK_LABEL, ...lines].join("\n"), facts: used };
}
