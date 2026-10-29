/**
 * One page of an org's grants or agent tokens, searched, filtered and ordered in
 * the query, for the Access page's Grants and Tokens tabs.
 *
 * The one rule: the org condition comes first and bounds everything, the rows,
 * the matching count and the org total, so a page can never list, count or be
 * shortened by another org's rows. Search is a case-insensitive literal (`%` and
 * `_` match themselves) over the text a row shows: for a grant its scope, grantee
 * name, id, type and permission; for a token its client, id, scope, permission
 * and status.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { ACCESS_PAGE_SIZE, type GrantListQuery, type TokenListQuery } from "@/lib/access-lists";
import { escapeLikePrefix, flattenSql } from "./scope-containment";

/** A grant as the Grants tab shows it. */
export type GrantRow = {
  id: string;
  granteeType: string;
  granteeId: string;
  /** The member's name or email, or the agent's name; absent for roles and everyone. */
  granteeName?: string;
  permission: string;
  expiresAt: string | null;
  createdAt: string;
  scope: { id: string; path: string; name: string };
};

/** An agent token as the Tokens tab shows it. */
export type TokenRow = {
  id: string;
  agentId: string;
  scopePath: string;
  /** The scope's name, or null for a path with no scope row (the org root's token, a deleted scope). */
  scopeName: string | null;
  permission: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  /** True when the token's agent is deactivated, so every call it makes is refused. */
  agentDeactivated: boolean;
};

export type AccessPage<R> = {
  rows: R[];
  /** Rows matching the search and filters. */
  total: number;
  /** Rows in the org before any narrowing. */
  count: number;
  page: number;
  pageSize: number;
};

const WEEK = Prisma.sql`interval '7 days'`;

function likePattern(search: string): string {
  return `%${escapeLikePrefix(search)}%`;
}

function direction(order: "asc" | "desc"): Prisma.Sql {
  return order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
}

/** Ascending puts "never expires" last; descending reverses the whole order, so it leads. */
function expiryOrder(column: Prisma.Sql, order: "asc" | "desc"): Prisma.Sql {
  return order === "asc" ? Prisma.sql`${column} ASC NULLS LAST` : Prisma.sql`${column} DESC NULLS FIRST`;
}

async function runPage<R>(
  select: Prisma.Sql,
  from: Prisma.Sql,
  inOrg: Prisma.Sql,
  narrowed: Prisma.Sql[],
  order: Prisma.Sql,
  page: number,
): Promise<{ rows: R[]; total: number; count: number }> {
  const where = Prisma.join([inOrg, ...narrowed], " AND ");
  const [rows, counts] = await Promise.all([
    db.$queryRaw<R[]>(
      ...flattenSql(Prisma.sql`SELECT ${select} FROM ${from} WHERE ${where}
        ORDER BY ${order}
        LIMIT ${ACCESS_PAGE_SIZE} OFFSET ${(page - 1) * ACCESS_PAGE_SIZE}`),
    ),
    db.$queryRaw<{ total: number; count: number }[]>(
      ...flattenSql(Prisma.sql`SELECT COUNT(*) FILTER (WHERE ${where})::int AS "total", COUNT(*)::int AS "count"
        FROM ${from} WHERE ${inOrg}`),
    ),
  ]);
  return { rows, total: counts[0]?.total ?? 0, count: counts[0]?.count ?? 0 };
}

const GRANT_FROM = Prisma.sql`"grants" g
  JOIN "scopes" s ON s."id" = g."scopeId"
  LEFT JOIN "users" u ON g."granteeType" = 'user' AND u."id" = g."granteeId"
  LEFT JOIN "agents" a ON g."granteeType" = 'agent' AND a."orgId" = g."orgId" AND a."agentKey" = g."granteeId"`;

/** The name a grant's grantee shows under, the same text the search and the Grantee sort read. */
const GRANTEE_NAME = Prisma.sql`CASE g."granteeType"
  WHEN 'user' THEN COALESCE(u."name", u."email", g."granteeId")
  WHEN 'agent' THEN COALESCE(a."name", g."granteeId")
  END`;

type GrantSqlRow = Omit<GrantRow, "expiresAt" | "createdAt" | "scope" | "granteeName"> & {
  granteeName: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  scopeId: string;
  scopePath: string;
  scopeName: string;
};

/** One page of the org's grants. */
export async function readGrantPage(orgId: string, q: GrantListQuery): Promise<AccessPage<GrantRow>> {
  const narrowed: Prisma.Sql[] = [];
  const { permission, grantee, expiry } = q.filters;
  if (permission) narrowed.push(Prisma.sql`g."permission"::text = ${permission}`);
  if (grantee) narrowed.push(Prisma.sql`g."granteeType"::text = ${grantee}`);
  if (expiry === "permanent") narrowed.push(Prisma.sql`g."expiresAt" IS NULL`);
  if (expiry === "expired") narrowed.push(Prisma.sql`g."expiresAt" <= ${sqlUtcNow}`);
  if (expiry === "soon")
    narrowed.push(Prisma.sql`g."expiresAt" > ${sqlUtcNow} AND g."expiresAt" <= ${sqlUtcNow} + ${WEEK}`);
  if (q.search !== "") {
    const p = likePattern(q.search);
    narrowed.push(Prisma.sql`(s."name" ILIKE ${p} ESCAPE '\\' OR s."path" ILIKE ${p} ESCAPE '\\'
      OR ${GRANTEE_NAME} ILIKE ${p} ESCAPE '\\' OR g."granteeId" ILIKE ${p} ESCAPE '\\'
      OR g."granteeType"::text ILIKE ${p} ESCAPE '\\' OR g."permission"::text ILIKE ${p} ESCAPE '\\')`);
  }
  const dir = direction(q.order);
  const tieBreak = Prisma.sql`g."createdAt" DESC, g."id" DESC`;
  const order =
    q.sort === "scope"
      ? Prisma.sql`lower(s."path") ${dir}, ${tieBreak}`
      : q.sort === "grantee"
        ? Prisma.sql`lower(COALESCE(${GRANTEE_NAME}, g."granteeId")) ${dir}, ${tieBreak}`
        : q.sort === "expires"
          ? Prisma.sql`${expiryOrder(Prisma.sql`g."expiresAt"`, q.order)}, ${tieBreak}`
          : Prisma.sql`g."createdAt" ${dir}, g."id" ${dir}`;

  const { rows, total, count } = await runPage<GrantSqlRow>(
    Prisma.sql`g."id", g."granteeType"::text AS "granteeType", g."granteeId", g."permission"::text AS "permission",
      g."expiresAt", g."createdAt", s."id" AS "scopeId", s."path" AS "scopePath", s."name" AS "scopeName",
      ${GRANTEE_NAME} AS "granteeName"`,
    GRANT_FROM,
    Prisma.sql`g."orgId" = ${orgId}`,
    narrowed,
    order,
    q.page,
  );
  return {
    rows: rows.map((r) => ({
      id: r.id,
      granteeType: r.granteeType,
      granteeId: r.granteeId,
      ...(r.granteeName !== null ? { granteeName: r.granteeName } : {}),
      permission: r.permission,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      scope: { id: r.scopeId, path: r.scopePath, name: r.scopeName },
    })),
    total,
    count,
    page: q.page,
    pageSize: ACCESS_PAGE_SIZE,
  };
}

const TOKEN_FROM = Prisma.sql`"capabilities" c
  LEFT JOIN "scopes" s ON s."orgId" = c."orgId" AND s."path" = c."scopePath"`;

/** A token's client names a deactivated agent, by key or, for one minted before keys were canonical, by id. */
const AGENT_DEACTIVATED = Prisma.sql`EXISTS (SELECT 1 FROM "agents" a
  WHERE a."orgId" = c."orgId" AND a."active" = false AND (a."agentKey" = c."agentId" OR a."id" = c."agentId"))`;

/** The status a token shows, in the order the Tokens tab decides it: revoked, expired, then deactivated. */
const TOKEN_STATUS = Prisma.sql`CASE
  WHEN c."revokedAt" IS NOT NULL THEN 'revoked'
  WHEN c."expiresAt" < ${sqlUtcNow} THEN 'expired'
  WHEN ${AGENT_DEACTIVATED} THEN 'deactivated'
  ELSE 'active' END`;

type TokenSqlRow = Omit<TokenRow, "expiresAt" | "revokedAt" | "createdAt"> & {
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

/** One page of the org's agent tokens, revoked and expired ones included. */
export async function readTokenPage(orgId: string, q: TokenListQuery): Promise<AccessPage<TokenRow>> {
  const narrowed: Prisma.Sql[] = [];
  const { status, permission } = q.filters;
  if (status) narrowed.push(Prisma.sql`${TOKEN_STATUS} = ${status}`);
  if (permission) narrowed.push(Prisma.sql`c."permission"::text = ${permission}`);
  if (q.search !== "") {
    const p = likePattern(q.search);
    narrowed.push(Prisma.sql`(c."agentId" ILIKE ${p} ESCAPE '\\' OR c."id" ILIKE ${p} ESCAPE '\\'
      OR c."scopePath" ILIKE ${p} ESCAPE '\\' OR s."name" ILIKE ${p} ESCAPE '\\'
      OR c."permission"::text ILIKE ${p} ESCAPE '\\' OR ${TOKEN_STATUS} ILIKE ${p} ESCAPE '\\')`);
  }
  const dir = direction(q.order);
  const tieBreak = Prisma.sql`c."createdAt" DESC, c."id" DESC`;
  const order =
    q.sort === "agent"
      ? Prisma.sql`lower(c."agentId") ${dir}, ${tieBreak}`
      : q.sort === "expires"
        ? Prisma.sql`c."expiresAt" ${dir}, ${tieBreak}`
        : Prisma.sql`c."createdAt" ${dir}, c."id" ${dir}`;

  const { rows, total, count } = await runPage<TokenSqlRow>(
    Prisma.sql`c."id", c."agentId", c."scopePath", s."name" AS "scopeName", c."permission"::text AS "permission",
      c."expiresAt", c."revokedAt", c."createdAt", ${AGENT_DEACTIVATED} AS "agentDeactivated"`,
    TOKEN_FROM,
    Prisma.sql`c."orgId" = ${orgId}`,
    narrowed,
    order,
    q.page,
  );
  return {
    rows: rows.map((r) => ({
      ...r,
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    count,
    page: q.page,
    pageSize: ACCESS_PAGE_SIZE,
  };
}
