// Later records on an answer's first line, served above it across write names.
//
// A reader takes the first line of memory_query's answer as the answer. Versions of one fact
// are already served newest first (breakTiesByRecency in guarded-store.ts), but only when
// their writers gave them one entity name. A conversation stored one record per turn names
// every record differently, so "my grocery budget is $500" and, a week later, "my grocery
// budget was increased to $550" are two unrelated facts to that rule, and the old value can
// lead the answer with nothing near it saying a later record exists.
//
// This serves a later record above the first line when its words state a new value of the
// first line's thing, and marks the first line "a later record on this is shown above". The
// mark states only what was read, that a later record about the same thing is above; it does
// not claim the later record replaced this one, because that is read from words, not known.
// The rules still err toward no link. A later line is linked when, for the query asked:
//
// - the query asks for a value ("what is", "how many", "when", ...);
// - both are stored records (not graph facts) in one scope and one provenance tier, dated the
//   same way, the later one strictly later and served whole (an excerpt may have lost the label
//   that says who spoke);
// - the later line asserts a change of a named thing to a value (stated-changes.ts says which
//   wordings count), and nothing later in its sentence gives back a value the first line states
//   ("increased to $550, then cut back to $500");
// - that thing is the queried one: its head noun is a query term, not a name ("Acme"), not a
//   word the query only puts after a preposition, and not a word the first line only uses to
//   qualify another noun ("savings" in "savings goal"); when the query asks about a goal, limit
//   or target, the head is that goal. Each of its other words is a query term or a word of the
//   first line's statement (or a month, or a period nothing contradicts), words after its head
//   are query terms, and it carries every word the query and the first line both put before
//   that noun, and, when it has modifiers of its own, the queried ones the first line gives it.
//   A scope phrase after the value ("for", "in", "at", "across", "through", "via", "by", …, and
//   "on" after "to <value>", stated-changes.ts says which phrases are read) is part of the thing,
//   and its words, short codes included ("UK", "R&D", "IT"), must fit the same way: "to $10,000
//   for my side business", "on Sam's project", "for FY25", "for the UK" and "for everyone on the
//   Denver team" are another budget. A neutral phrase ("for good") adds nothing only as the
//   whole phrase, and a phrase whose words give no term ("for me") adds nothing either.
//   So "estate tax exemption" is not "estate tax rate", "the budget for dining" is not "the
//   budget for groceries", and "my monthly budget" is not "my grocery budget";
// - the first line states a value of that thing (within a few words of a queried word of its
//   name, or in the unit a "how many" query counts; not spent, left, covered, someone else's or
//   conditional), of the same kind (a sum, a share, a date, a time, or a count of the same unit),
//   for the same period ("per week" never matches "a month"), and does not already state the new
//   one; and when the change says what it changed from, that is a value the first line states.
//
// The one rule: nothing is hidden, fetched or rewritten. The linked later lines move directly
// above the first, newest first, together with any later version of their own fact, and the
// first line stays with `laterRecordsAbove` set, which the answer prints as the mark. Every other
// line keeps its place. Both sides were served by this read under its own access check, so a
// mark never says anything about a record the reader cannot see.
//
// The rules read words, so a later record on the same thing that is not its current value can
// still be linked: dated away in words no list holds, a draft, an undo that gives no value, a
// temporary purpose or a subset. The mark claims only "a later record on this", so that is the
// accepted cost; a link to a different thing is the defect the rules exist to prevent.
//
// Only the first line is ever linked. Ordering near-equal matches newest first, answer wide,
// was measured on the retrieval lab to cut BEAM's first-line gold from 132 to 30 of 354. A change
// worded any way the rules do not read is not linked, which leaves the page as ranked.
import type { MemoryFact } from "@/types/memory";
import {
  changesOf,
  prepositionObjects,
  statementsOf,
  wordsOfQuery,
  type Change,
  type StatedValue,
  type Statement,
} from "./stated-changes";
import { MONTH_WORD, attributeTerms, periodOf, termSequence, type Value } from "./stated-values";

/** Questions that ask for one value. A yes-or-no question ("have I ...?") is not linked. */
const ASKS_FOR_VALUE = /^\s*(?:what|which|when|how\s+(?:many|much|long|often))\b/i;
/** Modifiers that never change which thing is meant. */
const NEUTRAL = new Set("current total overall own entire whole actual official latest".split(" "));
/** Nouns that name a bound to work toward: progress toward one ("my savings reached $10,000") is not a new one. */
const GOALS = new Set("goal target limit cap quota maximum minimum".split(" "));
/** How many words before a noun count as its modifiers: "monthly grocery budget". */
const MODIFIER_REACH = 3;

/** The query, read once for every comparison. */
interface Query {
  terms: Set<string>;
  words: Set<string>;
  sequence: string[];
  periods: Set<string>;
  /** The units a "how many" query counts, by its first two words: "How many total hours" counts hours. */
  counted: Set<string>;
  /** Terms the query capitalizes past its first word ("Danielle") or only puts after a preposition ("at acme"): never the thing asked about. */
  names: Set<string>;
}

function readQuery(query: string): Query {
  const terms = new Set(attributeTerms(query));
  const after = /\bhow\s+many\s+(\S+)(?:\s+(\S+))?/i.exec(query);
  return {
    terms,
    words: wordsOfQuery(query),
    sequence: termSequence(query),
    periods: new Set([...terms].flatMap((t) => periodOf(t) ?? [])),
    counted: new Set(after ? after.slice(1).flatMap((word) => (word ? attributeTerms(word) : [])) : []),
    names: new Set([
      ...query
        .split(/\s+/)
        .slice(1)
        .filter((word) => /^\p{Lu}\p{Ll}/u.test(word))
        .flatMap((word) => attributeTerms(word)),
      ...prepositionObjects(query),
    ]),
  };
}

/** The terms right before `head` in a term sequence, wherever it stands, up to a break. */
function modifiersOf(sequence: readonly string[], head: string): Set<string> {
  const modifiers = new Set<string>();
  sequence.forEach((term, at) => {
    if (term !== head) return;
    for (let i = at - 1; i >= Math.max(0, at - MODIFIER_REACH) && sequence[i] !== ""; i--) modifiers.add(sequence[i]);
  });
  return modifiers;
}

/** Whether every use of `term` in a term sequence qualifies the noun after it: "savings" in "savings goal". */
function onlyQualifies(sequence: readonly string[], term: string): boolean {
  let seen = false;
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i] !== term) continue;
    if (!sequence[i + 1]) return false;
    seen = true;
  }
  return seen;
}

/** Whether a changed value measures what a value the first line states does. */
function sameKind(changed: Value, stated: Value, counted: ReadonlySet<string>): boolean {
  if (!changed.kind.startsWith("count:")) return changed.kind === stated.kind;
  if (!stated.kind.startsWith("count:")) return false;
  const unit = changed.kind.slice("count:".length);
  const statedUnit = stated.kind.slice("count:".length);
  if (!statedUnit) return false;
  // A bare count ("has now reached 165") counts what a "how many" query asks for, or nothing.
  return unit ? unit === statedUnit : counted.has(statedUnit);
}

/** Whether a word of a changed thing's name fits the first line's statement it would update. */
function nameWordFits(term: string, query: Query, lead: Statement): boolean {
  if (query.terms.has(term) || lead.allTerms.has(term) || NEUTRAL.has(term) || MONTH_WORD.test(term)) return true;
  const period = periodOf(term);
  return period !== undefined && [...query.periods, ...lead.periods].every((p) => p === period);
}

/** Whether `change` changes the queried thing a statement of the first line states. */
function updatesStatement(change: Change, lead: Statement, query: Query): boolean {
  if (!query.terms.has(change.head) || query.names.has(change.head)) return false;
  // "What is my savings goal?": only a change of the goal itself, never progress toward it.
  if ([...query.terms].some((term) => GOALS.has(term)) && !GOALS.has(change.head)) return false;
  // "My savings goal is $15,000": where the first line uses the head only to qualify another noun, it is not the thing.
  if (onlyQualifies(lead.sequence, change.head)) return false;
  if (!change.name.every((term) => nameWordFits(term, query, lead))) return false;
  // "the budget for dining" is not "the budget for groceries": what follows the head must be asked about.
  if (!change.after.every((term) => query.terms.has(term))) return false;
  // "to $10,000 for my side business", "for FY25": a phrase after the value that names another thing.
  if (!change.scope.every((term) => nameWordFits(term, query, lead))) return false;
  const leadModifiers = modifiersOf(lead.sequence, change.head);
  // "my monthly budget" against "my grocery budget is $500 a month", asked as "budget for groceries":
  // a name with modifiers of its own must carry the queried ones the first line gives the noun.
  const ownModifiers = change.name.filter((term) => term !== change.head);
  if (ownModifiers.length > 0) {
    for (const modifier of leadModifiers) {
      if (
        query.terms.has(modifier) &&
        !NEUTRAL.has(modifier) &&
        !periodOf(modifier) &&
        !change.name.includes(modifier) &&
        !change.scope.includes(modifier)
      ) {
        return false;
      }
    }
  }
  for (const modifier of modifiersOf(query.sequence, change.head)) {
    if (
      leadModifiers.has(modifier) &&
      !NEUTRAL.has(modifier) &&
      !periodOf(modifier) &&
      !change.name.includes(modifier) &&
      !change.scope.includes(modifier)
    ) {
      return false;
    }
  }
  const period = change.value.period;
  if (period && [...query.periods, ...lead.periods].some((p) => p !== period)) return false;
  return lead.values.some(
    (stated) => statesTheThing(change, stated, query) && sameKind(change.value, stated, query.counted),
  );
}

/**
 * Whether a first line's value is the changed thing's own: said within a few words of a queried
 * word of its name ("$35 monthly budget", "a deadline of April 1"), or counted in the unit a "how many" query
 * asks for ("4,500 words"), and not spent, left, covered, someone else's or conditional.
 */
function statesTheThing(change: Change, stated: StatedValue, query: Query): boolean {
  if (!stated.isTheValue) return false;
  const unit = stated.kind.startsWith("count:") ? stated.kind.slice("count:".length) : "";
  return (
    change.name.some((term) => query.terms.has(term) && stated.near.has(term)) ||
    (unit !== "" && query.counted.has(unit))
  );
}

function datedAt(fact: MemoryFact): number | null {
  const ms = fact.store === "semantic" && fact.validAt ? Date.parse(fact.validAt) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Serve the later records that state a new value of an answer's first line's thing directly
 * above it, and mark it.
 *
 * `page` is an answer in the order it will be served (memory_query); the result holds exactly
 * its facts. `provenanceRank` gives each fact's tier, the ranking the page was ordered by, so
 * a later record is never moved above a line of a better tier. An answer with no such later
 * record is returned in its own order. `page` is never changed.
 */
export function serveLaterUpdatesFirst(
  page: readonly MemoryFact[],
  query: string,
  provenanceRank: (fact: MemoryFact) => number,
): MemoryFact[] {
  // The mark is this function's alone: one a store returned is never served.
  const unmarked = page.map(({ laterRecordsAbove: _, ...fact }) => fact as MemoryFact);
  const [lead] = unmarked;
  const leadAt = lead ? datedAt(lead) : null;
  if (leadAt === null || !ASKS_FOR_VALUE.test(query)) return unmarked;
  const asked = readQuery(query);
  const leadStatements = statementsOf(lead.fact, asked.terms);
  if (leadStatements.length === 0) return unmarked;
  const most = leadStatements.reduce((max, s) => Math.max(max, s.terms.size), 0);
  const leadBest = leadStatements.filter((s) => s.terms.size === most);
  const leadValues = new Set(leadStatements.flatMap((s) => s.values.map((v) => v.text)));

  const rest = unmarked.slice(1);
  /** A record that may stand above the lead: stored, later, and comparable with it. */
  const later = (fact: MemoryFact) => {
    const at = datedAt(fact);
    return (
      at !== null &&
      at > leadAt &&
      provenanceRank(fact) === provenanceRank(lead) &&
      (fact.scopePath ?? null) === (lead.scopePath ?? null) &&
      fact.validAtSource === lead.validAtSource
    );
  };
  const updates = (fact: MemoryFact) =>
    fact.excerptOfChars === undefined &&
    changesOf(fact.fact, asked.words).some(
      (change) =>
        !leadValues.has(change.value.text) &&
        // A change from a value the first line does not state is a change of something else.
        (!change.from || leadValues.has(change.from.text)) &&
        // "increased to $550, then cut back to $500": a later value of its sentence that the first line states undoes it.
        !change.laterValues.some((later) => leadValues.has(later.text)) &&
        leadBest.some((s) => updatesStatement(change, s, asked)),
    );
  const updaters = rest.filter((fact) => later(fact) && updates(fact));
  if (updaters.length === 0) return unmarked;
  // A later version of an updater's own fact (one subject, dated after that updater) moves with
  // it, so the newest version still leads.
  const firstUpdateOf = new Map<string, number>();
  for (const f of updaters) {
    if (f.subject) firstUpdateOf.set(f.subject, Math.min(firstUpdateOf.get(f.subject) ?? Infinity, datedAt(f)!));
  }
  const newerVersion = (f: MemoryFact) =>
    f.subject !== undefined && firstUpdateOf.has(f.subject) && later(f) && datedAt(f)! > firstUpdateOf.get(f.subject)!;
  const block = rest.filter((f) => updaters.includes(f) || newerVersion(f));
  const newestFirst = [...block].sort((a, b) => datedAt(b)! - datedAt(a)!);
  return [...newestFirst, { ...lead, laterRecordsAbove: block.length }, ...rest.filter((f) => !block.includes(f))];
}
