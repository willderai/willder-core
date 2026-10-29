// GET/DELETE /api/memory/entities/[id]: read or remove one entity; both go through guardedMemory's
// check() gate on the ?scope= partition the entity lives in.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import {
  AccessDeniedError,
  normalizeScopePath,
  orgRootPath,
  resolveCallerScopePath,
  type AccessAction,
  type AccessContext,
} from "@/services/access";

/** DELETE /api/memory/entities/:id — remove one entity from the scope's partition; gated inside removeEntity(). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  // Entities in a sub-scope live under that scope's Graphiti group_id, not the bare
  // org id. Honor ?scope= so the lookup hits the right partition (gated on that scope).
  try {
    const scope = await requestedScope(rc.ctx, req, "memory.delete");
    const result = await guardedMemory.removeEntity(rc.ctx, { groupId: rc.org.id, entityId: id }, scope);
    if (!result.removed) return NextResponse.json({ error: "entity not found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof AccessDeniedError) return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    if (e instanceof MemoryServiceError) return NextResponse.json({ error: e.message }, { status: 502 });
    throw e;
  }
}

// GET /api/memory/entities/:id — "what we know about X": the entity + its facts,
// scoped to the caller's org and access-checked through the check() gate (default
// deny, audited). 404 if the entity doesn't exist in this tenant; 403 if denied.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Honor ?scope= — a sub-scope entity is stored under that scope's group_id, not the
  // bare org id. Without this the lookup hits the wrong partition and 404s.
  try {
    const scope = await requestedScope(rc.ctx, req, "memory.entity");
    const entity = await guardedMemory.entity(rc.ctx, { groupId: rc.org.id, entityId: id }, scope);
    if (!entity) {
      return NextResponse.json({ error: "entity not found" }, { status: 404 });
    }
    return NextResponse.json(entity);
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    if (e instanceof MemoryServiceError) {
      // 503 means "ask again" (an overloaded service, or a lookup that could not list
      // the scopes below the caller's); anything else is a bad gateway.
      return NextResponse.json({ error: e.message }, { status: e.status === 503 ? 503 : 502 });
    }
    throw e;
  }
}

/**
 * The `?scope=` a request names, or undefined when it names none. A malformed one is
 * refused by name, with one deny row for `action`, rather than reaching check()'s
 * `::ltree` cast raw (AccessDeniedError). No scope stays no scope, so the resolver's
 * fallback is never used.
 */
async function requestedScope(ctx: AccessContext, req: Request, action: AccessAction): Promise<string | undefined> {
  const scope = normalizeScopePath(new URL(req.url).searchParams.get("scope") ?? undefined);
  if (!scope) return undefined;
  return resolveCallerScopePath(
    ctx,
    scope,
    { scopePath: orgRootPath(ctx.orgId) },
    { onInvalid: "refuse", action, field: "scope" },
  );
}
