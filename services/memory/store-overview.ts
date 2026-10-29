// What memory holds in one scope, store by store: the data behind
// GET /api/memory/stores (the Explore page's tabs other than Graph). Sources and
// contacts, text passages (chunks) and files are read here; briefs, rules and
// decisions, and working notes in store-record-lists.ts. Every listed row carries
// its scope's display name (withScopeNames).
//
// The one rule: a row is visible only if its scope is the given scope or a
// descendant of it. Untagged chunks (scopePath null) and org-wide contacts
// count only at the org root, so a caller authorized for a single sub-scope
// learns nothing about the rest of the org, not even a count. The caller must
// already have passed check() for `scope`; this module does not authorize.
//
// A chunk naming a person erased from the org, written at or before the erasure,
// is a copy a restored backup put back, and is not listed
// (services/memory/erasure-suppression.ts). It is still counted, as a stored row,
// until reapplyErasures removes it, so a page can hold fewer than the limit. A
// searched or filtered chunk list is the exception: its count would confirm that an
// erased person's copy is still stored, so it counts only the rows it may list
// (readStorePage).
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { escapeLikePrefix, flattenSql, orgRootPath, scopeContainsSql } from "@/services/access";
import { STORE_LIST_SORTS, STORE_PAGE_SIZE, type StoreList, type StoreListQuery } from "@/lib/memory-store-lists";
import type { StoreChunk, StoreFile, StorePage, StoreRecord, StoresOverview } from "@/types/memory";
import { loadErasedContentFilter } from "./erasure-suppression";
import { loadScopeNames, readBriefPage, readNotePage, readRulePage, withScopeNames } from "./store-record-lists";

/** Rows returned per list. Counts are exact; lists show the most recent rows. */
const STORE_LIST_LIMIT = 50;
const SNIPPET_CHARS = 240;

const query = <T>(sql: Prisma.Sql) => db.$queryRaw<T>(...flattenSql(sql));
const count = async (sql: Prisma.Sql) => (await query<{ n: number }[]>(sql))[0]?.n ?? 0;

/**
 * Which rows of each store are inside `scope`: the WHERE fragments every read in
 * this file starts from, so the overview and the paged lists cannot disagree.
 */
function storeScopePredicates(orgId: string, scope: string) {
  const isOrgRoot = scope === orgRootPath(orgId);
  // Containment goes through scopeContainsSql's text mode (escaped LIKE, served
  // by the (orgId, scopePath) btree indexes). Never Prisma `startsWith`: it
  // compiles to an unescaped LIKE, where the `_` in a path like `dept_sales`
  // matches any character and leaks a sibling such as `deptXsales`.
  const within = (column: string, includeUntagged = false) =>
    scopeContainsSql(Prisma.raw(column), scope, { relation: "within", mode: "text", includeUntagged });
  const recordIn = Prisma.sql`"orgId" = ${orgId} AND ${within('"scopePath"')}`;
  return {
    isOrgRoot,
    recordIn,
    chunkIn: Prisma.sql`"orgId" = ${orgId} AND ${within('"scopePath"', isOrgRoot)}`,
    fileIn: Prisma.sql`s."orgId" = ${orgId} AND ${within('s."scopePath"')}`,
  };
}

/** The first page of a list in its default view: what the overview carries for it. */
const firstPage = (list: StoreList): StoreListQuery => ({
  list,
  search: "",
  sort: STORE_LIST_SORTS[list][0],
  order: "desc",
  filter: null,
  page: 1,
});

/** Read the store overview for `scope` in `orgId`. `scope` must already be authorized. */
export async function readStoreOverview(orgId: string, scope: string): Promise<StoresOverview> {
  const { isOrgRoot, recordIn, chunkIn, fileIn } = storeScopePredicates(orgId, scope);

  const [briefs, rules, notes, sourceCount, contactCount, chunkCount, fileCount, sources, contacts, chunks, files] =
    await Promise.all([
      readBriefPage(orgId, scope, firstPage("briefs")),
      readRulePage(orgId, scope, firstPage("rules")),
      readNotePage(orgId, scope, firstPage("notes")),
      count(Prisma.sql`SELECT COUNT(*)::int AS n FROM "sources" WHERE ${recordIn}`),
      isOrgRoot ? db.contact.count({ where: { orgId } }) : 0,
      count(Prisma.sql`SELECT COUNT(*)::int AS n FROM "memory_chunks" WHERE ${chunkIn}`),
      count(
        Prisma.sql`SELECT COUNT(*)::int AS n FROM "source_files" f JOIN "sources" s ON s."id" = f."sourceId" WHERE ${fileIn}`,
      ),
      query<
        { id: string; type: string; name: string; status: string; scopePath: string; updatedAt: Date }[]
      >(Prisma.sql`
        SELECT "id", "type"::text AS "type", "name", "status"::text AS "status", "scopePath", "updatedAt"
        FROM "sources" WHERE ${recordIn}
        ORDER BY "updatedAt" DESC, "id" ASC LIMIT ${STORE_LIST_LIMIT}`),
      isOrgRoot
        ? db.contact.findMany({
            where: { orgId },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take: STORE_LIST_LIMIT,
            select: { id: true, name: true, type: true, updatedAt: true },
          })
        : [],
      // A chunk that lost a write race stays listed, as the stored row it is, but carries
      // the version that superseded it so it is never shown as the fact's current value
      // (services/memory/superseded-facts.ts).
      query<
        {
          id: string;
          content: string;
          entityName: string | null;
          source: string;
          actorName: string | null;
          scopePath: string | null;
          createdAt: Date;
          supersededById: string | null;
        }[]
      >(Prisma.sql`
        SELECT "id", "content", "entityName", "source", "actorName", "scopePath", "createdAt", w."supersededById"
        FROM "memory_chunks"
        LEFT JOIN LATERAL (
          SELECT e."fromId" AS "supersededById" FROM "fact_edges" e
          WHERE e."orgId" = "memory_chunks"."orgId" AND e."toId" = "memory_chunks"."id" AND e."kind" = 'supersedes'
          ORDER BY e."createdAt" ASC LIMIT 1
        ) w ON true
        WHERE ${chunkIn}
        ORDER BY "createdAt" DESC, "id" DESC LIMIT ${STORE_LIST_LIMIT}`),
      query<
        {
          id: string;
          externalFileId: string;
          chunkCount: number;
          syncedAt: Date;
          sourceName: string;
          sourceType: string;
          scopePath: string;
        }[]
      >(Prisma.sql`
        SELECT f."id", f."externalFileId", cardinality(f."chunkIds")::int AS "chunkCount", f."syncedAt",
               s."name" AS "sourceName", s."type"::text AS "sourceType", s."scopePath"
        FROM "source_files" f JOIN "sources" s ON s."id" = f."sourceId"
        WHERE ${fileIn}
        ORDER BY f."syncedAt" DESC, f."id" DESC LIMIT ${STORE_LIST_LIMIT}`),
    ]);
  const erased = chunks.length > 0 ? await loadErasedContentFilter(orgId) : null;
  const listedChunks = erased ? chunks.filter((c) => !erased(c.content, c.createdAt, c.entityName, c.id)) : chunks;

  const records = [
    ...sources.map((s) => ({
      kind: "source" as const,
      id: s.id,
      title: s.name,
      detail: `${s.type} source, ${s.status}`,
      scopePath: s.scopePath,
      updatedAt: s.updatedAt.toISOString(),
    })),
    ...contacts.map((c) => ({
      kind: "contact" as const,
      id: c.id,
      title: c.name,
      detail: `${c.type} contact`,
      scopePath: null,
      updatedAt: c.updatedAt.toISOString(),
    })),
  ]
    // Newest first, then by kind and id: the order readStorePage pages records in.
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.kind.localeCompare(b.kind) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, STORE_LIST_LIMIT);

  const storedChunks = listedChunks.map(toStoreChunk);
  const storedFiles = files.map(toStoreFile);
  // One scope-name lookup for every list.
  const nameOf = await loadScopeNames(orgId, [
    ...records,
    ...briefs.items,
    ...rules.items,
    ...notes.items,
    ...storedChunks,
    ...storedFiles,
  ]);
  const named = <T extends { scopePath: string | null }>(rows: T[]) =>
    rows.map((r) => ({ ...r, scopeName: nameOf(r.scopePath) }));

  const body: StoresOverview = {
    scope,
    counts: {
      records: sourceCount + contactCount,
      briefs: briefs.total,
      rules: rules.total,
      notes: notes.total,
      chunks: chunkCount,
      files: fileCount,
    },
    lowerBounds: rules.capped ? ["rules"] : [],
    records: named(records),
    briefs: named(briefs.items),
    rules: named(rules.items),
    notes: named(notes.items),
    chunks: named(storedChunks),
    files: named(storedFiles),
  };
  return body;
}

/** A chunk row as the Explore page lists it: its text cut to a snippet. */
type ChunkRow = {
  id: string;
  content: string;
  entityName: string | null;
  source: string;
  actorName: string | null;
  scopePath: string | null;
  createdAt: Date;
  supersededById: string | null;
};

function toStoreChunk(c: ChunkRow): Omit<StoreChunk, "scopeName"> {
  return {
    id: c.id,
    snippet: c.content.length > SNIPPET_CHARS ? `${c.content.slice(0, SNIPPET_CHARS)}…` : c.content,
    source: c.source,
    author: c.actorName,
    scopePath: c.scopePath,
    createdAt: c.createdAt.toISOString(),
    supersededById: c.supersededById,
  };
}

type FileRow = Omit<StoreFile, "syncedAt" | "scopeName"> & { syncedAt: Date };

function toStoreFile(f: FileRow): Omit<StoreFile, "scopeName"> {
  return { ...f, syncedAt: f.syncedAt.toISOString() };
}

/**
 * Most chunk rows a searched or filtered list reads in an org with recorded erasures,
 * to drop the erased copies before it counts. A list matching more than this many
 * stops there, and its page says the count is a lower bound (`capped`).
 */
const ERASURE_AWARE_SCAN_LIMIT = 2000;

/**
 * One page of one store in `scope`, searched, filtered and ordered, with how many
 * rows match in all. `scope` must already be authorized, as for readStoreOverview.
 *
 * The scope rule is the first condition of every query; the search and the filter
 * are added to the same WHERE clause, ahead of the order, the limit and the count,
 * so a row outside the scope can never be listed, counted, or shorten a page. Only
 * what the page shows is searchable: a record's title, a chunk's text, author and
 * source, a file's name and its source's name; never a source's stored token or
 * settings, nor a brief's body. `%` and `_` in the search are literal.
 */
export async function readStorePage(orgId: string, scope: string, q: StoreListQuery): Promise<StorePage> {
  const offset = (q.page - 1) * STORE_PAGE_SIZE;
  const direction = q.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const pattern = `%${escapeLikePrefix(q.search)}%`;
  const contains = (columns: string[]) =>
    q.search === ""
      ? Prisma.sql`TRUE`
      : Prisma.sql`(${Prisma.join(
          columns.map((c) => Prisma.sql`${Prisma.raw(c)} ILIKE ${pattern} ESCAPE '\\'`),
          " OR ",
        )})`;
  const predicates = storeScopePredicates(orgId, scope);
  const page = { scope, page: q.page, pageSize: STORE_PAGE_SIZE };

  if (q.list === "briefs") {
    const read = await readBriefPage(orgId, scope, q);
    return { ...page, list: "briefs", ...read, items: await withScopeNames(orgId, read.items) };
  }
  if (q.list === "rules") {
    const read = await readRulePage(orgId, scope, q);
    return { ...page, list: "rules", ...read, items: await withScopeNames(orgId, read.items) };
  }
  if (q.list === "notes") {
    const read = await readNotePage(orgId, scope, q);
    return { ...page, list: "notes", ...read, items: await withScopeNames(orgId, read.items) };
  }

  if (q.list === "records") {
    const legs: Prisma.Sql[] = [];
    if (q.filter === null || q.filter === "source") {
      legs.push(Prisma.sql`SELECT 'source'::text AS "kind", "id", "name" AS "title", "type"::text AS "type",
        "status"::text AS "status", "scopePath", "updatedAt" FROM "sources" WHERE ${predicates.recordIn} AND ${contains(['"name"'])}`);
    }
    // Contacts are org-wide: only a reader of the org root lists or counts them.
    if (predicates.isOrgRoot && (q.filter === null || q.filter === "contact")) {
      legs.push(Prisma.sql`SELECT 'contact'::text AS "kind", "id", "name" AS "title", "type", NULL::text AS "status",
        NULL::text AS "scopePath", "updatedAt" FROM "contacts" WHERE "orgId" = ${orgId} AND ${contains(['"name"'])}`);
    }
    if (legs.length === 0) return { ...page, list: "records", items: [], total: 0, capped: false };
    const union = Prisma.join(legs, " UNION ALL ");
    const order =
      q.sort === "title"
        ? Prisma.sql`LOWER("title") ${direction}, "updatedAt" DESC, "kind", "id"`
        : Prisma.sql`"updatedAt" ${direction}, "kind", "id"`;
    const [rows, total] = await Promise.all([
      query<
        {
          kind: StoreRecord["kind"];
          id: string;
          title: string;
          type: string;
          status: string | null;
          scopePath: string | null;
          updatedAt: Date;
        }[]
      >(Prisma.sql`SELECT * FROM (${union}) r ORDER BY ${order} LIMIT ${STORE_PAGE_SIZE} OFFSET ${offset}`),
      count(Prisma.sql`SELECT COUNT(*)::int AS n FROM (${union}) r`),
    ]);
    const items = rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      title: r.title,
      detail: r.kind === "source" ? `${r.type} source, ${r.status}` : `${r.type} contact`,
      scopePath: r.scopePath,
      updatedAt: r.updatedAt.toISOString(),
    }));
    return { ...page, list: "records", items: await withScopeNames(orgId, items), total, capped: false };
  }

  if (q.list === "files") {
    const conditions = [predicates.fileIn, contains(['f."externalFileId"', 's."name"'])];
    if (q.filter !== null) conditions.push(Prisma.sql`s."type"::text = ${q.filter}`);
    const where = Prisma.join(conditions, " AND ");
    const order =
      q.sort === "name"
        ? Prisma.sql`LOWER(f."externalFileId") ${direction}`
        : q.sort === "chunks"
          ? Prisma.sql`cardinality(f."chunkIds") ${direction}`
          : Prisma.sql`f."syncedAt" ${direction}`;
    const [rows, total] = await Promise.all([
      query<FileRow[]>(Prisma.sql`
        SELECT f."id", f."externalFileId", cardinality(f."chunkIds")::int AS "chunkCount", f."syncedAt",
               s."name" AS "sourceName", s."type"::text AS "sourceType", s."scopePath"
        FROM "source_files" f JOIN "sources" s ON s."id" = f."sourceId"
        WHERE ${where}
        ORDER BY ${order}, f."id" ${direction}
        LIMIT ${STORE_PAGE_SIZE} OFFSET ${offset}`),
      count(
        Prisma.sql`SELECT COUNT(*)::int AS n FROM "source_files" f JOIN "sources" s ON s."id" = f."sourceId" WHERE ${where}`,
      ),
    ]);
    return { ...page, list: "files", items: await withScopeNames(orgId, rows.map(toStoreFile)), total, capped: false };
  }

  // Chunks. A chunk is superseded when a later version replaced it in a write race.
  const superseded = Prisma.sql`EXISTS (SELECT 1 FROM "fact_edges" e
    WHERE e."orgId" = "memory_chunks"."orgId" AND e."toId" = "memory_chunks"."id" AND e."kind" = 'supersedes')`;
  const conditions = [predicates.chunkIn, contains(['"content"', '"actorName"', '"source"'])];
  if (q.filter === "superseded") conditions.push(superseded);
  if (q.filter === "current") conditions.push(Prisma.sql`NOT ${superseded}`);
  const where = Prisma.join(conditions, " AND ");
  const order = Prisma.sql`ORDER BY "createdAt" ${direction}, "id" ${direction}`;
  const selectRows = (filter: Prisma.Sql, limit: Prisma.Sql) =>
    query<ChunkRow[]>(Prisma.sql`
    SELECT "id", "content", "entityName", "source", "actorName", "scopePath", "createdAt", w."supersededById"
    FROM "memory_chunks"
    LEFT JOIN LATERAL (
      SELECT e."fromId" AS "supersededById" FROM "fact_edges" e
      WHERE e."orgId" = "memory_chunks"."orgId" AND e."toId" = "memory_chunks"."id" AND e."kind" = 'supersedes'
      ORDER BY e."createdAt" ASC LIMIT 1
    ) w ON true
    WHERE ${filter}
    ${order}
    ${limit}`);

  const erasures = await db.erasureSuppression.findFirst({ where: { orgId }, select: { id: true } });
  if ((q.search !== "" || q.filter !== null) && erasures !== null) {
    // A narrowed count must leave out erased copies: a search for a name, or a filter
    // whose count stands beside an emptied list, would otherwise confirm a hidden row.
    // So read the matching rows' text (bounded), drop the erased ones, and page what is left.
    const erased = await loadErasedContentFilter(orgId);
    const scanned = await query<Pick<ChunkRow, "id" | "content" | "entityName" | "createdAt">[]>(Prisma.sql`
      SELECT "id", "content", "entityName", "createdAt" FROM "memory_chunks"
      WHERE ${where} ${order} LIMIT ${ERASURE_AWARE_SCAN_LIMIT + 1}`);
    const kept = scanned
      .slice(0, ERASURE_AWARE_SCAN_LIMIT)
      .filter((c) => !erased(c.content, c.createdAt, c.entityName, c.id))
      .map((c) => c.id);
    const pageIds = kept.slice(offset, offset + STORE_PAGE_SIZE);
    const rows =
      pageIds.length === 0
        ? []
        : await selectRows(Prisma.sql`"memory_chunks"."id" IN (${Prisma.join(pageIds)})`, Prisma.empty);
    const position = new Map(pageIds.map((id, i) => [id, i]));
    rows.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    return {
      ...page,
      list: "chunks",
      items: await withScopeNames(orgId, rows.map(toStoreChunk)),
      total: kept.length,
      capped: scanned.length > ERASURE_AWARE_SCAN_LIMIT,
    };
  }

  const [rows, total] = await Promise.all([
    selectRows(where, Prisma.sql`LIMIT ${STORE_PAGE_SIZE} OFFSET ${offset}`),
    count(Prisma.sql`SELECT COUNT(*)::int AS n FROM "memory_chunks" WHERE ${where}`),
  ]);
  const erased = erasures !== null && rows.length > 0 ? await loadErasedContentFilter(orgId) : null;
  const listed = erased ? rows.filter((c) => !erased(c.content, c.createdAt, c.entityName, c.id)) : rows;
  return {
    ...page,
    list: "chunks",
    items: await withScopeNames(orgId, listed.map(toStoreChunk)),
    total,
    capped: false,
  };
}
