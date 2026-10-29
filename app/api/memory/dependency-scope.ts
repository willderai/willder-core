// The scope a dependency-graph route reads at (GET .../edges, .../what-to-change,
// /api/memory/scopes/stale): `?scope=`, or the org root when it is absent. A malformed
// value is refused with an audited 403 before any read, never widened to the root; the
// read itself is decided by check() inside services/memory/dependencies.ts.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError, orgRootPath, resolveCallerScopePath, type AccessContext } from "@/services/access";

/**
 * Run `read` at the caller's requested scope and answer with its JSON, or with the
 * response it returns itself. 401 when signed out, 403 with the reason when the scope is
 * malformed or the read is refused; any other error is thrown to the framework.
 */
export async function readAtScope(
  req: Request,
  read: (ctx: AccessContext, scopePath: string) => Promise<object | Response>,
): Promise<Response> {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const scopePath = await resolveCallerScopePath(
      rc.ctx,
      new URL(req.url).searchParams.get("scope") ?? undefined,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.read", field: "scope" },
    );
    const result = await read(rc.ctx, scopePath);
    return result instanceof Response ? result : NextResponse.json({ scope: scopePath, ...result });
  } catch (e) {
    if (e instanceof AccessDeniedError) return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    throw e;
  }
}
