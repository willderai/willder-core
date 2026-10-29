// Server-side entity-scope resolution: never trust a caller-supplied scope for
// an operation on an existing, named entity.
//
// The one rule this file enforces: the scope a merge is checked against is the
// scope the entity actually lives in, derived server-side from the org id
// alone, so the checked scope and the scope written to are always the same
// value. An entity has no Postgres row of its own; its only "location" is which
// Graphiti partition (groupId) contains a node with its name. (The same pattern
// app/api/briefs/[id]/correct/route.ts uses for a row: derive the real scopePath
// from the row itself, then check() against that.)
//
// Resolving by "first candidate scope with a hit" would leak scope existence
// through the status code and could silently merge the wrong entity when a name
// collides across scopes. resolveEntityScope collects every matching candidate
// and, only when more than one exists, checks each for real (audited, via
// check(), never can(); can() is a UI probe, never the gate on an actual
// access) so the caller's own authorization decides the outcome, not scan
// order. The scope-registry lookup does not go through descendantScopePaths'
// fail-soft catch: a registry outage must propagate, not degrade into "entity
// not found".
import { check, orgRootPath, strictDescendantScopePaths, type AccessContext } from "@/services/access";
import { graphitiStore } from "./store";

/**
 * Candidate scopes to probe, in order: the bare, untagged org partition first
 * (several ingest paths write with no scopePath at all — see guarded-store.ts's
 * own "bare-org id" comments — so this is genuinely the most common location for
 * older/seeded entities), then the org's real root scope, then every other real,
 * registered scope under it. All of them, with no bound: they are asked in one graph
 * query, and a scope left out would turn a real entity into "not found". Every
 * candidate is derived from the org id alone — nothing here ever comes from the
 * request body.
 *
 * Uses strictDescendantScopePaths() rather than descendantScopePaths(): the
 * latter is deliberately fail-soft (an empty array on any DB error), the right
 * posture for its actual read call sites, where a degraded-but-available
 * result beats a hard failure. This resolves the target of a MUTATION —
 * degrading a registry outage into an empty candidate list turns a transient
 * failure into a false "entity not found". A real failure here propagates, so
 * route.ts's catch surfaces it instead of masking it.
 */
async function candidateScopes(orgId: string): Promise<string[]> {
  const root = orgRootPath(orgId);
  const descendants = await strictDescendantScopePaths(orgId, root);
  return [orgId, root, ...descendants];
}

/** Outcome of {@link resolveEntityScope}: the one scope to act in, or why there is none. */
export type EntityScopeResolution =
  | { status: "not-found" }
  | { status: "refused" }
  | { status: "ambiguous" }
  | { status: "resolved"; scope: string };

/**
 * Which real scope should a merge on entity `name` act against? Probes every
 * candidate scope for the org (never anything from the request) for a match.
 *
 * - No candidate matches: "not-found". Nothing was decided; the caller decides
 *   it at the org root so it costs what a refused name costs.
 * - Exactly one candidate matches: "resolved" with that scope, the ordinary
 *   case, with no extra authorization probing (the actual memory.write check
 *   happens once, inside guardedMemory.transferEntity).
 * - More than one candidate matches (a duplicate name across scopes):
 *   resolution order alone must never pick a winner, or the wrong entity is
 *   silently rewritten. Each match is checked for real (check(), audited)
 *   against the caller's actual authorization: zero authorized hits is
 *   "refused", each hit already decided, which the caller answers exactly as
 *   "not-found" (the status code must not leak which scopes exist, as in the
 *   single-candidate case); exactly one authorized hit resolves to it;
 *   more than one is genuinely ambiguous. This route accepts no
 *   caller-supplied scope to disambiguate with, so the only safe answer is to
 *   refuse rather than guess.
 */
export async function resolveEntityScope(
  ctx: AccessContext,
  orgId: string,
  name: string,
): Promise<EntityScopeResolution> {
  const hits = await graphitiStore.groupsHoldingEntity({ name, groupIds: await candidateScopes(orgId) });
  if (hits.length === 0) return { status: "not-found" };
  if (hits.length === 1) return { status: "resolved", scope: hits[0] };

  const authorized: string[] = [];
  for (const hit of hits) {
    const checkScope = hit === orgId ? orgRootPath(orgId) : hit;
    const decision = await check(ctx, {
      action: "memory.write",
      scope: checkScope,
      target: `merge:${name}`,
    });
    if (decision.allowed) authorized.push(hit);
  }
  if (authorized.length === 0) return { status: "refused" };
  if (authorized.length > 1) return { status: "ambiguous" };
  return { status: "resolved", scope: authorized[0] };
}
