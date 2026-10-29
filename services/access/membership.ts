// Org membership: which orgs a person belongs to, and their role in each.
//
// The one rule: whether a person is a member of org X, and with what role, is
// read from `org_memberships`, never from `users.orgId`/`users.role`. Those two
// columns only name the org the person last had open; a person in two orgs is a
// member of both whichever one that is.
//
// Clerk owns membership and two writers mirror it here: a signed-in request
// (lib/tenant.ts, from the session token) and the Clerk webhook
// (app/api/webhooks/clerk). Each write carries `assertedAt`, the time Clerk
// asserted that state: the webhook event's timestamp, or the session token's
// issue time. A write older than the assertion already stored is ignored, so a
// webhook delivered late or a request on a session token issued before a removal
// cannot bring back a membership, or a role, that Clerk has since taken away.
// A removal wins a tie.
//
// Timestamps written here use `now() AT TIME ZONE 'UTC'`: the columns hold UTC
// without a zone, as Prisma writes them, whatever the session's time zone is.

import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { UserRole } from "@/types";
import { lockOrgDeletion, OPEN_DELETION_STATUSES } from "./org-deletion-gate";
import { escapeLikePrefix } from "./scope-containment";

/** One person's membership of one org, as stored. */
export interface Membership {
  orgId: string;
  userId: string;
  role: UserRole;
  /** Set when the membership has ended; a removed membership grants nothing. */
  removedAt: Date | null;
}

/**
 * How long the departure of an owner or admin whose `users` row was deleted after their
 * last membership ended is kept (`org_admin_departures`): Svix's whole retry schedule, so an
 * `organization.deleted` that Clerk sent with the departure but that arrived late still
 * finds them (services/memory/org-deletion). The scheduled org-deletion job prunes older
 * ones ({@link pruneAdminDepartures}).
 */
export const ADMIN_DEPARTURE_KEPT_MS = 3 * 86_400_000;

/**
 * The roles whose departure is kept: an org's owners and admins, the same roles as
 * `ORG_ADMIN_ROLES` in lib/org-role.ts, which this module cannot import (that file
 * imports this package).
 */
const ADMIN_ROLES: readonly UserRole[] = ["owner", "admin"];

/** Map a Clerk organization role ("org:admin", "org:member") to ours. Any role
 * other than admin is a plain member: an unknown role never widens access. */
export function clerkRoleToUserRole(orgRole: string | null | undefined): UserRole {
  return orgRole === "org:admin" ? "admin" : "member";
}

/**
 * Record that `userId` is a member of `orgId` with `role`, as Clerk asserted at
 * `assertedAt`. Creates the membership, updates its role, or restores a removed
 * one, unless the stored state was asserted at or after `assertedAt`.
 *
 * Returns the membership as it stands after the write, so the caller can tell
 * whether its assertion was the newest one (a removed membership stays removed
 * when it was not).
 */
export async function recordMembership(input: {
  orgId: string;
  userId: string;
  role: UserRole;
  assertedAt: Date;
}): Promise<Membership> {
  const { orgId, userId, role, assertedAt } = input;
  await db.$executeRaw`
    INSERT INTO "org_memberships" ("orgId", "userId", "role", "assertedAt", "removedAt", "createdAt", "updatedAt")
    VALUES (${orgId}, ${userId}, ${role}::"UserRole", ${assertedAt}, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("orgId", "userId") DO UPDATE
    SET "role" = EXCLUDED."role",
        "assertedAt" = EXCLUDED."assertedAt",
        "removedAt" = NULL,
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE "org_memberships"."assertedAt" < EXCLUDED."assertedAt"`;
  return db.orgMembership.findUniqueOrThrow({
    where: { orgId_userId: { orgId, userId } },
    select: { orgId: true, userId: true, role: true, removedAt: true },
  });
}

/**
 * Record that `userId` left `orgId`, as Clerk asserted at `removedAt`. Every
 * capability token they minted in that org is refused from the next call on
 * (`access_person_holds` reads only live memberships); their other orgs are
 * untouched.
 *
 * Their `users` row is kept while they belong to another org. If it named the
 * org they left as the last one used, it is pointed at their most recently
 * updated remaining membership instead, never one of an org whose deletion has
 * started: that org's rows, the person's included, are about to go. A person left with
 * no membership at all has the row deleted ({@link deleteUsersWithoutMembership}).
 * Unless the org is being deleted: then the row stays until the deletion runs (the org's
 * cascade removes it) or is cancelled ({@link deleteUsersLeftWithoutMembership}).
 * Deleting it would take their memberships with it, which the deletion reads to know who
 * was an admin, and would blank columns of rows the database refuses to change while the
 * org is being deleted. A person whose only remaining memberships are of orgs whose
 * deletion has started also keeps the row where it is; that deletion removes it once
 * their membership is gone (services/memory/org-deletion/run.ts).
 * A removal asserted before the stored state (the person was re-added since)
 * changes nothing.
 *
 * It takes the org's deletion lock ({@link lockOrgDeletion}) and locks the open deletions
 * of the orgs it may move the row to, so a deletion starting, being joined or cancelled,
 * or the job claiming one, either commits before this reads it or waits for this to
 * commit: the decision never rests on a deletion changing underneath it.
 */
export async function recordMembershipRemoved(input: {
  orgId: string;
  userId: string;
  removedAt: Date;
}): Promise<void> {
  const { orgId, userId, removedAt } = input;
  await db.$transaction(async (tx) => {
    // Before the person's row, as a cancel takes it before the rows it deletes: a start, a
    // join or a cancel of this org's deletion commits before this reads it, or waits.
    await lockOrgDeletion(tx, orgId);
    const leavingFrozen = await tx.orgDeletion.findFirst({
      where: { orgId, status: { in: [...OPEN_DELETION_STATUSES] } },
      select: { id: true },
    });
    // Locked next, so two removals of the same person run one after the other: each
    // reads where the row is homed and what memberships remain after the other committed.
    const person = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    // Deleted since the caller found it (a cancel or a removal from their last other org
    // committed first), with every membership it had: there is nothing left to end.
    if (person.length === 0) return;
    // The row is kept as a tombstone, so a later write asserted before this
    // removal can be recognised. Its role stays the one they held when they left;
    // an org deletion reads it to know who was an admin when Clerk deleted the org.
    const written = await tx.$executeRaw`
      INSERT INTO "org_memberships" ("orgId", "userId", "role", "assertedAt", "removedAt", "createdAt", "updatedAt")
      VALUES (${orgId}, ${userId}, 'member'::"UserRole", ${removedAt}, ${removedAt}, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
      ON CONFLICT ("orgId", "userId") DO UPDATE
      SET "assertedAt" = EXCLUDED."assertedAt",
          "removedAt" = EXCLUDED."removedAt",
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "org_memberships"."assertedAt" <= EXCLUDED."assertedAt"`;
    // Older than what is stored (the person was re-added since): nothing changed.
    if (written === 0) return;

    const user = await tx.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user || user.orgId !== orgId) return;
    const live = await tx.orgMembership.findMany({
      where: { userId, removedAt: null },
      orderBy: [{ updatedAt: "desc" }, { orgId: "asc" }],
      select: { orgId: true, role: true },
    });
    const deletions = await lockOpenDeletions(
      tx,
      live.map((m) => m.orgId),
    );
    const remaining = live.find((m) => deletions.get(m.orgId) !== "deleting");
    if (remaining) {
      await tx.user.update({ where: { id: userId }, data: { orgId: remaining.orgId, role: remaining.role } });
    } else if (!leavingFrozen) {
      // Keeps the row of a person still in an org whose deletion has started.
      await deleteUsersWithoutMembership(tx, { id: userId });
    }
  });
}

/**
 * The open deletions of `orgIds`, by org, each locked FOR SHARE to the end of the
 * transaction, in id order. The job's claim, which updates the row, then either committed
 * before this read it (and this sees `deleting`) or waits for this transaction to end.
 */
async function lockOpenDeletions(
  tx: Prisma.TransactionClient,
  orgIds: string[],
): Promise<Map<string, (typeof OPEN_DELETION_STATUSES)[number]>> {
  if (orgIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ orgId: string; status: (typeof OPEN_DELETION_STATUSES)[number] }[]>`
    SELECT "orgId", "status"::text AS "status" FROM "org_deletions"
    WHERE "orgId" = ANY(${orgIds}) AND "status"::text = ANY(${[...OPEN_DELETION_STATUSES]})
    ORDER BY "id"
    FOR SHARE`;
  return new Map(rows.map((r) => [r.orgId, r.status]));
}

/**
 * Delete the `users` rows matching `where` that hold no live membership: the one way a
 * `users` row is deleted, other than an org's own cascade at the end of its deletion.
 * A row homed in an org with an open deletion, which it was a member of, is not deleted:
 * it is kept for that deletion, whose cascade or cancel deletes it
 * ({@link recordMembershipRemoved}).
 * The row's ended memberships go with it, in every org. For each of those that ended as
 * an owner or admin within {@link ADMIN_DEPARTURE_KEPT_MS} of `now`, the person's Clerk
 * id and the time it ended are kept (`org_admin_departures`), so an
 * `organization.deleted` that Clerk sent with that removal still names them a recipient
 * of that org's final export. Returns how many rows were deleted.
 *
 * The rows and their memberships are locked first (in that order, as a removal locks
 * them, and each set in id order, so two callers locking overlapping sets wait for each
 * other instead of deadlocking), so a membership being created or made live again for
 * one of them commits before the check that it has none, and keeps the row. Then one statement deletes the
 * rows and keeps the departures, so neither can happen without the other: it reads the
 * memberships as they were before its own cascade. An existing departure keeps the
 * later of its time and the new one.
 */
export async function deleteUsersWithoutMembership(
  tx: Prisma.TransactionClient,
  where: Prisma.UserWhereInput,
  now: Date = new Date(),
): Promise<number> {
  const candidates = await tx.user.findMany({ where, select: { id: true } });
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.id);
  await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 FROM "org_memberships" WHERE "userId" = ANY(${ids}) ORDER BY "userId", "orgId" FOR UPDATE`;
  const keptSince = new Date(now.getTime() - ADMIN_DEPARTURE_KEPT_MS);
  const [{ deleted }] = await tx.$queryRaw<{ deleted: number }[]>`
    WITH gone AS (
      DELETE FROM "users" u
      WHERE u."id" = ANY(${ids})
        AND NOT EXISTS (SELECT 1 FROM "org_memberships" live WHERE live."userId" = u."id" AND live."removedAt" IS NULL)
        AND NOT (
          EXISTS (SELECT 1 FROM "org_deletions" d WHERE d."orgId" = u."orgId" AND d."status"::text = ANY(${[...OPEN_DELETION_STATUSES]}))
          AND EXISTS (SELECT 1 FROM "org_memberships" home WHERE home."userId" = u."id" AND home."orgId" = u."orgId")
        )
      RETURNING u."id", u."clerkId"
    ), kept AS (
      INSERT INTO "org_admin_departures" ("orgId", "clerkUserId", "removedAt")
      SELECT m."orgId", gone."clerkId", m."removedAt"
      FROM gone JOIN "org_memberships" m ON m."userId" = gone."id"
      WHERE m."role"::text = ANY(${[...ADMIN_ROLES]}) AND m."removedAt" >= ${keptSince}
      ON CONFLICT ("orgId", "clerkUserId") DO UPDATE
        SET "removedAt" = GREATEST("org_admin_departures"."removedAt", EXCLUDED."removedAt")
    )
    SELECT count(*)::int AS deleted FROM gone`;
  return deleted;
}

/**
 * Delete the `users` rows that {@link recordMembershipRemoved} kept because `orgId`
 * was being deleted: people whose row names `orgId`, whose membership of it has ended,
 * and who belong to no org now, whenever Clerk said they left. Called when the deletion
 * is cancelled, in its transaction, once the database accepts writes to the org again.
 */
export async function deleteUsersLeftWithoutMembership(
  tx: Prisma.TransactionClient,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  return deleteUsersWithoutMembership(tx, { orgId, memberships: { some: { orgId, removedAt: { not: null } } } }, now);
}

/** Delete the admin departures older than {@link ADMIN_DEPARTURE_KEPT_MS}. Returns how many. */
export async function pruneAdminDepartures(now: Date = new Date()): Promise<number> {
  const { count } = await db.orgAdminDeparture.deleteMany({
    where: { removedAt: { lt: new Date(now.getTime() - ADMIN_DEPARTURE_KEPT_MS) } },
  });
  return count;
}

/** The live membership of `userId` in `orgId`, or null if they are not a member. */
export async function liveMembership(orgId: string, userId: string): Promise<Membership | null> {
  return db.orgMembership.findFirst({
    where: { orgId, userId, removedAt: null },
    select: { orgId: true, userId: true, role: true, removedAt: true },
  });
}

/** The orders the members list offers. */
export const MEMBER_SORTS = ["name", "role", "joined"] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

/** The roles a member can hold, the members list's filter values. */
export const MEMBER_ROLES = ["owner", "admin", "member"] as const satisfies readonly UserRole[];

export interface MemberListQuery {
  /** Case-insensitive literal text in the member's name or email; empty for none. */
  search: string;
  role: UserRole | null;
  sort: MemberSort;
  order: "asc" | "desc";
  /** One page of `pageSize` rows, or every match when null. */
  page: { number: number; size: number } | null;
}

/** One live member of an org, as the members list shows them. */
export interface ListedMember {
  id: string;
  /** The identity provider's user id, to match a Clerk membership to this row. */
  clerkId: string;
  name: string | null;
  email: string;
  /** Their role in this org, from the membership. */
  role: UserRole;
  /** When they joined this org. */
  joinedAt: Date;
}

/**
 * The live members of `orgId` matching `q`, in the order it asks for, with how many
 * match in all. Only live memberships of this org are listed or counted: a removed
 * member, or a person whose `users.orgId` names this org but who holds no live
 * membership here, is never in either. The search reads only the name and email
 * the list shows; `%` and `_` in it are literal.
 */
export async function listMembers(
  orgId: string,
  q: MemberListQuery,
): Promise<{ members: ListedMember[]; total: number }> {
  // Prisma's insensitive `contains` is an unescaped ILIKE; backslash is Postgres'
  // default LIKE escape, so escaping the text keeps it a literal substring match.
  const contains = { contains: escapeLikePrefix(q.search), mode: "insensitive" as const };
  const where = {
    orgId,
    removedAt: null,
    ...(q.role ? { role: q.role } : {}),
    ...(q.search ? { user: { OR: [{ name: contains }, { email: contains }] } } : {}),
  };
  const byName = { user: { name: { sort: q.order, nulls: "last" as const } } };
  const orderBy =
    q.sort === "joined"
      ? [{ createdAt: q.order }, { userId: "asc" as const }]
      : q.sort === "role"
        ? [
            { role: q.order },
            { user: { name: { sort: "asc" as const, nulls: "last" as const } } },
            { userId: "asc" as const },
          ]
        : [byName, { user: { email: q.order } }, { userId: "asc" as const }];
  const [rows, total] = await Promise.all([
    db.orgMembership.findMany({
      where,
      orderBy,
      ...(q.page ? { skip: (q.page.number - 1) * q.page.size, take: q.page.size } : {}),
      select: { role: true, createdAt: true, user: { select: { id: true, clerkId: true, name: true, email: true } } },
    }),
    db.orgMembership.count({ where }),
  ]);
  return { members: rows.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })), total };
}
