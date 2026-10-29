// POST /api/memory/entities/merge: fold one entity into another; the write is checked and applied at
// the source entity's own server-resolved scope, never one the request chose.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { AccessDeniedError, check, orgRootPath } from "@/services/access";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import { recordMergeAlias, unstorableMergeAlias } from "@/services/memory/entity-aliases";
import { resolveEntityScope } from "@/services/memory/entity-scope";

/** The one answer for a name that exists nowhere and a name the caller may not merge. */
function entityNotFound(): NextResponse {
  return NextResponse.json({ error: "entity not found" }, { status: 404 });
}

/**
 * Transfer all edges from one entity to another, then delete the source entity.
 * Admin-only (memory.write gate). Body: { fromName, toName }.
 *
 * No caller-supplied `scope`. The checked scope and the written scope must always be
 * the same value, and neither may be something the request body chose: otherwise a
 * caller with memory.write at ANY scope could get real writes applied somewhere
 * check() never authorized, and the transferred count would be an existence oracle
 * for org-wide content. resolveEntityScope finds fromName's real, current scope
 * server-side (services/memory/entity-scope.ts), guardedMemory.transferEntity()
 * check()s memory.write against THAT scope, and the transfer runs at that same scope
 * (the same way app/api/briefs/[id]/correct/route.ts derives a brief's scopePath from
 * the brief row itself).
 *
 * Four further rules:
 * - Every input is validated before anything is read or written: a body field of the
 *   wrong JSON type, and a name the alias registry could not store (a NUL, half of a
 *   surrogate pair, a fromName over the entity id's byte cap), answer 400 naming the
 *   field. The answer depends on the request text alone, the same for every caller,
 *   so it says nothing about the org, and a merge it refuses transfers nothing.
 * - A name that exists outside the caller's authorized scope looks identical to a
 *   name that does not exist anywhere: a "not-found" resolution and a denied
 *   transferEntity both return the same 404. A name that resolves nowhere is
 *   still decided, at the org root, so it costs the same check() and leaves the
 *   same one audit row as a hidden name (services/access/authorize-record.ts
 *   states the rule for records looked up by id).
 * - A duplicate name that resolves to more than one scope the caller can write to
 *   is refused ("ambiguous", 409) rather than resolved by scan order; this route has
 *   no caller-supplied scope to disambiguate with.
 * - Resolution runs inside the same try block as the transfer, so a memory-service
 *   outage during lookup reaches the 502 mapping; and resolveEntityScope never
 *   degrades a DB failure into an empty candidate list (see entity-scope.ts), so an
 *   outage surfaces as a failure instead of a misleading 404.
 */
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { fromName?: string; toName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["fromName", "toName"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const fromName = body.fromName?.trim();
  const toName = body.toName?.trim();
  if (!fromName || !toName) {
    return NextResponse.json({ error: "fromName and toName are required" }, { status: 400 });
  }
  if (fromName === toName) {
    return NextResponse.json({ error: "fromName and toName must differ" }, { status: 400 });
  }
  const unstorable = unstorableMergeAlias(fromName, toName);
  if (unstorable) return NextResponse.json({ error: unstorable.message }, { status: 400 });

  try {
    const resolution = await resolveEntityScope(rc.ctx, rc.org.id, fromName);
    if (resolution.status === "not-found") {
      // The same action and target guardedMemory.transferEntity() decides for a hidden name.
      await check(rc.ctx, {
        action: "memory.write",
        scope: orgRootPath(rc.org.id),
        target: `merge:${fromName}→${toName}`,
      });
      return entityNotFound();
    }
    if (resolution.status === "refused") return entityNotFound();
    if (resolution.status === "ambiguous") {
      return NextResponse.json({ error: "entity name is ambiguous across multiple scopes" }, { status: 409 });
    }

    const result = await guardedMemory.transferEntity(
      rc.ctx,
      { groupId: rc.org.id, oldName: fromName, newName: toName },
      resolution.scope,
    );
    // Register fromName as an alias for toName so future writes resolve correctly.
    // This write is scoped to the org's alias registry, not the entity graph.
    await recordMergeAlias(rc.org.id, fromName, toName, rc.user.id);
    return NextResponse.json({ transferred: result.transferred, fromName, toName });
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      // Collapse with "not found": an entity that exists but sits
      // outside the caller's authorized scope must be indistinguishable from
      // one that doesn't exist anywhere. Returning e.decision.reason or a 403
      // here would answer "does this name exist somewhere in the org?" for
      // any caller holding write on any single scope.
      return entityNotFound();
    }
    if (e instanceof MemoryServiceError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    throw e;
  }
}
