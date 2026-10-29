// Whether an org has an open deletion, the one question check() asks of
// services/memory/org-deletion. Kept apart from that service so check() does not load it.
//
// The rule it serves: from an owner's request (or Clerk's `organization.deleted`)
// until the deletion is cancelled or done, the org's agent tokens are refused and its
// people may only read.
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/** The statuses during which an org is being deleted. */
export const OPEN_DELETION_STATUSES = ["pending", "deleting"] as const;

/** True while `orgId` has a deletion that is pending or running. */
export async function orgDeletionOpen(orgId: string): Promise<boolean> {
  const open = await db.orgDeletion.findFirst({
    where: { orgId, status: { in: [...OPEN_DELETION_STATUSES] } },
    select: { id: true },
  });
  return open !== null;
}

/**
 * One lock per org, held to the end of the transaction, around every change to the org's
 * deletion (starting it, Clerk's event joining it, a cancel, its recipients) and around a
 * removal deciding whether to keep the leaving member's `users` row for it. Whichever
 * commits first, the other then reads what it wrote.
 */
export async function lockOrgDeletion(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`org-deletion-recipients:${orgId}`}, 0))`;
}
