// Literal spans: the parts of a query the text leg can match on their own.
//
// The text leg (services/memory/text-match-fusion.ts) matches a query only when the whole
// query, words in order, is a run of a stored row. A reader rarely asks that way: "how did
// we resolve ECONNRESET on billing-api?" holds two strings a stored row would hold
// verbatim, an error code and a service name, inside words no row holds in that order. The
// vector legs read such a query by what it is about, so every row on the same subject ranks
// near it; the literal strings are what tells the asked row apart.
//
// This module picks those strings out of a query: quoted text, and tokens shaped like code
// (identifiers, paths, flags, error codes, numbers, ids). Each is matched on its own,
// through the same trigram index and inside the same visibility predicate as the quote
// (services/memory/pgvector-store.ts), and the rows that hold the most of them rank first in
// the text leg's ranking, fused into the read by the same reciprocal rank fusion.
//
// Behind RETRIEVAL_TEXT_SPANS, default off: with the flag off no span is matched and every
// read is ordered exactly as before.

import { splitWords, wordsInOrderPattern } from "./text-match-fusion";

export const TEXT_SPANS_FLAG = "RETRIEVAL_TEXT_SPANS";

/** Whether the text leg matches a query's literal spans too (RETRIEVAL_TEXT_SPANS). Default off. */
export function textSpansEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env[TEXT_SPANS_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/** The most spans one query is matched by: each is one indexed probe. */
export const MAX_SPANS = 6;

/**
 * What a span needs: three letters or digits in a row. The trigram index looks a pattern up
 * by the trigrams of its words, and a word of one or two characters has none of its own:
 * `v1.2.3` or `a-b-c` would make the index hand back every row of the table to recheck.
 */
const TRIGRAM_RUN = /[\p{L}\p{N}]{3}/u;

/**
 * The longest span matched, in code points; a longer quote is matched by its opening, cut
 * at the last whole word.
 */
const MAX_SPAN_CODE_POINTS = 120;

/** Quoted text: straight or curly double quotes, backticks, curly single quotes, and straight single quotes not inside a word. */
const QUOTED = /"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`|‘([^’\n]+)’|(?<![\p{L}\p{N}])'([^'\n]+)'(?![\p{L}\p{N}])/gu;

/** Punctuation that wraps a token in prose rather than belonging to it. */
const LEADING_WRAP = /^[([{<"'`“‘,;:!?.]+/u;
const TRAILING_WRAP = /[)\]}>"'`”’,;:!?.]+$/u;

/**
 * Shapes of a token a stored row would hold verbatim and prose words seldom have: a
 * separator inside it (`_ / \ = :: ->`, a dot or a hyphen between letters or digits), a
 * leading `-` (a flag), `$ # @` (a variable, an issue, a handle), an inner capital
 * (camelCase), a digit, or three or more capitals.
 */
const CODE_SHAPES: readonly RegExp[] = [
  /[_/\\=]|::|->/u,
  /[\p{L}\p{N}][.\-][\p{L}\p{N}]/u,
  /^-{1,2}\p{L}/u,
  /^[$#@][\p{L}\p{N}]/u,
  /\p{Ll}\p{Lu}/u,
  /\p{N}/u,
  /^\p{Lu}[\p{Lu}\p{N}]{2,}$/u,
];

/** Whether `token`, its wrapping punctuation stripped, is shaped like code in a query written in `query`'s case. */
function isLiteralToken(token: string, shouting: boolean): boolean {
  if (!TRIGRAM_RUN.test(token)) return false;
  return CODE_SHAPES.some((shape, i) => !(shouting && i === CODE_SHAPES.length - 1) && shape.test(token));
}

/**
 * The literal spans of `query`, in the order they appear: each quoted text, then each token
 * outside quotes shaped like code (CODE_SHAPES). A span is kept when it holds three letters
 * or digits in a row (TRIGRAM_RUN); a repeat, ignoring case, is dropped; at most MAX_SPANS
 * are returned. A query in plain prose has none.
 */
export function extractLiteralSpans(query: string): string[] {
  const spans: string[] = [];
  const seen = new Set<string>();
  const add = (span: string) => {
    const folded = span.toLowerCase();
    if (seen.has(folded)) return;
    seen.add(folded);
    spans.push(span);
  };
  for (const match of query.matchAll(QUOTED)) {
    const inner = splitWords(match.slice(1).find((g) => g !== undefined) ?? "").join(" ");
    const span = cutToWholeWords(inner);
    if (TRIGRAM_RUN.test(span)) add(span);
  }
  const prose = query.replace(QUOTED, " ");
  const letters = prose.match(/\p{L}/gu) ?? [];
  const shouting = letters.length > 0 && letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase());
  for (const word of splitWords(prose)) {
    const token = word.replace(LEADING_WRAP, "").replace(TRAILING_WRAP, "");
    if (Array.from(token).length <= MAX_SPAN_CODE_POINTS && isLiteralToken(token, shouting)) add(token);
  }
  return spans.slice(0, MAX_SPANS);
}

/**
 * `text` (words joined by single spaces) cut to MAX_SPAN_CODE_POINTS code points; a word the
 * cut would split is left out, so the span still ends where a stored word ends.
 */
function cutToWholeWords(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_SPAN_CODE_POINTS) return text.trim();
  const cut = chars.slice(0, MAX_SPAN_CODE_POINTS).join("");
  return (chars[MAX_SPAN_CODE_POINTS] === " " ? cut : cut.replace(/\S+$/u, "")).trim();
}

/** A span's first or last character is a letter or digit, so it must not run on into a longer word there. */
const ALNUM_EDGE = /^[\p{L}\p{N}]$/u;
/** A character that ends a word: not a letter, a digit, `_` or `-`, which join the parts of an identifier. */
const PG_NOT_WORD = "[^[:alnum:]_-]";

/**
 * A Postgres regular expression (for `~*`) matching text that holds `span` as written,
 * ignoring case and how the whitespace inside it is spelled, and not as part of a longer
 * word or identifier: `8080` does not match `18080`, nor `p95` `p950`, nor `billing-api`
 * `billing-api-v2`.
 */
export function literalSpanPattern(span: string): string {
  const chars = Array.from(span);
  const body = wordsInOrderPattern(splitWords(span));
  const head = ALNUM_EDGE.test(chars[0] ?? "") ? `(^|${PG_NOT_WORD})` : "";
  const tail = ALNUM_EDGE.test(chars.at(-1) ?? "") ? `($|${PG_NOT_WORD})` : "";
  return `${head}${body}${tail}`;
}

/**
 * How many rows may hold a span before it stops telling rows apart. A span more readable
 * rows hold than this is dropped from the read, as the quote is past its limit.
 */
export function spanMatchCap(limit: number): number {
  return Math.max(30, limit * 3);
}

/**
 * How many rows only spans found enter the text leg's ranking, the best first. A span the
 * reader mentions in passing ("around the time of INC-2265") points at rows the question is
 * not about, and reciprocal rank fusion lifts every row the text ranking holds above the
 * read's own best: this bounds how far such a span can push the asked row down. Rows past it
 * still compete by their own similarity. Chosen on the tune half of a development query set
 * (not in this repository): 1 scored best there, by one query; 3 keeps
 * room for a phrase several rows hold.
 */
export const SPAN_RANKING_DEPTH = 3;

/**
 * A query whose literal spans hold less than this share of its letters and digits is mostly
 * prose: its spans may be mentioned in passing ("…around the time of INC-2265").
 */
export const PROSE_SPAN_SHARE = 0.2;

/** How far below the read's best similarity a row only spans found may be, in a query mostly in prose. */
export const PROSE_SIMILARITY_MARGIN = 0.1;

const ALNUM = /[\p{L}\p{N}]/gu;
const alnumCount = (text: string) => text.match(ALNUM)?.length ?? 0;

/**
 * Whether a row only spans found, at similarity `s` to the query, may enter the text leg's
 * ranking, where `top` is the best similarity among the read's candidates. In a query mostly
 * in prose (spans under PROSE_SPAN_SHARE of its letters and digits) the row must be within
 * PROSE_SIMILARITY_MARGIN of `top`: a span named in passing points at rows on another subject,
 * which sit far below the read's best, while a row the question is about sits near it. A
 * query that is mostly literal (a quote, an id, a number with few words around it) has no
 * floor. Both constants were chosen on the tune half of a development query set
 * (not in this repository).
 */
export function spanSimilarityFloor(query: string, top: number): (s: number) => boolean {
  let prose: boolean | undefined;
  return (s) => {
    prose ??=
      extractLiteralSpans(query).reduce((n, span) => n + alnumCount(span), 0) / Math.max(1, alnumCount(query)) <
      PROSE_SPAN_SHARE;
    return !prose || s >= top - PROSE_SIMILARITY_MARGIN;
  };
}

/** A probe left less time than this is not started. */
const MIN_PROBE_MS = 5;

/** The least time a probe is given while that much is left: a fair share is never cut below it. */
const MIN_FAIR_SHARE_MS = 25;

/**
 * The statement timeout for the next of `remaining` probes when `leftMs` of the leg's budget
 * is left: an equal share of what is left, at least MIN_FAIR_SHARE_MS and at most `leftMs`.
 * Null when less than MIN_PROBE_MS is left, and the probe is not run. An unused share passes
 * on to the probes after it, because each share is taken from what is left.
 */
export function probeBudgetMs(leftMs: number, remaining: number): number | null {
  const left = Math.floor(leftMs);
  if (left < MIN_PROBE_MS) return null;
  return Math.min(left, Math.max(MIN_FAIR_SHARE_MS, Math.floor(left / Math.max(1, remaining))));
}

/**
 * The order to probe `spans` in, as indexes: the most letters and digits first, a longer
 * literal having more trigrams for the index to narrow by; ties keep the query's order.
 */
export function mostSelectiveFirst(spans: readonly string[]): number[] {
  return spans
    .map((span, i) => ({ i, n: alnumCount(span) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(({ i }) => i);
}

/** What the span probes found for one row: how many of the read's spans it holds, and their summed rarity. */
export interface SpanHit {
  spans: number;
  weight: number;
}

/**
 * Each row's hits from the rows each span matched (`matches[i]`, the ids span i found, at
 * most cap + 1). A span that matched more than `cap` rows is ignored. A row's weight sums
 * 1 / (rows the span matched) over the spans it holds, so a rarer span counts for more.
 */
export function spanHits(matches: readonly (readonly string[])[], cap: number): Map<string, SpanHit> {
  const hits = new Map<string, SpanHit>();
  for (const ids of matches) {
    if (ids.length === 0 || ids.length > cap) continue;
    for (const id of new Set(ids)) {
      const hit = hits.get(id) ?? { spans: 0, weight: 0 };
      hits.set(id, { spans: hit.spans + 1, weight: hit.weight + 1 / ids.length });
    }
  }
  return hits;
}

/** Orders two span hits, more spans first, then the rarer. */
export function compareSpanHits(a: SpanHit | undefined, b: SpanHit | undefined): number {
  return (b?.spans ?? 0) - (a?.spans ?? 0) || (b?.weight ?? 0) - (a?.weight ?? 0);
}
