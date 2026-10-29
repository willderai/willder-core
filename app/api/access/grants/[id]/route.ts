import { NextResponse } from "next/server";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { requireAccessContext } from "@/lib/access-context";
import {
  authorizeRecord,
  scopeContainsSql,
  flattenSql,
  pathCovers,
  anotherLiveAgentGrantCoversSql,
} from "@/services/access";
import { HANDOFF_AGENT_ID } from "@/lib/handoff-agent";

// A grant at a scope the caller cannot read answers like an absent one
// (services/access/authorize-record.ts).
function grantNotFound(): Response {
  return NextResponse.json({ error: "grant not found" }, { status: 404 });
}

// DELETE /api/access/grants/:id — revoke a grant. Admin-only (access.manage).
// Tenant-scoped: you can only revoke grants in your own org.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // Scope-admin authority: you may revoke only where you administer the grant's
  // scope. The grant is loaded tenant-scoped and decided on its own scope.
  const access = await authorizeRecord(
    rc.ctx,
    () =>
      db.grant.findFirst({
        where: { id, orgId: rc.org.id },
        select: {
          id: true,
          granteeType: true,
          granteeId: true,
          scope: { select: { path: true } },
        },
      }),
    { action: "access.manage", scopeOf: (g) => g.scope.path, target: `grants:revoke:${id}` },
  );
  if (access.status === "absent") return grantNotFound();
  if (access.status === "denied") return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  const grant = access.record;

  // Revoking a grant has to reach every capability it made possible, or the
  // revoke is cosmetic. Two independent populations of capability can trace
  // back to a grant, and neither supersedes the other, so both cascades run
  // in the same transaction as the grant delete: done as separate calls, a
  // failure in the capability step would leave the grant already gone while
  // its capability stayed live, and a retry on the same id 404s, so the
  // operator would have no way to finish the revoke.
  //
  // 1. The grantee agent's own tokens. check()'s agent branch authenticates
  //    the bearer token and evaluates the capability's own scope directly --
  //    it never joins grants -- so pulling an agent's grant alone would leave
  //    every token already issued to it working until natural expiry while
  //    the access UI showed the access as gone. Containment is
  //    descendant-or-self: a token scoped at or below the revoked grant's
  //    scope was covered by it and goes; one scoped ABOVE it was not granted
  //    here and is left alone. Already-expired tokens are excluded (matching
  //    check()'s own `expiresAt > sqlUtcNow` liveness test): a token past its TTL
  //    can no longer pass check() either way, so stamping revokedAt on it
  //    would misreport a natural expiry as a revocation in the audit trail.
  // 2. Any live handoff brief minted off this grant's own read access at
  //    generation time (POST /api/agents/:id/handoff ->
  //    provisionHandoffAgentCapability, lib/handoff-agent.ts). A handoff
  //    brief is a scoped VIEW, not a standing independent grant. That mint
  //    has no stored link back to a Grant row (Capability carries no
  //    grantId), only a scope: the exact scopePath the admin could read at
  //    handoff time. Left alone, it would keep passing check() for its own
  //    TTL (up to 1h) after the access it was derived from is gone.
  //    Containment here is ancestor-or-self (pathCovers, the same relation
  //    evaluate() enforces). Already-expired capabilities are excluded from
  //    the scan: they can no longer pass check(), so there is nothing to
  //    revoke.
  //
  // These are disjoint populations -- a handoff capability's agentId is
  // always HANDOFF_AGENT_ID, never a real grantee -- so both cascades run
  // unconditionally; this is composition, not a choice between them.
  let revokedAgentCapabilities = 0;
  let revokedHandoffCapabilities = 0;
  const revokedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.grant.delete({ where: { id } });

    if (grant.granteeType === "agent") {
      const containment = scopeContainsSql(Prisma.raw('"scopePath"'), grant.scope.path, {
        relation: "within",
        mode: "ltree",
      });
      // Scope containment alone over-revokes.
      // An agent can hold several overlapping grants at different scopes/
      // permissions (no uniqueness prevents it), so deleting the narrower one
      // must not strip a token a broader surviving grant still authorizes --
      // the same principle the route already applies to scopes ABOVE the
      // deleted grant. See anotherLiveAgentGrantCoversSql's own doc comment
      // (services/access/check.ts) for why this checks survivorship rather
      // than issuance provenance.
      const query = Prisma.sql`
        UPDATE "capabilities"
        SET "revokedAt" = ${revokedAt}
        WHERE "orgId" = ${rc.org.id}
          AND "agentId" = ${grant.granteeId}
          AND "revokedAt" IS NULL
          AND "expiresAt" > ${sqlUtcNow}
          AND ${containment}
          AND NOT ${anotherLiveAgentGrantCoversSql()}
      `;
      revokedAgentCapabilities = await tx.$executeRaw(...flattenSql(query));
    }

    const liveHandoffCaps = await tx.capability.findMany({
      where: {
        orgId: rc.org.id,
        agentId: HANDOFF_AGENT_ID,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, scopePath: true },
    });
    const toRevoke = liveHandoffCaps.filter((cap) => pathCovers(grant.scope.path, cap.scopePath)).map((cap) => cap.id);
    if (toRevoke.length > 0) {
      await tx.capability.updateMany({
        where: { id: { in: toRevoke } },
        data: { revokedAt },
      });
      revokedHandoffCapabilities = toRevoke.length;
    }
  });

  return NextResponse.json({
    revoked: id,
    revokedCapabilities: revokedAgentCapabilities + revokedHandoffCapabilities,
  });
}
