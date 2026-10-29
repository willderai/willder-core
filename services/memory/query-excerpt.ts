// Query-focused excerpts: the part of a long fact that answers the query, cut to a size.
//
// A retrieved fact can be far longer than the room left on a page (a pasted review, a
// long transcript turn). Cutting it to a prefix serves its opening and drops whatever
// the query was about whenever that sits later in the text. This picks the sentences
// that share the most terms with the query, plus their neighbours for context, keeps
// them in written order, and marks every gap with an ellipsis so an excerpt never
// reads as the whole fact.
//
// The one rule: an excerpt only ever removes text. It never reorders, rewrites or joins
// two sentences as if they were adjacent. Access and erasure are decided on the whole
// fact before this runs; nothing here can add content.

const GAP = " … ";
const LEAD = "… ";
const TAIL = " …";

/**
 * The marker shown after an excerpt's text wherever a person or a model reads it, so an
 * excerpt is never taken for the whole fact: ` [excerpt of N chars]`, with N the full
 * text's length (`MemoryFact.excerptOfChars`). Empty for a fact served whole.
 */
export function excerptMarker(fact: { excerptOfChars?: number }): string {
  return fact.excerptOfChars ? ` [excerpt of ${fact.excerptOfChars} chars]` : "";
}

/** Words too common to say anything about which sentence answers a query. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "with",
  "that",
  "this",
  "from",
  "what",
  "who",
  "whom",
  "which",
  "when",
  "where",
  "why",
  "how",
  "did",
  "does",
  "has",
  "have",
  "had",
  "not",
  "but",
  "you",
  "your",
  "our",
  "their",
  "its",
  "can",
  "will",
  "about",
  "into",
  "any",
  "all",
]);

interface Sentence {
  text: string;
  /** Lower-cased word tokens, for matching against query terms. */
  words: Set<string>;
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The query's terms worth matching on: numbers, and words of three or more letters that are not stopwords. */
export function queryTerms(query: string): string[] {
  return [...new Set(wordsOf(query).filter((w) => /^\p{N}+$/u.test(w) || (w.length >= 3 && !STOPWORDS.has(w))))];
}

/** Splits text at sentence ends (`.`, `!` or `?` followed by whitespace) and at line breaks. */
export function splitSentences(text: string): Sentence[] {
  return text
    .split(/(?<=[.!?]["')\]]*)\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, words: new Set(wordsOf(part)) }));
}

/** Joins sentences picked in written order (`order` ascending), marking every gap. */
function render(sentences: readonly Sentence[], order: readonly number[]): string {
  let out = order[0] > 0 ? LEAD : "";
  order.forEach((index, i) => {
    if (i > 0) out += index === order[i - 1] + 1 ? " " : GAP;
    out += sentences[index].text;
  });
  if (order[order.length - 1] < sentences.length - 1) out += TAIL;
  return out;
}

/**
 * Where the first of `terms` starts in `sentence`, as an index into `sentence` itself, or
 * 0 when none occurs. Terms are lower-case, so the search runs on the lower-cased text;
 * lower-casing can change a character's length (Turkish "İ" becomes two code units), so
 * each position there is mapped back to the character of the original that produced it.
 */
function firstTermIndex(sentence: string, terms: readonly string[]): number {
  const firstIn = (lower: string) => {
    const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
    return hits.length ? Math.min(...hits) : -1;
  };
  // No default lower-case mapping shortens a character, so an unchanged total length
  // means no character changed length and positions already line up.
  const lowered = sentence.toLowerCase();
  if (lowered.length === sentence.length) return Math.max(0, firstIn(lowered));
  // Otherwise map each position of the lower-cased text to the character it came from.
  // Lower-casing one character at a time gives the same lengths as the whole string
  // (the one context rule, Greek final sigma, swaps one letter for another).
  const originalAt: number[] = [];
  for (let i = 0; i < sentence.length; ) {
    const char = String.fromCodePoint(sentence.codePointAt(i)!);
    for (let k = char.toLowerCase().length; k > 0; k--) originalAt.push(i);
    i += char.length;
  }
  const hit = firstIn(lowered);
  return hit >= 0 ? originalAt[hit] : 0;
}

/** Whether a cut at `index` would separate the two halves of a surrogate pair (one emoji, one rare CJK character). */
function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Cuts one sentence that is longer than `maxChars` to a window starting near its first
 * query term, at word boundaries where there are any and never inside a character,
 * marked as cut on each side that lost text.
 */
function windowOfSentence(
  sentence: string,
  terms: readonly string[],
  maxChars: number,
  textBefore: boolean,
  textAfter: boolean,
): string {
  const anchor = firstTermIndex(sentence, terms);
  const room = maxChars - LEAD.length - TAIL.length;
  if (room <= 0) return "";
  let start = Math.max(0, anchor - Math.floor(room / 4));
  // Start after a space only when one lies before the term: in text written without
  // spaces, the next one can be far past it.
  const spaceAfterStart = sentence.indexOf(" ", start);
  if (start > 0 && spaceAfterStart >= 0 && spaceAfterStart < anchor) start = spaceAfterStart + 1;
  if (splitsPair(sentence, start)) start += 1;
  let end = Math.min(sentence.length, start + room);
  // End at a space only when one lies after the term, for the same reason.
  const spaceBeforeEnd = sentence.lastIndexOf(" ", end);
  if (end < sentence.length && spaceBeforeEnd > Math.max(start, anchor)) end = spaceBeforeEnd;
  if (splitsPair(sentence, end)) end -= 1;
  const lead = start > 0 || textBefore ? LEAD : "";
  const tail = end < sentence.length || textAfter ? TAIL : "";
  return `${lead}${sentence.slice(start, end).trim()}${tail}`;
}

/**
 * Returns at most `maxChars` characters of `text` that best answer `query`.
 *
 * Text that already fits is returned unchanged. Otherwise sentences are taken in order
 * of how many distinct query terms they contain (earlier first on a tie), each followed
 * by the sentence before and after it while they fit. A query that matches nothing
 * yields the opening sentences. A single matching sentence longer than `maxChars` is cut
 * to a window around its first matching term. The result is empty only when `maxChars`
 * is too small to hold any marked text.
 */
export function excerptForQuery(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return "";
  const terms = queryTerms(query);
  const scores = sentences.map((s) => terms.filter((t) => s.words.has(t)).length);
  const ranked = sentences
    .map((_, index) => index)
    .filter((index) => scores[index] > 0)
    .sort((a, b) => scores[b] - scores[a] || a - b);
  // With no match, the opening sentences, in order, are the honest default.
  const seeds = ranked.length ? ranked : sentences.map((_, index) => index);

  // `picked` stays sorted, and `length` is what render() would return for it, kept up
  // to date per insertion so a fact with thousands of matching sentences stays linear.
  const picked: number[] = [];
  let length = 0;
  const last = sentences.length - 1;
  const separator = (a: number, b: number) => (b === a + 1 ? 1 : GAP.length);
  /** Adds `index` if it fits; returns whether it is picked afterwards. */
  const tryAdd = (index: number): boolean => {
    if (index < 0 || index > last) return false;
    let at = 0;
    let hi = picked.length;
    while (at < hi) {
      const mid = (at + hi) >> 1;
      if (picked[mid] < index) at = mid + 1;
      else hi = mid;
    }
    if (picked[at] === index) return true;
    const prev = at > 0 ? picked[at - 1] : undefined;
    const next = at < picked.length ? picked[at] : undefined;
    let grown = length + sentences[index].text.length;
    if (prev === undefined && next === undefined) {
      grown += (index > 0 ? LEAD.length : 0) + (index < last ? TAIL.length : 0);
    } else if (prev === undefined) {
      grown += separator(index, next!) - (next! > 0 ? LEAD.length : 0) + (index > 0 ? LEAD.length : 0);
    } else if (next === undefined) {
      grown += separator(prev, index) - (prev < last ? TAIL.length : 0) + (index < last ? TAIL.length : 0);
    } else {
      grown += separator(prev, index) + separator(index, next) - separator(prev, next);
    }
    if (grown > maxChars) return false;
    picked.splice(at, 0, index);
    length = grown;
    return true;
  };
  for (const seed of seeds) {
    if (!tryAdd(seed)) {
      // An opening that skipped a sentence would read as continuous text; stop instead.
      if (!ranked.length) break;
      continue;
    }
    if (ranked.length) {
      tryAdd(seed - 1);
      tryAdd(seed + 1);
    }
    if (length === maxChars) break;
  }
  if (picked.length > 0) return render(sentences, picked);
  const first = seeds[0];
  return windowOfSentence(sentences[first].text, terms, maxChars, first > 0, first < sentences.length - 1);
}
