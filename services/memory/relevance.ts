// What the task-start block counts as relevant to a task, and which part of a record it serves.
//
// The block has a fixed token budget (mcp/task-start-notice.ts), so what it ranks first and
// which sentences of a record it shows decide what an agent learns before it starts. Both are
// decided here, lexically, so a reader can say why a record was served: no model and no
// embedding takes part.
//
// The one rule this file enforces: a record is relevant to a task by the task's own terms it
// contains, each weighted by how rare it is among the records being ranked, and an identifier
// (a path, a pull request number, a commit, a camelCase name) counts double. A word every
// candidate shares, such as the repository name a whole import repeats, weighs almost nothing,
// so it cannot crowd out the record that names what the task is about. Scores are BM25's: a
// term mentioned again adds less each time, and a long record needs more mentions than a short
// one, so a digest that names every term once does not outrank the record about the task. A
// record that contains none of the task's terms has no relevance, and is served exactly as it
// would be without this file: its opening, cut to the line's limit.
//
// The query can be widened by names the task's own records hold (weighTaskTerms' `related`),
// a file or an id an earlier session wrote down. Such a term weighs half what the task's own
// word would, and it never decides whether a record is about the task: a record is about the
// task by the task's own terms alone. When the task is named, its own terms are its name's
// (ownTermsOf): the rest of the query, what the session is doing now, ranks records but never
// decides which are about the task, so a long prompt cannot outvote the name.
//
// Only a record's first TEXT_RANKED_CHARS characters are ranked or cut from: the block never
// serves more than a few hundred, and a record's size must not decide how long a read takes.

/** Words too common to say what a task is about. */
const STOPWORDS = new Set(
  "the and for with from that this what when where which who why how are was were has have had not but you your our all any can its into about after before over under than then them they there these those will would should could just also only such more most other some very".split(
    " ",
  ),
);

/** The characters identifiers are written with, which join letters and digits into one token. */
const JOINERS = "-_.#/[]";
const JOINER_CODES = new Set([...JOINERS].map((char) => char.charCodeAt(0)));
/** A token holding a joiner, and where it splits into its parts. */
const HAS_JOINER = /[-_.#/[\]]/;
const TOKEN_JOINERS = /[-_.#/[\]]+/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** A pull request or issue number as people write it. */
const HASH_NUMBER = /#\d+/g;
/** Characters that make a token an identifier rather than a word. */
const IDENTIFIER_MARKS = /[\d/._#[\]]/;
/** A capital after a lower-case letter: a camelCase or PascalCase name. */
const INNER_CAPITAL = /\p{Ll}\p{Lu}/u;

/** How much more an identifier weighs than a word equally rare among the candidates. */
const IDENTIFIER_WEIGHT = 2;

/**
 * How much a term drawn from the task's own records weighs against the same term in the task's
 * own words. Below 1, as query expansion is: the task's words say what the work is, and the
 * records only what it touched before.
 */
export const RELATED_TERM_WEIGHT = 0.5;

/** BM25's usual constants: how fast a repeated mention stops adding, and how much length counts. */
const SATURATION = 1.2;
const LENGTH_NORMALIZATION = 0.75;

/** The characters of a record that are ranked and cut from. */
export const TEXT_RANKED_CHARS = 4000;

/**
 * `text` cut to {@link TEXT_RANKED_CHARS} code points, as Postgres counts characters, so no
 * character is split. Walks only as far as the cut, however long the text.
 */
export function rankedText(text: string): string {
  if (text.length <= TEXT_RANKED_CHARS) return text;
  let end = 0;
  for (let points = 0; points < TEXT_RANKED_CHARS && end < text.length; points++) {
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

/**
 * The terms of `text`, for ranking: lowercased, three characters or more, common words
 * dropped. An identifier is kept whole and also split, so it matches a mention of the whole
 * id and of its parts. A number written `#42` is kept as `#42` whatever its length, since a
 * pull request number is an identifier however short.
 */
export function termsOf(text: string): Set<string> {
  return new Set(termCountsOf(text).keys());
}

/** How many times each term ({@link termsOf}) of a record occurs in it. */
export type TermCounts = ReadonlyMap<string, number>;

/** Each term of `text` ({@link termsOf}) and how many times it occurs. */
export function termCountsOf(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string) => {
    if (term.length >= 3 && !STOPWORDS.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  };
  const lower = text.toLowerCase();
  for (const token of tokensOf(lower)) {
    add(token);
    if (HAS_JOINER.test(token)) for (const part of token.split(TOKEN_JOINERS)) add(part);
  }
  for (const number of lower.match(HASH_NUMBER) ?? []) counts.set(number, (counts.get(number) ?? 0) + 1);
  return counts;
}

/**
 * The tokens of `text`: runs of letters and digits joined by {@link JOINERS}
 * (`task1-run-state`, `app/api/facts/[id]/route.ts`, `memory_changes`, `v1.2`), with
 * the joiners at either end dropped. A scan rather than a Unicode regular expression, which
 * costs several times as much on the few hundred records one read ranks.
 */
function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  const flush = (end: number) => {
    let from = start;
    while (from < end && JOINER_CODES.has(text.charCodeAt(from))) from++;
    while (end > from && JOINER_CODES.has(text.charCodeAt(end - 1))) end--;
    if (end > from) tokens.push(text.slice(from, end));
    start = -1;
  };
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    if (JOINER_CODES.has(code) || isLetterOrDigit(code)) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      flush(i);
    }
    i += width;
  }
  if (start !== -1) flush(text.length);
  return tokens;
}

/** A digit or a joiner: what makes a token a name someone wrote on purpose rather than a word. */
const NAME_MARK = /[\d\-_.#/[\]]/;

/**
 * The names written in `text`, lowercased: its tokens that hold a digit or one of
 * {@link JOINERS}, such as `merge-gate-20260921`, `app/api/route.ts` or an id. A plain word
 * is never one, so a name matches only where a writer meant that exact thing.
 */
export function namesIn(text: string): Set<string> {
  return new Set(tokensOf(text.toLowerCase()).filter((token) => NAME_MARK.test(token)));
}

/** Whether the code point is a letter or a digit, ASCII decided without a regular expression. */
function isLetterOrDigit(code: number): boolean {
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  return LETTER_OR_DIGIT.test(String.fromCodePoint(code));
}

/** The terms of `text` written as identifiers: with a digit, a path or id character, or an inner capital. */
function identifiersOf(text: string): Set<string> {
  const identifiers = new Set<string>();
  for (const token of tokensOf(text)) {
    if (!IDENTIFIER_MARKS.test(token) && !INNER_CAPITAL.test(token)) continue;
    for (const term of termsOf(token)) identifiers.add(term);
  }
  for (const number of text.match(HASH_NUMBER) ?? []) identifiers.add(number);
  return identifiers;
}

/** How much each of a task's terms counts toward a record's relevance, and how long a record usually is. */
export interface TermWeights {
  /** Each term of the task and its weight, in the task's order; empty when the task names nothing. */
  readonly byTerm: ReadonlyMap<string, number>;
  /** The mean number of term occurrences in a candidate, against which a record's length counts. */
  readonly averageLength: number;
  /** The task's terms written as identifiers. */
  readonly identifiers: ReadonlySet<string>;
  /**
   * The terms of {@link byTerm} that decide whether a record is about the task
   * ({@link ownTermsOf}). Every other term, the session's own words or a name from the task's
   * records, ranks a record and chooses its passage, but never makes it about the task.
   */
  readonly own: ReadonlySet<string>;
}

const NO_TERMS: ReadonlySet<string> = new Set();

/** The weights of a task that names nothing: every record's relevance is 0. */
export const NO_WEIGHTS: TermWeights = { byTerm: new Map(), averageLength: 0, identifiers: new Set(), own: new Set() };

/**
 * The terms of `taskText` that decide whether a record is about the task: those of the task's
 * name, `nameText`, when the text holds any, otherwise all of them. The text may add what the
 * session is doing (a prompt, a tool call's arguments), which says how to rank but not what the
 * task is: counted toward "about", forty words of a prompt would outvote a three-word name.
 */
export function ownTermsOf(taskText: string, nameText = ""): Set<string> {
  const terms = termsOf(taskText);
  const named = [...termsOf(nameText)].filter((term) => terms.has(term));
  return named.length === 0 ? terms : new Set(named);
}

/** How many term occurrences `counts` holds. */
function lengthOf(counts: TermCounts): number {
  let length = 0;
  for (const count of counts.values()) length += count;
  return length;
}

/**
 * The weight of each term of `taskText` among `candidates`, the term counts
 * ({@link termCountsOf}) of each text being ranked: the term's inverse document frequency
 * (the BM25 form, which stays positive when every candidate holds the term), doubled for an
 * identifier. Each term of `related`, names the task's own records hold, that the task's
 * words lack is weighed the same way, as an identifier, times {@link RELATED_TERM_WEIGHT}.
 * Related terms alone weigh nothing: a task that names nothing is still served as one. `name`
 * is the task's name within `taskText`, whose terms alone decide what is about the task
 * ({@link ownTermsOf}).
 */
export function weighTaskTerms(
  taskText: string,
  candidates: readonly TermCounts[],
  { related: relatedText = "", name = "" }: { related?: string; name?: string } = {},
): TermWeights {
  const terms = termsOf(taskText);
  if (terms.size === 0) return NO_WEIGHTS;
  const identifiers = identifiersOf(taskText);
  const related = new Set([...termsOf(relatedText)].filter((term) => !terms.has(term)));
  const holding = new Map<string, number>();
  let totalLength = 0;
  for (const candidate of candidates) {
    totalLength += lengthOf(candidate);
    for (const term of [...terms, ...related]) {
      if (candidate.has(term)) holding.set(term, (holding.get(term) ?? 0) + 1);
    }
  }
  const total = candidates.length;
  const rarityOf = (term: string) => {
    const held = holding.get(term) ?? 0;
    return Math.log(1 + (total - held + 0.5) / (held + 0.5));
  };
  const byTerm = new Map<string, number>();
  for (const term of terms) byTerm.set(term, rarityOf(term) * (identifiers.has(term) ? IDENTIFIER_WEIGHT : 1));
  for (const term of related) byTerm.set(term, rarityOf(term) * IDENTIFIER_WEIGHT * RELATED_TERM_WEIGHT);
  return { byTerm, averageLength: total === 0 ? 0 : totalLength / total, identifiers, own: ownTermsOf(taskText, name) };
}

/** The summed weight of the task's terms that `terms` holds, each counted once, in the task's order. */
function weightOf(weights: TermWeights, terms: { has(term: string): boolean }): number {
  let score = 0;
  for (const [term, weight] of weights.byTerm) if (terms.has(term)) score += weight;
  return score;
}

/**
 * The BM25 score of a record whose terms occur `counts` times: each task term's weight, scaled
 * by how often the record mentions it, with repeats adding less and less, and a record longer
 * than the candidates' mean needing more mentions for the same score. 0 when it holds none of
 * the task's terms. Summed in the task's own order, so two records with the same counts score
 * exactly the same, and recency decides between them rather than rounding.
 */
export function relevanceOf(weights: TermWeights, counts: TermCounts): number {
  if (weights.byTerm.size === 0) return 0;
  const length = lengthOf(counts);
  const lengthFactor = weights.averageLength > 0 ? length / weights.averageLength : 1;
  const damping = SATURATION * (1 - LENGTH_NORMALIZATION + LENGTH_NORMALIZATION * lengthFactor);
  let score = 0;
  for (const [term, weight] of weights.byTerm) {
    const count = counts.get(term) ?? 0;
    if (count > 0) score += (weight * count * (SATURATION + 1)) / (count + damping);
  }
  return score;
}

/**
 * Whether a record holding the terms `terms` is about the task, rather than mentioning one of
 * its words in passing: it holds more than half of the task's own terms ({@link TermWeights.own}),
 * an identifier counting double. How rare a term is plays no part here, so a word of the task
 * that no record holds cannot decide whether a record that holds the rest is about it.
 */
export function isAboutTheTask(weights: TermWeights, terms: { has(term: string): boolean }): boolean {
  let whole = 0;
  let held = 0;
  for (const term of weights.own) {
    const weight = weights.identifiers.has(term) ? IDENTIFIER_WEIGHT : 1;
    whole += weight;
    if (terms.has(term)) held += weight;
  }
  return whole > 0 && held > whole / 2;
}

/** Whether `terms` holds any of the task's own terms ({@link TermWeights.own}). */
export function holdsATaskTerm(weights: TermWeights, terms: { has(term: string): boolean }): boolean {
  for (const term of weights.own) if (terms.has(term)) return true;
  return false;
}

/** How relevant `text` is to the task `weights` were drawn from: 0 when it contains none of its terms. */
export function relevance(weights: TermWeights, text: string): number {
  return weights.byTerm.size === 0 ? 0 : relevanceOf(weights, termCountsOf(rankedText(text)));
}

/**
 * `items` most relevant first, by the term counts of each, with ties kept in their given
 * order. The sort is stable, so a list that arrives newest first keeps the newest first among
 * equals: recency only breaks ties.
 */
export function rankByRelevance<T>(items: readonly T[], weights: TermWeights, countsOf: (item: T) => TermCounts): T[] {
  return items
    .map((item) => ({ item, score: relevanceOf(weights, countsOf(item)) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

/**
 * `text` on one line: every run of whitespace, line breaks included, becomes one space. A
 * line break in served text would split its line, or end the block early for a client that
 * reads the block up to its first blank line.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * `text` on one line, cut to `max` code points with an ellipsis when longer. Cut by code
 * point, so a character outside the Basic Multilingual Plane is never split.
 */
export function clip(text: string, max: number): string {
  const points = Array.from(oneLine(text));
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

/**
 * The distinct sentences of `text`, each where it first appears: its lines, each split after a
 * full stop, question or exclamation mark, on one line. A sentence that repeats is kept once,
 * so repeats neither fill a passage nor cost a scan. {@link bestPassage} serves a run of these.
 */
export function sentencesOf(text: string): string[] {
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const sentence = oneLine(part);
      if (sentence === "" || seen.has(sentence)) continue;
      seen.add(sentence);
      sentences.push(sentence);
    }
  }
  return sentences;
}

/**
 * The part of `text` most relevant to the task, on one line and at most `max` code points: the
 * run of consecutive sentences that fits and covers the most weight of the task's terms, each
 * term counted once, starting at a sentence that holds one. The earliest such run wins a tie. A
 * sentence that repeats is shown once. An ellipsis marks text left out before or after the run.
 * Only the first {@link TEXT_RANKED_CHARS} characters are read.
 *
 * When `text` holds none of the task's terms, or the task names none, this is `text`'s opening,
 * exactly as {@link clip} cuts it: an irrelevant record costs no more than its opening.
 */
export function bestPassage(text: string, weights: TermWeights, max: number): string {
  const ranked = rankedText(text);
  const cutShort = ranked.length < text.length;
  const opening = clip(cutShort ? `${ranked} …` : ranked, max);
  if (weights.byTerm.size === 0) return opening;
  // Every term is a lowercased stretch of the text it came from, so a sentence that holds none
  // of the task's terms as a substring holds none of them as a term, and is not tokenized.
  const taskTerms = [...weights.byTerm.keys()];
  const termsIn = (sentence: string) => {
    const lower = sentence.toLowerCase();
    return taskTerms.some((term) => lower.includes(term)) ? termsOf(sentence) : NO_TERMS;
  };
  const sentences = sentencesOf(ranked).map((sentence) => ({
    sentence,
    terms: termsIn(sentence),
    length: Array.from(sentence).length,
  }));
  if (!sentences.some(({ terms }) => weightOf(weights, terms) > 0)) return opening;

  let best = { score: 0, start: 0, end: 0 };
  for (let start = 0; start < sentences.length; start++) {
    if (weightOf(weights, sentences[start]!.terms) === 0) continue;
    const covered = new Set<string>();
    // Room for an ellipsis on each side, so a run never pushes the line past `max`.
    let length = -1;
    let end = start;
    for (; end < sentences.length; end++) {
      const added = sentences[end]!.length + 1;
      if (length + added > max - 4 && end > start) break;
      length += added;
      for (const term of sentences[end]!.terms) if (weights.byTerm.has(term)) covered.add(term);
    }
    const score = weightOf(weights, covered);
    if (score > best.score) best = { score, start, end };
  }

  const before = best.start > 0 ? "… " : "";
  const after = best.end < sentences.length || cutShort ? " …" : "";
  const body = sentences
    .slice(best.start, best.end)
    .map(({ sentence }) => sentence)
    .join(" ");
  // A single sentence longer than the room is cut, like any other line, and the cut's own
  // ellipsis already says that text follows. It is cut to the room left after both marks, not
  // only the leading one: cut to the larger room, a sentence that fits beside the leading mark
  // alone would be served whole and unmarked, as though it ended the text that goes on.
  const room = max - before.length - after.length;
  if (Array.from(body).length > room) return `${before}${clip(body, room)}`;
  return `${before}${body}${after}`;
}
