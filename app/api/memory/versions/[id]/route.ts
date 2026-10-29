// GET /api/memory/versions/[id]: read one stored version of a fact or a rule by the id
// a change notice handed out. The version carries its own scope, so the caller names
// none; services/memory/versions.ts makes the one memory.read decision against it.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { readMemoryVersion } from "@/services/memory/versions";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const version = await readMemoryVersion(rc.ctx, id);
  // A version in a scope this caller cannot read is reported as missing, so the route
  // cannot be used to find out what exists elsewhere in the org.
  if (!version) return NextResponse.json({ error: "version not found" }, { status: 404 });

  return NextResponse.json({ version: { ...version, createdAt: version.createdAt.toISOString() } });
}
