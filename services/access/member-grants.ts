// Which grants reach a person in an org: the one query behind both "may this
// person read here?" (check()) and "who may read here?" (the scope readers
// listing, services/access/source-widening.ts).
//
// The rule: the listing and the decision read the same membership. A grant in
// org X reaches a person only through their live membership of X in
// `org_memberships` (services/access/membership.ts): a grant to them, a grant to
// their role in X, or a grant to everyone. The role is the membership's. Neither
// the role a request context carries nor `users.orgId`/`users.role`, which only
// name the org a person last had open, is read here. The grant and its scope
// must both belong to X: the database does not tie a grant's org to its
// scope's org, so the query checks each against the membership's.
//
// A membership becomes known when Clerk's membership webhook arrives, or when
// the person's own signed-in request records it from their session token
// (lib/tenant.ts), whichever is first. That request records it before it
// reaches check(), so nobody is allowed a read while the listing leaves them
// out. Until then the person is in neither answer.
//
// A demotion or a removal takes effect only when its webhook lands, or, for a
// demotion, when the person makes a request carrying a session token issued
// after it. Until then the listing and the decision agree with each other on
// the old membership, and both are behind Clerk.

import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import type { UserRole } from "@/types";
import type { Permission } from "./check";
import { scopeContainsSql } from "./scope-containment";

/** One grant that reaches one live member. */
export interface MemberGrant {
  userId: string;
  /** The member's role in the org, from their membership. */
  role: UserRole;
  permission: Permission;
  /** The granted scope's path. */
  scopePath: string;
}

/**
 * Every live, unexpired grant in `orgId` that reaches a live member, one row per
 * (member, grant), as {@link MemberGrant}. `userId` narrows it to one person;
 * `covering` keeps only grants whose scope is the target or an ancestor of it.
 */
export function memberGrantsSql(orgId: string, filter: { userId?: string; covering?: string } = {}): Prisma.Sql {
  const onePerson = filter.userId === undefined ? Prisma.empty : Prisma.sql`AND m."userId" = ${filter.userId}`;
  const covers =
    filter.covering === undefined
      ? Prisma.empty
      : Prisma.sql`AND ${scopeContainsSql(Prisma.raw('s."path"'), filter.covering, { relation: "covers", mode: "ltree" })}`;
  return Prisma.sql`
    SELECT m."orgId", m."userId", m."role", g."permission", s."path" AS "scopePath"
    FROM "org_memberships" m
    JOIN "grants" g ON g."orgId" = m."orgId"
    JOIN "scopes" s ON s."id" = g."scopeId" AND s."orgId" = m."orgId"
    WHERE m."orgId" = ${orgId}
      AND m."removedAt" IS NULL
      ${onePerson}
      AND (
        (g."granteeType" = 'user' AND g."granteeId" = m."userId")
        OR (g."granteeType" = 'role' AND g."granteeId" = m."role"::text)
        OR g."granteeType" = 'everyone'
      )
      AND (g."expiresAt" IS NULL OR g."expiresAt" > ${sqlUtcNow})
      ${covers}
  `;
}
