// A retired version's place on a read's page goes to its current successor.
//
// A version is retired only by an explicit record: a `supersedes` edge from the version
// that replaced it (services/memory/edges.ts). A writer creates one by naming the version
// it read as `baseVersion` (services/memory/fact-update.ts), or the product does when a
// write race, a stale write, a person's correction or an upstream edit settles which
// version is current (services/memory/conflict.ts, fact-reads.ts). An entity name never
// links two versions here: many facts are written under one name (memory_ingest's `name`
// is the entity a fact is about), so two writes sharing a name are two facts unless the
// writer said otherwise.
//
// Before this file, a read left a retired version out and served nothing in its place. A
// question worded like the old version matched it, the version was dropped, and the update
// its writer recorded never reached the page when the update's own words did not match.
//
// THE ONE RULE: when a read's search ranks a retired version, that place goes to the head
// of its lineage (the version nothing has retired, following each version's earliest
// `supersedes` edge, the order services/memory/superseded-facts.ts names winners in), when
// the reader may read it; otherwise the retired version is dropped, as before. A retired
// version is never served.
//
// "May read" is the vector search's own test for its rows: the same org, inside the read's
// scope by the shared containment predicate, embedded, and not suppressed by a person
// erasure; and nothing still retires it (a lineage that loops serves nothing). Neither a
// successor nor the version it stands in for is stored under a rule's subject in the rule's
// scope, which every copy of a rule is (the fact `memory_ingest` stores beside a convention
// or decision, named by its subject): rules are replaced in the conventions table, whose own
// checks decide who may replace a person's rule, and a fact chain over a copy carries none
// of them.
//
// One query per read that ranked a retired version, and none otherwise.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { flattenSql, scopeContainsSql } from "@/services/access/scope-containment";
import type { MemoryFact } from "@/types/memory";
import { loadErasedContentFilter } from "./erasure-suppression";
import { storedChunkFact, type StoredChunkRow } from "./pgvector-store";

/** Which rows the read may see, as the vector search decides it (services/memory/pgvector-store.ts). */
export interface ReadableScope {
  /** The scope the read was authorized at; absent for a read authorized at the org root. */
  scope?: string;
  /** Whether rows with no scope are readable: true only when the read covers the org root. */
  includeUntagged: boolean;
}

/**
 * Whether the `memory_chunks` row `alias` is stored under a rule's subject in the rule's own
 * scope: every copy of a rule is (memory_ingest names the copy by the rule's subject), however
 * the stored text was normalized when an identical write was replayed onto it.
 */
function underRuleSubjectSql(alias: "retired" | "head"): Prisma.Sql {
  const row = Prisma.raw(`"${alias}"`);
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "conventions" r
    WHERE r."orgId" = ${row}."orgId" AND r."scopePath" = ${row}."scopePath" AND r."subject" = ${row}."entityName"
  )`;
}

/**
 * For each of `retiredIds` whose lineage ends in a version the read may serve, that version
 * as a read serves it, keyed by the retired id. An id nothing retired, or whose current
 * successor the reader may not read, is absent.
 */
export async function loadCurrentSuccessors(
  orgId: string,
  retiredIds: readonly string[],
  readable: ReadableScope,
): Promise<Map<string, MemoryFact>> {
  if (retiredIds.length === 0) return new Map();
  const withinRead = readable.scope
    ? Prisma.sql`AND ${scopeContainsSql(Prisma.raw('"head"."scopePath"'), readable.scope, {
        relation: "within",
        mode: "text",
        includeUntagged: readable.includeUntagged,
      })}`
    : Prisma.empty;
  const rows = await db.$queryRaw<(StoredChunkRow & { retired_id: string })[]>(
    ...flattenSql(Prisma.sql`
      WITH RECURSIVE lineage("retiredId", "id", "depth") AS (
        SELECT start, start, 0 FROM unnest(${[...new Set(retiredIds)]}::text[]) AS start
        UNION ALL
        SELECT lineage."retiredId", next."fromId", lineage."depth" + 1
        FROM lineage
        CROSS JOIN LATERAL (
          SELECT e."fromId" FROM "fact_edges" e
          WHERE e."orgId" = ${orgId} AND e."toId" = lineage."id" AND e."kind" = 'supersedes'
          ORDER BY e."createdAt" ASC, e."id" ASC
          LIMIT 1
        ) next
      ) CYCLE "id" SET "looped" USING "path",
      lineage_heads AS (
        SELECT DISTINCT ON ("retiredId") "retiredId", "id"
        FROM lineage
        WHERE NOT "looped"
        ORDER BY "retiredId", "depth" DESC
      )
      SELECT h."retiredId" AS retired_id, "head"."id", "head"."content", "head"."createdAt" AS created_at,
             "head"."occurredAt" AS occurred_at, "head"."actorType" AS actor_type, "head"."actorName" AS actor_name,
             "head"."sourceId" AS source_id, "head"."entityName" AS entity_name, "head"."scopePath" AS scope_path,
             "head"."factVersion" AS fact_version
      FROM lineage_heads h
      JOIN "memory_chunks" "retired" ON "retired"."id" = h."retiredId" AND "retired"."orgId" = ${orgId}
      JOIN "memory_chunks" "head" ON "head"."id" = h."id" AND "head"."orgId" = ${orgId}
      WHERE h."id" <> h."retiredId"
        -- A lineage that loops ends on a version an edge still retires: never served.
        AND NOT EXISTS (
          SELECT 1 FROM "fact_edges" e
          WHERE e."orgId" = ${orgId} AND e."toId" = "head"."id" AND e."kind" = 'supersedes'
        )
        AND "head"."embedding" IS NOT NULL
        ${withinRead}
        AND NOT ${underRuleSubjectSql("retired")}
        AND NOT ${underRuleSubjectSql("head")}
    `),
  );
  if (rows.length === 0) return new Map();

  const erased = await loadErasedContentFilter(orgId);
  const successors = new Map<string, MemoryFact>();
  for (const { retired_id: retiredId, ...head } of rows) {
    if (!erased(head.content, head.created_at, head.entity_name, head.id))
      successors.set(retiredId, storedChunkFact(head));
  }
  return successors;
}

/**
 * The stored versions a retired fact on a leg stands for: a vector row the search marked
 * `retired`, or every version behind a graph fact the supersession record retired (in
 * `retiredGraphFacts`). Null for a fact that is not retired.
 */
export function retiredVersionsOf(fact: MemoryFact, retiredGraphFacts: ReadonlySet<MemoryFact>): string[] | null {
  if (fact.retired) return [fact.uuid];
  if (retiredGraphFacts.has(fact)) return fact.chunkIds ?? [];
  return null;
}

/** The stored versions a fact on a leg was read from: a vector row itself, or a graph fact's stamped versions. */
function versionsHeldBy(fact: MemoryFact): string[] {
  return fact.store === "semantic" ? [fact.uuid] : (fact.chunkIds ?? []);
}

/**
 * `facts` (one leg's answer) with each retired fact replaced, in its place, by the current
 * successors of the versions behind it (`successors`, from `loadCurrentSuccessors`), or
 * dropped when the reader may read none. A successor this leg already answered with, as a
 * row or as a graph fact read from it, moves up into that place as it was answered, with
 * its own similarity and citation; any other is the row the lookup read. Nothing is listed
 * twice.
 */
export function inRetiredPlaces(
  facts: readonly MemoryFact[],
  retiredGraphFacts: ReadonlySet<MemoryFact>,
  successors: ReadonlyMap<string, MemoryFact>,
): MemoryFact[] {
  const holders = new Map<string, MemoryFact>();
  for (const fact of facts) {
    if (retiredVersionsOf(fact, retiredGraphFacts) !== null) continue;
    for (const id of versionsHeldBy(fact)) if (!holders.has(id)) holders.set(id, fact);
  }
  const listed = new Set<string>();
  const kept: MemoryFact[] = [];
  const add = (fact: MemoryFact) => {
    if (listed.has(fact.uuid)) return;
    listed.add(fact.uuid);
    kept.push(fact);
  };
  for (const fact of facts) {
    const retired = retiredVersionsOf(fact, retiredGraphFacts);
    if (retired === null) add(fact);
    else
      for (const id of retired) {
        const successor = successors.get(id);
        if (successor) add(holders.get(successor.uuid) ?? successor);
      }
  }
  return kept;
}
