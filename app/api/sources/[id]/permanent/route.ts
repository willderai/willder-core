// DELETE /api/sources/:id/permanent: an org admin removes a disconnected source's row.
//
// Disconnecting (DELETE /api/sources/:id) retires what a source ingested but keeps its
// row, marked `disconnected`, and a kept row is residue that stops its scope from being
// deleted (services/memory/scope-deletion.ts). This is the one way that row goes, and
// only once a disconnect has finished retiring what the source wrote
// (services/memory/source-removal.ts). Each refusal is a 409 that names what to do;
// a memory service that cannot say what is left is a 502, and nothing is removed.
//
// The decision is `access.manage` at the org root, made before the source is looked
// up, so a caller without it gets the same 403, and the same recorded refusal, for a
// real source and for an id never issued. A source actually removed also leaves a
// visible `record.removed` row naming it by id.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check, orgRootPath } from "@/services/access";
import { MemoryServiceError } from "@/services/memory/graphiti-store";
import { removeDisconnectedSource } from "@/services/memory/source-removal";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const decision = await check(rc.ctx, {
    action: "access.manage",
    scope: orgRootPath(rc.org.id),
    target: `sources:delete:${id}`,
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  let result;
  try {
    result = await removeDisconnectedSource(rc.ctx, id);
  } catch (e) {
    if (!(e instanceof MemoryServiceError)) throw e;
    return NextResponse.json(
      { error: `Could not confirm this source left nothing in the memory graph, so it was kept. ${e.message}` },
      { status: 502 },
    );
  }
  switch (result.status) {
    case "deleted":
      return NextResponse.json({ deleted: id });
    case "missing":
      return NextResponse.json({ error: "source not found" }, { status: 404 });
    case "connected":
      return NextResponse.json(
        { error: "this source is still connected; disconnect it first with DELETE /api/sources/:id" },
        { status: 409 },
      );
    case "recordsRemain":
      return NextResponse.json(
        {
          error:
            "this source still has records in memory; disconnect it again with DELETE /api/sources/:id " +
            "to retire them, then remove it",
          remaining: result.scopes,
        },
        { status: 409 },
      );
  }
}
