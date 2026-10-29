// GET /api/org-deletion/:id/export: the final export of an org being deleted, as JSON
// Lines (docs/export-format.md), for its recipients while it is pending: the person who
// asked while still an owner or admin, or once Clerk deleted the org its owners and admins
// of that moment. Gone once the deletion runs or is cancelled.
// Anyone else gets the same 404 as for an id that does not exist.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { orgRootPath, writeAuditRow } from "@/services/access";
import { finalExportBody } from "@/services/memory/org-deletion/final-export";
import { deletionAccess } from "@/services/memory/org-deletion/request";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await deletionAccess(id, userId);
  if (!access?.download) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { deletion } = access;
  const body = await finalExportBody(deletion);
  if (!body) return NextResponse.json({ error: "the final export is not available" }, { status: 404 });
  // Recorded like any export download; a recipient with no row in this database (their
  // account went with another org) downloads unrecorded, as the org's trail has no actor for them.
  const person = await db.user.findUnique({ where: { clerkId: userId }, select: { id: true } });
  if (person) {
    const root = orgRootPath(deletion.orgId);
    await writeAuditRow({
      orgId: deletion.orgId,
      actorType: "human",
      actorId: person.id,
      action: "memory.read",
      target: `${root}:export`,
      decision: "allow",
      reason: `download of the final export for org deletion ${deletion.id}`,
      metadata: { deletionId: deletion.id },
      origin: "app",
    });
  }
  const date = deletion.requestedAt.toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="willder-final-export-${date}.jsonl"`,
      "cache-control": "no-store",
    },
  });
}
