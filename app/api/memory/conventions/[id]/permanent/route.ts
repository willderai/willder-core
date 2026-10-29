// DELETE /api/memory/conventions/:id/permanent: an org admin removes a retired rule.
//
// Retiring (DELETE /api/memory/conventions/:id) takes a rule out of service but keeps
// its row readable by id, and a kept row is residue that stops its scope from being
// deleted (services/memory/scope-deletion.ts). This is the one way that row goes.
// Only a retired rule is removed (services/memory/conventions.ts
// `deleteRetiredConvention`); each refusal is a 409 that names what to do first.
//
// The decision is `access.manage` at the org root, made before the rule is looked up,
// so a caller without it gets the same 403, and the same recorded refusal, for a real
// rule and for an id never issued. A rule actually removed also leaves a visible
// `record.removed` row naming it and its lineage by id.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check, orgRootPath } from "@/services/access";
import { deleteRetiredConvention } from "@/services/memory/conventions";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const decision = await check(rc.ctx, {
    action: "access.manage",
    scope: orgRootPath(rc.org.id),
    target: `conventions:delete:${id}`,
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const result = await deleteRetiredConvention(rc.ctx, id);
  switch (result.status) {
    case "deleted":
      return NextResponse.json({ deleted: id });
    case "missing":
      return NextResponse.json({ error: "convention not found" }, { status: 404 });
    case "active":
      return NextResponse.json(
        { error: "this convention is not retired; retire it first with DELETE /api/memory/conventions/:id" },
        { status: 409 },
      );
    case "namedBy":
      return NextResponse.json(
        { error: `newer versions name this convention; remove them first: ${result.ids.join(", ")}` },
        { status: 409 },
      );
    case "wouldRestore":
      return NextResponse.json(
        {
          error:
            `removing this convention would put the version it replaced, ${result.id}, back in service; ` +
            "retire that version first",
        },
        { status: 409 },
      );
  }
}
