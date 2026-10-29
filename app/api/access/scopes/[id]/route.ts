import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { requireAccessContext } from "@/lib/access-context";
import { authorizeRecord, flattenSql, scopeContainsSql } from "@/services/access";
import { MemoryServiceError } from "@/services/memory/graphiti-store";
import { deleteScopeClearingFeed, describeScopeResidue, findScopeResidue } from "@/services/memory/scope-deletion";

// A scope the caller cannot read answers like an absent one
// (services/access/authorize-record.ts).
function scopeNotFound(): Response {
  return NextResponse.json({ error: "scope not found" }, { status: 404 });
}

// DELETE /api/access/scopes/:id — remove a scope and cascade its grants.
// Blocked if the scope is the org root, has child scopes, or still holds
// anything a reader could reach at its path (services/memory/scope-deletion.ts):
// a scope recreated at the same path must start empty.
// Requires access.manage on the scope being deleted.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await authorizeRecord(
    rc.ctx,
    () => db.scope.findFirst({ where: { id, orgId: rc.org.id }, select: { id: true, path: true, orgId: true } }),
    { action: "access.manage", scopeOf: (s) => s.path, target: (s) => `scopes:delete:${s.path}` },
  );
  if (access.status === "absent") return scopeNotFound();
  if (access.status === "denied") return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  const scope = access.record;

  // Org root has no dot in its path — never deletable.
  if (!scope.path.includes(".")) {
    return NextResponse.json({ error: "cannot delete the org root scope" }, { status: 409 });
  }

  // Block if any child scopes exist (ltree descendants). The containment leg
  // comes from the one shared scopeContainsSql() (same definition
  // check.ts/mcp/tools.ts/pgvector-store.ts use); the strict-descendant `!=`
  // leg stays here, since it is specific to this delete guard, not part of
  // the containment relation itself.
  const containment = scopeContainsSql(Prisma.raw("path"), scope.path, {
    relation: "within",
    mode: "ltree",
  });
  /* eslint-disable no-restricted-syntax -- this route IS the scope-management admin API, not a
     consumer of it, and needs a direct db.$queryRaw for the descendant COUNT(*) query no Prisma
     model call expresses. The containment predicate itself lives in scopeContainsSql above. */
  const query = Prisma.sql`
    SELECT COUNT(*) AS count FROM scopes
    WHERE "orgId" = ${rc.org.id}
      AND ${containment}
      AND path::text != ${scope.path}
  `;
  const rows = await db.$queryRaw<[{ count: bigint }]>(...flattenSql(query));
  /* eslint-enable no-restricted-syntax */
  if (Number(rows[0].count) > 0) {
    return NextResponse.json({ error: "delete child scopes first before deleting this one" }, { status: 409 });
  }

  let residue;
  try {
    residue = await findScopeResidue(rc.org.id, scope.path);
  } catch (err) {
    if (!(err instanceof MemoryServiceError)) throw err;
    return NextResponse.json(
      { error: "could not confirm the scope holds no facts (memory service unavailable), try again" },
      { status: 503 },
    );
  }
  if (Object.keys(residue).length > 0) {
    return NextResponse.json(
      {
        error: `this scope still holds ${describeScopeResidue(residue)}; remove or move them before deleting it`,
        remaining: residue,
      },
      { status: 409 },
    );
  }

  await deleteScopeClearingFeed(scope);
  return new NextResponse(null, { status: 204 });
}
