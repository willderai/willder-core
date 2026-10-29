// Starting, cancelling and showing an org deletion.
//
// The one rule: an org is deleted 7 days after the request, whoever made it. An owner
// asking in the app and Clerk reporting `organization.deleted` start the same deletion.
// At the request the org's agent tokens are revoked, check() starts refusing writes and
// agents (services/access/org-deletion-gate.ts), the database refuses writes to the
// org's content tables (migration 20261016200000_org_deletions), and a final export is
// queued for the owner. Until the 7 days are up an owner can cancel, which restores the
// revoked tokens and lifts both refusals, unless Clerk has deleted the org: then there is
// no org to restore. ./run.ts clears the stores afterwards.
//
// Who receives the export and the receipt is recorded on the deletion when each trigger
// happens, by Clerk user id, and never widened afterwards: the person who asked, and once
// Clerk deletes the org, its owners and admins of that moment instead. Every change to
// that list, and every start, join and cancel, takes one lock per org (lockOrgDeletion),
// so a membership event and Clerk's deletion arriving together in either order give the
// same list, and a member's removal sees the deletion as it is once each has committed.
import { db } from "@/lib/db";
import { Prisma, type OrgDeletion } from "@/lib/generated/prisma/client";
import { deleteUsersLeftWithoutMembership, lockOrgDeletion, OPEN_DELETION_STATUSES } from "@/services/access";
import { ORG_ADMIN_ROLES } from "@/lib/org-role";

/** Days between the request and the deletion. */
export const DELETION_DELAY_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * How far before Clerk's `organization.deleted` an admin's membership may have ended and
 * still count them as an admin of the org when it was deleted. Clerk may end the
 * memberships of a deleted org too, with timestamps of their own, and its events can
 * arrive in either order. A membership that ended earlier than this ended before the
 * deletion: that person is never a recipient.
 */
export const CLERK_MEMBERSHIP_SKEW_MS = 60_000;

/** A request this service refuses, with the HTTP status a route answers it with. */
export class OrgDeletionRefusedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "OrgDeletionRefusedError";
  }
}

/** An owner's request from the app: the person asking, already authorized by the route. */
interface OwnerRequest {
  trigger: "owner";
  orgId: string;
  /** users.id of the person asking. */
  requestedBy: string;
  /** Their Clerk user id: they receive the export and the receipt. */
  requesterClerkId: string;
}

/** Clerk's `organization.deleted`, verified by the webhook route. */
interface ClerkRequest {
  trigger: "clerk";
  orgId: string;
  /** The svix message id: a redelivery of the same event starts nothing. */
  clerkEventId: string;
  /** When Clerk deleted the org (the event's timestamp). */
  deletedAt: Date;
}

export type DeletionRequest = OwnerRequest | ClerkRequest;

/** The deletion this request is part of, and whether this call started it. */
export interface StartedDeletion {
  deletion: OrgDeletion;
  started: boolean;
}

/** The open (pending or running) deletion of `orgId`, if there is one. */
export async function openDeletion(orgId: string): Promise<OrgDeletion | null> {
  return db.orgDeletion.findFirst({ where: { orgId, status: { in: [...OPEN_DELETION_STATUSES] } } });
}

/**
 * Start deleting an org, or return the deletion already under way. Idempotent: a second
 * request while one is open returns that one with its original date; a Clerk event joins
 * it. A Clerk deletion cannot be cancelled, so a redelivered event always finds the one
 * it started, or no org once it has run. Returns null when the org is not in this database.
 */
export async function startOrgDeletion(
  request: DeletionRequest,
  now: Date = new Date(),
): Promise<StartedDeletion | null> {
  const already = await openDeletion(request.orgId);
  if (already) {
    if (request.trigger === "owner") return { deletion: already, started: false };
    const joined = await joinClerkEvent(already, request, now);
    // Null: an owner cancelled it while Clerk's event was on its way. The org is gone at
    // Clerk all the same, so the event starts a deletion of its own.
    if (joined) return { deletion: joined, started: false };
  }

  const org = await db.org.findUnique({ where: { id: request.orgId }, select: { id: true, name: true } });
  if (!org) return null;

  try {
    const deletion = await db.$transaction(async (tx) => {
      await lockOrgDeletion(tx, org.id);
      // The row first: from its commit on, the database refuses new tokens for this org,
      // so none minted alongside this request outlives it unrevoked for long, and check()
      // refuses any that does.
      const created = await tx.orgDeletion.create({
        data: {
          orgId: org.id,
          orgName: org.name,
          trigger: request.trigger,
          ...(request.trigger === "owner"
            ? { requestedBy: request.requestedBy, recipientClerkIds: [request.requesterClerkId] }
            : {
                clerkEventId: request.clerkEventId,
                clerkDeletedAt: request.deletedAt,
                recipientClerkIds: [...(await ownersAndAdmins(tx, org.id, request.deletedAt))].sort(),
                recipientsFixedAt: now,
              }),
          requestedAt: now,
          effectiveAt: new Date(now.getTime() + DELETION_DELAY_DAYS * DAY_MS),
          revokedCapabilityIds: [],
        },
      });
      // Revoked at exactly `now`, which is how a cancel tells these tokens from ones
      // revoked for another reason.
      await tx.capability.updateMany({ where: { orgId: org.id, revokedAt: null }, data: { revokedAt: now } });
      const revoked = await tx.capability.findMany({
        where: { orgId: org.id, revokedAt: now },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      return tx.orgDeletion.update({
        where: { id: created.id },
        data: { revokedCapabilityIds: revoked.map((c) => c.id) },
      });
    });
    return { deletion, started: true };
  } catch (error) {
    // Another request opened one first: the partial unique index on the open deletion
    // per org, or the same Clerk event delivered twice at once. Theirs is the deletion.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner =
        (request.trigger === "clerk" &&
          (await db.orgDeletion.findUnique({ where: { clerkEventId: request.clerkEventId } }))) ||
        (await openDeletion(request.orgId));
      const joined =
        winner && request.trigger === "clerk" && winner.clerkEventId === null
          ? await joinClerkEvent(winner, request, now)
          : winner;
      if (joined) return { deletion: joined, started: false };
    }
    throw error;
  }
}

/**
 * Record Clerk's deletion on a deletion an owner already started: its event id, so a
 * redelivery is recognised, and when Clerk deleted the org. The recipients become the
 * org's owners and admins of that moment, and are fixed from then on: the person who
 * asked stays one only if they still were one. The date stays the owner's. A second
 * Clerk event for the same org changes nothing; the first one's moment stands. Nor does
 * one arriving after the job has started. Returns null when an owner cancelled the
 * deletion first: Clerk's event then has nothing to join.
 */
async function joinClerkEvent(open: OrgDeletion, request: ClerkRequest, now: Date): Promise<OrgDeletion | null> {
  return db.$transaction(async (tx) => {
    await lockOrgDeletion(tx, open.orgId);
    const admins = await ownersAndAdmins(tx, open.orgId, request.deletedAt);
    // Only a pending deletion no Clerk event has joined, checked on the row itself, so a
    // cancel or the job's claim committing meanwhile wins and this writes nothing. Once
    // the job has started, Clerk's event is the one it caused by deleting the Clerk
    // organization itself, and the recipients are already fixed.
    await tx.orgDeletion.updateMany({
      where: { id: open.id, status: "pending", clerkEventId: null },
      data: {
        clerkEventId: request.clerkEventId,
        clerkDeletedAt: request.deletedAt,
        recipientClerkIds: [...admins].sort(),
        recipientsFixedAt: now,
      },
    });
    const joined = await tx.orgDeletion.findUniqueOrThrow({ where: { id: open.id } });
    return joined.status === "cancelled" ? null : joined;
  });
}

/**
 * Take a membership change into an org's deletion, once Clerk has deleted the org: a
 * person the change shows was no longer an owner or admin at that moment (their
 * membership ended before it, or their role was not an admin one) stops being a
 * recipient. Never adds one. Call it after every membership write of the org, deletion
 * or not: it takes the recipients' lock first, so it also sees a deletion Clerk's event
 * is starting at the same moment.
 */
export async function refreshDeletionRecipients(orgId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockOrgDeletion(tx, orgId);
    const open = await tx.orgDeletion.findFirst({
      where: { orgId, status: "pending", clerkDeletedAt: { not: null } },
      select: { id: true, clerkDeletedAt: true, recipientClerkIds: true },
    });
    if (!open?.clerkDeletedAt) return;
    const admins = await ownersAndAdmins(tx, orgId, open.clerkDeletedAt);
    const kept = open.recipientClerkIds.filter((id) => admins.has(id));
    if (kept.length < open.recipientClerkIds.length) {
      await tx.orgDeletion.update({ where: { id: open.id }, data: { recipientClerkIds: kept } });
    }
  });
}

/**
 * Fix the recipients of a deletion the job is about to clear, while the org's memberships
 * still exist to read: the recorded recipients who are still owners or admins. A deletion
 * Clerk joined is fixed already. Returns the deletion as stored.
 */
export async function fixRecipientsBeforeClearing(deletionId: string, now: Date = new Date()): Promise<OrgDeletion> {
  return db.$transaction(async (tx) => {
    const { orgId } = await tx.orgDeletion.findUniqueOrThrow({ where: { id: deletionId }, select: { orgId: true } });
    await lockOrgDeletion(tx, orgId);
    const deletion = await tx.orgDeletion.findUniqueOrThrow({ where: { id: deletionId } });
    if (deletion.recipientsFixedAt !== null) return deletion;
    const admins = await ownersAndAdmins(tx, orgId, null);
    return tx.orgDeletion.update({
      where: { id: deletion.id },
      data: { recipientClerkIds: deletion.recipientClerkIds.filter((id) => admins.has(id)), recipientsFixedAt: now },
    });
  });
}

/**
 * The Clerk user ids of the org's owners and admins: those whose membership is live, and,
 * given the moment Clerk deleted the org, also those whose membership ended no earlier
 * than {@link CLERK_MEMBERSHIP_SKEW_MS} before it, whether their row is still here (the
 * role read is the one the membership held when it ended) or went with that membership
 * (`org_admin_departures`).
 */
async function ownersAndAdmins(
  tx: Prisma.TransactionClient,
  orgId: string,
  clerkDeletedAt: Date | null,
): Promise<Set<string>> {
  const endedSince = clerkDeletedAt ? new Date(clerkDeletedAt.getTime() - CLERK_MEMBERSHIP_SKEW_MS) : null;
  const rows = await tx.orgMembership.findMany({
    where: {
      orgId,
      role: { in: [...ORG_ADMIN_ROLES] },
      OR: [{ removedAt: null }, ...(endedSince ? [{ removedAt: { gte: endedSince } }] : [])],
    },
    select: { user: { select: { clerkId: true } } },
  });
  const departed = endedSince
    ? await tx.orgAdminDeparture.findMany({
        where: { orgId, removedAt: { gte: endedSince } },
        select: { clerkUserId: true },
      })
    : [];
  return new Set([...rows.map((r) => r.user.clerkId), ...departed.map((d) => d.clerkUserId)]);
}

/**
 * Cancel a pending deletion before its 7 days are up. Restores exactly the tokens the
 * request revoked (a token revoked since for another reason, or expired, stays so), and
 * from the commit on writes are accepted again. Cancelling a cancelled deletion returns
 * it unchanged; one that has started or is due is refused, and so is one Clerk has
 * reported deleting the org for: Clerk cannot bring the org back, so a cancel would keep
 * data no one can reach, for good.
 */
export async function cancelOrgDeletion(
  deletionId: string,
  cancelledBy: string | null,
  now: Date = new Date(),
): Promise<OrgDeletion> {
  return db.$transaction(async (tx) => {
    const target = await tx.orgDeletion.findUnique({ where: { id: deletionId }, select: { orgId: true } });
    if (!target) throw new OrgDeletionRefusedError("no such org deletion", 404);
    // A removal of one of its members either committed before this, and is among the rows
    // it deletes, or waits for this and finds the deletion cancelled.
    await lockOrgDeletion(tx, target.orgId);
    const claimed = await tx.orgDeletion.updateMany({
      where: { id: deletionId, status: "pending", effectiveAt: { gt: now }, clerkEventId: null },
      data: { status: "cancelled", cancelledAt: now, cancelledBy },
    });
    const deletion = await tx.orgDeletion.findUniqueOrThrow({ where: { id: deletionId } });
    if (claimed.count === 0) {
      if (deletion.status === "cancelled") return deletion;
      if (deletion.status === "pending" && deletion.clerkEventId !== null && deletion.effectiveAt > now) {
        throw new OrgDeletionRefusedError(
          "the organization was deleted at the sign-in provider, so there is no organization to restore; its data is deleted when the 7 days end",
          409,
        );
      }
      throw new OrgDeletionRefusedError(
        deletion.status === "deleted"
          ? "this org has already been deleted"
          : "the 7 days are up and the deletion has started; it can no longer be cancelled",
        409,
      );
    }
    await tx.capability.updateMany({
      where: { id: { in: deletion.revokedCapabilityIds }, orgId: deletion.orgId, revokedAt: deletion.requestedAt },
      data: { revokedAt: null },
    });
    // People who left during the window kept their row for the deletion; with the org
    // staying, they go as they would have when they left.
    await deleteUsersLeftWithoutMembership(tx, deletion.orgId, now);
    return deletion;
  });
}

/** What a signed-in person may do with one deletion. */
export interface DeletionAccess {
  deletion: OrgDeletion;
  /** Read it and its receipt: a recipient, or an owner or admin of the org now. */
  view: true;
  /** Cancel it: an owner or admin of the org now, or an entitled recipient. */
  cancel: boolean;
  /** Download its final export: an entitled recipient. */
  download: boolean;
}

/**
 * What the signed-in Clerk user may do with deletion `id`, or null when they may not even
 * see it, the same as for an id that does not exist, so a caller cannot tell the two apart.
 */
export async function deletionAccess(id: string, clerkUserId: string): Promise<DeletionAccess | null> {
  const deletion = await db.orgDeletion.findUnique({ where: { id } });
  return deletion ? accessTo(deletion, clerkUserId) : null;
}

/**
 * The deletions that name the signed-in Clerk user as a recipient, newest first, with
 * what they may do with each. Needs no org: it is how the owners and admins of an org
 * Clerk deleted find its deletion. Anyone else gets an empty list.
 */
export async function deletionsNaming(clerkUserId: string): Promise<DeletionAccess[]> {
  const named = await db.orgDeletion.findMany({
    where: { recipientClerkIds: { has: clerkUserId } },
    orderBy: [{ requestedAt: "desc" }, { id: "asc" }],
  });
  const access = await Promise.all(named.map((deletion) => accessTo(deletion, clerkUserId)));
  return access.filter((a): a is DeletionAccess => a !== null);
}

/**
 * A recipient is entitled to the export, and to cancel, while they are still an owner or
 * admin of the org. Once the recipients are fixed (Clerk deleted the org, or the job is
 * clearing it) being on the list is the whole answer, since the memberships it was
 * chosen from are ending. A recipient who is no longer entitled may still read the
 * deletion, and its receipt only if they are still on the list when it is fixed.
 */
async function accessTo(deletion: OrgDeletion, clerkUserId: string): Promise<DeletionAccess | null> {
  const user = await db.user.findUnique({ where: { clerkId: clerkUserId }, select: { id: true } });
  const membership = user
    ? await db.orgMembership.findUnique({
        where: { orgId_userId: { orgId: deletion.orgId, userId: user.id } },
        select: { role: true, removedAt: true },
      })
    : null;
  const liveAdmin = membership !== null && membership.removedAt === null && ORG_ADMIN_ROLES.includes(membership.role);
  const recipient = deletion.recipientClerkIds.includes(clerkUserId);
  if (!recipient && !liveAdmin) return null;
  const entitled = recipient && (deletion.recipientsFixedAt !== null || liveAdmin);
  return { deletion, view: true, cancel: liveAdmin || entitled, download: entitled };
}

/** What a viewer is shown: never the recipients, the token ids or the export's URL. */
export interface DeletionView {
  id: string;
  orgName: string;
  trigger: OrgDeletion["trigger"];
  status: OrgDeletion["status"];
  requestedAt: string;
  effectiveAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
  finalExport: { ready: boolean; bytes: number | null; failed: boolean };
  receipt: Prisma.JsonValue | null;
}

export function viewOf(deletion: OrgDeletion): DeletionView {
  return {
    id: deletion.id,
    orgName: deletion.orgName,
    trigger: deletion.trigger,
    status: deletion.status,
    requestedAt: deletion.requestedAt.toISOString(),
    effectiveAt: deletion.effectiveAt.toISOString(),
    cancelledAt: deletion.cancelledAt?.toISOString() ?? null,
    completedAt: deletion.completedAt?.toISOString() ?? null,
    finalExport: {
      ready: deletion.exportUrl !== null,
      bytes: deletion.exportUrl !== null ? deletion.exportBytes : null,
      failed: deletion.exportUrl === null && deletion.exportError !== null,
    },
    receipt: deletion.receipt ?? null,
  };
}
