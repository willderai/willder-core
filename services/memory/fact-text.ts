// Normalising a fact's text so two spellings of one claim share a key.
//
// Two readers need the same key for different reasons: the hybrid store collapses a
// distilled fact and the raw chunk it came from into one answer
// (services/memory/hybrid-store.ts), and the supersede filter recognises a graph fact as
// a version Postgres has recorded as superseded (services/memory/superseded-facts.ts).
// They must agree, so the rule lives here once.

// Punctuation and control/format characters, in any script: the parts of a sentence
// that do not change the claim it makes. Marks (\p{M}) are kept because in Arabic,
// Hebrew and the Indic scripts they are part of the letter, and symbols (\p{S}, which
// includes emoji and currency) are kept because they carry meaning the surrounding
// words do not repeat.
const FACT_PUNCTUATION = /[\p{P}\p{C}]+/gu;

/** Whitespace in any script, including the Unicode separators `\s` misses. */
const FACT_WHITESPACE = /[\s\p{Z}]+/gu;

/**
 * Normalise a fact string so two spellings of the same claim share one key: compose to
 * NFKC, case-fold, strip punctuation by Unicode category, collapse whitespace.
 *
 * Script-agnostic on purpose. An ASCII allowlist (`[^a-z0-9 ]`) folded every fact
 * written in Chinese, Japanese, Korean, Cyrillic, Greek, Arabic or Hebrew to the empty
 * string, so all of them shared one key and a hybrid read kept only the first.
 *
 * A fact made entirely of punctuation still normalises to nothing, so it falls back to
 * its own case-folded text rather than joining that same empty bucket.
 */
export function normalizeFactText(text: string): string {
  const normalised = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(FACT_PUNCTUATION, " ")
    .replace(FACT_WHITESPACE, " ")
    .trim();
  return normalised || text.normalize("NFKC").toLowerCase().trim();
}
