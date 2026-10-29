import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { authorizeRecord } from "@/services/access";

// A token at a scope the caller cannot read answers like an absent one
// (services/access/authorize-record.ts).
function capabilityNotFound(): Response {
  return NextResponse.json({ error: "capability not found" }, { status: 404 });
}

// DELETE /api/access/capabilities/:id — revoke an agent capability token.
// Admin-only (access.manage), tenant-scoped, and scope-admin gated on the
// token's own scope, the same shape as revoking a grant. This is the one
// product path that sets `revokedAt`, which check() honours as `revokedAt IS
// NULL`; without it a leaked or misbehaving agent token would stay live until
// it expired on its own, up to 90 days.
//
// Revoking UPDATES the row rather than deleting it: check()'s predicate reads
// revokedAt, the UIs render revoked tokens in their inactive list, and the
// record of a token having existed is exactly what an access review needs.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // Loaded tenant-scoped and decided on the token's own scope, never anything
  // the caller supplied.
  const access = await authorizeRecord(
    rc.ctx,
    () =>
      db.capability.findFirst({
        where: { id, orgId: rc.org.id },
        select: { id: true, scopePath: true, revokedAt: true, agentId: true },
      }),
    { action: "access.manage", scopeOf: (c) => c.scopePath, target: `capabilities:revoke:${id}` },
  );
  if (access.status === "absent") return capabilityNotFound();
  if (access.status === "denied") return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  const capability = access.record;

  // Idempotent: revoking twice must not move the timestamp. The first revocation
  // is when access actually ended, and an access review reads that date.
  //
  // The write itself carries the same guard as the read above, not just the
  // read: with `where: { id }` and no `revokedAt: null` predicate, two
  // concurrent DELETEs (or a DELETE racing the grant-revoke cascade in
  // app/api/access/grants/[id]/route.ts, which writes this same column) could
  // both pass the findFirst check with revokedAt still null, then both write,
  // the later one silently moving the timestamp forward. `updateMany` makes
  // the guard atomic: only the write that actually flips revokedAt IS NULL ->
  // now can affect a row.
  if (capability.revokedAt) {
    return NextResponse.json({ revoked: id, revokedAt: capability.revokedAt, alreadyRevoked: true });
  }

  const revokedAt = new Date();
  const { count } = await db.capability.updateMany({
    where: { id, orgId: rc.org.id, revokedAt: null },
    data: { revokedAt },
  });
  if (count === 0) {
    // Lost the race: something else revoked it between our read and our write.
    // Report that revocation's real timestamp, not a fabricated one of our own.
    const current = await db.capability.findFirst({ where: { id, orgId: rc.org.id }, select: { revokedAt: true } });
    return NextResponse.json({ revoked: id, revokedAt: current?.revokedAt ?? null, alreadyRevoked: true });
  }
  return NextResponse.json({ revoked: id, revokedAt });
}
