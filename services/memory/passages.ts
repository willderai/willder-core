// Passages: the windows a long memory row is cut into, so vector search sees all of it.
//
// The embedding model (bge-small-en-v1.5, memory-service/app/config.py) reads at most 512
// tokens, about 2,000 characters of English, and silently drops the rest. One embedding
// per row therefore leaves the second half of a long row invisible to vector search. A
// row longer than one passage is also stored as overlapping passages, each embedded on
// its own (`memory_chunk_passages`), and a search can find the row by its best passage
// (services/memory/passage-ranking.ts says where such a row is placed).
//
// The rule this module enforces: the passages of a row cover it from its first
// character, in order, each at most PASSAGE_CHARS long, up to MAX_PASSAGES_PER_ROW of
// them; a row that fits in one passage has none, because its own embedding already
// reads all of it.

/**
 * The longest passage, in UTF-16 code units. Short, so that a one-sentence answer is a
 * large part of its passage's embedding instead of being averaged away by what surrounds
 * it. Chosen by measurement: on a passage-recall benchmark (answers past
 * character 2,500 of 4,400-character chat rows), 500 found the answer in the top 10 for
 * 0.81 of questions, against 0.69 at 1,500 and 0.42 with no passages (ranked by the
 * better score; with the interleaved ranking, 0.89 at 500); and on a
 * 20,000-row org of long rows, with the HNSW index, the read's p95 stays within 60 ms of
 * a search without passages (the largest size tried, 1,500, adds nothing; the bar was
 * 100 ms). Changing it changes how existing rows were cut; rerun
 * scripts/backfill-passage-embeddings.ts after deleting their passages.
 */
export const PASSAGE_CHARS = 500;

/** How far each passage reaches back into the one before it, at most. */
export const PASSAGE_OVERLAP_CHARS = 100;

/**
 * The most passages one row gets: its first 32, about 12,900 characters. A longer row
 * (a pasted transcript can run to hundreds of thousands of characters) would otherwise
 * cost hundreds of embeddings on one write. Past that, the row is searchable only by
 * what its own embedding and its first passages read, as every row was before passages.
 */
export const MAX_PASSAGES_PER_ROW = 32;

/** One window of a row's content, by its UTF-16 offsets into that content. */
export interface Passage {
  start: number;
  end: number;
  text: string;
}

/** A cut this close to a passage's start would waste most of the window, so it is not taken. */
const MIN_CUT = PASSAGE_CHARS / 2;

const SENTENCE_END = /[.!?…]["')\]]*(?=\s)|\n/g;
const WHITESPACE = /\s/g;

/**
 * Cut `content` into overlapping passages, at most MAX_PASSAGES_PER_ROW of them, from
 * its start. Each passage ends at the last sentence end inside its window, else at the
 * last space, else at the window's length; the next one starts about
 * PASSAGE_OVERLAP_CHARS earlier, moved forward to the start of a sentence or word.
 * Returns [] when the content fits in one passage.
 */
export function splitPassages(content: string): Passage[] {
  if (content.length <= PASSAGE_CHARS) return [];
  const passages: Passage[] = [];
  let start = 0;
  for (;;) {
    const end = cutAt(content, start);
    passages.push({ start, end, text: content.slice(start, end) });
    if (end === content.length || passages.length === MAX_PASSAGES_PER_ROW) return passages;
    start = nextStart(content, end);
  }
}

/** Where the passage starting at `start` ends. */
function cutAt(content: string, start: number): number {
  const limit = start + PASSAGE_CHARS;
  if (limit >= content.length) return content.length;
  const window = content.slice(start, limit);
  const cut = lastMatchEnd(window, SENTENCE_END) ?? lastMatchEnd(window, WHITESPACE) ?? PASSAGE_CHARS;
  return keepSurrogatePair(content, start + cut, -1);
}

/** Where the passage after the one ending at `end` starts: always after the previous start. */
function nextStart(content: string, end: number): number {
  const from = end - PASSAGE_OVERLAP_CHARS;
  const overlap = content.slice(from, end);
  for (const boundary of [SENTENCE_END, WHITESPACE]) {
    const offset = firstMatchEnd(overlap, boundary);
    if (offset === undefined) continue;
    // A passage starts at the next word, not at the whitespace before it.
    const start = from + offset + leadingSpace(overlap.slice(offset));
    if (start < end) return start;
  }
  return keepSurrogatePair(content, from, +1);
}

/** The end offset of the last match of `pattern` past MIN_CUT, if any. */
function lastMatchEnd(window: string, pattern: RegExp): number | undefined {
  let found: number | undefined;
  for (const match of window.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (end > MIN_CUT) found = end;
  }
  return found;
}

/** The end offset of the first match of `pattern`, if any. */
function firstMatchEnd(text: string, pattern: RegExp): number | undefined {
  for (const match of text.matchAll(pattern)) return match.index + match[0].length;
  return undefined;
}

function leadingSpace(text: string): number {
  return text.length - text.trimStart().length;
}

/** Move `offset` by `step` when it would split a surrogate pair. */
function keepSurrogatePair(content: string, offset: number, step: -1 | 1): number {
  const code = content.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff ? offset + step : offset;
}
