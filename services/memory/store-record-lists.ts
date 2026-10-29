// The Explore page's Briefs, Rules and decisions, and Working notes lists: one page of
// each in one scope, searched, filtered and ordered, plus the helper that gives every
// listed row its scope's display name. services/memory/store-overview.ts calls these for
// both the overview (the default view's first page) and GET /api/memory/stores?list=.
//
// The one rule, as in store-overview.ts: a row is listed or counted only if its scope is
// the given scope or a descendant of it, and that condition is the first one in every
// WHERE clause, ahead of the search, the filter, the order and the count. The caller
// must already have passed check() for `scope`; this module does not authorize.
//
// A row written at or before an erasure that names the erased person is never listed in
// any of the three lists: a rule a restored backup put back, a working note or a brief is
// dropped before it is counted (as the task-start block and reapplyErasures judge it), so
// a search for an erased name cannot confirm the copy.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { escapeLikePrefix, flattenSql, scopeContainsSql } from "@/services/access";
import { STORE_PAGE_SIZE, type StoreListQuery } from "@/lib/memory-store-lists";
import type { StoreBrief, StoreNote, StoreRule } from "@/types/memory";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";

/** A page of one list: its rows and how many rows match in all. */
export type ListedPage<T> = { items: T[]; total: number; capped: boolean };

/** Most rows a list reads in an org with recorded erasures, to drop erased copies before it counts. */
const ERASURE_AWARE_SCAN_LIMIT = 2000;

const query = <T>(sql: Prisma.Sql) => db.$queryRaw<T>(...flattenSql(sql));
const count = async (sql: Prisma.Sql) => (await query<{ n: number }[]>(sql))[0]?.n ?? 0;

/** `column` is inside `scope`, by escaped LIKE (never Prisma `startsWith`; see store-overview.ts). */
const within = (column: string, scope: string) =>
  scopeContainsSql(Prisma.raw(column), scope, { relation: "within", mode: "text" });

/** `%`/`_` in the search are literal; an empty search matches every row. */
function searchSql(search: string, columns: string[]): Prisma.Sql {
  if (search === "") return Prisma.sql`TRUE`;
  const pattern = `%${escapeLikePrefix(search)}%`;
  return Prisma.sql`(${Prisma.join(
    columns.map((c) => Prisma.sql`${Prisma.raw(c)} ILIKE ${pattern} ESCAPE '\\'`),
    " OR ",
  )})`;
}

const directionSql = (q: StoreListQuery) => (q.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`);
const offsetOf = (q: StoreListQuery) => (q.page - 1) * STORE_PAGE_SIZE;

/**
 * One page of a list whose rows may name an erased person. In an org with no recorded
 * erasure the page and the count come straight from SQL. Otherwise the matching rows are
 * read in order (bounded), every row `isErased` judges a pre-erasure copy is dropped, and
 * what is left is paged, so the count never includes a row the list may not show; past
 * the bound the count is a lower bound and `capped` says so.
 */
async function pageWithoutErased<R>(
  orgId: string,
  q: StoreListQuery,
  select: (limit: Prisma.Sql) => Promise<R[]>,
  countSql: Prisma.Sql,
  isErased: (row: R, erased: ErasedContentFilter) => boolean,
): Promise<ListedPage<R>> {
  const erasures = await db.erasureSuppression.findFirst({ where: { orgId }, select: { id: true } });
  if (erasures === null) {
    const [items, total] = await Promise.all([
      select(Prisma.sql`LIMIT ${STORE_PAGE_SIZE} OFFSET ${offsetOf(q)}`),
      count(countSql),
    ]);
    return { items, total, capped: false };
  }
  const erased = await loadErasedContentFilter(orgId);
  const scanned = await select(Prisma.sql`LIMIT ${ERASURE_AWARE_SCAN_LIMIT + 1}`);
  const kept = scanned.slice(0, ERASURE_AWARE_SCAN_LIMIT).filter((row) => !isErased(row, erased));
  return {
    items: kept.slice(offsetOf(q), offsetOf(q) + STORE_PAGE_SIZE),
    total: kept.length,
    capped: scanned.length > ERASURE_AWARE_SCAN_LIMIT,
  };
}

/**
 * Briefs in `scope`. A retired brief reads as absent everywhere (brief-retirement.ts), so
 * it is left out; one whose title names a person erased since it was written is dropped.
 */
export async function readBriefPage(
  orgId: string,
  scope: string,
  q: StoreListQuery,
): Promise<ListedPage<Omit<StoreBrief, "scopeName">>> {
  const conditions = [
    Prisma.sql`b."orgId" = ${orgId} AND ${within('b."scopePath"', scope)}`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM "brief_retirements" r WHERE r."briefId" = b."id")`,
    searchSql(q.search, ['b."title"']),
  ];
  if (q.filter !== null) conditions.push(Prisma.sql`b."type"::text = ${q.filter}`);
  const where = Prisma.join(conditions, " AND ");
  const direction = directionSql(q);
  const order =
    q.sort === "title"
      ? Prisma.sql`LOWER(b."title") ${direction}, b."createdAt" DESC`
      : Prisma.sql`b."createdAt" ${direction}`;
  const page = await pageWithoutErased(
    orgId,
    q,
    (limit) =>
      query<{ id: string; type: StoreBrief["type"]; title: string; scopePath: string; createdAt: Date }[]>(Prisma.sql`
      SELECT b."id", b."type"::text AS "type", b."title", b."scopePath", b."createdAt"
      FROM "briefs" b WHERE ${where}
      ORDER BY ${order}, b."id" ${direction}
      ${limit}`),
    Prisma.sql`SELECT COUNT(*)::int AS n FROM "briefs" b WHERE ${where}`,
    (b, erased) => erased(b.title, b.createdAt),
  );
  return { ...page, items: page.items.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })) };
}

type RuleRow = {
  id: string;
  kind: StoreRule["kind"];
  subject: string;
  text: string;
  scopePath: string;
  createdAt: Date;
  retiredAt: Date | null;
  supersededById: string | null;
  replaced: boolean;
};

/**
 * Rules and decisions in `scope`, every stored version, each with whether it is still
 * in force. A rule replaced by a version in another scope reads as replaced, without
 * naming that version or its scope: the task-start block stops serving a rule once any
 * row replaces it (task-start.ts), so "in force" would misstate what agents are given. A restored pre-erasure copy is
 * dropped (pageWithoutErased).
 */
export async function readRulePage(
  orgId: string,
  scope: string,
  q: StoreListQuery,
): Promise<ListedPage<Omit<StoreRule, "scopeName">>> {
  const conditions = [
    Prisma.sql`c."orgId" = ${orgId} AND ${within('c."scopePath"', scope)}`,
    searchSql(q.search, ['c."subject"', 'c."text"']),
  ];
  if (q.filter !== null) conditions.push(Prisma.sql`c."kind"::text = ${q.filter}`);
  const where = Prisma.join(conditions, " AND ");
  const direction = directionSql(q);
  const order =
    q.sort === "subject"
      ? Prisma.sql`ORDER BY LOWER(c."subject") ${direction}, c."createdAt" DESC, c."id" ${direction}`
      : Prisma.sql`ORDER BY c."createdAt" ${direction}, c."id" ${direction}`;
  const page = await pageWithoutErased(
    orgId,
    q,
    (limit) =>
      query<RuleRow[]>(Prisma.sql`
      SELECT c."id", c."kind"::text AS "kind", c."subject", c."text", c."scopePath", c."createdAt", c."retiredAt", c."supersededById",
             EXISTS (SELECT 1 FROM "conventions" n WHERE n."orgId" = c."orgId" AND n."supersedesId" = c."id") AS "replaced"
      FROM "conventions" c WHERE ${where} ${order} ${limit}`),
    Prisma.sql`SELECT COUNT(*)::int AS n FROM "conventions" c WHERE ${where}`,
    (r, erased) => erased(`${r.subject}\n${r.text}`, r.createdAt, r.subject) || erased.byRuleId(r.id, r.createdAt),
  );
  return { ...page, items: page.items.map(toStoreRule) };
}

function toStoreRule(r: RuleRow): Omit<StoreRule, "scopeName"> {
  return {
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    text: r.text,
    status: r.retiredAt !== null ? "retired" : r.replaced || r.supersededById !== null ? "replaced" : "in_force",
    scopePath: r.scopePath,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Working notes in `scope`, live, expired and released alike, with the posting agent's
 * name. A note whose task or body names a person erased since it was written is dropped.
 */
export async function readNotePage(
  orgId: string,
  scope: string,
  q: StoreListQuery,
): Promise<ListedPage<Omit<StoreNote, "scopeName">>> {
  const conditions = [
    Prisma.sql`w."orgId" = ${orgId} AND ${within('w."scopePath"', scope)}`,
    searchSql(q.search, ['w."task"', 'w."body"']),
  ];
  if (q.filter !== null) conditions.push(Prisma.sql`w."kind"::text = ${q.filter}`);
  const where = Prisma.join(conditions, " AND ");
  const direction = directionSql(q);
  const page = await pageWithoutErased(
    orgId,
    q,
    (limit) =>
      query<
        {
          id: string;
          kind: StoreNote["kind"];
          task: string;
          body: string;
          agentName: string | null;
          scopePath: string;
          createdAt: Date;
          expiresAt: Date;
          releasedAt: Date | null;
        }[]
      >(Prisma.sql`
      SELECT w."id", w."kind"::text AS "kind", w."task", w."body", a."name" AS "agentName", w."scopePath",
             w."createdAt", w."expiresAt", w."releasedAt"
      FROM "working_notes" w LEFT JOIN "agents" a ON a."id" = w."agentId" AND a."orgId" = w."orgId"
      WHERE ${where}
      ORDER BY w."createdAt" ${direction}, w."id" ${direction}
      ${limit}`),
    Prisma.sql`SELECT COUNT(*)::int AS n FROM "working_notes" w WHERE ${where}`,
    (n, erased) => erased(`${n.task}\n${n.body}`, n.createdAt),
  );
  const now = Date.now();
  const items = page.items.map(({ releasedAt, ...n }) => ({
    ...n,
    status:
      releasedAt !== null
        ? ("released" as const)
        : n.expiresAt.getTime() <= now
          ? ("expired" as const)
          : ("live" as const),
    createdAt: n.createdAt.toISOString(),
    expiresAt: n.expiresAt.toISOString(),
  }));
  return { ...page, items };
}

/**
 * Looks up the display name of each row's scope, so a list shows "Sales" instead of a
 * raw ltree path. Only the paths of rows already in the reader's scope are looked up;
 * a path no scope row names gets null, and the list shows a label derived from the path.
 */
export async function loadScopeNames(
  orgId: string,
  rows: readonly { scopePath: string | null }[],
): Promise<(scopePath: string | null) => string | null> {
  const paths = [...new Set(rows.flatMap((r) => (r.scopePath === null ? [] : [r.scopePath])))];
  const scopes =
    paths.length === 0
      ? []
      : await db.scope.findMany({ where: { orgId, path: { in: paths } }, select: { path: true, name: true } });
  const names = new Map(scopes.map((s) => [s.path, s.name]));
  return (scopePath) => (scopePath === null ? null : (names.get(scopePath) ?? null));
}

/** `rows`, each with its scope's display name (loadScopeNames). */
export async function withScopeNames<T extends { scopePath: string | null }>(
  orgId: string,
  rows: T[],
): Promise<(T & { scopeName: string | null })[]> {
  const nameOf = await loadScopeNames(orgId, rows);
  return rows.map((r) => ({ ...r, scopeName: nameOf(r.scopePath) }));
}
