// The scope registry's descendant lookups. Every caller that fans out over
// a scope's registered descendants (GuardedMemoryStore's Graphiti legs, the
// graph route, entity-merge resolution, the MCP scope completion) reads them here,
// so the containment rule lives in one place: ltree `<@`, never a LIKE prefix.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { flattenSql, scopeContainsSql } from "./scope-containment";

/**
 * Registered scope paths strictly below `targetPath` in `orgId`, in path order,
 * at most `limit` of them when given.
 * Containment is ltree `<@`, never Prisma `startsWith`: that compiles to an
 * unescaped LIKE, and the `_` in every minted scope label is a wildcard there,
 * so `org_x.dept_sales.` would also match the sibling `org_x.deptXsales.eu`.
 * `targetPath` must already be a valid ltree path. A lookup failure throws.
 */
export async function strictDescendantScopePaths(orgId: string, targetPath: string, limit?: number): Promise<string[]> {
  const withinTarget = scopeContainsSql(Prisma.raw('"path"'), targetPath, {
    relation: "within",
    mode: "ltree",
  });
  const limitClause = limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`;
  const rows = await db.$queryRaw<{ path: string }[]>(
    ...flattenSql(Prisma.sql`
      SELECT "path" FROM "scopes"
      WHERE "orgId" = ${orgId} AND "path" <> ${targetPath} AND ${withinTarget}
      ORDER BY "path" ASC
      ${limitClause}
    `),
  );
  return rows.map((row) => row.path);
}

/**
 * Up to `limit` registered scope paths at or below `withinPath` in `orgId` whose text starts
 * with `prefix`, in path order: the candidates a completion offers as someone types. The
 * prefix is compared as text (`starts_with`), never as a LIKE pattern, so `_`, `%` and `\`
 * match only themselves. The limit applies before any access filter the caller runs, so a
 * caller that filters reports a full page as possibly incomplete.
 */
export async function scopePathsStartingWith(
  orgId: string,
  withinPath: string,
  prefix: string,
  limit: number,
): Promise<string[]> {
  const within = scopeContainsSql(Prisma.raw('"path"'), withinPath, { relation: "within", mode: "ltree" });
  const rows = await db.$queryRaw<{ path: string }[]>(
    ...flattenSql(Prisma.sql`
      SELECT "path" FROM "scopes"
      WHERE "orgId" = ${orgId} AND ${within} AND starts_with("path", ${prefix})
      ORDER BY "path" ASC
      LIMIT ${limit}
    `),
  );
  return rows.map((row) => row.path);
}
