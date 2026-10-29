// How much new memory a caller can see: the number behind the nav's memory badge.
//
// The one rule, the same one services/memory/store-overview.ts enforces for the
// Explore page: a chunk is counted only if its scope is one the caller holds a
// covering read grant on, or a descendant of one. Untagged chunks (scopePath
// null) belong to the org root and count only for a grant that covers the root.
// A count is disclosure — "4 chunks arrived since your last visit" tells a member
// how much content landed in scopes they cannot read — so counting across the
// organisation is a leak, not a convenience.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { flattenSql, withinReadableScopesSql } from "@/services/access";

/**
 * Memory chunks written after `since` that sit inside one of `readablePaths` —
 * the scopes the caller holds a covering read grant on, from readableScopePaths().
 * Returns 0 for a caller with no readable scope. A count that cannot be run
 * rejects: a 0 would tell the caller nothing new arrived, which nobody measured.
 *
 * Containment goes through withinReadableScopesSql, the predicate the billing
 * usage list shares (escaped LIKE, served by the (orgId, scopePath) btree index).
 * Never Prisma `startsWith`: it compiles to an unescaped LIKE, where the `_` in a
 * path like `dept_sales` matches any character, so a reader granted `dept_sales`
 * would also count the sibling scope `deptXsales` — the cross-scope read this
 * whole count exists to avoid.
 */
export async function countNewChunksInScopes(orgId: string, readablePaths: string[], since: Date): Promise<number> {
  if (readablePaths.length === 0) return 0;
  const visible = withinReadableScopesSql(Prisma.raw('"scopePath"'), orgId, readablePaths);
  const query = Prisma.sql`SELECT COUNT(*)::int AS n FROM "memory_chunks"
    WHERE "orgId" = ${orgId} AND "createdAt" > ${since} AND ${visible}`;
  const rows = await db.$queryRaw<{ n: number }[]>(...flattenSql(query));
  return rows[0]?.n ?? 0;
}
