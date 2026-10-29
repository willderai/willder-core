// POST /api/memory/import: loads a Willder export (the request body, JSON Lines as
// GET /api/memory/export wrote it) into this org. services/memory/org-import.ts decides
// whether it may: an admin of the org, an org that holds no memory yet, and a complete
// file. The body is read line by line as it arrives. 503 when the import was written but
// re-applying the org's erasures after it failed, so it was undone.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError } from "@/services/access";
import { ImportIncompleteError, importMemory, ImportRefusedError, linesOf } from "@/services/memory/org-import";

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (req.body === null)
    return NextResponse.json({ error: "Send the export file as the request body." }, { status: 400 });

  try {
    return NextResponse.json(await importMemory(rc.ctx, linesOf(req.body)));
  } catch (error) {
    if (error instanceof AccessDeniedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportRefusedError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (error instanceof ImportIncompleteError) return NextResponse.json({ error: error.message }, { status: 503 });
    throw error;
  }
}
