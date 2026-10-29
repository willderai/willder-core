// DELETE /api/memory/conventions/[id]: retire one rule so it stops being served at the
// start of sessions in its scope. The row is kept and stays readable by id; retiring is
// how a rule leaves service when nothing replaces it.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError } from "@/services/access";
import { retireConvention } from "@/services/memory/conventions";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const retired = await retireConvention(rc.ctx, id);
    if (!retired) return NextResponse.json({ error: "convention not found" }, { status: 404 });
    return NextResponse.json({ retired: id });
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }
}
