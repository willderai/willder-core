// Markdown shaping for connectors, before a document reaches extraction.
//
// Repository READMEs are hard-wrapped: one sentence runs across two or three
// physical lines. Extraction and the memory service's verbatim-passage
// fallback both read a document line by line, so a wrapped sentence arrives as
// fragments cut mid-sentence, and a long document handed over as one episode
// comes back with facts for only a handful of its lines. The rule this module
// enforces: every sentence reaches extraction whole, inside a section small
// enough that extraction covers all of it.

/** A line that starts a new markdown block instead of continuing a paragraph. */
const BLOCK_START = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<)/;
const CODE_FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * Join soft-wrapped lines so each paragraph or list item sits on one line.
 * Headings, list items, quotes, table rows and HTML each start a new line;
 * blank lines are kept as paragraph breaks; fenced code is left untouched.
 */
export function unwrapMarkdown(markdown: string): string {
  const out: string[] = [];
  let inCode = false;
  let continuable = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (CODE_FENCE.test(raw)) inCode = !inCode;
    if (inCode || CODE_FENCE.test(raw)) {
      out.push(raw);
      continuable = false;
      continue;
    }
    const line = raw.trim();
    if (!line) {
      out.push("");
      continuable = false;
    } else if (continuable && !BLOCK_START.test(raw)) {
      out[out.length - 1] += ` ${line}`;
    } else {
      out.push(BLOCK_START.test(raw) ? raw.trimEnd() : line);
      continuable = !HEADING.test(raw);
    }
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split unwrapped markdown into sections at headings outside code fences,
 * then pack neighbouring sections together while they fit in `targetChars`.
 * A single section longer than the target stays whole; the caller decides how
 * to bound it.
 */
export function splitMarkdownSections(markdown: string, targetChars: number): string[] {
  const sections: string[][] = [[]];
  let inCode = false;
  for (const line of markdown.split("\n")) {
    if (CODE_FENCE.test(line)) inCode = !inCode;
    if (!inCode && HEADING.test(line) && sections.at(-1)!.some((l) => l.trim())) sections.push([]);
    sections.at(-1)!.push(line);
  }

  const packed: string[] = [];
  for (const section of sections.map((lines) => lines.join("\n").trim()).filter(Boolean)) {
    const last = packed.at(-1);
    if (last !== undefined && last.length + section.length + 2 <= targetChars) {
      packed[packed.length - 1] = `${last}\n\n${section}`;
    } else {
      packed.push(section);
    }
  }
  return packed;
}
