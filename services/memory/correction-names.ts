// The names a person's correction of a fact is filed under, how to tell one apart, and what
// the removal it makes says on the change feed.
//
// A correction is stored as a new fact under a name of its own, never the corrected fact's
// entity name: two people's corrections of two facts are two facts, and the conflict rule
// (services/memory/conflict.ts) would settle two writes under one name by hiding one.
//
// The one rule this file enforces: a name built here belongs to one correction only. That
// is what lets a person erasure remove a correction's graph copy by its name
// (services/memory/erasure-lineage.ts). Until 2026-10-13 a person's write was stored by the
// ingest job after its graph episodes were written, so those episodes carry the correction's
// name but not its stored row's id, and the name is the only exact way to find them.

const FACT_CORRECTION = "Human fact (edited)";
const BRIEF_CORRECTION = "Correction to brief";

/**
 * The name of a person's correction of fact `factId` through PATCH /api/memory/facts/:id,
 * made at `at`.
 */
export function factCorrectionName(factId: string, at: Date): string {
  return `${FACT_CORRECTION} — ${at.toISOString()} — corrects ${factId}`;
}

/**
 * The name of a person's correction of brief `briefId`. When the correction overruled a fact
 * (`overruledFactId`), the name says which, so it is that one correction's own. Without one,
 * every correction the person makes to the brief shares the name, as they did before.
 */
export function briefCorrectionName(briefId: string, userId: string, overruledFactId?: string): string {
  const name = `${BRIEF_CORRECTION} ${briefId} by ${userId}`;
  return overruledFactId === undefined ? name : `${name} — corrects ${overruledFactId}`;
}

/** What every correction of brief `briefId` is filed under the name of: the start of {@link briefCorrectionName}. */
export function briefCorrectionNamePrefix(briefId: string): string {
  return `${BRIEF_CORRECTION} ${briefId} by `;
}

/**
 * Whether `name` is the name of exactly one correction: a fact correction's, with or without
 * the corrected fact's id (names given before 2026-10-13 had none, and are told apart by
 * their timestamp), or a brief correction's that names the fact it overruled.
 */
export function namesOneCorrection(name: string | null | undefined): boolean {
  if (!name) return false;
  return (
    /^Human fact \(edited\) — \S+( — corrects \S+)?$/u.test(name) ||
    /^Correction to brief \S+ by \S+ — corrects \S+$/u.test(name)
  );
}

/** What a correction's `supersede` summary starts with when the removed fact had a subject. */
export const CORRECTED_PREFIX = "corrected: ";

/** What it starts with when the removed fact was a graph fact, which is filed under no name: its text follows. */
export const CORRECTED_FACT_PREFIX = "corrected fact: ";

/**
 * The title of the `supersede` event a correction's removal records. For a stored fact,
 * "corrected: <subject>", the entity name it was filed under; for a graph fact, which has none,
 * "corrected fact: <its text>"; and "corrected" when neither is known, or the name was another
 * correction's own, which says nothing about what the fact was about. Like a conflict's
 * "superseded by <id>: <subject>", it names the fact, not the text that replaced it: that is the
 * correction's own `create`. Once the fact is gone, this is how a person erasure finds the
 * correction of a fact about that person (services/memory/person-erasure.ts,
 * `correctionSubjectPatterns`).
 */
export function correctionTitle(subject: string | null | undefined, factText?: string): string {
  const named = subject?.replace(/\s+/gu, " ").trim();
  if (named && !namesOneCorrection(named)) return `${CORRECTED_PREFIX}${named}`;
  const fact = factText?.replace(/\s+/gu, " ").trim();
  return fact ? `${CORRECTED_FACT_PREFIX}${fact}` : "corrected";
}
