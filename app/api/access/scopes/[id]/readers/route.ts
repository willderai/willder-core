import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { authorizeRecord } from "@/services/access";
import { scopeReaders, scopeTokenReaders } from "@/services/access/source-widening";

// GET /api/access/scopes/:id/readers — who can read this scope, in one call.
//
// Lists every person and every live capability token that can read the scope,
// decided by the same rules check() applies: a person by a live grant to them,
// their role or everyone on the scope or an ancestor; a token by being live,
// covering the scope, its agent active, and, for a grant-governed agent, still
// backed by a covering grant. Tokens are named by capability id, agent,
// permission and expiry, never by the token or its hash.
//
// Requires access.manage on the scope. A scope the caller cannot administer,
// or one in another org, answers as not found or refused exactly like
// DELETE on the same path (services/access/authorize-record.ts).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await authorizeRecord(
    rc.ctx,
    () => db.scope.findFirst({ where: { id, orgId: rc.org.id }, select: { id: true, path: true, orgId: true } }),
    { action: "access.manage", scopeOf: (s) => s.path, target: (s) => `scopes:readers:${s.path}` },
  );
  if (access.status === "absent") return NextResponse.json({ error: "scope not found" }, { status: 404 });
  if (access.status === "denied") return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  const scope = access.record;

  const [people, tokens] = await Promise.all([
    scopeReaders(rc.org.id, scope.path),
    scopeTokenReaders(rc.org.id, scope.path),
  ]);
  return NextResponse.json({
    scope: { id: scope.id, path: scope.path },
    people: people
      .map(({ id, name, email, role }) => ({ id, name, email, role }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    tokens,
  });
}
