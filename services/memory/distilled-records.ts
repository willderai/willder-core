// Typed records the ingest distiller (`distillFacts` in lib/inngest/memory-ingest.ts)
// returns, and the checks that decide which of them may be stored.
//
// The one rule this file enforces: a record is stored only when the source text it
// was distilled from actually says it. The distiller is a language model; left to
// free text it can turn "Jordan decided on 2026-09-24 that every agent run reads
// Willder memory ..." into "Jordan is a Decision that specifies operational procedures
// for agent runs", losing the decision and typing a person as one. So a decision's
// text must be a verbatim span of the source (the stored text is that span, not the
// model's wording), its actor and date are kept only when they appear in the source,
// and an entity seed must name something the source mentions, with a type from a
// closed list.
//
// Imported by its own path rather than through `services/memory`'s barrel, like
// `fact-change-event`, so `lib/inngest.ts` does not pull the barrel in twice.

/**
 * The entity types the distiller may seed a graph node for, each with the
 * definition the model is shown. Decisions are not seeded here: they are stored
 * as {@link DecisionRecord}s, which keep what was decided instead of a one-line
 * label for it.
 */
export const ENTITY_SEED_TYPES = {
  Deal: "a specific business opportunity, contract, or commercial engagement",
  Signal: "a market event, job change, funding round, or relationship trigger",
  Commitment: "a stated future action or promise with a deadline",
  PainPoint: "a problem, challenge, or friction that blocks progress",
  Objection: "a reason given against a purchase, decision, or proposal",
  Relationship: "the role a person plays (champion, blocker, decision-maker, sponsor)",
  Project: "a named initiative, workstream, or campaign with a goal",
  Meeting: "a specific gathering with attendees and outcomes",
} as const;

type EntitySeedType = keyof typeof ENTITY_SEED_TYPES;

/** A named entity the source mentions, seeded as a graph node before the facts that
 * reference it are ingested. */
export interface EntitySeed {
  name: string;
  type: EntitySeedType;
  description: string;
}

/** A decision the source states, kept in the source's own words. */
export interface DecisionRecord {
  /** What was decided: a verbatim span of the source. */
  decision: string;
  /** Who decided, when the source names them. */
  actor?: string;
  /** When it was decided (YYYY-MM-DD), when the source states that date. */
  date?: string;
}

/** Decision text shorter than this is not a decision a reader can act on. */
const MIN_DECISION_LENGTH = 15;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the model's raw `decisions` array against `source`. A record whose
 * decision text is not a verbatim span of the source is dropped; an actor or date
 * the source does not contain is dropped from an otherwise valid record.
 */
export function parseDecisions(raw: unknown, source: string): DecisionRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { decision, actor, date } = item as Record<string, unknown>;
    if (typeof decision !== "string") continue;
    const span = findSpan(source, stripEndPunctuation(decision));
    if (span === null || span.length < MIN_DECISION_LENGTH) continue;

    const record: DecisionRecord = { decision: span };
    const actorSpan = typeof actor === "string" ? findSpan(source, actor) : null;
    if (actorSpan) record.actor = actorSpan;
    if (typeof date === "string" && ISO_DATE.test(date.trim()) && source.includes(date.trim())) {
      record.date = date.trim();
    }
    out.push(record);
  }
  return out;
}

/**
 * Render a decision as the fact a reader gets back, type first:
 * `Decision by Jordan on 2026-09-24: every agent run reads Willder memory ...`.
 */
export function decisionToSentence(record: DecisionRecord): string {
  const by = record.actor ? ` by ${record.actor}` : "";
  const on = record.date ? ` on ${record.date}` : "";
  return `Decision${by}${on}: ${record.decision}.`;
}

/**
 * Validate the model's raw `entities` array against `source`. A seed survives only
 * with a type from {@link ENTITY_SEED_TYPES}, a name the source contains, and a
 * description. A name that is the actor of one of `decisions` is never seeded: that
 * is a person, and no seed type describes one.
 */
export function parseEntitySeeds(
  raw: unknown,
  source: string,
  decisions: readonly DecisionRecord[] = [],
): EntitySeed[] {
  if (!Array.isArray(raw)) return [];
  const actors = new Set(decisions.flatMap((d) => (d.actor ? [normalize(d.actor)] : [])));
  const out: EntitySeed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { name, type, description } = item as Record<string, unknown>;
    if (typeof type !== "string" || !Object.hasOwn(ENTITY_SEED_TYPES, type)) continue;
    if (typeof description !== "string" || !stripEndPunctuation(description)) continue;
    const span = typeof name === "string" ? findSpan(source, name) : null;
    if (!span || actors.has(normalize(span))) continue;
    out.push({ name: span, type: type as EntitySeedType, description: stripEndPunctuation(description) });
  }
  return out;
}

/**
 * Render a seed as the definition Graphiti creates its node from, which a read can serve
 * back as a fact: `ED: the emergency department that referred the patient.`
 *
 * The description is the model's own clause, as often a noun phrase as a verb phrase, so
 * the name is followed by a colon, which reads for both. The type is not stated: it is the
 * model's pick from {@link ENTITY_SEED_TYPES}, which decides whether a seed is made at
 * all, and no graph node type uses it, so a wrong pick ("MemCare is a Relationship") would
 * be served as a claim nobody made.
 */
export function entitySeedToSentence(seed: EntitySeed): string {
  return `${seed.name}: ${seed.description}.`;
}

/**
 * The span of `source` that matches `text`, ignoring case and runs of whitespace,
 * in the source's own spelling; null when the source does not contain it.
 */
function findSpan(source: string, text: string): string | null {
  const needle = normalize(text);
  if (!needle) return null;
  const { normalized, offsets } = normalizeWithOffsets(source);
  const at = normalized.indexOf(needle);
  if (at === -1) return null;
  return source.slice(offsets[at], offsets[at + needle.length - 1] + 1);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** {@link normalize} for the whole source, keeping each normalized character's
 * index in the original string so a match can be cut from the original. */
function normalizeWithOffsets(source: string): { normalized: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const isSpace = /\s/.test(source[i]);
    if (isSpace && (normalized === "" || normalized.endsWith(" "))) continue;
    // Lowercasing can lengthen a character (U+0130 becomes two), so every
    // character it produces maps back to the same source index.
    const lowered = isSpace ? " " : source[i].toLowerCase();
    normalized += lowered;
    for (let k = 0; k < lowered.length; k++) offsets.push(i);
  }
  return { normalized, offsets };
}

function stripEndPunctuation(text: string): string {
  return text
    .trim()
    .replace(/[.;,]+$/, "")
    .trim();
}
