// Which of a question's specific values some memory the caller can read holds.
//
// memory_query's "no visible match" note (mcp/read-notes.ts) rests on this check. It
// runs over every memory the read may see, not over the page the read serves, so "not on
// this page" is never presented as "not in memory". Every memory here means every current
// stored version (`memory_chunks`), every rule in force (`conventions`) and every live
// working note (`working_notes`) in the read's scope and below it. The graph store holds
// facts distilled from those versions, and content of its own from connectors and entity
// seeds; that content has no exhaustive search, so `graphOnlyContentReachable` says when
// a read could reach it, and the read then makes no claim at all.
//
// The one rule this file enforces: the answer is a function of the question and of the
// memory the caller may read, and of nothing else. It runs only after check() has allowed
// the read (GuardedMemoryStore.retrieve), over the rows that read may see: this org, the
// checked scope and its descendants (untagged rows only when that scope covers org root),
// current versions only, and never a row an erasure suppresses. A value held only where
// the caller cannot read, held only in a deleted record, or never written gives the same
// answer, so the answer says nothing about which of those it was.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { flattenSql, scopeContainsSql } from "@/services/access";
import {
  erasedByVersionDigestSql,
  erasuresApplied,
  loadErasedContentFilter,
  versionIdDigestSql,
} from "./erasure-suppression";
import { CURRENT_VERSIONS_ONLY } from "./pgvector-store";
import { IGNORABLE_CLASS, textHoldsValue, unsettledCharacterClass, type SpecificValue } from "./specific-values";

/** The rows one authorized read may see. */
export interface ReadableRows {
  orgId: string;
  /** The scope check() authorized; undefined for the org root, which sees every row. */
  scope: string | undefined;
  /** Whether that scope covers org root, so the untagged rows are readable too. */
  includeUntagged: boolean;
}

/**
 * Stored versions the first round reads. Each later round reads four times as many as the
 * one before, leaving out every version already read, and a round that reads fewer than
 * it asked for has seen every match.
 */
const FIRST_ROUND_VERSIONS = 50;
/**
 * Rounds before the check gives up, past 68,250 versions read: then it makes no claim at
 * all (null), for every value, rather than count an unsettled value either way. Only a
 * scope full of versions an erasure suppresses can get there.
 */
const MAX_ROUNDS = 6;
/**
 * How long one statement of the check may run. A check that takes longer makes no claim,
 * and the read answers without the note; well inside the shortest store-call ceiling any
 * tier allows (1,500 ms, account-tiers.ts).
 */
const CHECK_TIMEOUT_MS = 1_000;

type VersionRow = { id: string; content: string; created_at: Date | null; entity_name: string | null };

/** `column` within the read's scope, as the vector read filters it (pgvector-store.ts). */
function inScope(column: string, rows: ReadableRows, opts: { nullable: boolean }): Prisma.Sql {
  if (rows.scope === undefined) return Prisma.sql`true`;
  return scopeContainsSql(Prisma.raw(column), rows.scope, {
    relation: "within",
    mode: "text",
    includeUntagged: opts.nullable && rows.includeUntagged,
  });
}

/**
 * `column` as specific-values.ts compares a text (normalizeForMatch): default-ignorable
 * characters removed, in NFKC form, and any default-ignorable character that produced
 * removed too. normalize() costs about ten times a pattern match, so it runs only on a
 * text holding a character that could change it (unsettledCharacterClass): an ASCII text,
 * or one whose other characters NFKC leaves as they are, is the same text normalized.
 */
function matchTextSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN octet_length(${column}) = char_length(${column}) THEN ${column}
    WHEN ${column} ~ ${unsettledCharacterClass()}
      THEN regexp_replace(normalize(regexp_replace(${column}, ${IGNORABLE_CLASS}, '', 'g'), NFKC), ${IGNORABLE_CLASS}, '', 'g')
    ELSE ${column} END`;
}

/** One pattern that matches a text holding any of `values`, and one every such text also matches. */
const anyOf = (values: readonly SpecificValue[]): string => values.map((v) => `(${v.pattern})`).join("|");
const anyScreen = (values: readonly SpecificValue[]): string => values.map((v) => `(${v.screen})`).join("|");

/** Runs `query` with the check's statement timeout, which ends with its transaction. */
async function withinTimeout<T>(query: Prisma.Sql): Promise<T[]> {
  const [, rows] = await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${CHECK_TIMEOUT_MS}`),
    db.$queryRaw<T[]>(...flattenSql(query)),
  ]);
  return rows;
}

/**
 * Up to `limit` current stored versions in the read's scope holding any of `values`,
 * leaving out `excluded`. One pass over the readable rows, whatever the number of values.
 *
 * The rows are chosen in a subquery the planner may not merge (`OFFSET 0`), so the pattern
 * is matched only against rows the read may see: how long the check takes depends on the
 * caller's own memory, not on what other scopes or orgs hold. A version an erasure removed
 * by its id (a copy a restored backup put back) is left out the same way, before the
 * pattern is matched: whether such copies hold a value costs the check nothing.
 */
async function versionsHoldingAny(
  rows: ReadableRows,
  values: readonly SpecificValue[],
  excluded: readonly string[],
  limit: number,
): Promise<VersionRow[]> {
  return withinTimeout<VersionRow>(Prisma.sql`
    SELECT readable.id, readable.content, readable.created_at, readable.entity_name
    FROM (
      SELECT in_scope.id, in_scope.content, in_scope.created_at, in_scope.entity_name,
             ${matchTextSql(Prisma.sql`in_scope.content`)} AS match_text
      FROM (
        SELECT memory_chunks.id, memory_chunks.content, memory_chunks."createdAt" AS created_at,
               memory_chunks."entityName" AS entity_name,
               ${versionIdDigestSql(rows.orgId, Prisma.sql`memory_chunks.id`)} AS version_digest
        FROM memory_chunks
        WHERE memory_chunks."orgId" = ${rows.orgId}
          AND ${CURRENT_VERSIONS_ONLY}
          AND ${inScope('memory_chunks."scopePath"', rows, { nullable: true })}
          AND memory_chunks.id <> ALL (${excluded}::text[])
        OFFSET 0
      ) in_scope
      WHERE NOT ${erasedByVersionDigestSql(rows.orgId, Prisma.sql`in_scope.version_digest`, Prisma.sql`in_scope.created_at`)}
      OFFSET 0
    ) readable
    WHERE readable.match_text ~ ${anyScreen(values)} AND readable.match_text ~ ${anyOf(values)}
    LIMIT ${limit}`);
}

/** Which of `values` a rule in force or a live working note in the read's scope holds, by 0-based position. */
async function rulesAndNotesHolding(rows: ReadableRows, values: readonly SpecificValue[]): Promise<Set<number>> {
  // A rule in force: neither retired, nor a lost race, nor replaced. The rules the
  // task-start block serves (services/memory/task-start.ts, rulesInForce). A redacted rule
  // is retired, so an erased person's rule never answers. A live note: neither released
  // nor expired, as the task-start block serves notes.
  // Both sets are chosen before any pattern is matched (`MATERIALIZED`), as the versions are.
  const found = await withinTimeout<{ i: number }>(Prisma.sql`
    WITH readable AS MATERIALIZED (
      SELECT ${matchTextSql(Prisma.sql`c.subject || E'\n' || c.text`)} AS text FROM conventions c
      WHERE c."orgId" = ${rows.orgId}
        AND ${inScope('c."scopePath"', rows, { nullable: false })}
        AND c."supersededById" IS NULL
        AND c."retiredAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM conventions s WHERE s."orgId" = c."orgId" AND s."supersedesId" = c.id)
      UNION ALL
      SELECT ${matchTextSql(Prisma.sql`n.task || E'\n' || n.body`)} FROM working_notes n
      WHERE n."orgId" = ${rows.orgId}
        AND ${inScope('n."scopePath"', rows, { nullable: false })}
        AND n."releasedAt" IS NULL
        AND n."expiresAt" > ${sqlUtcNow}
    )
    SELECT v.i::int AS i
    FROM unnest(${values.map((v) => v.screen)}::text[], ${values.map((v) => v.pattern)}::text[]) WITH ORDINALITY AS v(screen, pattern, i)
    WHERE EXISTS (SELECT 1 FROM readable WHERE readable.text ~ v.screen AND readable.text ~ v.pattern)`);
  return new Set(found.map((row) => row.i - 1));
}

/**
 * For each of `values`, in order, whether some memory the read may see holds it: a
 * current stored version that no erasure suppresses, a rule in force, or a live working
 * note, in the read's scope or below it; null when the check could not be completed, or
 * when the org's erasures are not recorded as applied (a restore whose re-apply has not run).
 * Call only after check() has allowed the read `rows` describes.
 */
export async function readableMemoryHolds(
  rows: ReadableRows,
  values: readonly SpecificValue[],
): Promise<boolean[] | null> {
  if (values.length === 0) return [];
  // While some list entry is not applied (an erasure is running, or a restore copied newer
  // entries back over an older backup and its re-apply has not run), copies of erased content
  // may still be in the tables, and reading past them costs time that would say whether one
  // held the value. So no claim, and nothing else is read, until every entry is applied
  // (services/memory/erasure-reapply.ts, completeRestore). The cost: any reader in the org
  // sees the note absent meanwhile, which says only that an erasure or a restore is not yet
  // complete somewhere in the org, never which value, scope or person.
  if (!(await erasuresApplied(rows.orgId))) return null;
  const held = new Set<number>();
  const fromRulesAndNotes = rulesAndNotesHolding(rows, values);
  fromRulesAndNotes.catch(() => {});
  // Loaded whether or not a version matches, so the statements issued do not say whether
  // one did. A version an erasure removed by its id is left out in SQL, before its text is
  // read (versionsHoldingAny); this filter catches the rest, by what the text names.
  const erasedFilter = loadErasedContentFilter(rows.orgId);
  erasedFilter.catch(() => {});
  // A version an erasure suppresses is not readable (pgvector-store.ts leaves it out the
  // same way), so it settles nothing: every version read is left out of the next round,
  // and a value only suppressed versions hold stays open until no version is left.
  let open = values.map((_, i) => i);
  const excluded: string[] = [];
  for (let round = 0, limit = FIRST_ROUND_VERSIONS; open.length > 0; round++, limit *= 4) {
    if (round === MAX_ROUNDS) return null;
    const found = await versionsHoldingAny(
      rows,
      open.map((i) => values[i]!),
      excluded,
      limit,
    );
    if (found.length > 0) {
      const isErased = await erasedFilter;
      for (const version of found) {
        excluded.push(version.id);
        if (isErased(version.content, version.created_at, version.entity_name, version.id)) continue;
        for (const i of open) if (textHoldsValue(version.content, values[i]!)) held.add(i);
      }
    }
    open = open.filter((i) => !held.has(i));
    if (found.length < limit) break;
  }
  await erasedFilter;
  for (const i of await fromRulesAndNotes) held.add(i);
  return values.map((_, i) => held.has(i));
}

/**
 * Whether a read of `rows` could reach graph content that is not distilled from the
 * memory `readableMemoryHolds` searches: a connector's synced items (stored in the graph
 * store only, in the connector's scope), and the entity seeds that member, contact,
 * account and role records write under the bare org id, which only a read covering org
 * root reaches. Such content has no exhaustive search, so a read that could reach it
 * makes no claim about what memory lacks.
 */
export async function graphOnlyContentReachable(rows: ReadableRows): Promise<boolean> {
  if (rows.includeUntagged || rows.scope === undefined) return true;
  const sources = await db.$queryRaw<{ found: boolean }[]>(
    ...flattenSql(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM sources s
        WHERE s."orgId" = ${rows.orgId} AND ${inScope('s."scopePath"', rows, { nullable: false })}
      ) AS found`),
  );
  return sources[0]?.found ?? true;
}
