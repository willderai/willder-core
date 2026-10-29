// Every sentence an access decision is explained in, in one place, written for
// the two audiences that see it.
//
// A refused caller may learn that access was denied, which permission was
// missing, and how to obtain it. It must NOT learn the scope path the server
// resolved the request to. A scope path is built from ltree labels, and a label
// is an entity name, so naming the resolved path tells a caller who was just
// refused that a given subject exists inside their org — a label-existence leak
// in the one product whose central claim is access control.
//
// Echoing back a scope the CALLER supplied discloses nothing, because they
// already knew it; invalidCallerScopePath below is the one message that quotes a
// caller-supplied value, and it quotes only that. Everything else names the
// permission and the fix instead of the target.
//
// The operator is entitled to the whole story. Every builder returns both
// halves: `reason`, which is what AccessDeniedError carries and what a route or
// MCP tool hands back, and `auditReason`, the same decision with the resolved
// path (and, for a misused token, its real owner) spelled out. recordAudit in
// check.ts writes `auditReason`, so the audit trail is undiminished.
//
// The invariant: no builder may put a server-resolved scope path, entity name,
// or another principal's identity into `reason`. deny-reason.test.ts drives every
// builder and fails if one does.

import { jsonTypeName } from "@/lib/json-type-name";
import { unstorableText } from "@/lib/unstorable-text";
import type { Permission } from "./check";
import type { Widening, WideningAcknowledgement } from "./source-widening";

/**
 * The two halves of a decision's explanation: `reason` for whoever made the
 * request, `auditReason` for the operator reading the audit trail.
 */
export interface DecisionReasons {
  /** Client-safe. Never names a server-resolved scope or another principal. */
  reason: string;
  /** Operator-only. Names the resolved target scope, and the token's real owner
   * when it differs from the claimed actor. Written to `audit_log.reason`. */
  auditReason: string;
}

/** Both halves of a message that is safe to show either audience as-is. */
function same(text: string): DecisionReasons {
  return { reason: text, auditReason: text };
}

/** A live grant to this human covers the action at the target scope. */
export function humanGrantAllows(needed: Permission, targetPath: string): DecisionReasons {
  return {
    reason: `human grant covers ${needed} on the target scope`,
    auditReason: `human grant covers ${needed} on ${targetPath}`,
  };
}

/**
 * No grant reaches this human, as a live member of the org, through a grant to
 * them, their role in the org, or everyone. A person who is not a member is
 * told the same: whether someone belongs to an org is not the caller's to learn
 * from a refusal.
 */
export function noHumanGrant(needed: Permission, userId: string, targetPath: string): DecisionReasons {
  return {
    reason:
      `no ${needed} grant for user ${userId} as a member of this org on the target scope — ` +
      `ask an org admin for a ${needed} grant covering the scope you need`,
    auditReason: `no ${needed} grant for user ${userId} as a member of this org on ${targetPath}`,
  };
}

/** The agent's live capability token covers the action at the target scope. */
export function capabilityAllows(needed: Permission, targetPath: string): DecisionReasons {
  return {
    reason: `capability covers ${needed} on the target scope`,
    auditReason: `capability covers ${needed} on ${targetPath}`,
  };
}

/**
 * The presented token belongs to a different agent than the context claims.
 * Naming the real owner to the caller would disclose the identity the deny was
 * protecting, so only the audit half carries it.
 */
export function capabilityOwnerMismatch(tokenAgentId: string, claimedActorId: string): DecisionReasons {
  return {
    reason: "capability agentId mismatch: token does not match the claimed actor identity",
    auditReason: `capability agentId mismatch: token was issued to agent ${tokenAgentId}, but context claims actor ${claimedActorId}`,
  };
}

/** No live capability row for this token covers the action at the target scope. */
export function noCapability(needed: Permission, agentId: string, targetPath: string): DecisionReasons {
  return {
    reason:
      `no valid capability for agent ${agentId} granting ${needed} on the target scope — ` +
      `ask an org admin to issue this agent a capability granting ${needed} on the scope you need`,
    auditReason: `no valid capability for agent ${agentId} granting ${needed} on ${targetPath}`,
  };
}

/** The capability outlived the grant behind it: grant-governed, no live grant. */
export function capabilityOutlivedGrant(needed: Permission, agentId: string, targetPath: string): DecisionReasons {
  return {
    reason:
      `capability for agent ${agentId} is stale: no current grant covers ${needed} on the target scope ` +
      `(demoted or removed since the token was minted) — ask an org admin to restore the ${needed} grant and re-issue the token`,
    auditReason:
      `capability for agent ${agentId} is stale: no current grant covers ${needed} on ${targetPath} ` +
      `(demoted or removed since the token was minted)`,
  };
}

/**
 * The token is this agent's own and covers the action, but the agent has been
 * deactivated. The agent id is the caller's own identity, so naming it discloses
 * nothing; the fix is to turn the agent back on, which restores the same token.
 */
export function agentDeactivated(needed: Permission, agentId: string, targetPath: string): DecisionReasons {
  return {
    reason:
      `agent ${agentId} is deactivated, so its capability is refused for ${needed} — ` +
      `ask an org admin to reactivate the agent, which restores its unrevoked tokens`,
    auditReason: `agent ${agentId} is deactivated; its capability is refused for ${needed} on ${targetPath}`,
  };
}

/**
 * The org has an open deletion (services/memory/org-deletion): its agent tokens are refused
 * outright and people may only read until an owner cancels it. Neither half needs the
 * target to explain this, and only the operator's names it.
 */
export function orgBeingDeleted(needed: Permission, actorType: "human" | "agent", targetPath: string): DecisionReasons {
  const reason =
    actorType === "agent"
      ? "this organization is scheduled for deletion, so agent tokens are refused — an owner can cancel the deletion, which restores them"
      : `this organization is scheduled for deletion, so ${needed} is refused — an owner can cancel the deletion to write again`;
  return { reason, auditReason: `org deletion pending; ${actorType} ${needed} refused on ${targetPath}` };
}

/**
 * A restore of the org's database is not complete: the erasures made since its backup are not
 * re-applied yet (services/access/check.ts, reapplyDueSql). The restore-completion job runs it
 * within ten minutes; an operator can run it at once. Nothing here is specific to the caller.
 */
export function restoreIncomplete(needed: Permission, targetPath: string): DecisionReasons {
  return {
    reason:
      `this organization's memory was restored from a backup and its erasures are still being re-applied, so ${needed} is refused — ` +
      "retry in ten minutes, or have an operator run scripts/complete-restore.ts against the database",
    auditReason: `restore incomplete: erasures not re-applied; ${needed} refused on ${targetPath}`,
  };
}

/** The request carried no actor id to attribute the decision to. */
export function missingActorIdentity(needed: Permission, targetPath: string): DecisionReasons {
  return {
    reason: `actor identity required: missing actor.id for ${needed} — send the request as a named actor`,
    auditReason: `actor identity required: missing actor.id for ${needed} on ${targetPath}`,
  };
}

/**
 * A caller-supplied scope path that is not a valid ltree path, named by the `field` the
 * caller sent it in. Quoting it back discloses nothing — the caller wrote it — and
 * quoting it is what makes the message actionable, so both halves are the same. A NUL
 * cannot be seen in a quote, so a path holding one is refused by naming the NUL and the
 * fix instead. A value sent as another JSON type is refused by naming its type. `dashed`
 * is a valid path refused only for a dash (isMintableScopePath), which the message names.
 */
export function invalidCallerScopePath(callerScopePath: unknown, field = "scopePath", dashed = false): DecisionReasons {
  if (typeof callerScopePath !== "string") {
    return same(`${field} must be a string scope path, not ${jsonTypeName(callerScopePath)}`);
  }
  if (unstorableText({ [field]: callerScopePath })) return same(nulNotAccepted(field));
  if (dashed)
    return same(`${field} "${callerScopePath}" holds a dash; scope labels are letters, digits and underscores`);
  return same(`${field} "${callerScopePath}" is not a valid scope path`);
}

/**
 * A request whose target (a query, or an id the caller sent) holds a NUL, which the audit
 * row recording the decision cannot store. Names the NUL and the fix and quotes nothing,
 * since a NUL cannot be seen in a quote. When the grants already refused the request,
 * `denied` is that refusal: it stays first, so the reason it gives is not lost.
 */
export function unstorableTarget(denied?: DecisionReasons): DecisionReasons {
  const nul = nulNotAccepted("the request");
  if (!denied) return same(nul);
  return { reason: `${denied.reason}; ${nul}`, auditReason: `${denied.auditReason}; ${nul}` };
}

/** The refusal of a NUL in `field`. Said as "not accepted", since it refuses reads as well as writes. */
function nulNotAccepted(field: string): string {
  return `${field} contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.`;
}

/**
 * A partition in neither of the org's two legitimate namespaces. Both values are
 * the caller's own: the partition they asked for and the org they are in.
 */
export function partitionOutsideTenant(groupId: string, orgId: string): DecisionReasons {
  return same(`tenant mismatch: partition "${groupId}" is neither a group_id nor a scope path of org "${orgId}"`);
}

/** A bare `group_id` outside the context org. Both values are the caller's own. */
export function groupIdOutsideTenant(orgId: string, groupId: string): DecisionReasons {
  return same(`tenant mismatch: context org ${orgId} != group_id ${groupId}`);
}

/** Why a token was refused at the door, before any action was known. */
export type CapabilityRefusal = "revoked" | "expired" | "agent-deactivated";

const REFUSAL_SUBJECT: Record<CapabilityRefusal, string> = {
  revoked: "capability revoked",
  expired: "capability expired",
  "agent-deactivated": "agent deactivated",
};

/** A revoked or expired token, or one whose agent is deactivated, refused before any action was known. */
export function capabilityRefused(refusal: CapabilityRefusal): DecisionReasons {
  return same(`${REFUSAL_SUBJECT[refusal]}: token refused before any action ran`);
}

/**
 * An org-wide operation reserved for some org roles, asked for by someone holding
 * another. The org root is the only scope such an operation has, and only the
 * operator's half names it.
 */
export function orgRoleRequired(role: string, roles: readonly string[], orgRoot: string): DecisionReasons {
  const needed = roles.join(" or ");
  return {
    reason: `requires the ${needed} role in this organization`,
    auditReason: `role ${role} on ${orgRoot}; this operation requires ${needed}`,
  };
}

/**
 * An operation the deployment reserves for its own operator organization, asked
 * for from any other org. Nothing about the operator org is in either half.
 */
export function operatorOrgRequired(orgRoot: string): DecisionReasons {
  return {
    reason: "only the operator organization may do this",
    auditReason: `${orgRoot} is not the operator organization`,
  };
}

function people(n: number): string {
  return n === 1 ? "1 more person" : `${n} more people`;
}

function agents(n: number): string {
  return n === 1 ? "1 agent" : `${n} agents`;
}

/** "9 more people and 3 agents", leaving out a count of zero unless both are. */
function whoGains(peopleCount: number, agentCount: number): string {
  if (agentCount === 0) return people(peopleCount);
  if (peopleCount === 0) return agents(agentCount);
  return `${people(peopleCount)} and ${agents(agentCount)}`;
}

/** The sentence the person connecting reads, before and after confirming. */
function wideningSentence(widening: Widening): string {
  if (widening.status === "known") {
    return `This lets ${whoGains(widening.people, widening.agents)} read this source's content through Willder.`;
  }
  const lead = `Willder cannot tell who can read this source at the source (${widening.reason}), so connecting it may let `;
  if (widening.atMost === 0) {
    // No bound is known, not "none": say the number is unknown rather than "up to 0".
    const who =
      widening.agents > 0
        ? `an unknown number of people and ${agents(widening.agents)}`
        : "an unknown number of people";
    return `${lead}${who} read its content through Willder.`;
  }
  const agentClause = widening.agents > 0 ? `, and lets ${agents(widening.agents)}` : "";
  return `${lead}up to ${people(widening.atMost)}${agentClause} read its content through Willder.`;
}

/**
 * A connect refused because it widens who reads the source and the caller did
 * not acknowledge that. Only the person connecting sees this, and they already
 * hold write on the scope, so the caller's half carries the count and how to
 * confirm; it never names a reader, an email, or the resolved scope.
 */
export function wideningNotAcknowledged(
  widening: Widening,
  acknowledge: WideningAcknowledgement,
  targetPath: string,
): DecisionReasons {
  const how = `To connect anyway, send the same request with acknowledgeWidening: ${JSON.stringify(acknowledge)}.`;
  return {
    reason: `${wideningSentence(widening)} ${how}`,
    auditReason: `${wideningSentence(widening)} Not acknowledged; nothing was connected to ${targetPath}.`,
  };
}

/** A connect whose widening the person connecting acknowledged. */
export function wideningAcknowledged(widening: Widening, targetPath: string): DecisionReasons {
  return {
    reason: `${wideningSentence(widening)} Acknowledged.`,
    auditReason: `${wideningSentence(widening)} Acknowledged by the person connecting it to ${targetPath}.`,
  };
}

/**
 * The person who issued the token cannot do this on the target any more. Names
 * neither the target nor the issuer to the caller: the issuer is another
 * principal, and the target is server-resolved.
 */
export function issuerLacksAccess(needed: Permission, agentId: string, targetPath: string): DecisionReasons {
  return {
    reason:
      `capability for agent ${agentId} is wider than its issuer: the person who issued it cannot ${needed} the target scope any more — ` +
      `ask an org admin, or someone who holds ${needed} on the scope you need, to issue a new token`,
    auditReason: `capability for agent ${agentId} is wider than its issuer: the issuing person no longer holds ${needed} on ${targetPath}`,
  };
}
