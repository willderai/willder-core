// GET /api/memory/uploads/:id: the uploaded file itself, as it was uploaded.
// DELETE /api/memory/uploads/:id: remove the upload: its passages, then its raw file.
//
// Both decide at the upload's own stored scope (memory.read, memory.delete), never at a
// scope the caller names. An upload the caller may not read or remove answers 404, the
// same as one that does not exist, so its existence is not disclosed.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { readUploadFile, removeUpload } from "@/services/memory/uploads";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const file = await readUploadFile(rc.ctx, id);
  if (!file) return NextResponse.json({ error: "upload not found" }, { status: 404 });
  return new Response(file.body, {
    headers: {
      "content-type": CONTENT_TYPES[file.fileType] ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const { removed, passages } = await removeUpload(rc.ctx, id);
  if (!removed) return NextResponse.json({ error: "upload not found" }, { status: 404 });
  return NextResponse.json({ removed: true, passagesRemoved: passages });
}
