// POST /api/org-deletion/:id/cancel: stop an org deletion before its 7 days are up. The
// org's agent tokens the request revoked work again and writes are accepted again; the
// final export is deleted. Who may: an owner or admin of the org now, or a person the
// deletion names who still is one (after Clerk deleted the org, who was one). 404 for
// anyone who cannot see it, 403 for one who can but may not cancel, 409 once it has started.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { orgRootPath, recordRefusal, writeAuditRow } from "@/services/access";
import { discardFinalExport } from "@/services/memory/org-deletion/final-export";
import {
  cancelOrgDeletion,
  deletionAccess,
  OrgDeletionRefusedError,
  viewOf,
} from "@/services/memory/org-deletion/request";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await deletionAccess(id, userId);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!access.cancel) {
    await recordCancelRefused(access.deletion.orgId, userId);
    return NextResponse.json({ error: "only an owner or admin of the organization can cancel" }, { status: 403 });
  }

  let cancelled;
  try {
    cancelled = await cancelOrgDeletion(id, userId);
  } catch (error) {
    if (error instanceof OrgDeletionRefusedError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const person = await db.user.findUnique({ where: { clerkId: userId }, select: { id: true } });
  if (person && (await db.org.findUnique({ where: { id: cancelled.orgId }, select: { id: true } }))) {
    const root = orgRootPath(cancelled.orgId);
    await writeAuditRow({
      orgId: cancelled.orgId,
      actorType: "human",
      actorId: person.id,
      action: "access.manage",
      target: `${root}:org-deletion`,
      decision: "allow",
      reason: `cancelled org deletion ${cancelled.id}`,
      metadata: { deletionId: cancelled.id },
      origin: "app",
    });
  }
  // The sweep deletes a cancelled deletion's export too, if this fails.
  await discardFinalExport(cancelled).catch((error: unknown) => {
    console.error("[org-deletion] could not delete the final export of a cancelled deletion; the sweep will", error);
  });
  return NextResponse.json({ deletion: viewOf({ ...cancelled, exportUrl: null }) });
}

/** The one deny row for a refused cancel, while the org and the person's row exist to name. */
async function recordCancelRefused(orgId: string, clerkUserId: string): Promise<void> {
  const person = await db.user.findUnique({ where: { clerkId: clerkUserId }, select: { id: true, role: true } });
  if (!person || !(await db.org.findUnique({ where: { id: orgId }, select: { id: true } }))) return;
  const root = orgRootPath(orgId);
  await recordRefusal(
    { orgId, actor: { type: "human", id: person.id, role: person.role }, origin: "app" },
    {
      action: "access.refused",
      target: `${root}/org-deletion:cancel`,
      auditReason: `${person.id} is not an owner or admin of ${root}; cancelling its deletion needs one`,
    },
  );
}
