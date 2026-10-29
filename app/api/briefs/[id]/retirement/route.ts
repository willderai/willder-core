import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { briefNotFound, briefWriteDenied } from "@/lib/brief-access";
import { isBriefRetired, unretireBrief } from "@/services/memory/brief-retirement";
import { authorizeBrief } from "@/services/memory/briefs";

// DELETE /api/briefs/:id/retirement[?sourceId=]: an org admin rules that a brief
// withdrawn by a moved or disconnected source never drew from it
// (services/memory/brief-retirement.ts `unretireBrief`). The brief reads again
// once no other source withdraws it. `sourceId` names the source to waive and
// may be omitted only when one source withdrew the brief.
//
// Gated by `access.manage` on the brief's own scope: the admin who decides who
// may read that scope decides whether this brief is fit to read there. A
// retired brief reads as absent to
// everyone else, so a caller without that permission gets the same 404 as for
// an id never issued; the 403 of `briefWriteDenied` only reaches a caller who
// can already read the live brief. Refused with 409 when the brief's recorded
// provenance shows it read the source, since then it does quote content that
// left its scope, and for a retirement recorded before retirements were kept
// per source, since another source may have withdrawn the brief unrecorded.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await authorizeBrief(rc.ctx, id, {
    action: "access.manage",
    target: `brief:${id}`,
    includeWithdrawn: true,
  });
  if (access.status !== "allowed") {
    // Both lookups run on every refusal, so a retired brief, a live one and an
    // absent id all take as long to refuse.
    const denied = await briefWriteDenied(rc.ctx, access);
    return (await isBriefRetired(id)) ? briefNotFound() : denied;
  }

  const sourceId = new URL(req.url).searchParams.get("sourceId") || undefined;
  const { refusal, retiredBy } = await unretireBrief({
    orgId: rc.org.id,
    briefId: id,
    sourceId,
    actor: rc.ctx.actor,
    origin: rc.ctx.origin,
  });
  if (refusal === "not_retired") {
    const error = sourceId ? "brief is not retired by that source" : "brief is not retired";
    return NextResponse.json({ error }, { status: 409 });
  }
  if (refusal === "source_required") {
    return NextResponse.json(
      { error: "several sources withdrew this brief; name one with ?sourceId=", retiredBy },
      { status: 409 },
    );
  }
  if (refusal === "read_the_source") {
    return NextResponse.json(
      { error: "this brief read the source that withdrew it; generate a new brief instead" },
      { status: 409 },
    );
  }
  if (refusal === "legacy") {
    return NextResponse.json(
      { error: "withdrawn before per-source tracking; generate a new brief instead" },
      { status: 409 },
    );
  }
  return NextResponse.json({ briefId: id, retired: retiredBy.length > 0, retiredBy });
}
