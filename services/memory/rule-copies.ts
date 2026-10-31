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
//
// A person's rule in force may have no copy on the page: an agent replaced the copy before the
// person confirmed, it lost a conflict window, it was deleted, or it ranked below the limit. A read
// of the subject must not then read as if no rule stood, so the first fact there carries one label
// with the rule's own text (`standingRules`), and no other fact there is labelled: without the
// rule beside them nothing shows they differ. The text comes from the rule, in the fact's own
// scope, which is what the copy held. It is served as fact text is, under its own budget, since
// the read's token budget was spent before this label; a rule that reads as erased is left out,
// and the erasure's own rule is untouched (services/memory/erasure-rules.ts).
import { db } from "@/lib/db";
import type { MemoryFact, RuleCopyStanding, StandingRule } from "@/types";
import { ruleIsSettled, type ClaimWriter } from "./claim-status";
import { CONVENTION_RECORD_TYPE, type ConventionKind } from "./conventions";
import { loadErasedContentFilter } from "./erasure-suppression";
import { inlineText } from "./inline-text";
import { RULE_IN_FORCE_SQL } from "./person-rule-copy";
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
  /** False when the chunk only shares a person's rule's subject; absent or true when it copies it. */
  copies?: boolean;
  text?: string;
  createdAt?: Date;
}

/** Most of one rule's text a label carries when no copy of the rule is on the page. */
const STANDING_RULE_CHARS = 280;
/** Most rule text those labels carry on one page: the read's own token budget was spent before them. */
const STANDING_RULES_PAGE_CHARS = 800;

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
           p."actorId" AS "personId", u."name" AS "personName",
           c."text" = m."content" AS "copies", c."text", c."createdAt"
    FROM "memory_chunks" m
    JOIN "conventions" c ON c."orgId" = m."orgId" AND c."scopePath" = m."scopePath"
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
      AND ${RULE_IN_FORCE_SQL}
      AND (c."text" = m."content" OR w."by" = 'person')
    ORDER BY m."id" COLLATE "C", c."id" COLLATE "C"`;
  if (rows.length === 0) return [...facts];

  const copyOfChunk = new Map<string, Copy>();
  const subjectOfChunk = new Map<string, string>();
  for (const row of rows) {
    if (row.copies === false) {
      subjectOfChunk.set(row.chunkId, subjectKey(row.scopePath, row.subject));
      continue;
    }
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
    // A graph fact reaches a rule through a chunk only in its own scope: the label carries text.
    const shared = chunksOf(fact)
      .map((id) => subjectOfChunk.get(id))
      .find((key) => key !== undefined && (!fact.scopePath || key.startsWith(`${fact.scopePath}\n`)));
    return { fact: credited(fact, best), key: best?.subjectKey ?? factSubjectKey(fact) ?? shared ?? null };
  });
  const standing = await standingRulesBySubject(orgId, rows);
  let room = STANDING_RULES_PAGE_CHARS;

  for (const key of new Set(served.flatMap((s) => (s.key ? [s.key] : [])))) {
    const places = served.flatMap((s, i) => (s.key === key ? [i] : []));
    const members = places.map((i) => served[i]!.fact);
    // Only a person's rule leads its subject: an agent's convention is in force too, but never
    // demotes what a person wrote.
    const persons = members.filter((f) => f.rule?.settled && f.rule.by === "person");
    if (persons.length === 0) {
      const rules = standing.get(key);
      if (!rules) continue;
      const fitted = rules.map((rule) => {
        const one = withinRoom(rule, room);
        room -= one.text.length;
        return one;
      });
      served[places[0]!]!.fact = { ...members[0]!, standingRules: fitted };
      continue;
    }
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

/** `rule` as a served line may carry it: one line, nothing that closes the label, within `room`. */
function withinRoom(rule: StandingRule, room: number): StandingRule {
  const text = inlineText(rule.text).replaceAll("[", "(").replaceAll("]", ")").replaceAll('"', "'");
  const count = Math.min(STANDING_RULE_CHARS, room);
  if (text.length <= count) return { ...rule, text };
  return { ...rule, text: count > 0 ? firstGraphemes(text, count, count).trimEnd() : "", cut: true };
}

/**
 * The person's rules in force on each subject `rows` touch, those that read as erased left out.
 * Loads the erased-person list only when a chunk shares such a rule's subject.
 */
async function standingRulesBySubject(orgId: string, rows: readonly CopyRow[]): Promise<Map<string, StandingRule[]>> {
  const out = new Map<string, StandingRule[]>();
  const sharing = rows.filter((row) => row.copies === false);
  if (sharing.length === 0) return out;
  const erased = await loadErasedContentFilter(orgId);
  for (const row of sharing) {
    const at = row.createdAt ? new Date(row.createdAt) : null;
    if (erased(row.text ?? "", at, row.subject) || erased.byRuleId(row.id, at)) continue;
    const key = subjectKey(row.scopePath, row.subject);
    const held = out.get(key) ?? [];
    if (!held.some((rule) => rule.ruleId === row.id))
      out.set(key, [...held, { ruleId: row.id, kind: row.kind, text: row.text ?? "" }]);
  }
  return out;
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
 * `MAX_MARKS_PER_CHARACTER` marks on a character and `maxUnits` units in all. The stored
 * name is untouched.
 */
function firstGraphemes(text: string, count: number, maxUnits = MAX_NAME_UNITS): string {
  let out = "";
  let kept = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text.replace(/^\p{M}+/u, ""),
  )) {
    let marks = 0;
    const grapheme = [...segment].filter((c) => !/^\p{M}$/u.test(c) || ++marks <= MAX_MARKS_PER_CHARACTER).join("");
    if (kept === count || out.length + grapheme.length > maxUnits) break;
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
 * comparison the copy query makes; it is never said of a person's fact, which may agree. A fact
 * carrying `standingRules` opens with one `[a person's settled decision <id> stands on this subject: '<text>']`,
 * since no copy of those rules is on the page to read.
 */
export function ruleLabelOf(fact: MemoryFact): string | null {
  const standing = standingLabelOf(fact.standingRules ?? []);
  return [standing, ownLabelOf(fact)].filter((label) => label !== null).join(" ") || null;
}

/** One label for every rule that stands on a subject with no copy on the page. */
function standingLabelOf(rules: readonly StandingRule[]): string | null {
  const said = (rule: StandingRule): string => {
    const text = rule.text ? `: '${rule.text}${rule.cut ? "…" : ""}'` : "";
    return `${text}${rule.cut ? `; memory_version ${rule.ruleId} reads it whole` : ""}`;
  };
  const [first, ...rest] = rules;
  if (!first) return null;
  const more = rest.map((rule) => `; also ${rule.kind} ${rule.ruleId}${said(rule)}`).join("");
  return `[a person's settled ${first.kind} ${first.ruleId} stands on this subject${said(first)}${more}]`;
}

/** {@link ruleLabelOf} for what the fact itself is, without the rules that stand on its subject. */
function ownLabelOf(fact: MemoryFact): string | null {
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
