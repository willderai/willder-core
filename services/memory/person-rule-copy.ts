// The fact copy of a person's rule, and why an agent's write never replaces it.
//
// A rule's text is stored twice: in `conventions`, and as a fact under the rule's subject
// (mcp/tools/memory-ingest.ts), which is the copy memory_query reads. A rule a person recorded or
// confirmed is replaced only by a person (`personsRuleRefusal`, services/memory/conventions.ts),
// and a write based on the copy must not do through the fact what `supersedes` refuses through the
// rule: the rule would stand in `conventions` while a read served the agent's text alone.
//
// THE ONE RULE: while such a rule is in force, a version an agent bases on its copy replaces
// nothing and is kept beside the copy (`recordBasedWrite`, services/memory/fact-update.ts). A
// person's own write replaces the copy as any version. An agent's change reaches the rule the way
// `kept` says: a new rule, which a person confirms, and the old one retired. A kept version is
// linked to the copy by a `derivedFrom` edge, so an erasure of the copy takes it too
// (services/memory/erasure-lineage.ts): refusals name the copy as `baseVersion` for that reason.
import { Prisma } from "@/lib/generated/prisma/client";
import type { ConventionKind } from "./conventions";

/** The rule a fact version copies. */
export interface PersonRuleCopy {
  ruleId: string;
  kind: ConventionKind;
}

/** The sentence a refusal names such a copy with: the rule, and why this writer stops there. */
export function personRuleCopySentence(versionId: string, rule: PersonRuleCopy): string {
  return `${versionId} is the copy of ${rule.kind} ${rule.ruleId}, which a person recorded or confirmed, so a write from you stands beside it and never replaces it.`;
}

/**
 * How an agent changes the rule itself: a proposal alone leaves the rule in force
 * (`keptRuleReply`, mcp/tools/memory-ingest.ts), so the old rule has to be retired too.
 */
export function changeTheRule(rule: PersonRuleCopy): string {
  return `send memory_ingest with kind and supersedes ${rule.ruleId}; then the person who recorded it, or an owner or admin, confirms yours and retires ${rule.ruleId}.`;
}

/** The record type `conventions` rows are announced under (services/memory/conventions.ts). */
const RULE_RECORD_TYPE = "convention";

/** Whether the `conventions` row `c` is in force: not replaced, not retired, as every read tells. */
export const RULE_IN_FORCE_SQL = Prisma.sql`c."supersededById" IS NULL
      AND c."retiredAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "conventions" s WHERE s."orgId" = c."orgId" AND s."supersedesId" = c."id")`;

/**
 * The person's rule in force that the stored version `versionId` is the current fact copy of, or
 * null. A copy is the rule's exact text under the rule's subject, in the rule's scope, as
 * services/memory/rule-copies.ts reads it. A version already replaced is no copy to protect:
 * a write on it is stale.
 *
 * The first `create` event says who recorded a rule; confirming a rule is a person recording it.
 */
export async function personRuleCopyOf(
  reader: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  versionId: string,
): Promise<PersonRuleCopy | null> {
  const rows = await reader.$queryRaw<{ id: string; kind: ConventionKind }[]>(Prisma.sql`
    SELECT c."id", c."kind"::text AS "kind"
    FROM "memory_chunks" m
    JOIN "conventions" c ON c."orgId" = m."orgId" AND c."scopePath" = m."scopePath" AND c."text" = m."content"
      AND lower(btrim(m."entityName")) = lower(btrim(c."subject"))
    WHERE m."orgId" = ${orgId} AND m."id" = ${versionId}
      AND ${RULE_IN_FORCE_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM "fact_edges" e
        WHERE e."orgId" = m."orgId" AND e."toId" = m."id" AND e."kind" = 'supersedes'
      )
      AND 'human' = (
        SELECT e."actorType"::text FROM "change_events" e
        WHERE e."orgId" = c."orgId" AND e."recordType" = ${RULE_RECORD_TYPE} AND e."recordId" = c."id" AND e."op" = 'create'
        ORDER BY e."seq" ASC
        LIMIT 1
      )
    ORDER BY c."id" COLLATE "C"
    LIMIT 1
  `);
  const rule = rows[0];
  return rule ? { ruleId: rule.id, kind: rule.kind } : null;
}
