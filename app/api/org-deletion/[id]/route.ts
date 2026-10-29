// GET /api/org-deletion/:id: one org deletion as its owner sees it, the receipt included
// once it has run. Readable by the people it names (who asked, or the org's admins when
// Clerk deleted it), after the org is gone too: it needs a Clerk sign-in, not an org; and
// by the org's current owners and admins. Anyone else gets the same 404 as for an id
// that does not exist.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deletionAccess, viewOf } from "@/services/memory/org-deletion/request";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await deletionAccess(id, userId);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deletion: viewOf(access.deletion) });
}
