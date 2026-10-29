// Read-your-writes on the graph path: the caller's own stored versions about an entity
// that the graph may not have extracted yet.
//
// memory_ingest stores a version in Postgres before it returns, and queues graph
// extraction to run afterwards. memory_query reads Postgres directly, so it sees the write
// at once; memory_entity reads the graph, so until extraction finishes the writer's next
// read of the entity would leave out what it just wrote. That read now also serves the
// writer's own recent versions about the entity, from Postgres
// (nothing for the agent to pass).
//
// The one rule this file enforces: the overlay never shows a caller anything it could not
// already read, and never shows anyone else's write. A row is served only when all hold:
//
// - the calling agent wrote it, so no other reader's answer changes;
// - it is in the partition the entity was found in, which check() already authorized, and
//   which is the partition the graph extracts it into;
// - it is a current version (no `supersedes` edge points at it);
// - it names the entity, in its entity name or its text;
// - it is recent: the overlay covers extraction's lag, not a second copy of the graph.
//
// Rows the graph already holds on this entity are left out by the caller, which knows the
// chunk ids stamped on the entity's graph facts (`MemoryFact.chunkIds`).
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { flattenSql, type AccessContext } from "@/services/access";
import { CURRENT_VERSIONS_ONLY } from "./pgvector-store";
import type { MemoryFact } from "@/types/memory";

/**
 * How far back a caller's own write is still served beside the graph. Extraction usually
 * lands within a minute or two; this leaves room for a queue backlog without turning the
 * overlay into a permanent second answer.
 */
const OWN_PENDING_WINDOW_MS = 15 * 60 * 1000;

/** Most own versions served on one entity read; the newest win. */
const MAX_OWN_PENDING_FACTS = 20;

export interface OwnPendingLookup {
  /** The entity as the graph returned it: its name is what a write must name. */
  entityName: string;
  /** The partition the entity was found in: a scope path, or the bare org id for untagged content. */
  partition: string;
  /** Stored version ids the graph already serves on this entity. */
  alreadyHeld: ReadonlySet<string>;
}

/**
 * The caller's own current versions in `partition` that name `entityName`, written within
 * {@link OWN_PENDING_WINDOW_MS}, newest first, minus the ones the graph already holds.
 * Assumes check() has authorized the caller to read `partition`.
 */
export async function loadOwnPendingFacts(ctx: AccessContext, lookup: OwnPendingLookup): Promise<MemoryFact[]> {
  // Pending own facts are about an agent's reads; a person's entity page is unchanged.
  if (ctx.actor.type !== "agent") return [];
  const name = lookup.entityName.trim().toLowerCase();
  if (name === "") return [];
  // The graph writes a row with no scope into the bare org id's partition
  // (graphiti-store.ts ingest: `scopePath ?? groupId`), so that partition holds the
  // untagged rows and only them.
  const inPartition =
    lookup.partition === ctx.orgId ? Prisma.sql`"scopePath" IS NULL` : Prisma.sql`"scopePath" = ${lookup.partition}`;
  const since = new Date(Date.now() - OWN_PENDING_WINDOW_MS);
  const rows = await db.$queryRaw<{ id: string; content: string; actor_name: string | null }[]>(
    ...flattenSql(Prisma.sql`
      SELECT id, content, "actorName" AS actor_name
      FROM memory_chunks
      WHERE "orgId" = ${ctx.orgId}
        AND "actorType" = 'agent'
        AND "actorId" = ${ctx.actor.id}
        AND ${inPartition}
        AND "createdAt" >= ${since}
        AND (lower("entityName") = ${name} OR strpos(lower(content), ${name}) > 0)
        AND ${CURRENT_VERSIONS_ONLY}
      ORDER BY "createdAt" DESC
      LIMIT ${MAX_OWN_PENDING_FACTS + lookup.alreadyHeld.size}
    `),
  );
  return rows
    .filter((row) => !lookup.alreadyHeld.has(row.id))
    .slice(0, MAX_OWN_PENDING_FACTS)
    .map((row) => ({
      uuid: row.id,
      fact: row.content,
      validAt: null,
      actorType: "agent",
      ...(row.actor_name ? { actorName: row.actor_name } : {}),
      store: "semantic",
    }));
}
