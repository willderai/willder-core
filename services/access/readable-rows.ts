// "This row's scope is one the caller may read", for browsing views that list or
// count rows carrying a scope path: the SQL predicate, and the queries built on it
// that live outside the memory store (the scope picker and the billing page's
// figures and usage list).
//
// The one rule: a row is visible when its scope is a scope the caller holds a
// covering read grant on, or a descendant of one, and a row with no scope belongs
// to the org root, so it is visible only through a grant that covers the root. The
// granted paths come from readableScopePaths(), the same membership and grant query
// check() decides a single read with, so a listing cannot show a row a direct read
// of it would refuse.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import type { TimeRange } from "@/lib/date-range";
import { sqlUtcAt } from "@/lib/sql-utc-now";
import { pathCovers } from "./check";
import { orgRootPath } from "./org-root";
import { escapeLikePrefix, flattenSql, scopeContainsSql } from "./scope-containment";

/**
 * A predicate over `column` (a text scope path, nullable) that holds for rows inside
 * one of `readablePaths`, the caller's granted scopes from readableScopePaths().
 * Untagged rows (`column IS NULL`) are included only for a grant covering the org
 * root. With no readable path it is `FALSE`, so a caller with no grant sees nothing.
 *
 * `column` must be a fixed identifier from this codebase, never caller input. It is
 * matched in text mode (escaped LIKE), which the usual `(orgId, scopePath)` btree
 * index serves; see scope-containment.ts for why the `_` in a path is escaped.
 */
export function withinReadableScopesSql(column: Prisma.Sql, orgId: string, readablePaths: string[]): Prisma.Sql {
  if (readablePaths.length === 0) return Prisma.sql`FALSE`;
  const root = orgRootPath(orgId);
  const legs = [...new Set(readablePaths)].map((granted) =>
    scopeContainsSql(column, granted, { relation: "within", mode: "text", includeUntagged: pathCovers(granted, root) }),
  );
  return Prisma.sql`(${legs.reduce((all, leg) => Prisma.sql`${all} OR ${leg}`)})`;
}

/**
 * Whether one of `readablePaths` covers the org root, so the caller may read every
 * scope in the org and the rows that carry none. Org-wide figures, such as the credit
 * balance every scope draws down, are shown only to such a caller.
 */
export function readsWholeOrg(orgId: string, readablePaths: string[]): boolean {
  const root = orgRootPath(orgId);
  return readablePaths.some((granted) => pathCovers(granted, root));
}

/** A scope as the scope picker lists it. */
interface ScopeSummary {
  id: string;
  path: string;
  name: string;
}

/**
 * The org's scopes inside one of `grantedPaths` (the caller's granted scopes, from
 * readableScopePaths()), first by path, at most `limit`. This narrows candidates
 * only; the caller still decides each one with can(). Matched in ltree mode, which
 * the GiST index on `scopes.path` serves.
 */
export async function scopesWithinGrants(
  orgId: string,
  grantedPaths: string[],
  limit: number,
): Promise<ScopeSummary[]> {
  if (grantedPaths.length === 0) return [];
  const within = [...new Set(grantedPaths)]
    .map((path) => scopeContainsSql(Prisma.raw('"path"'), path, { relation: "within", mode: "ltree" }))
    .reduce((all, leg) => Prisma.sql`${all} OR ${leg}`);
  return db.$queryRaw<ScopeSummary[]>(
    ...flattenSql(Prisma.sql`SELECT "id", "path", "name" FROM "scopes"
      WHERE "orgId" = ${orgId} AND (${within})
      ORDER BY "path" ASC
      LIMIT ${limit}`),
  );
}

/** One accepted artifact on the billing page: what it cost and which scope it was made in. */
export interface UsageRow {
  id: string;
  artifactType: string;
  credits: number;
  overage: boolean;
  scopePath: string | null;
  createdAt: string;
}

/**
 * The org's newest `limit` usage rows whose scope is one of `readablePaths` or inside
 * one (untagged rows only through a root grant). The filter runs before the limit, so
 * readable rows behind newer hidden ones are still found.
 */
export async function readableUsageRows(orgId: string, readablePaths: string[], limit: number): Promise<UsageRow[]> {
  if (readablePaths.length === 0) return [];
  const visible = withinReadableScopesSql(Prisma.raw('"scopePath"'), orgId, readablePaths);
  const rows = await db.$queryRaw<Array<Omit<UsageRow, "createdAt"> & { createdAt: Date }>>(
    ...flattenSql(Prisma.sql`SELECT "id", "artifactType", "credits", "overage", "scopePath", "createdAt"
      FROM "artifact_usage"
      WHERE "orgId" = ${orgId} AND ${visible}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${limit}`),
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * The credits the org's usage rows drew from `since` on, counting only rows whose
 * scope is one of `readablePaths` or inside one (untagged rows only through a root
 * grant). Spend in a scope the caller cannot read never reaches the total. A caller
 * with no readable scope gets 0 without a query.
 */
export async function readableUsageCredits(orgId: string, readablePaths: string[], since: Date): Promise<number> {
  if (readablePaths.length === 0) return 0;
  const visible = withinReadableScopesSql(Prisma.raw('"scopePath"'), orgId, readablePaths);
  const rows = await db.$queryRaw<{ credits: bigint }[]>(
    ...flattenSql(Prisma.sql`SELECT COALESCE(SUM("credits"), 0)::bigint AS "credits"
      FROM "artifact_usage"
      WHERE "orgId" = ${orgId} AND "createdAt" >= ${since} AND ${visible}`),
  );
  return Number(rows[0]?.credits ?? 0);
}

/** The orders the usage list offers. */
export const USAGE_SORTS = ["date", "credits"] as const;

export interface UsageListQuery {
  /** Case-insensitive literal text in the row's scope path or artifact type; empty for none. */
  search: string;
  /** One artifact type, or null for every type. */
  artifactType: string | null;
  sort: (typeof USAGE_SORTS)[number];
  order: "asc" | "desc";
  /**
   * Rows recorded from `from` (inclusive) to `to` (exclusive); either end may be open. It
   * narrows the page and `total`, never `readable`, which counts every row the caller may read.
   */
  range?: TimeRange;
  page: number;
  pageSize: number;
}

/**
 * One page of the org's usage rows the caller may read, searched, filtered and
 * ordered and narrowed to a date range, with how many match (`total`) and how many
 * the caller may read in all (`readable`). The scope rule is part of the WHERE clause ahead of the search, the
 * filter, the order, the limit and both counts, so a row from a scope the caller
 * cannot read is never listed, counted, or able to shorten a page. The search reads
 * only the scope path and the artifact type a row shows; `%` and `_` are literal.
 */
export async function readableUsagePage(
  orgId: string,
  readablePaths: string[],
  q: UsageListQuery,
): Promise<{ rows: UsageRow[]; total: number; readable: number }> {
  if (readablePaths.length === 0) return { rows: [], total: 0, readable: 0 };
  const readable = Prisma.sql`"orgId" = ${orgId} AND ${withinReadableScopesSql(Prisma.raw('"scopePath"'), orgId, readablePaths)}`;
  const conditions = [readable];
  if (q.artifactType !== null) conditions.push(Prisma.sql`"artifactType" = ${q.artifactType}`);
  if (q.search !== "") {
    const pattern = `%${escapeLikePrefix(q.search)}%`;
    conditions.push(
      Prisma.sql`("scopePath" ILIKE ${pattern} ESCAPE '\\' OR "artifactType" ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  // `createdAt` holds UTC wall-clock time with no zone; see lib/sql-utc-now.ts.
  if (q.range?.from) conditions.push(Prisma.sql`"createdAt" >= ${sqlUtcAt(q.range.from)}`);
  if (q.range?.to) conditions.push(Prisma.sql`"createdAt" < ${sqlUtcAt(q.range.to)}`);
  const where = Prisma.join(conditions, " AND ");
  const direction = q.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const order =
    q.sort === "credits"
      ? Prisma.sql`"credits" ${direction}, "createdAt" DESC, "id" DESC`
      : Prisma.sql`"createdAt" ${direction}, "id" ${direction}`;
  const [rows, counts] = await Promise.all([
    db.$queryRaw<Array<Omit<UsageRow, "createdAt"> & { createdAt: Date }>>(
      ...flattenSql(Prisma.sql`SELECT "id", "artifactType", "credits", "overage", "scopePath", "createdAt"
        FROM "artifact_usage" WHERE ${where}
        ORDER BY ${order}
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`),
    ),
    db.$queryRaw<{ total: number; readable: number }[]>(
      ...flattenSql(Prisma.sql`SELECT COUNT(*) FILTER (WHERE ${where})::int AS "total", COUNT(*)::int AS "readable"
        FROM "artifact_usage" WHERE ${readable}`),
    ),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    total: counts[0]?.total ?? 0,
    readable: counts[0]?.readable ?? 0,
  };
}
