// Audit rows for refusals decided outside check().
//
// The one rule this file enforces: a request refused for authorization reasons leaves
// exactly one deny row, naming the principal, the person it acts for, the scope it
// resolved to and the decision, even when the gate that refused it is not check().
// check() records every decision it makes. Some refusals happen before it can be
// asked: an operation reserved for org owners and admins, a partition outside the
// caller's tenant, a malformed scope on a write. Without these rows the trail shows
// only the requests that were let through or that reached the grant lookup.
//
// What the caller is told does not change: each gate keeps its own response. The row
// carries the operator's half of the reason (services/access/deny-reason.ts). The
// org-role gate built on this is lib/org-role.ts.
import { writeAuditRow } from "./audit-row";
import type { AccessAction, AccessContext, DerivedAuditAction } from "./check";
import { delegatingPerson } from "./delegation";

/** A refusal to record: what was asked for, where, and why it was refused. */
export interface Refusal {
  action: AccessAction | DerivedAuditAction;
  /** The resolved target, already prefixed with its scope path. */
  target: string;
  /** The operator's half of the reason, written to `audit_log.reason`. */
  auditReason: string;
}

/**
 * Write the one deny row for a refusal made outside check(). For an agent, the row
 * names the person who provisioned its token as `metadata.triggeredBy`, the key
 * check()'s own rows use.
 */
export async function recordRefusal(ctx: AccessContext, refusal: Refusal): Promise<void> {
  const triggeredBy = await delegatingPerson(ctx);
  await writeAuditRow({
    orgId: ctx.orgId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    action: refusal.action,
    target: refusal.target,
    decision: "deny",
    reason: refusal.auditReason,
    metadata: triggeredBy ? { triggeredBy } : {},
    runId: ctx.runId,
    origin: ctx.origin,
  });
}
