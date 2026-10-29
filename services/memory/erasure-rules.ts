// What a person erasure does to rules: the conventions and decisions served unasked at the
// start of every session in their scope (services/memory/conventions.ts).
//
// THE ONE RULE: a rule version that names an erased person, and every version written in place
// of one, is redacted: its subject and text are blanked and it is retired, so it is never served
// again. "Written in place of" follows the rule's own chain (`supersedesId`), as
// services/memory/erasure-lineage.ts follows a fact's: a replacement need not name anyone ("She
// approves refunds", replacing "Dana Whitfield approves refunds") and goes with what it replaced.
// A version that lost a race to replace a rule is not written in place of it, and stays.
//
// The row is redacted rather than deleted because the chain is what keeps older versions out of
// service: a rule is served while no row names it as replaced, so deleting a replacement would
// serve the version it replaced again (conventions.ts, `deleteRetiredConvention`'s
// `wouldRestore`). A redacted row holds ids, a scope and timestamps, nothing a person wrote.
//
// What a redacted rule leaves elsewhere goes with it:
//  - the fact memory_ingest stored its text as (mcp/tools/memory-ingest.ts), linked to it by the
//    one access decision that admitted both, which both `create` events name (`authorizedById`):
//    its row, its passages and its graph copy, as any erased fact version, through
//    erasure-lineage.ts, which also removes whatever was written in place of that fact;
//  - the text of every change event about it, blanked. A rule that was in force gets a `delete`
//    event with no text, so a subscriber stops serving it;
//  - the task-start log's rows naming it.
// Its id goes on the suppression list (kind "rule_id"), so a retry still finds what replaced it
// after its text is gone, and `reapplyErasures` redacts a copy a restored backup puts back.
import type { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import type { AccessContext } from "@/services/access";
import { FACT_RECORD_TYPE, recordChangeEvent } from "./change-events";
import { CONVENTION_RECORD_TYPE } from "./conventions";
import {
  ErasureLineageTooLargeError,
  MAX_LINEAGE_DEPTH,
  MAX_LINEAGE_VERSIONS,
  type LineageBounds,
} from "./erasure-lineage";
import { erasedRulesAmong, recordErasedRules } from "./erasure-suppression";
import { forgetErasedVersions } from "./task-start-served";

/** The slice of a Prisma client or transaction the reads here go through. */
type RuleReader = Pick<Prisma.TransactionClient, "$queryRaw" | "erasureSuppression">;

/**
 * Every rule in `orgId` written in place of one of `erased`, and in place of those, to the end
 * of each chain, without `erased` themselves. A rule is replaced at most once (the unique index
 * on `supersedesId`), so each chain is a line.
 *
 * @throws ErasureLineageTooLargeError past either bound.
 */
export async function rulesWrittenInPlaceOf(
  reader: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  erased: readonly string[],
  { maxVersions = MAX_LINEAGE_VERSIONS, maxDepth = MAX_LINEAGE_DEPTH }: LineageBounds = {},
): Promise<string[]> {
  const visited = new Set(erased);
  const found: string[] = [];
  let frontier = [...visited];
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= maxDepth) throw new ErasureLineageTooLargeError("depth", maxDepth);
    const next = await reader.$queryRaw<{ id: string }[]>`
      SELECT id FROM conventions WHERE "orgId" = ${orgId} AND "supersedesId" = ANY (${frontier}::text[]) ORDER BY id
    `;
    frontier = [];
    for (const { id } of next) {
      if (visited.has(id)) continue;
      visited.add(id);
      if (visited.size > maxVersions) throw new ErasureLineageTooLargeError("versions", maxVersions);
      found.push(id);
      frontier.push(id);
    }
  }
  return found;
}

/**
 * The rules in `orgId` an erasure still owes: those `namesPerson` matches (a predicate over the
 * `conventions` row), those an earlier erasure redacted that a restore or a failed step left
 * unredacted, and every version written in place of any of them or of a rule already redacted.
 * Only rules not yet redacted are returned, so a step run again redacts nothing twice.
 */
export async function rulesToRedact(reader: RuleReader, orgId: string, namesPerson: Prisma.Sql): Promise<string[]> {
  const named = await reader.$queryRaw<{ id: string }[]>`
    SELECT id FROM conventions WHERE "orgId" = ${orgId} AND ${namesPerson}
  `;
  const all = await reader.$queryRaw<{ id: string }[]>`SELECT id FROM conventions WHERE "orgId" = ${orgId}`;
  const erased = await erasedRulesAmong(
    reader,
    orgId,
    all.map((r) => r.id),
  );
  const start = [...new Set([...named.map((r) => r.id), ...erased])];
  const owed = [...start, ...(await rulesWrittenInPlaceOf(reader, orgId, start))];
  if (owed.length === 0) return [];
  const pending = await reader.$queryRaw<{ id: string }[]>`
    SELECT id FROM conventions
    WHERE "orgId" = ${orgId} AND id = ANY (${owed}::text[]) AND (subject <> '' OR text <> '' OR "retiredAt" IS NULL)
    ORDER BY id
  `;
  return pending.map((r) => r.id);
}

/**
 * The fact versions memory_ingest stored the text of `ruleIds` as: the facts announced under the
 * access decision a rule's own `create` event names. A rule recorded without a visible decision
 * names none, and has no fact found this way.
 */
export async function factCopiesOfRules(
  reader: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  ruleIds: readonly string[],
): Promise<string[]> {
  if (ruleIds.length === 0) return [];
  const facts = await reader.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT f."recordId" AS id
    FROM change_events r
    JOIN change_events f ON f."orgId" = r."orgId" AND f."authorizedById" = r."authorizedById"
    WHERE r."orgId" = ${orgId} AND r."recordType" = ${CONVENTION_RECORD_TYPE} AND r.op = 'create'
      AND r."recordId" = ANY (${[...ruleIds]}::text[]) AND r."authorizedById" IS NOT NULL
      AND f."recordType" = ${FACT_RECORD_TYPE} AND f.op = 'create'
    ORDER BY id
  `;
  return facts.map((f) => f.id);
}

/**
 * Inside `tx`: redact and retire those of `ruleIds` not redacted yet, announce a `delete` with no
 * text for each that was in force, blank the text of every change event about them, forget them
 * in the task-start log, and put them on the suppression list as removed by `requestId`. Their
 * fact copies are the caller's to remove ({@link factCopiesOfRules}).
 *
 * @returns how many rules were redacted, and how many summaries were blanked.
 */
export async function redactRules(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  requestId: string,
  ruleIds: readonly string[],
): Promise<{ rules: number; summariesBlanked: number }> {
  if (ruleIds.length === 0) return { rules: 0, summariesBlanked: 0 };
  const ids = [...ruleIds];
  // In force is decided before the update, as task-start decides it: not retired, not a race's
  // loser, and replaced by nothing.
  const redacted = await tx.$queryRaw<{ id: string; scopePath: string; inForce: boolean }[]>`
    WITH target AS (
      SELECT c.id, c."scopePath",
        (c."retiredAt" IS NULL AND c."supersededById" IS NULL
          AND NOT EXISTS (SELECT 1 FROM conventions s WHERE s."supersedesId" = c.id)) AS "inForce"
      FROM conventions c
      WHERE c."orgId" = ${ctx.orgId} AND c.id = ANY (${ids}::text[])
        AND (c.subject <> '' OR c.text <> '' OR c."retiredAt" IS NULL)
    )
    UPDATE conventions AS c
    SET subject = '', text = '',
        "retiredAt" = COALESCE(c."retiredAt", ${sqlUtcNow}),
        "retiredBy" = COALESCE(c."retiredBy", ${ctx.actor.id})
    FROM target
    WHERE c.id = target.id
    RETURNING target.id, target."scopePath", target."inForce"
  `;
  const summariesBlanked = await tx.$executeRaw`
    UPDATE change_events SET summary = ''
    WHERE "orgId" = ${ctx.orgId} AND "recordType" = ${CONVENTION_RECORD_TYPE} AND "recordId" = ANY (${ids}::text[])
      AND summary <> ''
  `;
  for (const rule of redacted.filter((r) => r.inForce)) {
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: rule.scopePath,
      recordType: CONVENTION_RECORD_TYPE,
      recordId: rule.id,
      op: "delete",
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      title: "",
    });
  }
  await forgetErasedVersions(tx, ctx.orgId, ids);
  await recordErasedRules(tx, ctx.orgId, requestId, ids);
  return { rules: redacted.length, summariesBlanked };
}
