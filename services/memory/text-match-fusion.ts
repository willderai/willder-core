// The text leg of a read, and how its ranking is fused with the others.
//
// Vector search ranks a stored row by what it is about, and the graph by the relations
// extracted from it. Neither ranks a row by whether it holds the words a reader asked
// with, so a reader who quotes a stored line back ("Findings T-4c378528: Cause is ...")
// can get ten rows on the same subject before the one that says it, in a scope full of
// similar rows. The text leg finds the rows that hold the query's words in order, ignoring
// case and how the whitespace between them is spelled, through a trigram index on
// memory_chunks.content (services/memory/pgvector-store.ts, inside the same visibility
// predicate as the vector legs). Its ranking is fused with the read's own ranking by
// reciprocal rank fusion.
//
// The rule this module enforces: a ranking fused with an empty text ranking is returned
// unchanged, so a read whose query quotes nothing is ordered exactly as before.

/** Words a query needs before the text leg runs: a quoted line, not a keyword. */
const MIN_QUOTED_WORDS = 4;

/**
 * Characters other than whitespace a query needs before the text leg runs. Below this the
 * words are too short for the trigram index to narrow the search, and every row of the
 * org would be read.
 */
const MIN_QUOTED_CHARACTERS = 20;

/**
 * The longest quote matched, in code points: a change summary's length
 * (services/memory/change-events.ts). A longer query is matched by its first this many; a
 * regular expression grows faster than its length, and past a few thousand words Postgres
 * refuses to build it.
 */
const QUOTE_MAX_CODE_POINTS = 200;

/**
 * What separates two words of a quote: any run of whitespace and control characters, the
 * characters a change summary folds into one space (services/memory/change-events.ts
 * summarizeChange), so a line quoted from its summary still matches the stored text.
 */
const WORD_BREAK = /[\u0000-\u001f\u007f\s]+/u;
/**
 * The same set in Postgres: its own space and control classes, which on some locales leave
 * out the Unicode spaces, plus every character outside ASCII that JavaScript's `\s` holds,
 * written literally.
 */
const PG_BREAK_CHARACTERS = "[:space:][:cntrl:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const PG_WORD_BREAK = `[${PG_BREAK_CHARACTERS}]+`;

/** ASCII punctuation, every character a Postgres advanced regular expression may treat as an operator. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/gu;

/**
 * A Postgres regular expression (for `~*`) matching text that holds `query`'s words in
 * order, separated by whitespace, or null when `query` is not a quote. A short query is a
 * keyword: every row that names it holds it, so the text leg could not tell them apart,
 * and the vector and graph legs already answer it. Every word is matched literally; a last
 * word cut short (a query cut at a length) matches the start of the stored word; a lone
 * surrogate left by such a cut is dropped. A query longer than QUOTE_MAX_CODE_POINTS is
 * matched by its opening.
 */
export function quotedTextPattern(query: string): string | null {
  const quote = Array.from(query)
    .slice(0, QUOTE_MAX_CODE_POINTS)
    .join("")
    .replace(/[\ud800-\udbff]$/u, "");
  const words = quote.split(WORD_BREAK).filter((word) => word !== "");
  if (words.length < MIN_QUOTED_WORDS || words.join("").length < MIN_QUOTED_CHARACTERS) return null;
  return words.map((word) => word.replace(ASCII_PUNCTUATION, "\\$&")).join(PG_WORD_BREAK);
}

/**
 * The same expression anchored to the start of the text, after any leading whitespace: a
 * row that opens with the quote ranks ahead of one that holds it further in.
 */
export function opensWithPattern(pattern: string): string {
  return `^[${PG_BREAK_CHARACTERS}]*${pattern}`;
}

/** Reciprocal rank fusion's constant: rank r scores 1 / (RRF_K + r). 60 is the usual value. */
const RRF_K = 60;

/**
 * Fuses `ranking` with `textRanking`, the text leg's order of some of the same items,
 * by reciprocal rank fusion: each item scores 1 / (RRF_K + rank) in every ranking it is
 * in, ranks counted from 1, and items are returned by total score. Ties keep `ranking`'s
 * order, so with an empty `textRanking` the result is `ranking` itself. An item of
 * `textRanking` that `ranking` lacks is ignored: fusion reorders a read, it never adds to it.
 */
export function fuseTextRanking<T>(ranking: readonly T[], textRanking: readonly T[]): T[] {
  if (textRanking.length === 0) return [...ranking];
  const textRank = new Map(textRanking.map((item, i) => [item, i + 1]));
  const score = (item: T, rank: number) => {
    const inText = textRank.get(item);
    return 1 / (RRF_K + rank) + (inText === undefined ? 0 : 1 / (RRF_K + inText));
  };
  return ranking
    .map((item, i) => ({ item, place: i, score: score(item, i + 1) }))
    .sort((a, b) => b.score - a.score || a.place - b.place)
    .map(({ item }) => item);
}
