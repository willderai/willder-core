// Facts that copy a rule's text, and facts that contradict a settled rule, served in its light.
//
// memory_ingest stores a convention's or decision's text as a fact as well as a rule
// (mcp/tools/memory-ingest.ts), so a fact read can serve a rule's words without saying whether
// the rule is settled. Facts sharing a subject are versions of one fact to the store, which
// serves the newest first, so a read served an agent's newer conflicting decision, or a plain
// fact an agent wrote on the same subject, above the decision a person confirmed.
//
// The one rule this file enforces: within one subject (its scope and its name, case-folded),
// when the page holds a copy of a rule a person recorded or confirmed, that copy comes first and
// every other fact on that subject follows, a fact an agent wrote that copies no settled rule
// marked as a lead to verify and a person's own fact marked by its writer. Each copy says which rule it is and how it stands, by the rule the task-start block uses
// (`ruleIsSettled`), and a copy of a person's rule is credited to that person. A subject with no
// person's rule on the page, and every fact on no shared subject, keeps the read's order and places.
import { db } from "@/lib/db";
import type { MemoryFact, RuleCopyStanding } from "@/types";
import { ruleIsSettled, type ClaimWriter } from "./claim-status";
import { CONVENTION_RECORD_TYPE, type ConventionKind } from "./conventions";
import { writtenBySql } from "./task-start";

/** A stored chunk that copies a rule in force, with the rule's subject and who recorded it. */
interface CopyRow {
  chunkId: string;
  id: string;
  kind: ConventionKind;
  scopePath: string;
  subject: string;
  by: ClaimWriter;
  /** The person the rule's create event names, when a person recorded it. */
  personId: string | null;
  personName: string | null;
}

/** A copy's standing, with what the read needs to group and credit it. */
interface Copy {
  standing: RuleCopyStanding;
  subjectKey: string;
  /** The person who recorded the rule; `name` is their current users row's, null without one. */
  person: { id: string; name: string | null } | null;
}

/** The order copies are served in: a person's settled rules, other settled rules, then leads. */
function tierOf(standing: RuleCopyStanding): number {
  if (!standing.settled) return 2;
  return standing.by === "person" ? 0 : 1;
}

/** The stored chunks a fact is: the chunk itself, or the chunks a graph fact was extracted from. */
function chunksOf(fact: MemoryFact): string[] {
  return [fact.uuid, ...(fact.chunkIds ?? [])];
}

/** One subject: a scope and a name, compared case-folded and trimmed. */
function subjectKey(scopePath: string, name: string): string {
  return `${scopePath}\n${name.trim().toLowerCase()}`;
}

/** The subject a stored chunk's writer gave it (`MemoryFact.subject`, a JSON [scope, name]). */
function factSubjectKey(fact: MemoryFact): string | null {
  if (!fact.subject) return null;
  try {
    const [scopePath, name] = JSON.parse(fact.subject) as unknown[];
    return typeof scopePath === "string" && typeof name === "string" ? subjectKey(scopePath, name) : null;
  } catch {
    return null;
  }
}

/**
 * `facts` served in the light of the rules in force they copy or contradict; see this file's
 * header for the rule. A fact copies a rule when a chunk it is (itself, or one a graph fact was
 * extracted from) holds the rule's exact text in the rule's own scope, so an excerpt stands as
 * its rule does and no fact names a rule from a scope it is not in. A fact two rules in force
 * back is credited to the better standing one.
 */
export async function settledRuleCopiesFirst(orgId: string, facts: readonly MemoryFact[]): Promise<MemoryFact[]> {
  const chunkIds = [...new Set(facts.flatMap(chunksOf))];
  if (chunkIds.length === 0) return [...facts];

  const rows = await db.$queryRaw<CopyRow[]>`
    SELECT m."id" AS "chunkId", c."id", c."kind"::text AS "kind", c."scopePath", c."subject", w."by",
           p."actorId" AS "personId", u."name" AS "personName"
    FROM "memory_chunks" m
    JOIN "conventions" c ON c."orgId" = m."orgId" AND c."scopePath" = m."scopePath" AND c."text" = m."content"
      AND lower(btrim(m."entityName")) = lower(btrim(c."subject"))
    ${writtenBySql(orgId, CONVENTION_RECORD_TYPE, 'c."id"')}
    LEFT JOIN LATERAL (
      SELECT e."actorId" FROM "change_events" e
      WHERE e."orgId" = ${orgId} AND e."recordType" = ${CONVENTION_RECORD_TYPE} AND e."recordId" = c."id"
        AND e."op" = 'create' AND e."actorType" = 'human'
      ORDER BY e."seq" ASC
      LIMIT 1
    ) p ON w."by" = 'person'
    LEFT JOIN "users" u ON u."id" = p."actorId"
    WHERE m."orgId" = ${orgId}
      AND m."id" = ANY(${chunkIds}::text[])
      AND c."supersededById" IS NULL
      AND c."retiredAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "conventions" s WHERE s."orgId" = c."orgId" AND s."supersedesId" = c."id")
    ORDER BY m."id" COLLATE "C", c."id" COLLATE "C"`;
  if (rows.length === 0) return [...facts];

  const copyOfChunk = new Map<string, Copy>();
  for (const row of rows) {
    const copy: Copy = {
      standing: { ruleId: row.id, kind: row.kind, by: row.by, settled: ruleIsSettled(row) },
      subjectKey: subjectKey(row.scopePath, row.subject),
      person: row.personId ? { id: row.personId, name: row.personName?.trim() || null } : null,
    };
    const held = copyOfChunk.get(row.chunkId);
    if (!held || tierOf(copy.standing) < tierOf(held.standing)) copyOfChunk.set(row.chunkId, copy);
  }

  const served = facts.map((fact) => {
    let best: Copy | undefined;
    for (const id of chunksOf(fact)) {
      const copy = copyOfChunk.get(id);
      if (copy && (!best || tierOf(copy.standing) < tierOf(best.standing))) best = copy;
    }
    return { fact: credited(fact, best), key: best?.subjectKey ?? factSubjectKey(fact) };
  });

  for (const key of new Set(served.flatMap((s) => (s.key ? [s.key] : [])))) {
    const places = served.flatMap((s, i) => (s.key === key ? [i] : []));
    const members = places.map((i) => served[i]!.fact);
    // Only a person's rule leads its subject: an agent's convention is in force too, but never
    // demotes what a person wrote.
    const persons = members.filter((f) => f.rule?.settled && f.rule.by === "person");
    if (persons.length === 0) continue;
    const first = persons[0]!.rule!;
    const rest = members
      .filter((f) => !persons.includes(f))
      .map((f): MemoryFact => {
        if (f.rule?.settled) return f;
        // Every fact here is served after the rule, but only an agent's is a lead: a person's own
        // fact is labelled by its writer (`ruleLabelOf`), never as unverified.
        return {
          ...f,
          contradicts: {
            ruleId: first.ruleId,
            kind: first.kind,
            ...(f.actorType === "human" && !f.sourceId ? { byPerson: true } : {}),
          },
        };
      });
    [...persons, ...rest].forEach((fact, n) => {
      served[places[n]!]!.fact = fact;
    });
  }
  return served.map((s) => s.fact);
}

/** `fact` marked with the rule it copies, and credited to the person when a person recorded it. */
function credited(fact: MemoryFact, copy: Copy | undefined): MemoryFact {
  if (!copy) return { ...fact };
  const marked: MemoryFact = { ...fact, rule: copy.standing };
  if (!copy.standing.settled || !copy.person || fact.sourceId) return marked;
  // Named by their current users row, never by an id or a name stored on the fact; a person
  // with no row left is "a person".
  return { ...marked, actorType: "human", actorName: copy.person.name ?? "a person" };
}

/**
 * A provenance rank that never lets a fact served after a settled rule stand level with anything
 * else, so a read that moves later records above an earlier one (services/memory/update-links.ts)
 * cannot move it back above that rule. Every other fact ranks as `rank` does.
 */
export function rankingLeadsApart(rank: (fact: MemoryFact) => number): (fact: MemoryFact) => number {
  return (fact) => rank(fact) * 2 + (fact.contradicts ? 1 : 0);
}

/** Most combining marks a served name keeps on one character; more only draw over the next line. */
const MAX_MARKS_PER_CHARACTER = 2;
/** Longest a served name may be in UTF-16 units, beyond its grapheme count. */
const MAX_NAME_UNITS = 120;

/**
 * The first `count` user-perceived characters of `text` for a served label: no lone surrogate or
 * split accent, no leading mark (it would combine with the label's own space), at most
 * `MAX_MARKS_PER_CHARACTER` marks on a character and `MAX_NAME_UNITS` units in all. The stored
 * name is untouched.
 */
function firstGraphemes(text: string, count: number): string {
  let out = "";
  let kept = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text.replace(/^\p{M}+/u, ""),
  )) {
    let marks = 0;
    const grapheme = [...segment].filter((c) => !/^\p{M}$/u.test(c) || ++marks <= MAX_MARKS_PER_CHARACTER).join("");
    if (kept === count || out.length + grapheme.length > MAX_NAME_UNITS) break;
    out += grapheme;
    kept += 1;
  }
  return out;
}

/**
 * What a served line says before its text about the rule it copies or contradicts, or null:
 * `[settled decision <id>, a person's]`, `[settled convention <id>, agent-recorded]`,
 * `[lead to verify: decision <id>, not confirmed by a person]`, for a fact an agent wrote on a
 * settled rule's subject `[lead to verify: differs from settled decision <id>]`, and for a
 * person's own fact there `[on the subject of settled decision <id>; recorded by <name>, <date>]`.
 * A fact reaches the "differs" wording only by not being a copy of the rule's exact text, the
 * comparison the copy query makes; it is never said of a person's fact, which may agree.
 */
export function ruleLabelOf(fact: MemoryFact): string | null {
  const standing = fact.rule;
  if (standing?.settled) {
    const rule = `${standing.kind} ${standing.ruleId}`;
    return standing.by === "person" ? `[settled ${rule}, a person's]` : `[settled ${rule}, agent-recorded]`;
  }
  if (standing) return `[lead to verify: ${standing.kind} ${standing.ruleId}, not confirmed by a person]`;
  if (fact.contradicts?.byPerson) {
    // The name is user-editable and the label is read by models: keep letters, digits and plain
    // punctuation only, so it can neither close the bracket nor start another line.
    const clean =
      (fact.actorName ?? "")
        .replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "")
        .replace(/\s+/g, " ")
        .trim() || "a person";
    const name = firstGraphemes(clean, 60) || "a person";
    // Only a stored-at moment is a recording date; an `occurredAt` is when the content happened.
    const date =
      fact.validAtSource === "stored" && /^\d{4}-\d{2}-\d{2}/.test(fact.validAt ?? "")
        ? fact.validAt!.slice(0, 10)
        : null;
    return `[on the subject of settled ${fact.contradicts.kind} ${fact.contradicts.ruleId}; recorded by ${name}${date ? `, ${date}` : ""}]`;
  }
  if (fact.contradicts)
    return `[lead to verify: differs from settled ${fact.contradicts.kind} ${fact.contradicts.ruleId}]`;
  return null;
}
