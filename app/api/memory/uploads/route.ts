// GET /api/memory/uploads: the files the caller uploaded or may read, whose raw copies are
// kept until removed. Each one's raw file is GET /api/memory/uploads/:id; together they are
// how an export of memory hands uploads back. Listed only in scopes the caller may read.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { listReadableUploads } from "@/services/memory/uploads";

export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ uploads: await listReadableUploads(rc.ctx) });
}
