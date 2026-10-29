// GET /api/org-deletion/mine: the org deletions that name the signed-in person as a
// recipient, newest first, each with links to read it (and its receipt once it has run)
// and, while they may take it, to download its final export. Needs a Clerk sign-in only,
// no org: after Clerk deletes an org there is no org session left, and this is how its
// owners and admins of that moment find the deletion. Anyone else gets an empty list,
// the same answer as a person no deletion has ever named.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deletionsNaming, viewOf } from "@/services/memory/org-deletion/request";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const named = await deletionsNaming(userId);
  return NextResponse.json({
    deletions: named.map(({ deletion, download }) => {
      const view = viewOf(deletion);
      const path = `/api/org-deletion/${encodeURIComponent(deletion.id)}`;
      return {
        deletion: view,
        links: { deletion: path, export: download && view.finalExport.ready ? `${path}/export` : null },
      };
    }),
  });
}
