import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { briefNotFound } from "@/lib/brief-access";
import { AccessDeniedError, recordBriefAcknowledgement } from "@/services/access";
import { authorizeBrief } from "@/services/memory/briefs";
import { checkBriefStaleness } from "@/services/memory/brief-staleness";

// POST /api/briefs/:id/acknowledge: a grantee explicitly attests they have
// read a handoff brief. A completion receipt that carries no staleness state
// would attest a clean handoff of a brief the product already knows is
// stale, so the attestation carries the staleness verdict AT THAT MOMENT,
// computed the same way GET /api/briefs/:id/staleness does, right before
// recording it, never trusted from whatever the client last fetched. That
// keeps "acknowledged while stale" and "acknowledged while current"
// distinguishable later.
//
// Same access pattern as GET /api/briefs/:id and its /staleness route:
// org-scoped, and re-gated through check() on the brief's own scopePath, so
// an ungranted or revoked reader cannot learn the staleness verdict for a
// scope they hold no grant on, or write brief.acknowledged audit rows
// attributed to them at that scope. Handoff-only: staleness/acknowledgement
// exist for the point-in-time-read brief type only, matching
// brief-document.tsx's own `isHandoff` gate.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.read" });
  if (access.status !== "allowed") return briefNotFound();
  const { brief } = access;

  if (brief.type !== "handoff") {
    return NextResponse.json({ error: "acknowledgement applies to handoff briefs only" }, { status: 400 });
  }

  // A grant revoked between the read above and this one answers like an absent brief.
  const staleness = await checkBriefStaleness(rc.ctx, {
    id,
    orgId: rc.org.id,
    scopePath: brief.scopePath,
    createdAt: brief.createdAt,
  }).catch((error: unknown) => {
    if (error instanceof AccessDeniedError) return null;
    throw error;
  });
  if (staleness === null) return briefNotFound();

  const ack = await recordBriefAcknowledgement({
    orgId: rc.org.id,
    scopePath: brief.scopePath,
    briefId: id,
    actorType: rc.ctx.actor.type,
    actorId: rc.ctx.actor.id,
    stale: staleness.stale,
    origin: rc.ctx.origin,
  });

  return NextResponse.json({ acknowledgedAt: ack.at, stale: staleness.stale });
}
