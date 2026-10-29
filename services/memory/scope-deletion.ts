/**
 * Deleting a scope without stranding what was stored under it.
 *
 * The rule this file enforces: a scope is deleted only when nothing that can be
 * read through it remains at its path or below. Records carry their scope as a
 * path string, not a foreign key to the `Scope` row, so deleting that row alone
 * leaves them in place, and a scope later recreated at the same path would hand
 * all of them to whoever is granted the new scope.
 *
 * Deletion refuses rather than cascading: removing a source, a brief or a fact
 * is a decision with its own route and its own audit trail, and a scope delete
 * should not make that decision on the caller's behalf. The one thing deletion
 * does change is the change feed, a log no route deletes from: event summaries
 * under the path are cleared in the same transaction as the delete, the same
 * redaction a retired source gets (services/memory/source-retirement.ts).
 *
 * The caller must already have passed check() for the scope. This module does
 * not authorize.
 */

import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { flattenSql, scopeContainsSql } from "@/services/access";
import { graphitiStore } from "./store";

/** Counts of what remains at or under a scope path. Only nonzero kinds are present. */
export type ScopeResidue = Partial<Record<ScopeResidueKind, number>>;

export type ScopeResidueKind =
  | "sources"
  | "briefs"
  | "conventions"
  | "memoryChunks"
  | "liveCapabilities"
  | "graphFacts"
  | "graphEpisodes";

const RESIDUE_LABELS: Record<ScopeResidueKind, [singular: string, plural: string]> = {
  sources: ["source", "sources"],
  briefs: ["brief", "briefs"],
  conventions: ["convention", "conventions"],
  memoryChunks: ["memory chunk", "memory chunks"],
  liveCapabilities: ["unrevoked agent token", "unrevoked agent tokens"],
  graphFacts: ["fact", "facts"],
  graphEpisodes: ["ingested episode", "ingested episodes"],
};

/**
 * Count what still lives at `path` or below it in `orgId`.
 *
 * Postgres rows are matched with the shared escaped-LIKE containment, so an `_`
 * in a path cannot match a sibling. The graph is counted at the scope's own
 * group only: Graphiti keys a group by exact path and has no prefix lookup, and
 * child scopes already block deletion. It counts facts and the episodes they
 * were extracted from, since both carry the group id a recreated scope reuses.
 * A memory-service failure propagates: an unanswered question is not an empty
 * scope.
 */
export async function findScopeResidue(orgId: string, path: string): Promise<ScopeResidue> {
  const within = scopeContainsSql(Prisma.raw('"scopePath"'), path, { relation: "within", mode: "text" });
  const count = async (table: string) => {
    const query = Prisma.sql`SELECT COUNT(*)::int AS n FROM ${Prisma.raw(`"${table}"`)}
      WHERE "orgId" = ${orgId} AND ${within}`;
    const rows = await db.$queryRaw<{ n: number }[]>(...flattenSql(query));
    return rows[0]?.n ?? 0;
  };
  // Expiry is compared by Prisma, not in SQL: `expiresAt` is a timestamp
  // without time zone, and a raw comparison would depend on the session's zone.
  const countLiveCapabilities = async () => {
    const query = Prisma.sql`SELECT "id" FROM "capabilities"
      WHERE "orgId" = ${orgId} AND ${within} AND "revokedAt" IS NULL`;
    const rows = await db.$queryRaw<{ id: string }[]>(...flattenSql(query));
    if (rows.length === 0) return 0;
    return db.capability.count({
      where: { id: { in: rows.map((row) => row.id) }, expiresAt: { gt: new Date() } },
    });
  };

  const [sources, briefs, conventions, memoryChunks, liveCapabilities, graph] = await Promise.all([
    count("sources"),
    count("briefs"),
    count("conventions"),
    count("memory_chunks"),
    countLiveCapabilities(),
    graphitiStore.groupResidue({ groupId: path }),
  ]);

  const counts: Record<ScopeResidueKind, number> = {
    sources,
    briefs,
    conventions,
    memoryChunks,
    liveCapabilities,
    graphFacts: graph.facts,
    graphEpisodes: graph.episodes,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) as ScopeResidue;
}

/** "2 sources and 1 fact" — the residue as a phrase for an error message. */
export function describeScopeResidue(residue: ScopeResidue): string {
  const parts = Object.entries(residue).map(([kind, n]) => {
    const [singular, plural] = RESIDUE_LABELS[kind as ScopeResidueKind];
    return `${n} ${n === 1 ? singular : plural}`;
  });
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Delete the scope row and clear the change-event summaries at or under its
 * path, in one transaction. Grants go with the scope (`onDelete: Cascade`).
 *
 * Events keep their rows, with scope, record id and op, because an agent's feed
 * cursor may name one and a deleted event would turn that cursor into an error.
 * Returns how many summaries were cleared.
 */
export async function deleteScopeClearingFeed(scope: {
  id: string;
  orgId: string;
  path: string;
}): Promise<{ clearedChangeSummaries: number }> {
  const within = scopeContainsSql(Prisma.raw('"scopePath"'), scope.path, { relation: "within", mode: "text" });
  const redact = Prisma.sql`UPDATE "change_events" SET "summary" = ''
    WHERE "orgId" = ${scope.orgId} AND ${within} AND "summary" <> ''`;

  return db.$transaction(async (tx) => {
    const clearedChangeSummaries = await tx.$executeRaw(...flattenSql(redact));
    await tx.scope.delete({ where: { id: scope.id } });
    return { clearedChangeSummaries };
  });
}
