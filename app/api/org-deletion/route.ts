// GET  /api/org-deletion: the open deletion of the signed-in person's org, if any.
// POST /api/org-deletion: an owner asks to delete the org. Body: { confirm }, the org's
//   name typed exactly. The org is deleted 7 days later unless an owner cancels
//   (POST /api/org-deletion/:id/cancel); the request revokes the org's agent tokens,
//   refuses new writes and makes a final export for the person who asked.
// Owners and admins only, both. services/memory/org-deletion holds the rules.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { queueFinalExport } from "@/lib/inngest/org-deletion";
import { check, orgRootPath } from "@/services/access";
import { openDeletion, startOrgDeletion, viewOf } from "@/services/memory/org-deletion/request";

export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "org-deletion:read"))) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const open = await openDeletion(rc.org.id);
  return NextResponse.json({ deletion: open ? viewOf(open) : null });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "org-deletion:request"))) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const confirm = typeof body === "object" && body !== null ? (body as { confirm?: unknown }).confirm : undefined;
  // Exact, character for character: no trimming, case folding or normalization, so
  // only someone who typed this org's name confirms deleting it.
  if (typeof confirm !== "string" || confirm.length === 0 || confirm !== rc.org.name) {
    return NextResponse.json({ error: "type the organization's name exactly to confirm" }, { status: 400 });
  }

  const open = await openDeletion(rc.org.id);
  if (open) return NextResponse.json({ deletion: viewOf(open) }, { status: 200 });

  const root = orgRootPath(rc.org.id);
  const decision = await check(rc.ctx, { action: "access.manage", scope: root, target: `${root}:org-deletion` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const result = await startOrgDeletion({
    trigger: "owner",
    orgId: rc.org.id,
    requestedBy: rc.user.id,
    requesterClerkId: rc.user.clerkId,
  });
  if (!result) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (result.started) {
    // The sweep makes the export too, so a lost event only delays it.
    await queueFinalExport(result.deletion.id).catch((error: unknown) => {
      console.error("[org-deletion] could not queue the final export; the sweep will make it", error);
    });
  }
  return NextResponse.json({ deletion: viewOf(result.deletion) }, { status: result.started ? 202 : 200 });
}
