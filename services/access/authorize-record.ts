// Load one record and decide an action on the scope it is stored at, as one step.
//
// The one rule this file enforces: a caller who cannot read a record's scope cannot
// learn the record exists. An id that was never issued, a record in another org and
// a record at a scope the caller holds no read on all come back as `absent`, so a
// route has one answer for the three and cannot tell them apart even by mistake.
// Only a caller who can already read the scope gets `denied`, with a reason: telling
// them "no" says nothing they could not already see.
//
// The refusal is still recorded. check() writes its one deny row for a record that
// exists, whether the caller is then told `absent` or `denied`. An id that matches
// nothing is decided too, at the org root, so it costs the same grant evaluation,
// audit write and read probe as a hidden record: without that, the absent 404 came
// back after one lookup and could be timed to find real ids
// (app/api/existence-timing.realdb.test.ts). Its row records the probe.
//
// Use it when the decision depends on the record (its scope is the one to ask
// about). When it does not, decide first and look up afterwards. The lookup gate
// (eslint.lookup-gate.mjs) holds every API route to one of the two.
import { can, check, isValidLtreePath, orgRootPath } from "./check";
import type { AccessAction, AccessContext, AccessDecision } from "./check";

/**
 * The outcome of {@link authorizeRecord}.
 *
 * - `absent`: no such record, or one the caller may not read. Answer it as not found.
 * - `denied`: the caller can read the record but may not take `action` on it.
 *   `decision.reason` is client-safe and may be returned.
 * - `allowed`: the record, and the decision that allowed it.
 */
export type RecordAccess<T> =
  | { status: "absent" }
  | { status: "denied"; record: T; decision: AccessDecision }
  | { status: "allowed"; record: T; decision: AccessDecision };

/** What to decide on a loaded record. */
export interface RecordRequest<T> {
  action: AccessAction;
  /** The scope path the record is stored at, read from the record itself. */
  scopeOf: (record: T) => string;
  /** The audit target suffix, as check() takes it, or built from the record. An id
   * that matches nothing is recorded with the string form only, since there is no
   * record to build one from. */
  target?: string | ((record: T) => string);
}

/** The two access questions {@link authorizeRecord} asks: check() and can(). */
export interface RecordDeciders {
  check: typeof check;
  can: typeof can;
}

/**
 * Build {@link authorizeRecord} over the given deciders. The product uses the one
 * built over the real check() and can(); a test that stubs those two builds its own,
 * so it runs this file's logic rather than a copy of it.
 */
export function recordAuthorizer(deciders: RecordDeciders) {
  return async function authorizeRecord<T>(
    ctx: AccessContext,
    load: () => Promise<T | null>,
    request: RecordRequest<T>,
  ): Promise<RecordAccess<T>> {
    const record = await load();

    // An absent id is decided at the org root and probed for read like a hidden
    // record, then answered absent whatever the outcome: the work must not depend on
    // whether the record exists, and only the outcome for a real record matters.
    const stored = record ? request.scopeOf(record) : undefined;
    const scope = stored !== undefined && isValidLtreePath(stored) ? stored : orgRootPath(ctx.orgId);
    const target =
      typeof request.target === "function" ? (record ? request.target(record) : undefined) : request.target;
    const decision = await deciders.check(ctx, { action: request.action, scope, target });
    if (decision.allowed) return record ? { status: "allowed", record, decision } : { status: "absent" };

    // can(), not check(): the decision being answered is already on the audit trail,
    // and whether the caller may see the record is not a decision of its own.
    const readable =
      request.action !== "memory.read" && (await deciders.can(ctx, { action: "memory.read", scope })).allowed;
    return record && readable ? { status: "denied", record, decision } : { status: "absent" };
  };
}

/**
 * Load a record with `load` (which must already filter by the caller's org) and
 * decide `request.action` on the record's own scope.
 *
 * A stored scope that is not a valid path is decided at the org root instead of
 * reaching check()'s ltree cast: an org-root principal still passes, anyone
 * narrower is refused.
 */
export const authorizeRecord = recordAuthorizer({ check, can });
