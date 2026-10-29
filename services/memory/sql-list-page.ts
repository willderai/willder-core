/**
 * One page of a server-paged list read with raw SQL, for the lists whose search
 * Prisma's query builder cannot express (a substring of any element of a text array).
 *
 * The one rule: the org condition bounds the rows, the matching count and the org
 * total alike, so a page can never list, count or be shortened by another org's rows.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { escapeLikePrefix, flattenSql } from "@/services/access/scope-containment";

/** A case-insensitive literal `ILIKE` pattern for `search`: `%` and `_` match themselves. */
export function containsPattern(search: string): string {
  return `%${escapeLikePrefix(search)}%`;
}

/** `column ILIKE pattern`, escaped the way `containsPattern` builds it. */
export function ilike(column: Prisma.Sql, pattern: string): Prisma.Sql {
  return Prisma.sql`${column} ILIKE ${pattern} ESCAPE '\\'`;
}

/** True when any element of the text array `column` contains the pattern. */
export function anyElementIlike(column: Prisma.Sql, pattern: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM unnest(${column}) AS element WHERE element ILIKE ${pattern} ESCAPE '\\')`;
}

export function sqlDirection(order: "asc" | "desc"): Prisma.Sql {
  return order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
}

/**
 * Reads page `page` (1-based) of `pageSize` rows from `from`, kept to `inOrg` and
 * narrowed by every condition in `narrowed`, in `order`. `total` counts the rows
 * matching the narrowing; `count` counts the org's rows before it.
 */
export async function readSqlPage<R>({
  select,
  from,
  inOrg,
  narrowed,
  order,
  page,
  pageSize,
}: {
  select: Prisma.Sql;
  from: Prisma.Sql;
  inOrg: Prisma.Sql;
  narrowed: Prisma.Sql[];
  order: Prisma.Sql;
  page: number;
  pageSize: number;
}): Promise<{ rows: R[]; total: number; count: number }> {
  const where = Prisma.join([inOrg, ...narrowed], " AND ");
  const [rows, counts] = await Promise.all([
    db.$queryRaw<R[]>(
      ...flattenSql(Prisma.sql`SELECT ${select} FROM ${from} WHERE ${where}
        ORDER BY ${order}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
    ),
    db.$queryRaw<{ total: number; count: number }[]>(
      ...flattenSql(Prisma.sql`SELECT COUNT(*) FILTER (WHERE ${where})::int AS "total", COUNT(*)::int AS "count"
        FROM ${from} WHERE ${inOrg}`),
    ),
  ]);
  return { rows, total: counts[0]?.total ?? 0, count: counts[0]?.count ?? 0 };
}
