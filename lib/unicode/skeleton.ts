// The confusable skeleton of a string (Unicode UTS #39, section 4): the form two strings
// share when a reader cannot tell them apart by eye. "Ѕystem" with a Cyrillic Ѕ, "ｓｙｓｔｅｍ"
// in fullwidth letters, and "sys​tem" with a zero-width space all have the skeleton of
// "system".
//
// The rule this module enforces: any comparison of names a person reads goes through the
// official Unicode data, never a hand-picked list of lookalikes, so a lookalike nobody
// thought of is caught the same as the ones somebody did. The data is
// lib/unicode/confusables.json, generated from one pinned release of confusables.txt by
// scripts/generate-confusables.mjs (source, version and SHA-256 are recorded in the JSON).
import confusables from "./confusables.json";

const PROTOTYPES: Readonly<Record<string, string>> = confusables.prototypes;

/** Unicode release of the confusables data the skeleton maps with. */
export const CONFUSABLES_VERSION: string = confusables.version;

// Built at runtime: the project's compile target predates regex property escapes.
const INVISIBLE = new RegExp("[\\p{Default_Ignorable_Code_Point}\\p{Cf}]", "gu");

/**
 * The UTS #39 skeleton of `text`, after NFKC: compatibility forms folded (fullwidth,
 * ligatures), default-ignorable and format characters removed (zero-width spaces and
 * joiners, bidi controls), and every confusable character replaced by its prototype.
 *
 * Case is kept, as UTS #39 specifies: a capital Cyrillic Н looks like Latin H only as a
 * capital. Lowercasing the result is not a case-insensitive comparison: "m" maps to "rn"
 * and "M" does not. Callers ignoring case also compare the skeleton of the lowercased text.
 */
export function confusableSkeleton(text: string): string {
  const visible = text.normalize("NFKC").normalize("NFD").replace(INVISIBLE, "");
  let mapped = "";
  for (const char of visible) mapped += PROTOTYPES[char] ?? char;
  return mapped.normalize("NFD");
}
