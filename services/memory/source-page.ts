/**
 * Which connected sources one page of the Integrations lists holds
 * (GET /api/sources?page=), searched, filtered and ordered in the query.
 *
 * Sources are connector configuration, not memory, but their search and order read
 * the destination scope path, and raw SQL naming a scope path lives here or in
 * services/access (eslint.scope-gate.mjs). This returns ids only; the route reads the
 * rows through its own column allowlist, so no credential column is ever selected here.
 *
 * The one rule: the org condition bounds the page, the matching count and the list's
 * total alike, so a page never lists, counts or is shortened by another org's sources.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { CONNECTOR_SOURCE_TYPES, SOURCE_PAGE_SIZE, typesNamed, type SourceListQuery } from "@/lib/source-lists";
import { flattenSql } from "@/services/access/scope-containment";
import { containsPattern, ilike, readSqlPage, sqlDirection } from "./sql-list-page";

const SOURCES = Prisma.sql`"sources" s`;

/**
 * The list's own rows, before any search or filter: the org's sources, or only its
 * connectors for the Connectors panel, whose empty state and total count those alone.
 */
function listed(orgId: string, q: SourceListQuery): Prisma.Sql {
  return q.filters.kind === "connector"
    ? Prisma.sql`s."orgId" = ${orgId} AND s."type"::text = ANY(${[...CONNECTOR_SOURCE_TYPES]})`
    : Prisma.sql`s."orgId" = ${orgId}`;
}

/** The search and filters as conditions; none for a list with neither. */
function narrowing(q: SourceListQuery): Prisma.Sql[] {
  const narrowed: Prisma.Sql[] = [];
  if (q.search !== "") {
    const p = containsPattern(q.search);
    narrowed.push(Prisma.sql`(${ilike(Prisma.sql`s."name"`, p)} OR ${ilike(Prisma.sql`s."scopePath"`, p)}
      OR s."type"::text = ANY(${typesNamed(q.search)}))`);
  }
  if (q.filters.type) narrowed.push(Prisma.sql`s."type"::text = ${q.filters.type}`);
  if (q.filters.status) narrowed.push(Prisma.sql`s."status"::text = ${q.filters.status}`);
  return narrowed;
}

/** The order, with the id last so rows that tie keep one place across pages. */
function ordering(q: SourceListQuery): Prisma.Sql {
  const dir = sqlDirection(q.order);
  const key =
    q.sort === "name"
      ? Prisma.sql`lower(s."name")`
      : q.sort === "scope"
        ? Prisma.sql`lower(s."scopePath")`
        : Prisma.sql`s."createdAt"`;
  return Prisma.sql`${key} ${dir}, s."id" ${dir}`;
}

/** The ids on page `q.page`, in order, with the matching count and the list's total. */
export async function pageSourceIds(
  orgId: string,
  q: SourceListQuery,
): Promise<{ ids: string[]; total: number; count: number }> {
  const { rows, total, count } = await readSqlPage<{ id: string }>({
    select: Prisma.sql`s."id"`,
    from: SOURCES,
    inOrg: listed(orgId, q),
    narrowed: narrowing(q),
    order: ordering(q),
    page: q.page,
    pageSize: SOURCE_PAGE_SIZE,
  });
  return { ids: rows.map((row) => row.id), total, count };
}

/**
 * The page that holds source `id` under the search, filters and order of `q`, so a
 * link to one source can open on it. Null when the org has no such source in that view.
 */
export async function pageOfSource(orgId: string, q: SourceListQuery, id: string): Promise<number | null> {
  const where = Prisma.join([listed(orgId, q), ...narrowing(q)], " AND ");
  const rows = await db.$queryRaw<{ position: number }[]>(
    ...flattenSql(Prisma.sql`SELECT ranked."position" FROM (
        SELECT s."id", (row_number() OVER (ORDER BY ${ordering(q)}))::int AS "position"
        FROM ${SOURCES} WHERE ${where}
      ) ranked WHERE ranked."id" = ${id}`),
  );
  const position = rows[0]?.position;
  return position === undefined ? null : Math.ceil(position / SOURCE_PAGE_SIZE);
}
