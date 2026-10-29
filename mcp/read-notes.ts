// The notes memory_query appends to an answer that is not the whole answer. Kept apart
// from the tool so a client, such as the benchmark harness, can recognise them by the
// same text without loading the memory layer.
//
// The one rule: every note starts its own line with "Note: ", so a reader can tell a
// note from a fact that happens to contain the same words.
import type { RetrievalBackend, SearchResult } from "@/types/memory";

/** Appended when some scopes below the caller's were not searched (SearchResult.partialScopeCoverage). */
export const PARTIAL_SCOPE_COVERAGE_NOTE =
  "Note: not every scope under yours was searched (more scopes than one read searches, or the scope lookup failed), so a missing fact may still exist. Narrow scopePath to search a smaller subtree.";

/** How the note naming the scopes a read did not search begins. */
export const UNSEARCHED_SCOPES_NOTE_PREFIX = "Note: scopes under yours that were not searched:";

/** The most unsearched scopes the note names; it counts the rest. */
const UNSEARCHED_SCOPES_NAMED = 10;

/**
 * Appended after PARTIAL_SCOPE_COVERAGE_NOTE when the read knows which scopes it did not
 * search (SearchResult.unsearchedScopes), so the caller can ask for exactly those. They
 * are all inside the caller's own scope, so naming them reveals nothing it cannot read.
 */
export function unsearchedScopesNote(scopes: readonly string[]): string {
  const named = scopes.slice(0, UNSEARCHED_SCOPES_NAMED).join(", ");
  const rest = scopes.length - UNSEARCHED_SCOPES_NAMED;
  return `${UNSEARCHED_SCOPES_NOTE_PREFIX} ${named}${rest > 0 ? ` and ${rest} more` : ""}.`;
}

/**
 * Appended when the question names a specific value (a number, quoted text or a
 * multi-word name, services/memory/specific-values.ts) that no memory the caller can read
 * holds (SearchResult.unheldValues). One fixed sentence: it never repeats the value and
 * never says why memory lacks it, so a value that is hidden from the caller, removed, or
 * never written reads the same.
 */
export const NO_READABLE_MATCH_NOTE =
  "Note: no memory you can read holds at least one specific value this question names (a number, quoted text or a name), so memory cannot confirm it.";

/**
 * Appended when memory_query serves at least one record. Every read is decided by check()
 * against the caller's own grant before anything is searched, so each record served is one
 * the caller may read. Saying so lets an agent use what it was given instead of re-deciding
 * access from whatever partial metadata it holds, and refusing records it is entitled to.
 * It says nothing about records that were not served, so it reveals nothing about them.
 */
export const READ_GRANT_NOTE =
  "Note: Willder checked your read grant for this read; every record above is one your grant allows you to read.";

/** How the note naming the scope a read was checked against begins. */
export const CHECKED_SCOPE_NOTE_PREFIX = "Note: your grant allowed this read on the scope";

/** The longest scope name the note quotes, in graphemes; a longer one is cut and marked. */
const CHECKED_SCOPE_NAME_MAX = 120;

/** How much of a name, in UTF-16 units, is ever read: 64 a grapheme, far past the cut. */
const CHECKED_SCOPE_NAME_SCAN = CHECKED_SCOPE_NAME_MAX * 64;

/** Splits a name into what a reader sees as single characters, for the cut. */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Appended to every read memory_query completes: the name of the one scope check() allowed
 * this read on (the caller's `scopePath`, or its token's own scope), so an agent can tell
 * what its grant covers ("Elena Park appointment logistics") before it answers a question
 * that grant does not reach. It names that scope only: never a parent, sibling or child, so
 * it shows nothing beyond a scope the caller was just allowed to read. The name is the
 * customer's own text, so every run of whitespace or control characters becomes one space
 * (the note stays one line, and a name cannot start a line of its own that reads as another
 * note), invisible format characters go, and a double quote becomes a single one (the name
 * cannot close its own quotes).
 * Returns null for a name with nothing left to quote.
 */
export function checkedScopeNote(scopeName: string): string | null {
  // Only a bounded head of the name is ever looked at, so a read's cost does not grow with a
  // name's length: segmenting a whole very long name took seconds a read (QA on #977).
  const head = scopeName.length > CHECKED_SCOPE_NAME_SCAN ? scopeName.slice(0, CHECKED_SCOPE_NAME_SCAN) : scopeName;
  const flat = head
    // Invisible format characters (bidi overrides, zero-width marks) go: an override left open
    // would turn the rest of the line around in any screen that shows it. A zero-width joiner
    // stays only inside an emoji sequence (👩‍⚕️), where it is part of one visible character.
    .replace(/(?!\u200d)\p{Cf}+/gu, "")
    .replace(/\u200d(?!\p{Extended_Pictographic})|(?<!\p{Extended_Pictographic}\ufe0f?)\u200d/gu, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replaceAll('"', "'")
    .trim();
  if (flat === "") return null;
  // Cut by grapheme, so a cut never splits a character, an accented letter or an emoji
  // sequence. Graphemes are read one at a time and the read stops once the cut is known.
  const kept: string[] = [];
  let cut = head !== scopeName;
  for (const { segment } of GRAPHEMES.segment(flat)) {
    if (kept.length === CHECKED_SCOPE_NAME_MAX) {
      cut = true;
      break;
    }
    kept.push(segment);
  }
  // The cut mark takes the last place; when the head was cut, its last grapheme may be only part
  // of one, and it goes too.
  const quoted = cut ? `${kept.slice(0, -1).join("").trimEnd()}…` : flat;
  return `${CHECKED_SCOPE_NOTE_PREFIX} "${quoted}"; nothing outside that scope was searched.`;
}

/** How the note on a served "never" claim that other served records mention begins. */
const NEVER_CLAIM_NOTE_PREFIX = "Note: possible conflict detected, not resolved:";

/** A question a yes or no would answer: it opens with an auxiliary verb ("Have I ever ...", "Did we ..."). */
const YES_NO_QUESTION = /^\s*(?:have|has|had|did|do|does|is|are|was|were|am|can|could|will|would)(?:n['’]t)?\b/iu;

/**
 * Appended when a served record says something about the question never happened and other
 * served records mention that thing (services/memory/never-claims.ts). It quotes the claim and
 * one mention, both served by this read, and says which holds is the person's to say: it
 * never says the claim is wrong or that the records disagree.
 *
 * To a yes-or-no question it ends by saying what to answer when the mention does say the thing
 * happened: both quotes and a question to the person, not a bare yes or no. A reader told only
 * to "ask the person" answered a bare yes, no or "unclear" when its own instructions forbade
 * explanation. The condition is the reader's to judge, because a mention may be a plan or a
 * question (never-claims.ts reads words, not meaning). Any other question ("how many", "when")
 * may be answered by a record outright, so there it only asks that the person be asked.
 */
export function neverClaimNote(claim: string, mentions: number, example: string, question: string): string {
  const others = mentions === 1 ? "another record here mentions it" : `${mentions} other records here mention it`;
  const answer = YES_NO_QUESTION.test(question)
    ? "If that mention says it happened, these records do not settle it: answer by quoting both and asking the person which is correct, not with a bare yes or no."
    : "Ask the person which is right before relying on either.";
  return `${NEVER_CLAIM_NOTE_PREFIX} a record here says "${claim}", and ${others}, for example "${example}". ${answer}`;
}

/**
 * Result `_meta` key on memory_query: the 0-based positions, among the specific values the
 * question names, of those no memory the caller can read holds. Set only when the check
 * was complete. For a client that reads several scopes with one question, such as the
 * GateMem harness, which needs to know whether one value is held in none of them.
 */
export const UNHELD_VALUES_META_KEY = "willder/unheldValues";

/** How the note for a store that did not answer begins. */
export const DEGRADED_READ_NOTE_PREFIX = "Note: search was incomplete:";

/** What each store a read can fail to answer is called in the note. */
const STORE_NAMES: Record<RetrievalBackend, string> = {
  graph: "the graph store",
  semantic: "the vector store",
  source: "the records store",
  files: "the file store",
};

/**
 * Appended when a store failed to answer even after one retry (SearchResult.degraded),
 * so an agent never takes a one-store answer for a full one.
 */
export function degradedReadNote(stores: readonly RetrievalBackend[]): string {
  const names = stores.map((store) => STORE_NAMES[store]).join(" and ");
  return `${DEGRADED_READ_NOTE_PREFIX} ${names} did not answer, so a missing fact may still exist. Ask again to retry.`;
}

/**
 * Every note a read's answer must carry, in the order memory_query appends them: none
 * for a complete read. For readers other than memory_query that hand a read to an agent
 * or a model, so an incomplete answer, an empty one above all, never reads as complete.
 */
export function incompleteReadNotes(
  read: Pick<SearchResult, "partialScopeCoverage" | "unsearchedScopes" | "degraded">,
): string[] {
  return [
    ...(read.partialScopeCoverage ? [PARTIAL_SCOPE_COVERAGE_NOTE] : []),
    ...(read.unsearchedScopes?.length ? [unsearchedScopesNote(read.unsearchedScopes)] : []),
    ...(read.degraded?.length ? [degradedReadNote(read.degraded)] : []),
  ];
}
