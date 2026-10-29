// What the graph readers read from the raw rows (`memory_chunks`) instead of the graph, on a
// tier that does not read the graph or for a row the graph has not absorbed.
//
// The one rule this file enforces: every lookup is bound to the caller's own org, and none
// widens what a reader may see. Each takes ids a reader already holds (a fact it was served,
// a row anchored on a uuid) and answers about those ids alone; the caller has already decided
// access to them.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { ActorType } from "@/types/memory";
import { DEFAULT_ACCOUNT_TIER, loadAccountTier } from "./account-tiers";
import { GRAPH_READING_TIERS, graphReadAllowed } from "./routing-policy";

/** Whether reads in this org may ask the graph, from its account tier (the routing policy's rule). */
export async function graphReadAllowedFor(orgId: string): Promise<boolean> {
  return graphReadAllowed(await loadAccountTier(orgId));
}

/**
 * Who wrote a raw row, as the row itself records it, or null when `chunkId` names no row of
 * the org (a graph edge's uuid, say). The synchronous contradiction check reads this when
 * no graph edge matches its hit, so a row the graph has not absorbed yet is ranked as written.
 */
export async function rawRowAuthorship(
  orgId: string,
  chunkId: string,
): Promise<{ actorType: ActorType; actorName: string | null } | null> {
  const row = await db.memoryChunk.findFirst({
    where: { id: chunkId, orgId },
    select: { actorType: true, actorName: true },
  });
  return row ? { actorType: row.actorType as ActorType, actorName: row.actorName } : null;
}

/** The entity name a raw row was written about, or null when it names none or is not the org's. */
export async function rawRowEntityName(orgId: string, chunkId: string): Promise<string | null> {
  const row = await db.memoryChunk.findFirst({ where: { id: chunkId, orgId }, select: { entityName: true } });
  const name = row?.entityName?.trim();
  return name ? name : null;
}

/**
 * The rows a reader on this org's tier may be served, of rows anchored on a fact uuid
 * (`fact_disputes`, `fact_provenance`): all of them where the tier reads the graph, else only
 * those anchored on one of the org's raw rows. A row anchored on a graph edge is not served
 * where the edge itself is not. On enterprise this returns `rows` unchanged, with no query.
 */
export async function keepServedAnchors<T extends { graphitiFactUuid: string }>(
  orgId: string,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0 || (await graphReadAllowedFor(orgId))) return [...rows];
  const ids = [...new Set(rows.map((r) => r.graphitiFactUuid))];
  const raw = await db.memoryChunk.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } });
  const held = new Set(raw.map((r) => r.id));
  return rows.filter((r) => held.has(r.graphitiFactUuid));
}

/**
 * SQL that is true when a row anchored on `uuidColumn` may be served on the org's tier: the
 * same answer as {@link keepServedAnchors}, for a reader that decides inside one statement
 * (services/memory/task-start.ts). The tier is read from `settings.accountTier` the way
 * `accountTierFromSettings` reads it, absent meaning the default; a value that names no tier
 * is not one that reads the graph, so it narrows rather than widens.
 */
export function servedAnchorSql(orgId: string, uuidColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    COALESCE((SELECT o."settings"->>'accountTier' FROM "orgs" o WHERE o."id" = ${orgId}), ${DEFAULT_ACCOUNT_TIER})
      IN (${Prisma.join(GRAPH_READING_TIERS)})
    OR EXISTS (SELECT 1 FROM "memory_chunks" anchor WHERE anchor."id" = ${uuidColumn} AND anchor."orgId" = ${orgId})
  )`;
}
