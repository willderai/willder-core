/**
 * The suppression list a person erasure leaves behind, and the check a
 * connector sync makes against it before writing anything.
 *
 * The rule this file enforces: once a person is erased from an org, a
 * connector sync never writes content naming them back into that org. Erasure
 * removes what is already stored; this list is what stops a re-sync of a
 * changed Slack message, Figma comment or Drive file from undoing it.
 *
 * The list holds a SHA-256 digest of each erased email address, full name,
 * contact id and stored version id, bound to the org, never the value itself. A digest of a guessable value is
 * not anonymous, but it lets the org recognize the person without keeping a
 * readable copy of what it was asked to forget.
 *
 * Matching follows the erasure's own rules (services/memory/person-erasure.ts) as far as
 * digests allow, reading names by the same characters (services/memory/person-name-characters.ts);
 * services/memory/erasure-rule-agreement.realdb.test.ts runs one table of cases through
 * both, and they agree on every row.
 *  - Text, names and addresses are compared folded as the erasure compares them
 *    (services/memory/person-name-characters.ts, foldName): letters Unicode assigned after
 *    15.0 read from one list, compatibility forms folded (NFKC), lowercased, "i" and a combining dot above (the Turkish "İ") read as "i",
 *    composed (NFC), a final sigma read as "σ", a curly apostrophe straight, so "Zoe\u0308"
 *    with a combining accent is "Zoë", a fullwidth "Ｄａｎａ" is "dana" and "WHİTFİELD" is
 *    "whitfield". Names recorded before the fold read "İ" and "ς" so are still found
 *    ({@link foldedAsRecordedBefore}).
 *  - An email is matched as a whole address found in the text, in any case.
 *  - A name is matched only when it has at least two words, as a stretch of text that
 *    starts and ends at a word's edge and is the name once lowercased and each run of
 *    whitespace made one space ("Dana Whitfield's" and "DANA  WHITFIELD" both match "Dana
 *    Whitfield"). A hyphen joining two words or a combining accent continues a word, so "Dana
 *    Whitfield-Barnes" and "Ana Dana-Whitfield" are other people, while a bullet dash
 *    ("-Dana Whitfield") or a modifier ("Dana Whitfield-approved") is not. A name written
 *    surname first in text is not matched, as in the erasure: read that way, a list of
 *    people ("Wei Li, Ann Chen") would name "Ann Li".
 *  - A name is also matched with its words joined by `_`, `.`, a hyphen or a camel-case step,
 *    as file names and addresses write it ("Dana_Whitfield_offer.pdf",
 *    "DanaWhitfield offer.pdf", "Dana Whitfield2.pdf"), by the rules of
 *    services/memory/person-name-characters.ts, joinedNamePattern. "Danaher",
 *    "Dana/Whitfield", "Dana_Whitfield-Barnes_CV.pdf" and her words joined by hyphens alone
 *    ("dana-whitfield.pdf", "(Dana-Whitfield, 2019)", "jean-pierre dupont") are other people.
 *    Text is read after markWordSteps and, when that changes it, also as folded
 *    ({@link joinedNameStretches}).
 *  - A name is also matched run together with nothing between its words, when that is at least
 *    6 characters ("danawhitfield", "DANAWHITFIELD", "RoryMcDonald2026"), at the same edges
 *    (person-name-characters.ts, concatenatedNames); under 8 characters, only beside an "@"
 *    ("kitchen@x.com", never "in the kitchen." or "window_start"; concatenatedStretches). Erasures recorded before these digests
 *    existed do not match it.
 *  - Names recorded before these rules (kind "name") were digests of letters and digits
 *    only. They still match a stretch whose letters and digits are the name, so a hyphen,
 *    accent or slash inside the stretch does not hide the person from an older erasure.
 *  - A record's own name (the entity a chunk is filed under, a contact's name) is matched
 *    only as the person's whole name, however it is spaced, or surname first, or their
 *    whole address, or her whole name written without spaces ("dana_whitfield",
 *    "DanaWhitfield"), as the erasure's recordNamePatterns decides. Erasures recorded before
 *    these digests existed are not matched by a record's name.
 *  - A contact without an address is matched only by its id: the erasure removed the
 *    contacts it linked by id, address or graph entity, never by name, and a restored row
 *    keeps its id. Erasures recorded before contact-id digests existed match no such
 *    contact.
 *  - A stored version (a fact's chunk row, a connector item's episode) is matched by its own
 *    id when the erasure removed it: one that named the person, and one written in place of
 *    an erased version, whose text need not name them at all
 *    (services/memory/erasure-lineage.ts). Erasures recorded before version-id digests
 *    existed match no version by its id.
 *
 * Content written outside a connector sync (a person typed in by a member, a
 * contact created again on purpose) is not checked: that is a new, deliberate
 * act, not the old copy coming back. A file uploaded before an erasure is not new, however
 * late its text is extracted: the extraction checks its passages as of the upload's time
 * (lib/inngest/file-ingest.ts, storeFilePassages).
 *
 * The same list keeps a restored backup from undoing an erasure. A row written
 * at or before the latest erasure that named the person is an old copy by definition,
 * however it came back, so the read paths leave it out
 * (`loadErasedContentFilter`) and `reapplyErasures` removes it. A row written
 * after the erasure is the deliberate kind above and is served as usual.
 */

import { hash } from "node:crypto";
import { db } from "@/lib/db";
import { sqlUtcAt } from "@/lib/sql-utc-now";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import {
  CAMEL_STEP,
  compatibilityFolded,
  CONCATENATED_NAME_PROSE_MIN_LENGTH,
  concatenatedNames,
  foldName,
  joinedName,
  joinedNames,
  type JoinedName,
  NAME_DASH,
  markWordSteps,
  NAME_HYPHEN,
  NAME_INLINE_SPACE,
  NAME_JOINER,
  NAME_LETTER,
  NAME_MODIFIER_WORDS,
  NAME_SPACE,
  NAME_WORD as NAME_WORD_SOURCE,
  NEWER_LETTER_CHARACTERS,
  SHORT_RUN_MARK,
} from "./person-name-characters";

/** Answers whether a piece of text names a person erased from the org. */
export type ErasedPersonMatcher = (text: string) => boolean;

/**
 * What a digest is of:
 *  - "email": a whole address, lowercased.
 *  - "text_name": a full name as it is found in text: lowercased, each run of whitespace one
 *    space. Its word count bounds how long a stretch of text is worth hashing.
 *  - "joined_name": a full name as it is found written without spaces, recorded only when its
 *    own words hold a joining mark ("anne-marie dupont" as "anne marie dupont"): its words
 *    split at whitespace and joining marks, joined by one space
 *    (services/memory/person-name-characters.ts, joinedNameParts). Any other name has the
 *    same key as its "text_name", which a stretch is checked against too. Its word count is
 *    its runs of letters and digits.
 *  - "joined_run": a full name run together up to a hyphen of hers ("kimji woo" and "kimji-woo"
 *    for Kim Ji-woo; person-name-characters.ts, joinedNames), keyed as a "joined_name" is, and
 *    read only where no whitespace joins its words. Its word count is its runs of letters.
 *  - "concatenated_name": a full name's words run together with nothing between them
 *    ("danawhitfield", and "siobhano'brien" also as "siobhanobrien"), recorded only when that
 *    is at least 6 characters. Its word count is its length in characters: only a stretch of
 *    text that long can match it.
 *  - "name": a full name as erasures recorded it before "text_name": its letters and digits
 *    only, as words joined by one space. Matched, never written.
 *  - "record_name", "record_name_reversed": a full name as erasure matches a record's own
 *    name (services/memory/person-erasure.ts, recordNamePatterns), and a two-word name
 *    surname first. A record name that is an address is matched against "email".
 *  - "contact_id": the id of a contact row the erasure removed.
 *  - "version_id": the id of a stored version the erasure removed (a `memory_chunks` row, a
 *    connector item's graph episode, or a version already gone whose announcement named
 *    the person), so a restored copy is known by its id even when its text names nobody.
 *  - "rule_id": the id of a rule (a convention or decision) the erasure redacted
 *    (services/memory/erasure-rules.ts). Kept apart from "version_id" because a rule's
 *    replacements are followed through its own table, never through the walk over fact
 *    versions.
 * Names and addresses are folded (foldName) before they are hashed.
 */
type SuppressionKind =
  | "email"
  | "name"
  | "text_name"
  | "joined_name"
  | "joined_run"
  | "concatenated_name"
  | "record_name"
  | "record_name_reversed"
  | "contact_id"
  | "version_id"
  | "rule_id";

/** A letter, for a character class: `\p{L}` holds only those this engine's Unicode knows, so the letters Unicode added after 15.0 are listed too. */
const ANY_LETTER = `\\p{L}${NEWER_LETTER_CHARACTERS}`;

/** Whole addresses in running text: what the erasure's email check accepts. */
// Started only where an address can start, so a long run with no "@" is read once, not once per character.
const EMAIL_IN_TEXT = new RegExp(
  `(?<![${ANY_LETTER}\\p{N}._%+-])[${ANY_LETTER}\\p{N}._%+-]+@[${ANY_LETTER}\\p{N}-]+(?:\\.[${ANY_LETTER}\\p{N}-]+)*\\.[${ANY_LETTER}]{2,}`,
  "gu",
);

/** A word as erasure reads a name: letters and digits, and the hyphens that join them to more. */
const NAME_WORD = new RegExp(NAME_WORD_SOURCE, "gu");
const SPACE_RUN = new RegExp(`${NAME_SPACE}+`, "gu");
/**
 * Two or more runs of letters and digits joined by marks or apostrophes, and in marked text by
 * whitespace and word steps too. Started only at a word's first letter, so a long word is read
 * once, not once per letter.
 */
const JOINED_RUN = new RegExp(`(?<!${NAME_LETTER})${NAME_LETTER}+(?:(?:${NAME_JOINER}+|')${NAME_LETTER}+)+`, "gu");
const MARKED_JOINED_RUN = new RegExp(
  `(?<!${NAME_LETTER})${NAME_LETTER}+(?:(?:${NAME_JOINER}+|'|${NAME_SPACE}+|${CAMEL_STEP})${NAME_LETTER}+)+`,
  "gu",
);
/** A record's whole name written without spaces: runs joined by marks or apostrophes, and in marked text word steps. */
const WHOLE_JOINED = new RegExp(`^${NAME_LETTER}+(?:(?:${NAME_JOINER}+|')${NAME_LETTER}+)*$`, "u");
const MARKED_WHOLE_JOINED = new RegExp(`^${NAME_LETTER}+(?:(?:${NAME_JOINER}+|'|${CAMEL_STEP})${NAME_LETTER}+)*$`, "u");
const IS_LETTER = new RegExp(`^${NAME_LETTER}$`, "u");
const IS_DIGIT = /^[0-9]$/u;

/** The tails of `word` that start right after one of its digits ("dana" in "2026dana"), where marked text may start a name. */
function afterDigits(word: string): string[] {
  const chars = [...word];
  return chars.flatMap((char, i) => (i > 0 && IS_DIGIT.test(chars[i - 1]!) ? [chars.slice(i).join("")] : []));
}
/** A character that is not a lowercase letter or digit as NAME_LETTER reads one: the ones folding may change into one. */
const NOT_A_LETTER = new RegExp(`(?!${NAME_LETTER}).`, "gsu");
/** A joint between runs of letters, as the runs above hold one; captured, so splitting a run yields its words and joints in turn. */
const JOINT = new RegExp(`(${NAME_JOINER}+|'|${NAME_SPACE}+|${CAMEL_STEP})`, "u");
const IS_SPACE = new RegExp(`^${NAME_SPACE}$`, "u");
/** Whitespace holding a tab or a line break: it parts two entries, not two words of one name. */
const HAS_BREAK = new RegExp(`(?!${NAME_INLINE_SPACE})${NAME_SPACE}`, "u");
const IS_HYPHENS = new RegExp(`^${NAME_HYPHEN}+$`, "u");
const IS_DASH = new RegExp(`^${NAME_DASH}$`, "u");
/** A dash run that joins the word before it to the next ("-barnes", "\u2013barnes"), never to a modifier word. */
const DASH_JOIN = new RegExp(
  `${NAME_DASH}+(?!(?:${NAME_MODIFIER_WORDS.join("|")})(?!${NAME_LETTER}))${NAME_LETTER}`,
  "uy",
);
const MODIFIER_WORDS: ReadonlySet<string> = new Set(NAME_MODIFIER_WORDS);
const EDGE_SPACE = new RegExp(`^${NAME_SPACE}+|${NAME_SPACE}+$`, "gu");

function digest(orgId: string, kind: SuppressionKind, value: string): string {
  // One-shot hashing: the same digest as createHash("sha256").update(...).digest("hex"),
  // at half the cost, which matters when a long text is checked stretch by stretch.
  return hash("sha256", `${orgId}\0${kind}\0${value}`, "hex");
}

/** Text as both rules compare it (services/memory/person-name-characters.ts, foldName). */
const composed = foldName;

/** Lowercased text as both rules compare a name in it: each run of whitespace one space. */
const nameKey = (lowered: string): string => lowered.replace(SPACE_RUN, " ");

/** A lowercased record name as erasure compares it: {@link nameKey}, with no space at either end. */
const recordNameKey = (lowered: string): string => nameKey(lowered).replace(/^ | $/g, "");

/** A stretch of text as a "name" digest recorded before "text_name" holds it: its letters and digits as words. */
const legacyNameKey = (stretch: string): string => (stretch.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

/** A record name written surname first ("whitfield, dana", "whitfield,dana", "whitfield dana"), once keyed. */
const SURNAME_FIRST = /^([^ ,]+)(?:, ?| )([^ ,]+)$/u;

/**
 * Every distinct stretch of lowercased `text` of one to `maxWords` words that starts at a
 * word's first character and ends at a word's last, holding whatever lies between them as
 * written, each once, in the order it first appears. These are the only places the erasure's
 * name patterns can match: nothing that continues a name may sit on either side of one. A
 * stretch of one word is kept for "name" digests, whose words a hyphen used to split
 * ("anne-marie" was "anne marie"). A stretch that repeats would be hashed to the same digest
 * again, which can only find the same erasure again, so it is hashed once: a long text that
 * repeats its words costs what its distinct stretches cost.
 */
export function nameStretches(lowered: string, maxWords: number): string[] {
  const words = [...lowered.matchAll(NAME_WORD)];
  const stretches = new Set<string>();
  for (let first = 0; first < words.length; first++) {
    for (let last = first; last < Math.min(words.length, first + maxWords); last++) {
      stretches.add(lowered.slice(words[first]!.index, words[last]!.index + words[last]![0].length));
    }
  }
  return [...stretches];
}

/** Whether a dash run that a letter comes before ends right before `at` ("x-" in "x-dana"). */
function dashJoinsBefore(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && IS_DASH.test(text[i]!)) i--;
  return i < at - 1 && i >= 0 && IS_LETTER.test(text[i]!);
}

/** Whether a dash run at `at` joins the word before it to another ("-barnes" in "whitfield-barnes"). */
function dashJoinsAfter(text: string, at: number): boolean {
  DASH_JOIN.lastIndex = at;
  return DASH_JOIN.test(text);
}

/**
 * How a joint between two runs of letters reads: an apostrophe inside a word ("o'brien"),
 * whitespace within a line, whitespace holding a tab or a line break, a camel-case step, hyphens
 * alone, or any other run of joining marks ("_", ".", "_-").
 */
type Joint = "inside" | "space" | "break" | "step" | "hyphens" | "marks";

/** `joint`, one joint as {@link JOINT} splits a run at. */
function jointKind(joint: string): Joint {
  if (joint === "'") return "inside";
  if (joint === CAMEL_STEP) return "step";
  if (IS_SPACE.test(joint[0]!)) return HAS_BREAK.test(joint) ? "break" : "space";
  return IS_HYPHENS.test(joint) ? "hyphens" : "marks";
}

/**
 * A stretch {@link joinedNameStretches} found: its number of words, whether whitespace alone
 * joins them, whether hyphens alone do, and whether the text right after it differs from the folded text the spaced search
 * reads (a camel-case step, or a dash, which a modifier word may follow and end at a step).
 */
interface JoinedStretch {
  words: number;
  spaceOnly: boolean;
  hyphensOnly: boolean;
  /** Whether whitespace joins any two of its words: a name run together up to her hyphen never holds any. */
  anySpace: boolean;
  changedAfter: boolean;
}

/**
 * Which stretches joined by whitespace alone {@link joinedNameStretches} keeps: every one, or
 * those of a length in `words` and those the text changes after.
 */
type SpaceOnlyStretches = "all" | { words: ReadonlySet<number> };

/**
 * The key of words `first` to `last` of a run, as a "joined_name" or "text_name" digest holds
 * one: a joint of hyphens alone as "-", as only a name with a mark there can stand across one; a
 * tab or line break as "\n", as only a name with whitespace there can; any other joint as one
 * space; an apostrophe as written.
 */
function stretchKey(words: readonly string[], joints: readonly Joint[], first: number, last: number): string {
  let key = words[first]!;
  for (let i = first + 1; i <= last; i++) {
    const joint = joints[i - 1]!;
    key += (joint === "inside" ? "'" : joint === "hyphens" ? "-" : joint === "break" ? "\n" : " ") + words[i]!;
  }
  return key;
}

/**
 * Every distinct stretch of folded text of two to `maxWords` runs of letters and digits where
 * the erasure's joinedNamePattern can find a name (services/memory/person-name-characters.ts),
 * keyed by {@link stretchKey}. `marked` reads the text as folded after markWordSteps: whitespace
 * and camel-case steps join words too. A stretch joined by whitespace alone is kept as
 * `spaceOnly` says. The pattern's rules, stretch by stretch:
 *  - a stretch never starts at a camel-case step; in marked text it may start right after a
 *    digit inside a word ("2026dana_whitfield");
 *  - a stretch is not kept when a dash joins it to a word before or after it
 *    ("dana_whitfield-barnes", "dana_whitfield\u2013barnes"), a modifier word after it aside
 *    ("dana_whitfield-approved");
 *  - a stretch whose words are joined by hyphens alone ("dana-whitfield", "kimji-woo") is
 *    kept only for a "joined_name", which holds one only for a name run together up to her own
 *    hyphen (person-name-characters.ts, joinedNames): a "name" digest recorded before text names
 *    reads only letters and digits, so "anne-marie" would be read as Anne Marie's.
 */
function joinedNameStretches(
  text: string,
  maxWords: number,
  { marked, spaceOnly: keepSpaceOnly = "all" }: { marked: boolean; spaceOnly?: SpaceOnlyStretches },
): Map<string, JoinedStretch> {
  const stretches = new Map<string, JoinedStretch>();
  for (const run of text.matchAll(marked ? MARKED_JOINED_RUN : JOINED_RUN)) {
    // words[i] and words[i + 1] lie either side of joints[i].
    const parts = run[0].split(JOINT);
    const words = parts.filter((_, i) => i % 2 === 0);
    const joints = parts.filter((_, i) => i % 2 === 1).map(jointKind);
    const end = run.index + run[0].length;
    const dashBefore = dashJoinsBefore(text, run.index);
    const dashAfter = dashJoinsAfter(text, end);
    const dashNext = IS_DASH.test(text[end] ?? "");
    for (let first = 0; first < words.length; first++) {
      // Never at a camel-case step, nor after a word a dash joins it to; in marked text also
      // right after a digit inside the word ("2026dana whitfield").
      const startsHere = !(first === 0 ? dashBefore : joints[first - 1] === "step" || joints[first - 1] === "hyphens");
      for (const firstWord of [...(startsHere ? [words[first]!] : []), ...(marked ? afterDigits(words[first]!) : [])]) {
        const afterDigit = firstWord !== words[first];
        const stretchWords = afterDigit ? words.with(first, firstWord) : words;
        let count = 1;
        let hyphensOnly = true;
        let spaceOnly = true;
        let spaced = false;
        for (let last = first + 1; last < Math.min(words.length, first + maxWords); last++) {
          const joint = joints[last - 1]!;
          count++;
          if (joint !== "inside") {
            spaced = true;
            hyphensOnly &&= joint === "hyphens";
            spaceOnly &&= joint === "space" || joint === "break";
          }
          if (!spaced) continue;
          const next = joints[last];
          if (next === undefined ? dashAfter : next === "hyphens" && !MODIFIER_WORDS.has(words[last + 1]!)) continue;
          // After a digit, the spaced search did not read the stretch either ("2026dana" is one word there).
          const changedAfter = afterDigit || (next === undefined ? dashNext : next === "step" || next === "hyphens");
          if (spaceOnly && keepSpaceOnly !== "all" && !changedAfter && !keepSpaceOnly.words.has(count)) continue;
          const key = stretchKey(stretchWords, joints, first, last);
          const seen = stretches.get(key);
          stretches.set(key, {
            words: count,
            spaceOnly,
            hyphensOnly,
            anySpace: joints.slice(first, last).some((joint) => joint === "space" || joint === "break"),
            changedAfter: changedAfter || (seen?.changedAfter ?? false),
          });
        }
      }
    }
  }
  return stretches;
}

/**
 * A run of letters and digits, apostrophes inside it, and in marked text camel-case steps too:
 * where a name run together can stand.
 */
const LETTER_RUN = new RegExp(`(?<!${NAME_LETTER})${NAME_LETTER}+(?:'${NAME_LETTER}+)*`, "gu");
const MARKED_LETTER_RUN = new RegExp(`(?<!${NAME_LETTER})${NAME_LETTER}+(?:(?:'|${CAMEL_STEP})${NAME_LETTER}+)*`, "gu");

/**
 * Every distinct stretch of folded `text` where a name run together can be found
 * (person-name-characters.ts, concatenatedNames), without its camel-case steps, of a length in
 * `lengths`. A stretch starts where a run of letters does, unless a dash joins it to a word
 * before, or right after an apostrophe or, in marked text, a digit; it ends right before an apostrophe or a camel-case
 * step, or where the run does, unless a dash joins it to a word after ("danawhitfield" in
 * "danawhitfield's", "l'danawhitfield" and "DanawhitfieldOffer"; "rorymcdonald" in
 * "RoryMcDonald2026"; "danawhitfield" in "2026danawhitfield"). A stretch never starts at a
 * step, as the erasure's pattern never does. A stretch under CONCATENATED_NAME_PROSE_MIN_LENGTH
 * characters counts only beside an "@" ({@link markedBeside}): "kitchen" in "kitchen@x.com" or
 * "@kitchen", never in "Coffee is in the kitchen." or "window_start".
 * Each start reads at most the longest of `lengths` ahead, so the cost is the text's length
 * times that, whatever the text.
 */
function concatenatedStretches(
  text: string,
  lengths: ReadonlySet<number>,
  { marked }: { marked: boolean },
): Set<string> {
  const stretches = new Set<string>();
  const longest = Math.max(0, ...lengths);
  for (const run of text.matchAll(marked ? MARKED_LETTER_RUN : LETTER_RUN)) {
    const chars = [...run[0]];
    // Where each character starts in `text`, in UTF-16 units, and where the run ends.
    const offsets = [run.index];
    for (const char of chars) offsets.push(offsets.at(-1)! + char.length);
    const runEnd = run.index + run[0].length;
    const dashAfter = dashJoinsAfter(text, runEnd);
    for (let first = 0; first < chars.length; first++) {
      const afterDigit = marked && first > 0 && IS_DIGIT.test(chars[first - 1]!);
      if (first === 0 ? dashJoinsBefore(text, run.index) : chars[first - 1] !== "'" && !afterDigit) continue;
      let stretch = "";
      let length = 0;
      for (let i = first; i < chars.length && length <= longest; i++) {
        if (chars[i] === CAMEL_STEP) continue;
        stretch += chars[i];
        length++;
        const next = chars[i + 1];
        const endsHere = next === undefined ? !dashAfter : next === "'" || next === CAMEL_STEP;
        if (!endsHere || !lengths.has(length)) continue;
        if (length < CONCATENATED_NAME_PROSE_MIN_LENGTH && !markedBeside(text, offsets[first]!, offsets[i + 1]!))
          continue;
        stretches.add(stretch);
      }
    }
  }
  return stretches;
}

/**
 * Whether {@link SHORT_RUN_MARK} stands right before `start` or right at `end` in `text`, as the
 * erasure reads a name run together under CONCATENATED_NAME_PROSE_MIN_LENGTH characters
 * (person-name-characters.ts, inTextRun).
 */
function markedBeside(text: string, start: number, end: number): boolean {
  return text.startsWith(SHORT_RUN_MARK, start - SHORT_RUN_MARK.length) || text.startsWith(SHORT_RUN_MARK, end);
}

/**
 * A record's whole name as a "joined_name" or "record_name" digest holds it, when it is a name
 * written without spaces ("dana_whitfield", "DanaWhitfield" marked at its camel-case step), by
 * {@link stretchKey}. Null when it is anything else. Words joined by hyphens alone key "-" at
 * every joint, which only a name run together up to her own hyphen holds ("kimji-woo"), so a
 * login "dana-whitfield", spelled as another person's double surname is, matches no one.
 */
function wholeJoinedKey(text: string, { marked }: { marked: boolean }): string | null {
  const field = text.replace(EDGE_SPACE, "");
  if (!(marked ? MARKED_WHOLE_JOINED : WHOLE_JOINED).test(field)) return null;
  const parts = field.split(JOINT);
  const words = parts.filter((_, i) => i % 2 === 0);
  const joints = parts.filter((_, i) => i % 2 === 1).map(jointKind);
  return joints.some((joint) => joint !== "inside") ? stretchKey(words, joints, 0, words.length - 1) : null;
}

/**
 * Text as names were folded when they were recorded before foldName read the Turkish "İ"
 * as "i" and a final sigma as "σ" (2026-10-16): NFKC, lowercased, NFC, a curly apostrophe
 * straight. A name recorded then, such as "νίκος παπάς", holds its final sigmas, so text
 * is also read this way wherever the two folds differ.
 */
const foldedAsRecordedBefore = (text: string): string =>
  text.normalize("NFKC").toLowerCase().normalize("NFC").replaceAll("\u2019", "'");

/**
 * `match` applied to `text` folded (services/memory/person-name-characters.ts, foldName), and,
 * where they differ, folded as names were recorded before ({@link foldedAsRecordedBefore}). Text
 * that the earlier fold changes beyond lowercasing is also matched as spelled (`asSpelled`): an
 * erasure recorded before names were composed holds a decomposed name as it was spelled.
 */
function inEitherSpelling(text: string, match: (spelling: Spelling) => Date | null): Date | null {
  const lowered = text.toLowerCase();
  const folded = composed(text);
  const before = foldedAsRecordedBefore(text);
  // Unchanged by markWordSteps, the marked pass reads what the plain one does, unless the
  // text held a U+0001 that markWordSteps dropped and put back as a step.
  const unmarked = (spelled: string, marked: string) => marked === spelled && !spelled.includes(CAMEL_STEP);
  const nfkc = compatibilityFolded(text);
  const markedNfkc = markWordSteps(nfkc);
  const markedSame = unmarked(nfkc, markedNfkc);
  let found = match({ lowered: folded, marked: markedSame ? null : composed(markedNfkc), asSpelled: false });
  if (before !== folded) {
    found = latestOf(
      found,
      match({ lowered: before, marked: markedSame ? null : foldedAsRecordedBefore(markedNfkc), asSpelled: false }),
    );
  }
  if (before === lowered) return found;
  // As spelled, letters keep their spelling, and every other character is folded as the
  // erasure folds it, so a fullwidth hyphen or a "ª" still joins or continues a word.
  const spelled = text.replace(NOT_A_LETTER, (char) =>
    IS_LETTER.test(char.toLowerCase()) ? char : compatibilityFolded(char),
  );
  const marked = markWordSteps(spelled);
  return latestOf(
    found,
    match({
      lowered: spelled.toLowerCase(),
      marked: unmarked(spelled, marked) ? null : marked.toLowerCase(),
      asSpelled: true,
    }),
  );
}

/** One spelling of a text, lowercased: as it is, and after markWordSteps before lowercasing (null when that changes nothing). */
interface Spelling {
  lowered: string;
  marked: string | null;
  asSpelled: boolean;
}

/**
 * Every key a stretch naming `name` written without spaces can have ({@link stretchKey}): one
 * space or "-" where her name has a mark, and one space or "\n" where it has whitespace.
 */
function joinedNameKeys({ words, marks }: JoinedName): string[] {
  let keys = [words[0]!];
  for (let i = 1; i < words.length; i++) {
    const joints = marks[i - 1] ? [" ", "-"] : [" ", "\n"];
    keys = keys.flatMap((key) => joints.map((joint) => `${key}${joint}${words[i]}`));
  }
  return keys;
}

/**
 * Add the person's emails, multi-word names and contact ids to the org's suppression list.
 * Idempotent: a value already on the list keeps the request that first recorded it, and a
 * name's or address's time moves to this erasure (a contact id keeps its first time). A person erased, added again and erased again has everything
 * written before the second erasure removed, so a copy of it brought back later must be
 * covered too: a brief or working note is known only by its text, and its text is judged
 * against this time.
 *
 * The time every new or moved entry gets is the listing's own, taken from the database clock
 * under the org's applied-markers lock, and later than every name or address entry already
 * on the list: listings are serialized by that lock, so a listing's time is later than every
 * listing committed before it, whatever the clocks of the app instances that ran them. It is
 * the `asOf` the erasure marks its entries applied with (markApplied), so an entry a later
 * listing moved is never marked by an earlier one.
 *
 * @param emails addresses, as the erasure resolved them.
 * @param names full names, as the erasure resolved them.
 * @param contactIds the contact rows the erasure removes.
 * @returns when the person was listed: the `asOf` for the erasure's markApplied.
 */
export async function recordSuppressions(
  client: Pick<PrismaClient, "$transaction">,
  orgId: string,
  requestId: string,
  person: PersonValues,
): Promise<Date> {
  const rows = suppressionEntriesFor(orgId, person);
  return client.$transaction(async (tx) => {
    await listingInThisTransaction(tx);
    // Listing and dropping the markers is one step against markApplied (lockAppliedMarkers).
    await lockAppliedMarkers(tx, orgId);
    // Truncated to the column's milliseconds, so the time stored is the time returned.
    const [{ listedAt }] = await tx.$queryRaw<{ listedAt: Date }[]>`
      SELECT greatest(
        date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
        (SELECT max("createdAt") FROM erasure_suppressions
          WHERE "orgId" = ${orgId} AND kind <> ALL (${ID_KINDS}::text[])) + interval '1 millisecond'
      ) AS "listedAt"`;
    if (rows.length === 0) return listedAt;
    await tx.erasureSuppression.createMany({
      data: rows.map((row) => ({ ...row, orgId, requestId, createdAt: listedAt })),
      skipDuplicates: true,
    });
    // Names and addresses only: a contact id keeps its first time, which firstSuppressedAt
    // reads as when the first attempt at erasing that contact started. A digest is of its
    // kind as well as its value, so the digests alone name the rows.
    const byValue = rows.filter((row) => row.kind !== "contact_id").map((row) => row.digest);
    if (byValue.length > 0) {
      await tx.erasureSuppression.updateMany({
        where: { orgId, digest: { in: byValue }, createdAt: { lt: listedAt } },
        data: { createdAt: listedAt },
      });
      // An entry whose time moved to this erasure now stands for copies written since the last
      // one, which this erasure has yet to remove: not applied until it marks them (markApplied).
      await tx.erasureSuppressionApplied.deleteMany({ where: { orgId, digest: { in: byValue } } });
    }
    return listedAt;
  });
}

/**
 * Mark the caller's transaction as the app listing erasures. The list's insert trigger
 * (migration 20261019100000_erasure_reapply_due) takes any insert made without it for a
 * restore's copy-back and marks the org due for a re-apply, which check() refuses the org's
 * reads and writes over until completeRestore runs. Every writer of the list calls this in the
 * transaction that inserts; an insert outside a transaction loses the setting and marks the
 * org due, which refuses loudly rather than serves.
 */
async function listingInThisTransaction(tx: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.erasure_listing', 'on', true) AS listing`;
}

/** Advisory-lock namespace for an org's applied markers (the other 8_241_00x locks are in change-events.ts and working-notes.ts). */
const APPLIED_MARKERS_LOCK_NAMESPACE = 8_241_006;

/**
 * Serialize, per org, listing a person (which moves an entry's time and drops its marker) with
 * marking entries applied. markApplied reads an entry's time in its own statement; without
 * this lock, a listing that commits after that read drops only the markers it can see, not
 * the one markApplied is about to commit, and the entry reads applied though the listing's
 * erasure has not run. Held to the end of the caller's transaction. Taken last in every
 * transaction that marks (markApplied is its final statement), and alone in the listing's, so
 * no transaction waits on it while it holds a lock another waiter holds first.
 */
async function lockAppliedMarkers(client: Pick<Prisma.TransactionClient, "$queryRaw">, orgId: string): Promise<void> {
  // In FROM: the function returns void, which the Prisma pg adapter cannot read as a column.
  await client.$queryRaw`
    SELECT true AS locked
    FROM pg_advisory_xact_lock(${APPLIED_MARKERS_LOCK_NAMESPACE}::int4, hashtext(${orgId})::int4)
  `;
}

/**
 * Inside `tx`, keep any erasure from listing a person in the org until `tx` ends, waiting first
 * for a listing already under way to commit. A write that judges content against the list
 * takes it before it reads the list: a listing it does not see then gets a time later than
 * everything `tx` writes (recordSuppressions takes its time under the exclusive lock), so the
 * reads take that content for an old copy and the erasure's passes, which come after its
 * listing, find it. Shared, so such writes do not wait on one another. A writer may hold row
 * locks while it waits: no transaction holds the exclusive lock while waiting on one, since
 * a listing takes nothing else and markApplied takes it last.
 */
export async function holdOffListings(tx: Pick<Prisma.TransactionClient, "$queryRaw">, orgId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT true AS locked
    FROM pg_advisory_xact_lock_shared(${APPLIED_MARKERS_LOCK_NAMESPACE}::int4, hashtext(${orgId})::int4)
  `;
}

/** The values one erasure resolves a person to: addresses, full names, contact ids. */
export interface PersonValues {
  emails: string[];
  names: string[];
  contactIds: string[];
}

/** The list entries {@link recordSuppressions} records for `person`. */
function suppressionEntriesFor(
  orgId: string,
  { emails, names, contactIds }: PersonValues,
): { kind: string; digest: string; wordCount: number | null }[] {
  const keys = names.map(composed);
  return [
    ...emails.map((email) => ({
      kind: "email",
      digest: digest(orgId, "email", composed(email.trim())),
      wordCount: null,
    })),
    ...contactIds.map((id) => ({ kind: "contact_id", digest: digest(orgId, "contact_id", id), wordCount: null })),
    ...keys.map(nameKey).flatMap((key) => {
      const wordCount = key.match(NAME_WORD)?.length ?? 0;
      return wordCount >= 2 ? [{ kind: "text_name", digest: digest(orgId, "text_name", key), wordCount }] : [];
    }),
    ...keys.map(nameKey).flatMap((key) => {
      // Her name and, when she has whitespace and a hyphen, her name run together up to it
      // ("kimji-woo" for Kim Ji-woo; person-name-characters.ts, joinedNames).
      const [joined, ...runsUpToHyphen] = (key.match(NAME_WORD)?.length ?? 0) >= 2 ? joinedNames(key) : [];
      if (!joined) return [];
      const entry = (kind: "joined_name" | "joined_run", form: JoinedName) => (joinedKey: string) => ({
        kind,
        digest: digest(orgId, kind, joinedKey),
        wordCount: form.words.length,
      });
      // A key the "text_name" already holds, once "\n" reads as a space ("dana whitfield",
      // "anne-marie dupont"), is found by that digest; a dotted name ("d. whitfield") is not.
      // A form run together up to her hyphen is a "joined_run": whitespace never joins its words.
      return [
        ...joinedNameKeys(joined)
          .filter((joinedKey) => joinedKey.replaceAll("\n", " ") !== key)
          .map(entry("joined_name", joined)),
        ...runsUpToHyphen.flatMap((form) =>
          joinedNameKeys(form)
            .filter((runKey) => !runKey.includes("\n"))
            .map(entry("joined_run", form)),
        ),
      ];
    }),
    ...keys.map(nameKey).flatMap((key) => {
      const joined = (key.match(NAME_WORD)?.length ?? 0) >= 2 ? joinedName(key) : null;
      return (joined ? concatenatedNames(joined) : []).map((run) => ({
        kind: "concatenated_name",
        digest: digest(orgId, "concatenated_name", run),
        wordCount: [...run].length,
      }));
    }),
    ...keys.map(recordNameKey).flatMap((key) => {
      const parts = key.split(" ");
      return [
        { kind: "record_name", digest: digest(orgId, "record_name", key), wordCount: null },
        ...(parts.length === 2
          ? [
              {
                kind: "record_name_reversed",
                digest: digest(orgId, "record_name_reversed", `${parts[1]} ${parts[0]}`),
                wordCount: null,
              },
            ]
          : []),
      ];
    }),
  ];
}

/**
 * Add stored versions an erasure removes to the org's suppression list, by their ids.
 * Idempotent: a version already on the list keeps the request that first recorded it.
 *
 * @returns how many entries were new.
 */
export function recordErasedVersions(
  client: Pick<Prisma.TransactionClient, "erasureSuppression" | "$queryRaw">,
  orgId: string,
  requestId: string,
  versionIds: readonly string[],
): Promise<number> {
  return recordIds(client, orgId, requestId, "version_id", versionIds);
}

/** {@link recordErasedVersions} for rules an erasure redacts (services/memory/erasure-rules.ts). */
export function recordErasedRules(
  client: Pick<Prisma.TransactionClient, "erasureSuppression" | "$queryRaw">,
  orgId: string,
  requestId: string,
  ruleIds: readonly string[],
): Promise<number> {
  return recordIds(client, orgId, requestId, "rule_id", ruleIds);
}

async function recordIds(
  client: Pick<Prisma.TransactionClient, "erasureSuppression" | "$queryRaw">,
  orgId: string,
  requestId: string,
  kind: "version_id" | "rule_id",
  values: readonly string[],
): Promise<number> {
  const ids = [...new Set(values)];
  if (ids.length === 0) return 0;
  await listingInThisTransaction(client);
  const { count } = await client.erasureSuppression.createMany({
    data: ids.map((id) => ({ orgId, requestId, kind, digest: digest(orgId, kind, id), wordCount: null })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Which of `candidates` are versions an erasure in `orgId` removed, by their ids. Reads the
 * org's version entries once and hashes the candidates, so a long candidate list costs no
 * longer query.
 */
export function erasedVersionsAmong(
  client: Pick<Prisma.TransactionClient, "erasureSuppression">,
  orgId: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  return idsAmong(client, orgId, "version_id", candidates);
}

/** {@link erasedVersionsAmong} for rules an erasure redacted. */
export function erasedRulesAmong(
  client: Pick<Prisma.TransactionClient, "erasureSuppression">,
  orgId: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  return idsAmong(client, orgId, "rule_id", candidates);
}

async function idsAmong(
  client: Pick<Prisma.TransactionClient, "erasureSuppression">,
  orgId: string,
  kind: "version_id" | "rule_id",
  candidates: readonly string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await client.erasureSuppression.findMany({
    where: { orgId, kind },
    select: { digest: true },
  });
  if (rows.length === 0) return new Set();
  const erased = new Set(rows.map((row) => row.digest));
  return new Set(candidates.filter((id) => erased.has(digest(orgId, kind, id))));
}

/**
 * The digest the suppression list holds for the stored version whose id is in `idColumn`
 * ("version_id", {@link recordErasedVersions}), computed by Postgres as {@link digest}
 * computes it.
 */
export function versionIdDigestSql(orgId: string, idColumn: Prisma.Sql): Prisma.Sql {
  return idDigestSql(orgId, "version_id", idColumn);
}

function idDigestSql(orgId: string, kind: "version_id" | "rule_id", idColumn: Prisma.Sql): Prisma.Sql {
  const prefix = Buffer.from(`${orgId}\0${kind}\0`, "utf8").toString("hex");
  return Prisma.sql`encode(sha256(decode(${prefix}, 'hex') || convert_to(${idColumn}, 'UTF8')), 'hex')`;
}

/**
 * A SQL condition that is true when the id in `idColumn` is one an erasure in `orgId`
 * removed or redacted, judged by the id alone: it is on the list as a stored version's id
 * ({@link recordErasedVersions}) or a rule's ({@link recordErasedRules}), whenever that was
 * recorded. The read paths' filter decides the same given the id and no text or write time
 * ({@link loadErasedContentFilter}). A reader that names records by id puts this in its
 * WHERE clause, so its bound and counts never include them. `idColumn` is a fixed
 * identifier, never caller input.
 */
export function erasedByIdSql(orgId: string, idColumn: Prisma.Sql): Prisma.Sql {
  // One probe of the list's unique index per kind and row. `OFFSET 0` keeps each a lookup:
  // the planner would otherwise make an anti-join that hashes every row against every entry.
  const listed = (kind: "version_id" | "rule_id") => Prisma.sql`EXISTS (
    SELECT 1 FROM erasure_suppressions erased_id
    WHERE erased_id."orgId" = ${orgId} AND erased_id.kind = ${kind} AND erased_id.digest = ${idDigestSql(orgId, kind, idColumn)}
    OFFSET 0
  )`;
  return Prisma.sql`(${listed("version_id")} OR ${listed("rule_id")})`;
}

/**
 * A SQL condition that is true when the stored version whose {@link versionIdDigestSql} is
 * in `digestColumn`, written at `writtenAtColumn`, is one an erasure in `orgId` removed by
 * its id, as the read paths' filter decides it ({@link loadErasedContentFilter}): its digest
 * is on the list, and it was written at or before that entry, or has no write time. Given
 * the digest as a column, the lookup is one probe of the list's unique index per version:
 * `OFFSET 0` keeps it a lookup per version, which the planner would otherwise turn into a
 * join that, on a small or unanalyzed list, compares every version with every entry.
 */
export function erasedByVersionDigestSql(
  orgId: string,
  digestColumn: Prisma.Sql,
  writtenAtColumn: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM erasure_suppressions erased_version
    WHERE erased_version."orgId" = ${orgId}
      AND erased_version.kind = 'version_id'
      AND erased_version.digest = ${digestColumn}
      AND (${writtenAtColumn} IS NULL OR ${writtenAtColumn} <= erased_version."createdAt")
    OFFSET 0
  )`;
}

/**
 * Record that what some of `orgId`'s list entries stand for has been removed from this
 * database: the entries recorded under `requestIds`, and those for `person`'s values. Call it
 * as the last statement of the transaction that finishes the removal, never before: an entry
 * marked applied is one a restore's re-apply will not look at again
 * (services/memory/erasure-reapply.ts), and the lock it takes is held to that commit. Idempotent.
 *
 * `asOf` is when the caller's removal took the list as it stood: the time recordSuppressions
 * returned for its listing, or {@link listEntriesAsOf}'s for a re-apply. An address or name entry whose
 * time is later was moved there by another erasure of the same person since, which stands for
 * copies the caller's removal did not look for, so it is left for that erasure to mark. Entries
 * by id (contacts, versions, rules) keep their first time and are not held to it.
 */
export async function markApplied(
  client: Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">,
  orgId: string,
  by: string,
  {
    requestIds = [],
    person,
    entries = [],
    asOf,
  }: { requestIds?: readonly string[]; person?: PersonValues; entries?: readonly ListEntry[]; asOf?: Date },
): Promise<void> {
  const listed = [...entries, ...(person ? suppressionEntriesFor(orgId, person) : [])];
  // Before the statement below, so its snapshot already holds any listing that committed first,
  // and a listing that comes later waits for this transaction's markers (lockAppliedMarkers).
  await lockAppliedMarkers(client, orgId);
  const notMovedSince = asOf
    ? Prisma.sql`AND (s.kind = ANY (${ID_KINDS}::text[]) OR s."createdAt" <= ${sqlUtcAt(asOf)})`
    : Prisma.empty;
  await client.$executeRaw`
    INSERT INTO erasure_suppressions_applied ("orgId", kind, digest, "by")
    SELECT s."orgId", s.kind, s.digest, ${by} FROM erasure_suppressions s
    WHERE s."orgId" = ${orgId}
      AND (s."requestId" = ANY (${[...requestIds]}::text[])
           OR (s.kind, s.digest) IN (SELECT * FROM unnest(${listed.map((e) => e.kind)}::text[], ${listed.map((e) => e.digest)}::text[])))
      ${notMovedSince}
    ON CONFLICT DO NOTHING`;
}

/** The kinds whose entries keep the time they were first recorded: recordSuppressions moves every other kind's. */
const ID_KINDS: SuppressionKind[] = ["contact_id", "version_id", "rule_id"];

/** One entry of a suppression list, by its key. */
export interface ListEntry {
  kind: string;
  digest: string;
}

/** The list entry for the stored version `versionId`, as {@link recordErasedVersions} records it. */
export function versionIdEntry(orgId: string, versionId: string): ListEntry {
  return { kind: "version_id", digest: digest(orgId, "version_id", versionId) };
}

/**
 * Every entry on `orgId`'s list now, by its key (what a re-apply starting now covers), and the
 * `asOf` that covers exactly them: the latest time a name or
 * address entry among them has. A listing that commits after this read gets a later time
 * ({@link recordSuppressions}), so markApplied as of it never marks an entry that listing
 * moved. Read in one statement, so the two agree.
 */
export async function listEntriesAsOf(orgId: string): Promise<{ entries: ListEntry[]; asOf: Date }> {
  const rows = await db.erasureSuppression.findMany({
    where: { orgId },
    select: { kind: true, digest: true, createdAt: true },
  });
  const byValue = rows
    .filter((row) => !ID_KINDS.includes(row.kind as SuppressionKind))
    .map((row) => row.createdAt.getTime());
  return {
    entries: rows.map(({ kind, digest }) => ({ kind, digest })),
    // With no name or address entry, no time: markApplied then marks no entry of those kinds.
    asOf: new Date(byValue.length > 0 ? Math.max(...byValue) : 0),
  };
}

/**
 * A SQL condition that is true when everything on `orgId`'s suppression list has been removed
 * from this database ({@link markApplied}): every entry has its applied row. An applied row
 * names a listed entry (a foreign key), so the two counts are equal exactly then. False while
 * an erasure is running, and after a restore copied newer entries back over an older backup,
 * until the re-apply has run (services/memory/erasure-reapply.ts, `completeRestore`).
 */
export const erasuresAppliedSql = (orgId: string): Prisma.Sql =>
  Prisma.sql`((SELECT count(*) FROM erasure_suppressions WHERE "orgId" = ${orgId})
            = (SELECT count(*) FROM erasure_suppressions_applied WHERE "orgId" = ${orgId}))`;

/**
 * Inside `tx`, end `orgId`'s due re-apply (the `erasure_reapply_due` row a restore's copy-back
 * wrote) when every entry on its list now reads as applied, and say whether it is now not due.
 * Takes the org's applied-markers lock, which the copy-back's trigger takes too, so an entry
 * copied back after this transaction's read keeps the org due. Call it last, after markApplied.
 */
export async function endReapplyDue(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">,
  orgId: string,
): Promise<boolean> {
  await lockAppliedMarkers(tx, orgId);
  await tx.$executeRaw`DELETE FROM erasure_reapply_due WHERE "orgId" = ${orgId} AND ${erasuresAppliedSql(orgId)}`;
  const [row] = await tx.$queryRaw<
    { due: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM erasure_reapply_due WHERE "orgId" = ${orgId}) AS due`;
  return !row!.due;
}

/** Whether a restore's copy-back left `orgId` due for a re-apply ({@link endReapplyDue}). */
export async function reapplyDue(orgId: string): Promise<boolean> {
  return (await db.erasureReapplyDue.findUnique({ where: { orgId }, select: { orgId: true } })) !== null;
}

/** The orgs a restore's copy-back left due for a re-apply, in id order. */
export async function orgsWithReapplyDue(): Promise<string[]> {
  const rows = await db.erasureReapplyDue.findMany({ select: { orgId: true }, orderBy: { orgId: "asc" } });
  return rows.map((r) => r.orgId);
}

/** {@link erasuresAppliedSql}, read now. */
export async function erasuresApplied(orgId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<{ applied: boolean }[]>`SELECT ${erasuresAppliedSql(orgId)} AS applied`;
  return row?.applied ?? false;
}

/**
 * When the first erasure of any of `contactIds` was recorded, or null when none was: no
 * attempt at erasing them started earlier.
 */
export async function firstSuppressedAt(orgId: string, contactIds: string[]): Promise<Date | null> {
  if (contactIds.length === 0) return null;
  const first = await db.erasureSuppression.findFirst({
    where: { orgId, kind: "contact_id", digest: { in: contactIds.map((id) => digest(orgId, "contact_id", id)) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return first?.createdAt ?? null;
}

/**
 * Load the org's suppression list once and return a matcher for it. A sync
 * loads it per item it is about to write, so an erasure that finishes during
 * a long sync applies to the items after it.
 */
export async function loadErasedPersonMatcher(orgId: string): Promise<ErasedPersonMatcher> {
  const erasedAt = await loadErasureTimes(orgId);
  return (text) => erasedAt(text) !== null;
}

/**
 * Answers whether content written at `writtenAt` names a person erased from the
 * org at or after that moment: a copy the erasure should have removed. It names
 * them when its text does, or when `recordName` (the entity it is filed under) is
 * the person's whole name or address, as the erasure itself decides
 * (recordNamePatterns). A stored version is also such a copy when `versionId` is the
 * id of a version an erasure removed, whatever its text. Content with no write time is
 * treated as old.
 */
export interface ErasedContentFilter {
  (text: string, writtenAt: Date | null, recordName?: string | null, versionId?: string): boolean;
  /**
   * The same answer for a record judged by its own name alone (a contact's name or
   * address): the person's whole name, surname first, or whole address. A name that only
   * contains theirs ("Mary Dana Whitfield") is someone else's.
   */
  byRecordName(name: string, writtenAt: Date | null): boolean;
  /** The same answer for a contact row judged by its id alone: one an erasure removed. */
  byContactId(id: string, writtenAt: Date | null): boolean;
  /** The same answer for a rule judged by its id alone: one an erasure redacted. */
  byRuleId(id: string, writtenAt: Date | null): boolean;
}

/**
 * Load the org's suppression list once and return an {@link ErasedContentFilter} for it. Pass
 * `client` to read it inside a transaction.
 */
export async function loadErasedContentFilter(orgId: string, client: ListReader = db): Promise<ErasedContentFilter> {
  const erasedAt = await loadErasureTimes(orgId, client);
  const covers = (at: Date | null, writtenAt: Date | null) =>
    at !== null && (writtenAt === null || writtenAt.getTime() <= at.getTime());
  const filter = (text: string, writtenAt: Date | null, recordName?: string | null, versionId?: string) =>
    covers(
      latestOf(
        latestOf(erasedAt(text), recordName ? erasedAt.recordName(recordName) : null),
        versionId ? erasedAt.versionId(versionId) : null,
      ),
      writtenAt,
    );
  return Object.assign(filter, {
    byRecordName: (name: string, writtenAt: Date | null) => covers(erasedAt.recordName(name), writtenAt),
    byContactId: (id: string, writtenAt: Date | null) => covers(erasedAt.contactId(id), writtenAt),
    byRuleId: (id: string, writtenAt: Date | null) => covers(erasedAt.ruleId(id), writtenAt),
  });
}

const latestOf = (a: Date | null, b: Date | null | undefined): Date | null => (b && (!a || b > a) ? b : a);

/** A client the suppression list can be read with: the database, or a transaction. */
type ListReader = Pick<Prisma.TransactionClient, "erasureSuppression">;

/** When an erasure named in some text, in a record's own name, or a contact's, version's or rule's id was recorded; null when none was. */
interface ErasureTimes {
  (text: string): Date | null;
  recordName(name: string): Date | null;
  contactId(id: string): Date | null;
  versionId(id: string): Date | null;
  ruleId(id: string): Date | null;
}

/**
 * The suppression list as one function: the latest time an erasure named in
 * `text` was recorded, or null when the text names nobody erased from the org;
 * and the same for a record's own name, a contact's id, a stored version's id and a rule's id.
 */
async function loadErasureTimes(orgId: string, client: ListReader = db): Promise<ErasureTimes> {
  const rows = await client.erasureSuppression.findMany({
    where: { orgId },
    select: { kind: true, digest: true, wordCount: true, createdAt: true },
  });
  const recordedAt = new Map(rows.map((r) => [`${r.kind}:${r.digest}`, r.createdAt]));
  const at = (kind: SuppressionKind, value: string) => recordedAt.get(`${kind}:${digest(orgId, kind, value)}`) ?? null;
  const nameRows = rows.filter((r) => r.kind === "text_name" || r.kind === "joined_name" || r.kind === "name");
  // A text name counts words by NAME_WORD, a joined one by runs of letters, which can be more
  // ("anne-marie dupont" is 2 and 3): each search is bounded by its own, and the joined search,
  // which also checks "text_name" digests, by both.
  const longestOf = (kinds: string[]) =>
    Math.max(0, ...nameRows.filter((r) => kinds.includes(r.kind)).map((r) => r.wordCount ?? 0));
  const longestName = longestOf(["text_name", "name"]);
  const longestJoined = Math.max(longestName, longestOf(["joined_name"]));
  const hasLegacyNames = nameRows.some((r) => r.kind === "name");
  const hasJoinedNames = nameRows.some((r) => r.kind === "joined_name");
  // The lengths, in characters, of the names recorded run together: no other stretch can match one.
  const concatenatedLengths: ReadonlySet<number> = new Set(
    rows.filter((r) => r.kind === "concatenated_name").map((r) => r.wordCount ?? 0),
  );
  // The lengths, in words, of the names recorded as "joined_name": no other stretch can match one.
  const joinedNameWords: ReadonlySet<number> = new Set(
    nameRows.filter((r) => r.kind === "joined_name").map((r) => r.wordCount ?? 0),
  );
  // The same for names run together up to a hyphen of hers, read only where no whitespace joins the words.
  const joinedRunWords: ReadonlySet<number> = new Set(
    rows.filter((r) => r.kind === "joined_run").map((r) => r.wordCount ?? 0),
  );

  const textIn = ({ lowered, marked, asSpelled }: Spelling): Date | null => {
    let found: Date | null = null;
    for (const email of lowered.match(EMAIL_IN_TEXT) ?? []) found = latestOf(found, at("email", email));
    for (const stretch of nameStretches(lowered, longestName)) {
      found = latestOf(found, at("text_name", nameKey(stretch)));
      // A "name" digest keeps only letters and digits, so a decomposed accent read as
      // spelled would drop out of the word ("zoe" + U+0308 is "zoe"): composed text only.
      if (hasLegacyNames && !asSpelled) found = latestOf(found, at("name", legacyNameKey(stretch)));
    }
    // Written without spaces, in the marked text (the folded text itself when marking changes
    // nothing), and, as a word of hers that holds a capital ("McDonald") is stepped there, in
    // the folded text without any U+0001 too, as the erasure reads it. A name whose words hold
    // no joining mark has one key either way, so it is recorded only as a "text_name".
    // A stretch joined by whitespace alone is one the spaced search above already hashed,
    // unless a camel-case step follows it ("dana whitfield" in "Dana WhitfieldOffer"), or
    // marking turned a "%20" into a space or a "%27" or "%E2%80%99" into an apostrophe, or dropped a U+0001 the text held. Otherwise it is
    // read only for a "joined_name" of its length.
    const spacedChanged =
      marked !== null &&
      (lowered.includes("%20") ||
        lowered.includes("%27") ||
        lowered.includes("%e2%80%99") ||
        lowered.includes(CAMEL_STEP));
    const joined = joinedNameStretches(marked ?? lowered, longestJoined, {
      marked: true,
      spaceOnly: spacedChanged ? "all" : { words: joinedNameWords },
    });
    if (marked !== null) {
      for (const [key, stretch] of joinedNameStretches(lowered.replaceAll(CAMEL_STEP, ""), longestJoined, {
        marked: false,
      })) {
        joined.set(key, stretch);
      }
    }
    for (const [key, { words, spaceOnly, hyphensOnly, anySpace, changedAfter }] of joined) {
      if (joinedNameWords.has(words)) found = latestOf(found, at("joined_name", key));
      if (!anySpace && joinedRunWords.has(words)) found = latestOf(found, at("joined_run", key));
      if (hyphensOnly || (spaceOnly && !changedAfter && !spacedChanged)) continue;
      // A "text_name" holds whitespace as one space, and counts its words by NAME_WORD: a
      // hyphen keyed as "-" joins two into one.
      const textKey = key.replaceAll("\n", " ");
      if (textKey.split(" ").length <= longestName) found = latestOf(found, at("text_name", textKey));
      if (hasLegacyNames && !asSpelled) found = latestOf(found, at("name", legacyNameKey(key)));
    }
    // Run together, in the folded text without any U+0001 and in the marked text, as the
    // erasure reads both ("DanaWhitfield" is a step in one and "danawhitfield" in the other).
    if (concatenatedLengths.size > 0) {
      const runs = concatenatedStretches(lowered.replaceAll(CAMEL_STEP, ""), concatenatedLengths, { marked: false });
      for (const run of concatenatedStretches(marked ?? lowered, concatenatedLengths, { marked: true })) runs.add(run);
      for (const run of runs) found = latestOf(found, at("concatenated_name", run));
    }
    return found;
  };
  const recordNameIn = ({ lowered, marked }: Spelling): Date | null => {
    const key = recordNameKey(lowered);
    const surnameFirst = SURNAME_FIRST.exec(key);
    let found = latestOf(
      latestOf(at("email", key), at("record_name", key)),
      surnameFirst ? at("record_name_reversed", `${surnameFirst[1]} ${surnameFirst[2]}`) : null,
    );
    // Written without spaces: the whole name is hers, joined by marks or camel-case steps.
    const keys = [wholeJoinedKey(marked ?? lowered, { marked: true })];
    if (marked !== null) keys.push(wholeJoinedKey(lowered.replaceAll(CAMEL_STEP, ""), { marked: false }));
    for (const joined of keys) {
      if (joined)
        found = latestOf(latestOf(found, at("record_name", joined)), hasJoinedNames ? at("joined_name", joined) : null);
      if (joined && joinedRunWords.size > 0) found = latestOf(found, at("joined_run", joined));
    }
    // Run together: the whole name is her words with nothing between them, in either reading.
    if (concatenatedLengths.size > 0) {
      found = latestOf(found, at("concatenated_name", key.replaceAll(CAMEL_STEP, "")));
      if (marked !== null)
        found = latestOf(found, at("concatenated_name", recordNameKey(marked).replaceAll(CAMEL_STEP, "")));
    }
    return found;
  };
  const inText = (text: string): Date | null => (rows.length === 0 ? null : inEitherSpelling(text, textIn));
  return Object.assign(inText, {
    recordName: (name: string): Date | null => (rows.length === 0 ? null : inEitherSpelling(name, recordNameIn)),
    contactId: (id: string): Date | null => at("contact_id", id),
    versionId: (id: string): Date | null => at("version_id", id),
    ruleId: (id: string): Date | null => at("rule_id", id),
  });
}
