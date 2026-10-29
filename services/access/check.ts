// check() — the single access-control chokepoint. Every memory
// read (and write) passes through here before any fact is returned. It is
// DEFAULT DENY: access is granted only when an explicit grant (for a human) or a
// valid capability token (for an agent that is still active) covers a scope that
// is an ancestor-or-self of the target scope, with a permission that covers the
// action. Every decision — allow or deny — is written to the append-only audit_log.
//
// Scopes form an ltree tree (scopes.path). "Covers" = the granted scope is an
// ancestor-or-self of the target: `granted_path @> target_path`. A grant on the
// org root therefore covers everything under it; a grant on a single deal covers
// only that deal. The full multi-level tree is the enterprise depth; the MVP
// seeds an org-root scope and grants admins there (see lib/tenant.ts).

import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { Prisma } from "@/lib/generated/prisma/client";
import type { UserRole } from "@/types";
import { hashCapabilityToken } from "./capabilities";
import * as reasons from "./deny-reason";
import type { CapabilityRefusal } from "./deny-reason";
import { escapeLikePrefix, flattenSql, scopeContainsSql } from "./scope-containment";
import { GROUP_ID_TARGET_PREFIX } from "@/services/audit/audit-target";
import { unstorableText, withNulEscaped } from "@/lib/unstorable-text";
import { strictDescendantScopePaths } from "./scope-registry";
import { writeAuditRow } from "./audit-row";
import type { AuditOrigin } from "./origin";
import { orgRootPath } from "./org-root";
import { orgDeletionOpen } from "./org-deletion-gate";
import { memberGrantsSql, type MemberGrant } from "./member-grants";

export type Permission = "read" | "write" | "admin";

export type AccessAction = "memory.read" | "memory.entity" | "memory.write" | "memory.delete" | "access.manage";

/**
 * Actions written into `audit_log.action` by the additive recorders at the
 * bottom of this file, after an authorized operation has actually happened,
 * plus `capability.refused`: the deny {@link resolveCapability} records when a
 * revoked or expired token is presented, before any action is known, and
 * `access.refused`: the deny `services/access/refusal.ts` records when a gate
 * other than check() refuses a request, such as an operation reserved for org
 * owners and admins.
 *
 * These are deliberately NOT `AccessAction`s. An `AccessAction` is a question
 * `check()` can be asked -- it has a required permission in {@link REQUIRED}
 * and a caller can pass it to `check()`/`can()`. None of these is: they record
 * what followed a decision, never request one, and there is no permission that
 * would mean anything for them. Keeping the two unions apart is what stops a
 * future caller from gating a real access on `"memory.write.effect"`.
 *
 * They share one home with `AccessAction` in `services/audit/audit-actions.ts`,
 * whose `AUDIT_ACTIONS` map is exhaustive over both, so adding a recorder here
 * forces a decision about whether an audit surface shows its rows.
 */
export type DerivedAuditAction =
  | "memory.read.factIds"
  | "memory.write.applied"
  | "memory.delete.applied"
  | "memory.write.effect"
  | "memory.delete.effect"
  | "brief.acknowledged"
  | "brief.unretired"
  | "capability.refused"
  | "access.refused"
  | "source.widening.acknowledged"
  | "memory.write.declassified"
  | "person.erased"
  | "person.erasure_step"
  | "person.erasure_failed"
  | "oauth.disconnected"
  | "record.removed";

/**
 * How an agent names the capability it acts under: the raw `wcap_` token it holds,
 * or, for an OAuth client, which never holds one, the id of the capability its
 * connection binds (./oauth-connection.ts). An id is not a secret. Only code that
 * has already authenticated the caller, by verifying its OAuth token and finding
 * the live connection that names the id, may build an actor from one.
 */
export type CapabilityCredential = { capabilityToken: string } | { capabilityId: string };

/**
 * The acting principal. Agents carry a capability credential. Humans carry
 * their role for display; check() does not read it, and decides from the
 * person's membership of the org instead (services/access/member-grants.ts).
 */
export type Actor =
  | { type: "human"; id: string; role: UserRole; name?: string }
  | ({ type: "agent"; id: string; name?: string } & CapabilityCredential);

/** The unique key of the capability a credential names. A bare string is a raw token. */
export function capabilityKey(credential: string | CapabilityCredential): { tokenHash: string } | { id: string } {
  if (typeof credential === "string") return { tokenHash: hashCapabilityToken(credential) };
  return "capabilityId" in credential
    ? { id: credential.capabilityId }
    : { tokenHash: hashCapabilityToken(credential.capabilityToken) };
}

export interface AccessContext {
  /** Internal org id (= Neo4j group_id). Tenant boundary. */
  orgId: string;
  actor: Actor;
  /** The entry point this request came in through, set where it was authenticated.
   * Every audit row and change event written for this ctx records it as its source. */
  origin: AuditOrigin;
  /** AgentRun.id, when this read/write happens inside an agent run.
   * Stamped onto every audit_log row check()/recordReadFactIds() write for this
   * ctx, so two overlapping runs of the same agent (same actor.id) are
   * disambiguable by runId instead of by actorId + time-window heuristics alone.
   * Absent for human actors and for agent activity outside a tracked run. */
  runId?: string;
}

export interface AccessRequest {
  action: AccessAction;
  /** Target scope path (ltree). Defaults to the org root scope. */
  scope?: string;
  /** Human-readable target for the audit trail (entity id, query, etc). */
  target?: string;
}

export interface AccessDecision {
  allowed: boolean;
  /**
   * What the caller may be told. Client-safe by construction: it names the
   * missing permission and how to obtain it, never the scope path the server
   * resolved the request to and never another principal's identity. A route or
   * MCP tool can put this straight into a response body — that is the point of
   * splitting it from {@link AccessDecision.auditReason}. See
   * `services/access/deny-reason.ts` for why, and for every wording.
   */
  reason: string;
  /**
   * The same decision told in full, for the operator: the resolved target scope,
   * and the token's real owner when it differs from the claimed actor. This is
   * what `recordAudit` writes to `audit_log.reason`. Never return it to a
   * caller. Absent when there is nothing to add beyond `reason`.
   */
  auditReason?: string;
  /** For agent actors: the internal User.id who provisioned the capability. */
  triggeredBy?: string;
  /** Row id of the audit_log entry check() just wrote for this decision. Lets a
   * caller annotate that same row afterward (e.g. attach the fact ids a
   * memory.read actually returned) without re-implementing audit recording. */
  auditLogId?: string;
  /** For agent actors: the id of the capability token check() matched, when that
   * token was issued to this agent and covers the target. Set on an allow and on
   * a stale-grant deny alike, and recorded on the audit row so either leads back
   * to its token; the newest allowed row is when the token was last used. */
  capabilityId?: string;
  /** For agent actors: true when that matched token carries `admin`, so the audit
   * row marks the decision as taken inside an agent's admin window. */
  agentAdmin?: boolean;
}

/** Thrown by guarded callers when check() denies. Carries the decision, whose
 * `reason` is the client-safe half: a route can map this straight to a 403 body.
 * `message` is that same half, so an error that bubbles into a generic handler
 * cannot leak the resolved target either. */
export class AccessDeniedError extends Error {
  constructor(readonly decision: AccessDecision) {
    super(decision.reason);
    this.name = "AccessDeniedError";
  }
}

export { orgRootPath };

/** A partition a guarded write executed against, in both the forms its two
 * consumers need: the `group_id` the store call ran with, and the audit
 * `target` prefix that names it unambiguously. Built by
 * {@link resolveExecutedPartition}. */
export type ExecutedPartition = {
  /** The exact `group_id` string the store mutation ran against. */
  groupId: string;
  /** The same partition, with its namespace made explicit for an audit target. */
  targetPath: string;
};

/**
 * Resolve the partition a guarded memory read or write runs against, and
 * refuse one outside the caller's tenant. This is the store layer's single
 * tenant-containment predicate for partitions: GuardedMemoryStore calls it on
 * `scope ?? input.groupId` in every method, before touching the backend.
 *
 * A partition is legitimate in exactly two namespaces, the two the store
 * really holds: the bare `orgId` (the untagged Graphiti partition, and the
 * group_id every request carries), and the org's scope tree under
 * `orgRootPath(orgId)`. See services/audit/audit-target.ts for how the audit
 * trail tells them apart.
 *
 * Why this exists beside check(): check() already denies a cross-tenant scope,
 * because its grant query is filtered to the context org and every registered
 * scope descends from that org's own root. That is one layer. A caller who can
 * influence `scope` (`?scope=` on the entity routes, `body.scope` on
 * /api/memory/query) would otherwise pick the partition read or written while
 * only the bare group_id was tenant-checked. This is the independent second
 * layer: pure containment against the context org, no grant, no DB round trip.
 *
 * `orgId` is what tells the namespaces apart. A scope path always carries
 * `org_` in front of the org id, so it can never match the group_id shape
 * tested first below, whatever the org id itself happens to look like. Testing
 * the partition string for a bare `org_` prefix is the tempting alternative
 * and it is wrong: it misreads every group_id belonging to an org whose own id
 * starts with `org_`. Hence the realistic org ids in the tests that cover this.
 *
 * Throws AccessDeniedError (a 403 at the route) for a partition in neither
 * namespace. Writers resolve BEFORE the store mutation so this fails while
 * nothing has been written: an audit row naming the wrong partition is worse
 * than a rejected request, because the row exists to prove where a
 * destructive write landed.
 */
export function resolveExecutedPartition(orgId: string, groupId: string): ExecutedPartition {
  if (groupId === orgId || groupId.startsWith(`${orgId}.`)) {
    return { groupId, targetPath: `${GROUP_ID_TARGET_PREFIX}${groupId}` };
  }
  const root = orgRootPath(orgId);
  if (groupId === root || groupId.startsWith(`${root}.`)) {
    return { groupId, targetPath: groupId };
  }
  throw new AccessDeniedError({ allowed: false, ...reasons.partitionOutsideTenant(groupId, orgId) });
}

/**
 * Pure ltree ancestor-or-self predicate: does `coveringPath` sit at or above
 * `targetPath` in the scope tree? Mirrors, without a DB round trip, the exact
 * containment rule evaluate() enforces via Postgres's `s."path"::ltree @>
 * ${targetPath}::ltree` (this file's own top comment: "the granted scope is
 * an ancestor-or-self of the target") — dot-separated labels, so containment
 * is either exact equality or `targetPath` starting with `coveringPath + "."`.
 * For two already-known, already-server-derived path strings (never
 * caller-supplied — same posture as descendantScopePaths below), this needs
 * no query at all. Callers gate bare-org/untagged-content visibility on it
 * ("is the caller's own checked scope genuinely orgRootPath(orgId) or a real
 * ancestor of it") instead of hand-rolling a prefix comparison that could
 * drift from evaluate()'s rule.
 */
export function pathCovers(coveringPath: string, targetPath: string): boolean {
  return targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`);
}

/** Normalize an optional, request-supplied scope path: empty or whitespace-only
 * collapses to undefined, same as never having been given. Call this at every
 * route boundary that accepts a body-supplied scopePath, before it reaches
 * either check() or a `scopePath ?? orgRootPath(...)` write path — an empty
 * string is falsy for `if (body.scopePath)` (so a bare-string empty scopePath
 * silently skipped check() entirely) but truthy for `??` (so it survived past
 * `scopePath ?? orgRootPath(...)` as a non-ltree value instead of being
 * replaced). Normalizing once here means every downstream `?? orgRootPath`
 * can trust an empty scopePath never reaches it.
 *
 * A JSON body can send any type, and a value that is not a string is not a scope
 * path, so it normalizes to undefined too. A route that must refuse such a value
 * rather than treat it as absent passes the raw value to resolveCallerScopePath,
 * which refuses it by name. */
export const normalizeScopePath = (scopePath: unknown): string | undefined => {
  if (typeof scopePath !== "string") return undefined;
  const trimmed = scopePath.trim();
  return trimmed ? trimmed : undefined;
};

/** True when a request sent no scope: the field is missing, null, or blank. A value
 * of another type was sent, so it is not absent; resolveCallerScopePath refuses it.
 * For a route whose scope is required, or whose absent scope means something other
 * than the resolver's fallback. */
export const scopeIsAbsent = (scopePath: unknown): boolean =>
  scopePath == null || (typeof scopePath === "string" && !scopePath.trim());

/** ltree label = `[A-Za-z0-9_-]+`, dot-separated, each label at most 1000
 * BYTES (Postgres's deployed contract): a hyphen casts fine and participates
 * in `@>` containment (`'org_x'::ltree @> 'org_x.deal-A'::ltree` is true),
 * and a label over 1000 bytes throws 42622 "label string is too long". Also
 * capped at 65535 labels: Postgres's ltree extension is compiled with
 * LTREE_MAX_LEVELS = 65535, so a path with 65536+ labels raises 54000 "number
 * of ltree levels ... exceeds the maximum allowed" on the same `::ltree`
 * cast — a distinct failure from the per-label regex/byte checks, but
 * reaching check() unvalidated is the same defect either way. A non-empty
 * scopePath that fails any of this must be gated before it reaches check():
 * normalizeScopePath only catches the empty/whitespace case, and check()'s
 * `::ltree` cast throws on anything else, before recordAudit() runs. Byte
 * length, not character length, since Postgres's limit is on the stored byte
 * representation, not the JS string's UTF-16 code unit count. Lives here
 * rather than in mcp/tools.ts so resolveCallerScopePath below can use it
 * without a circular import. */
export const isValidLtreePath = (path: string): boolean => {
  const labels = path.split(".");
  return (
    path.length > 0 &&
    labels.length <= 65535 &&
    labels.every((label) => /^[A-Za-z0-9_-]+$/.test(label) && Buffer.byteLength(label) <= 1000)
  );
};

/**
 * True for a valid scope path whose labels below the org root hold no dash: the only
 * paths a caller's write may create. ltree accepts a dash, but `eng-secrets` reads as
 * `eng.secrets` to a person, and no scope this product mints holds one (labels are
 * slugs of [a-z0-9_]), so a dashed path from outside is refused rather than stored. The
 * root label is `org_<org id>`, named by the org, not the caller.
 */
export const isMintableScopePath = (path: string): boolean =>
  isValidLtreePath(path) &&
  !path
    .split(".")
    .slice(1)
    .some((label) => label.includes("-"));

/**
 * Resolve what scope a caller-supplied, optional `scopePath` argument
 * actually targets, given the calling capability's own default scope. This
 * is the one resolution memory_query, memory_entity, memory_ingest, and
 * get_my_brief (mcp/tools.ts) all share, so an unguarded caller-supplied
 * scopePath can never reach check()'s `::ltree` cast raw from any of them.
 *
 * Always: normalizeScopePath() first (empty/whitespace -> undefined, so it
 * can never survive a `??` chain as a non-ltree value), then
 * isValidLtreePath() on whatever is left. A value sent as another JSON type (a
 * number, an array) is invalid, never absent: it was sent, so it is refused or
 * falls back exactly as a malformed string does.
 *
 * - `onInvalid: "fallback"` — the read-side direction (memory_query,
 *   memory_entity, get_my_brief): a normalized-but-invalid input is
 *   discarded the same as an absent one, falling back to `cap.scopePath`.
 *   Safe specifically because a read can never return MORE than the token
 *   already covers, only less.
 * - `onInvalid: "refuse"` — the write-side direction (memory_ingest): a
 *   normalized-but-invalid input is a real error, not silently widened to
 *   `cap.scopePath` (widening would turn a narrowing WRITE request into one
 *   stored at the caller's full, WIDER scope instead of being rejected).
 *   Can't route through check() itself, whose `::ltree`
 *   cast would throw on the malformed value before recordAudit() runs, so
 *   this writes the deny audit row directly, in the same shape
 *   recordAudit() would, then throws AccessDeniedError. The row's target is
 *   the input as sent, with a NUL written as `\u0000`: Postgres cannot store
 *   the character, and a failed audit insert would turn the refusal into a 500.
 */
export async function resolveCallerScopePath(
  ctx: AccessContext,
  scopePath: unknown,
  /** The presented token's capability: its default scope, and the person who
   * provisioned it, named on a refusal's audit row as the delegating person. */
  cap: { scopePath: string; createdBy?: string | null },
  /** `field` names the request field the scope came in, for the refusal message
   * (`scopePath` when omitted). `persists` marks a path the caller stores and memory is
   * later written to (a brief, a fact's new version), held to a write's rule. */
  opts: { onInvalid: "fallback" } | { onInvalid: "refuse"; action: AccessAction; field?: string; persists?: boolean },
): Promise<string> {
  const notAString = scopePath != null && typeof scopePath !== "string";
  const normalized = normalizeScopePath(scopePath);
  // A write may create the partition it names, so it takes only a path a scope could be minted as.
  const writes = opts.onInvalid === "refuse" && (opts.action === "memory.write" || opts.persists === true);
  const valid =
    normalized && (writes ? isMintableScopePath(normalized) : isValidLtreePath(normalized)) ? normalized : undefined;

  if ((notAString || (normalized && !valid)) && opts.onInvalid === "refuse") {
    const dashed = Boolean(normalized && isValidLtreePath(normalized));
    const { reason, auditReason } = reasons.invalidCallerScopePath(normalized ?? scopePath, opts.field, dashed);
    const triggeredBy = cap.createdBy ?? undefined;
    await writeAuditRow({
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action: opts.action,
      target: normalized ? withNulEscaped(normalized) : JSON.stringify(scopePath),
      decision: "deny",
      reason: auditReason,
      metadata: triggeredBy ? { triggeredBy } : {},
      runId: ctx.runId,
      origin: ctx.origin,
    });
    throw new AccessDeniedError({ allowed: false, reason, auditReason });
  }

  return valid ?? cap.scopePath ?? orgRootPath(ctx.orgId);
}

/**
 * Resolve a capability token to its owning org + agent, for callers that hold ONLY
 * the token (e.g. the MCP server, where the external AI presents a token and no
 * session), or a capability by id, for an OAuth client whose connection binds it
 * (see {@link CapabilityCredential} for who may pass one). Either way the same
 * capability row answers, and the same rules apply to it.
 * Also the token's LIFECYCLE gate at session establishment: an unknown,
 * revoked, or expired token, or one whose agent has been deactivated, all resolve
 * to null here, the same shape, so a caller presenting a dead token never gets
 * further than one who typed the wrong token.
 * Without this gate a hosted MCP session for a revoked/expired token would still
 * connect and return the full `tools/list` result, denied only once a real tool
 * ran into check() below (app/api/mcp/route.revoked.test.ts and
 * route.expired.test.ts cover both cases).
 *
 * This does NOT replace check()'s real, per-operation enforcement: scope +
 * permission are per-action (this function is called before any action is even
 * known), so only check() can evaluate them, on every call. And a long-lived
 * stdio session (mcp/server.ts) that gets revoked mid-run is caught only by
 * check() on its next call — this function runs once, at session start, not per
 * call. What THIS gates is the one part of validity that is action-independent
 * (expiry, revocation, the agent being active). check()'s own query keeps the
 * identical `revokedAt IS NULL AND expiresAt > sqlUtcNow` predicate and its own
 * active-agent test below — this is additive, not a substitute. It matters on its
 * own for a tool that reads no memory and so never calls check(), such as
 * send_feedback.
 */
export async function resolveCapability(
  /** A raw capability token, or a credential naming the capability. */
  credential: string | CapabilityCredential,
  /** The entry point the token was presented to, recorded on a refusal. */
  origin: AuditOrigin,
): Promise<{ orgId: string; agentId: string; scopePath: string; createdBy: string | null } | null> {
  const row = await db.capability.findUnique({
    where: capabilityKey(credential),
    select: {
      id: true,
      orgId: true,
      agentId: true,
      scopePath: true,
      createdBy: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!row) return null;
  const refusal: CapabilityRefusal | null = row.revokedAt
    ? "revoked"
    : row.expiresAt <= new Date()
      ? "expired"
      : (await agentIsDeactivated(row.orgId, row.agentId))
        ? "agent-deactivated"
        : null;
  if (refusal) {
    await recordCapabilityRefused(row, refusal, origin);
    return null;
  }
  return { orgId: row.orgId, agentId: row.agentId, scopePath: row.scopePath, createdBy: row.createdBy };
}

/**
 * Has the agent this token was issued to been switched off (`Agent.active =
 * false`)? A capability names its agent by key, or by database id for a token
 * minted before keys were canonical (see agent-identity.ts), so either matches.
 * An agent with no Agent row, such as an external MCP client, has nothing to
 * switch off and is never deactivated; revoking its tokens is how it is stopped.
 *
 * The same rule as `"agentDeactivated"` in loadMatchingCapabilities' query,
 * which answers it per call in the same round trip as the token lookup.
 */
async function agentIsDeactivated(orgId: string, agentId: string): Promise<boolean> {
  const deactivated = await db.agent.count({
    where: { orgId, active: false, OR: [{ agentKey: agentId }, { id: agentId }] },
  });
  return deactivated > 0;
}

/**
 * The audit row for a token refused at the door. Without it
 * the one read an org most needs to see after a revoke, the agent trying again,
 * left no trace: the token never reached check(), which is where every other
 * decision is recorded. The row is attributed to the token's own org and agent
 * and names the capability id, so it walks back to the token the admin revoked.
 * An unknown token has no org to record against, so it is refused unrecorded.
 */
async function recordCapabilityRefused(
  capability: { id: string; orgId: string; agentId: string; scopePath: string; createdBy?: string | null },
  refusal: CapabilityRefusal,
  origin: AuditOrigin,
): Promise<void> {
  const refusedAction: DerivedAuditAction = "capability.refused";
  await writeAuditRow({
    orgId: capability.orgId,
    actorType: "agent",
    actorId: capability.agentId,
    action: refusedAction,
    target: capability.scopePath,
    decision: "deny",
    reason: reasons.capabilityRefused(refusal).auditReason,
    metadata: {
      capabilityId: capability.id,
      ...(capability.createdBy ? { triggeredBy: capability.createdBy } : {}),
    },
    origin,
  });
}

/**
 * What a NEW capability's `grantGoverned`/`derivedFromGrantId` columns are
 * stamped with at mint time. Does `agentId` currently have any grant on file
 * in `orgId` (`granteeType: "agent"`)? If so, this capability is born
 * grant-governed and stays that way for its whole lifetime, however its grants
 * change later (see `grantGoverned`'s schema comment for why this must be a
 * stamped ratchet, not a live re-check every time check() runs). If not — the
 * system-agent case, copy-agent/research-agent/etc., minted with no
 * /access/grants entry at all — this capability is born ungoverned.
 *
 * Call at every `capability.create()` site. Does not itself write anything;
 * spread the result straight into that call's `data`.
 */
export async function deriveGrantGovernance(
  orgId: string,
  agentId: string,
): Promise<{ grantGoverned: boolean; derivedFromGrantId: string | null }> {
  const grant = await db.grant.findFirst({
    where: { orgId, granteeType: "agent", granteeId: agentId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return grant
    ? { grantGoverned: true, derivedFromGrantId: grant.id }
    : { grantGoverned: false, derivedFromGrantId: null };
}

const REQUIRED: Record<AccessAction, Permission> = {
  "memory.read": "read",
  "memory.entity": "read",
  "memory.write": "write",
  "memory.delete": "write", // removing memory needs write+ (read-only members can't)
  "access.manage": "admin",
};

const RANK: Record<Permission, number> = { read: 1, write: 2, admin: 3 };
/** Does a held permission satisfy the one an action needs? (admin ⊇ write ⊇ read) */
const covers = (held: Permission, needed: Permission): boolean => RANK[held] >= RANK[needed];

/**
 * SQL predicate: does at least one OTHER live grant to agent `agentId` still
 * authorize a `capabilities` row this query is evaluating (correlated on
 * that row's own `"orgId"`, `"agentId"`, `"scopePath"` and `"permission"`
 * columns, referenced by the bare table name since callers run this inside
 * an `UPDATE "capabilities" ... WHERE`)? Containment is the same
 * ancestor-or-self "covers" relation `evaluate()` uses above; permission
 * comparison relies on Postgres ordering enum values by their `CREATE TYPE`
 * declaration order (`read`, `write`, `admin`), the same hierarchy `covers()`
 * enforces in code.
 *
 * The grant-revoke cascade (app/api/access/grants/[id]/route.ts) must not
 * revoke a capability by scope containment alone: that would strip a token a
 * different, broader or differently-permissioned live grant still authorizes.
 * `Capability` carries no `grantId` — it is minted off the admin's own
 * `access.manage` authority at issue time, never off a specific `Grant` row —
 * so there is no issuance link to check; the only sound test is whether any
 * OTHER live grant still covers the token. The grant being revoked is expected
 * to already be deleted (in the same transaction) by the time a caller runs
 * this, so it excludes itself with no extra guard needed.
 */
export function anotherLiveAgentGrantCoversSql(): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "grants" g
      JOIN "scopes" s ON s."id" = g."scopeId"
      WHERE g."orgId" = "capabilities"."orgId"
        AND g."granteeType" = 'agent'
        AND g."granteeId" = "capabilities"."agentId"
        AND (g."expiresAt" IS NULL OR g."expiresAt" > ${sqlUtcNow})
        AND s."path"::ltree @> "capabilities"."scopePath"::ltree
        AND g."permission" >= "capabilities"."permission"
    )
  `;
}

/**
 * Decide whether `ctx.actor` may perform `req.action` on `req.scope` (default:
 * the org root). Default deny. Always records one audit_log row. Pure decision +
 * audit; callers enforce by throwing AccessDeniedError (see guarded-store).
 */
export async function check(ctx: AccessContext, req: AccessRequest): Promise<AccessDecision> {
  const needed = REQUIRED[req.action];
  const targetPath = req.scope ?? orgRootPath(ctx.orgId);
  const decision = await evaluate(ctx, needed, targetPath);
  // A target holding a NUL (a query, or an id the caller sent) is refused whatever the
  // grants say. The audit row must record it and Postgres text cannot store the
  // character, so the row writes it as `\u0000`; the refusal is explicit, so escaping
  // it can never let the request through. A request the grants already refused keeps
  // that reason, with the NUL added; the row keeps who the actor acts for.
  if (req.target !== undefined && unstorableText({ target: req.target })) {
    const denied = decision.allowed
      ? undefined
      : { reason: decision.reason, auditReason: decision.auditReason ?? decision.reason };
    const refused: AccessDecision = { ...decision, allowed: false, ...reasons.unstorableTarget(denied) };
    const auditLogId = await recordAudit(ctx, { ...req, target: withNulEscaped(req.target) }, targetPath, refused);
    return { ...refused, auditLogId };
  }
  const auditLogId = await recordAudit(ctx, req, targetPath, decision);
  return { ...decision, auditLogId };
}

/**
 * Same decision as check(), but WITHOUT writing an audit row. For UI capability
 * probing only (e.g. "should I show the Remove button?") — never as the gate on an
 * actual access. The real action must always go through check() so it's audited.
 */
export async function can(ctx: AccessContext, req: AccessRequest): Promise<AccessDecision> {
  const needed = REQUIRED[req.action];
  const targetPath = req.scope ?? orgRootPath(ctx.orgId);
  return evaluate(ctx, needed, targetPath);
}

/**
 * All scope paths a human actor holds a covering grant on (their own user
 * grants, their role's grants, and any `everyone` baseline), at `needed`
 * permission or better, non-expired, read through their live membership of
 * the org exactly as check() reads it. Agents authenticate via capability
 * token rather than a grant, so this is empty for an agent actor.
 *
 * For a single already-known target, evaluate() is the right call (and the
 * only one that audits). This exists for the different shape of problem a
 * browsing view has: filtering an existing multi-row result set (e.g. every
 * connected Source in the org) down to what THIS actor may actually see,
 * without either check()-ing every row (one audit_log write per row, for a
 * decision that isn't a real access — see `can()`'s own doc comment) or
 * skipping the guard and returning the row count unfiltered.
 * Callers pair this with pathCovers(grantedPath, row.scopePath) per row —
 * same ancestor-or-self relation evaluate() enforces server-side, just
 * inverted (many rows against a few granted paths, instead of one target
 * against many grants).
 */
export async function readableScopePaths(ctx: AccessContext, needed: Permission = "read"): Promise<string[]> {
  if (ctx.actor.type !== "human") return [];
  const rows = await db.$queryRaw<MemberGrant[]>(...flattenSql(memberGrantsSql(ctx.orgId, { userId: ctx.actor.id })));
  return rows.filter((r) => covers(r.permission, needed)).map((r) => r.scopePath);
}

type HumanActor = Extract<Actor, { type: "human" }>;
type AgentActor = Extract<Actor, { type: "agent" }>;

/** One row of the capability lookup below: the token's own snapshot, whether
 * its scope covers the target, whether a current grant still covers it, and
 * whether its agent has been deactivated. The computed columns are optional
 * because a test fixture may build a row without them (the query always
 * selects them); a fixture row is one the test meant to match the target. */
type CapabilityRow = {
  id: string;
  permission: Permission;
  createdBy: string | null;
  agentId: string;
  coversTarget?: boolean | null;
  grantGoverned?: boolean;
  hasLiveCoveringGrant?: boolean;
  agentDeactivated?: boolean;
  /** The org has an open deletion: a token issued alongside the request, which the
   * revocation did not catch, is refused all the same. */
  orgBeingDeleted?: boolean;
  /** A restore's re-apply of the org's erasures is due (reapplyDueSql). */
  reapplyDue?: boolean;
  /** The token was issued by a person who is not known to be able to do
   * `needed` on the target right now. The query never returns NULL here; a
   * NULL still denies (see issuerLacksAccess()). Optional for the same reason
   * as the two grant columns. */
  issuerLacksAccess?: boolean | null;
};

function anyRowCovers(rows: { permission: Permission }[], needed: Permission): boolean {
  return rows.some((r) => covers(r.permission, needed));
}

/**
 * True while a restore's re-apply of the org's erasures is due: a copy-back of the suppression
 * list added entries this database did not list itself (migration
 * 20261019100000_erasure_reapply_due), and completeRestore has not yet carried them out
 * (services/memory/erasure-reapply.ts). Until then the restored rows may still hold an erased
 * person, so check() refuses everything in the org but `admin`, which the re-apply itself needs.
 */
function reapplyDueSql(orgId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "erasure_reapply_due" due WHERE due."orgId" = ${orgId})`;
}

/**
 * A human is allowed when they are a live member of the org and some live grant
 * to them, their role in the org, or everyone has a scope that is an
 * ancestor-or-self of the target and carries a permission covering `needed`.
 * Membership and role are read from `org_memberships` (services/access/member-grants.ts),
 * the same query the scope readers listing runs, never from `actor.role`.
 */
async function evaluateHumanGrants(
  orgId: string,
  actor: HumanActor,
  needed: Permission,
  targetPath: string,
): Promise<AccessDecision> {
  // The org's due re-apply rides on the grants query as a column, so it costs no statement and
  // binds no value of its own.
  const query = Prisma.sql`
    SELECT member_grants."permission", ${reapplyDueSql(Prisma.raw('member_grants."orgId"'))} AS "reapplyDue"
    FROM (${memberGrantsSql(orgId, { userId: actor.id, covering: targetPath })}) member_grants
  `;
  const rows = await db.$queryRaw<{ permission: Permission; reapplyDue?: boolean }[]>(...flattenSql(query));
  if (!anyRowCovers(rows, needed)) return { allowed: false, ...reasons.noHumanGrant(needed, actor.id, targetPath) };
  if (needed !== "admin" && rows.some((r) => r.reapplyDue))
    return { allowed: false, ...reasons.restoreIncomplete(needed, targetPath) };
  return { allowed: true, ...reasons.humanGrantAllows(needed, targetPath) };
}

/**
 * Load the live capability row this agent's credential names, stamped with whether
 * its scope covers `targetPath`, whether one of the agent's CURRENT grants
 * still covers the action and scope, and whether the agent has been deactivated
 * since (read live, like the grants, so switching an agent off refuses its very
 * next call and switching it back on restores the same token; see
 * agentIsDeactivated).
 *
 * A row whose scope does not cover the target is still returned, flagged
 * `coversTarget: false`, so a refusal for asking outside the token's scope can
 * name the person who provisioned it (`createdBy`), the delegating person an
 * audit row records. It never counts toward a decision: evaluateAgentCapability
 * drops it before any rule runs.
 */
async function loadMatchingCapabilities(
  orgId: string,
  actor: AgentActor,
  needed: Permission,
  targetPath: string,
): Promise<CapabilityRow[]> {
  const key = capabilityKey(actor);
  const capabilityMatch = "id" in key ? Prisma.sql`"id" = ${key.id}` : Prisma.sql`"tokenHash" = ${key.tokenHash}`;
  const capabilityCoversTarget = scopeContainsSql(Prisma.raw('cap."scopePath"'), targetPath, {
    relation: "covers",
    mode: "ltree",
  });
  // Capability.scopePath/permission are a snapshot fixed at mint, never
  // re-derived, so the token lookup alone proves fresh identity but a STALE
  // scope decision. A DELETE on a grant cascades revokedAt to the tokens it
  // covers (caught by the `"revokedAt" IS NULL` filter below); a grant demoted
  // or removed since mint by any other path would otherwise leave the old,
  // wider capability enforceable until natural expiry (up to 90 days).
  //
  // So the query re-derives against this agent's CURRENT covering grants
  // (granteeType: 'agent'), the same query-time posture as the human branch
  // above -- but only for agents actually governed by a grant, read from the
  // capability's OWN persisted `grantGoverned` column, not from whether a
  // "grants" row for this agentId happens to exist right now. An agentId with
  // none ever (copy-agent, research-agent, handoff-agent, qa-agent,
  // architecture-agent: every lib/*-agent.ts provisions its capability
  // directly, with no /api/access/grants entry) is born with
  // `grantGoverned = false` and has nothing to re-derive from. This can only
  // narrow an agent that IS grant-governed, never deny one that was never
  // grant-governed, and never widen anything past the capability's own
  // scope/permission this same query already requires.
  //
  // Why a stamped column and not a live `EXISTS` against "grants": a live
  // EXISTS answers "does a grants row for this agentId exist RIGHT NOW," which
  // cannot tell a full removal apart from never-governed -- both are zero
  // rows. DELETE /api/access/scopes/:id's `onDelete: Cascade` on Grant.scope
  // hard-deletes every Grant row under that scope with no application code in
  // the path, so an agent's LAST grant disappearing that way looks identical,
  // to a live query, to an agentId that was never grant-governed, and the
  // stale wide capability would fall into the ungoverned branch and stay
  // enforceable to natural expiry. `grantGoverned` is set once
  // (deriveGrantGovernance() at mint, or retroactively via the ratchet in POST
  // /api/access/grants the moment this agentId's first grant is created) and
  // never cleared afterward by anything, including every one of that
  // agentId's grants later being deleted -- a hard-delete cascade cannot
  // silently undo a fact recorded on a different table.
  //
  // `hasLiveCoveringGrant` stays a live EXISTS deliberately: an agent that IS
  // grant-governed must still be measured against what actually covers it
  // RIGHT NOW, so a demotion or removal bites immediately. Only "was this
  // agentId ever grant-governed at all" is read from the stamped column.
  //
  // Cost: the one capability lookup this branch always runs, plus one
  // correlated EXISTS -- not a second round trip. Structured as a `cap` CTE
  // so the WHERE clause's own bound values (orgId, then the token hash or the
  // capability id) stay FIRST in bind order: several test files (e.g.
  // app/api/mcp/route.test.ts, services/memory/scale-and-concurrency.eval.test.ts)
  // index into `db.$queryRaw`'s raw values array positionally (`values[1]`
  // for tokenHash) to route their mock, and putting `hasLiveCoveringGrant`'s
  // bound values (the permission list, the second containment check) in the
  // SELECT list ahead of the WHERE clause would shift every one of those
  // positions. The scope containment is a column of the outer SELECT for the
  // same reason, and so the row is found even when its scope misses.
  // Structurally this is one indexed (orgId, granteeType,
  // granteeId) EXISTS check the planner can short-circuit against the `cap`
  // CTE's single already-authenticated row, the same cost class as the human
  // branch's own grants JOIN above, not a fan-out.
  const satisfyingPermissions = (Object.keys(RANK) as Permission[]).filter((p) => covers(p, needed));
  const agentGrantCoversTarget = scopeContainsSql(Prisma.raw('s."path"'), targetPath, {
    relation: "covers",
    mode: "ltree",
  });
  const capabilityQuery = Prisma.sql`
    WITH cap AS (
      SELECT "id", "permission", "createdBy", "agentId", "orgId", "scopePath", "grantGoverned", "issuedByPerson"
      FROM "capabilities"
      WHERE "orgId" = ${orgId}
        AND ${capabilityMatch}
        AND "revokedAt" IS NULL
        AND "expiresAt" > ${sqlUtcNow}
    )
    SELECT
      cap."id",
      cap."permission",
      cap."createdBy",
      cap."agentId",
      cap."grantGoverned",
      ${capabilityCoversTarget} AS "coversTarget",
      EXISTS (
        SELECT 1 FROM "grants" g
        JOIN "scopes" s ON s."id" = g."scopeId"
        WHERE g."orgId" = cap."orgId"
          AND g."granteeType" = 'agent'
          AND g."granteeId" = cap."agentId"
          AND (g."expiresAt" IS NULL OR g."expiresAt" > ${sqlUtcNow})
          AND g."permission" IN (${Prisma.join(satisfyingPermissions)})
          AND ${agentGrantCoversTarget}
      ) AS "hasLiveCoveringGrant",
      EXISTS (
        SELECT 1 FROM "agents" a
        WHERE a."orgId" = cap."orgId"
          AND (a."agentKey" = cap."agentId" OR a."id" = cap."agentId")
          AND a."active" = false
      ) AS "agentDeactivated",
      EXISTS (
        SELECT 1 FROM "org_deletions" d
        WHERE d."orgId" = cap."orgId" AND d."status" IN ('pending', 'deleting')
      ) AS "orgBeingDeleted",
      ${reapplyDueSql(Prisma.raw('cap."orgId"'))} AS "reapplyDue",
      (
        cap."issuedByPerson" IS NOT FALSE
        AND "access_person_holds"(cap."orgId", cap."createdBy", ${needed}::"Permission", ${targetPath}) IS NOT TRUE
      ) AS "issuerLacksAccess"
    FROM cap
  `;
  return db.$queryRaw<CapabilityRow[]>(...flattenSql(capabilityQuery));
}

/**
 * Was a matching token found, but issued to a different agent than the one the
 * context claims to be?
 *
 * The token query proves the caller HOLDS a valid capability; it says nothing
 * about who they're claiming to be. Capability.agentId is the column recording
 * which agent the token was actually issued to: without this comparison, a
 * context presenting agent A's valid token while claiming actorId agent B is
 * allowed on token/org/scope/permission alone, and recordAudit stamps B onto
 * the row — a fabricated-identity misattribution reaching the same audit trail
 * the missing-actor guard protects.
 */
function tokenIssuedToAnotherAgent(rows: CapabilityRow[], ownedRows: CapabilityRow[]): boolean {
  return rows.length > 0 && ownedRows.length === 0;
}

/**
 * Is this agent grant-governed while none of its current grants covers the
 * action and scope any more — a capability that outlived the grant behind it?
 *
 * See loadMatchingCapabilities: only `grantGoverned` (the persisted ratchet,
 * not a live "grants" lookup) puts an agent under this rule. A row from a
 * test/mock that never set these columns has both as `undefined`, which is
 * falsy here exactly like `false`, so capability-only fixtures are unaffected.
 */
function capabilityOutlivedItsGrant(ownedRows: CapabilityRow[]): boolean {
  const grantGoverned = ownedRows.some((r) => r.grantGoverned);
  const hasLiveCoveringGrant = ownedRows.some((r) => r.hasLiveCoveringGrant);
  return grantGoverned && !hasLiveCoveringGrant;
}

/**
 * Was this token issued by a person who cannot do the same thing on the target
 * right now? A token is never wider than its issuer, at mint (the database
 * refuses the row, see migration 20261010010000_capability_issuer_bound) and at
 * every use (here), so narrowing, demoting or removing the person narrows every
 * token they minted on the next call. Tokens with no person behind them
 * (`createdBy` null or `system:<label>`) carry `issuedByPerson = false` and are
 * bounded by their own scope only.
 *
 * Only a definite "the issuer holds access" passes. The query compares with
 * `IS NOT TRUE`, so an issuer check that cannot answer (NULL) already reads as
 * "lacks access" there, and a NULL that reaches this function denies too. The
 * column is absent only from test doubles that predate it.
 */
function issuerLacksAccess(coveringRow: CapabilityRow): boolean {
  return coveringRow.issuerLacksAccess !== false && coveringRow.issuerLacksAccess !== undefined;
}

/**
 * An agent is allowed when its capability token is live, was issued to the
 * agent the context claims to be, covers the target scope at `needed`
 * permission, belongs to an agent that has not been deactivated, is still
 * backed by a current grant if the agent is grant-governed, and was issued by
 * a person who can still do the same, if a person issued it. Each of those is
 * checked in that order, and the first failure is the decision.
 */
async function evaluateAgentCapability(
  orgId: string,
  actor: AgentActor,
  needed: Permission,
  targetPath: string,
): Promise<AccessDecision> {
  const tokenRows = await loadMatchingCapabilities(orgId, actor, needed, targetPath);
  // The person the token acts for, named on the row whatever the decision.
  const triggeredBy = tokenRows[0]?.createdBy ?? undefined;
  // Only a definite "covers" reaches a rule. NULL (a comparison Postgres could not
  // decide) is a deny; `undefined` comes only from a test fixture's row.
  const rows = tokenRows.filter((r) => r.coversTarget === true || r.coversTarget === undefined);
  // Checked against every matching row (not just rows[0]) so a real
  // permission match on a mismatched row is never mistaken for a hit.
  const ownedRows = rows.filter((r) => r.agentId === actor.id);
  if (tokenIssuedToAnotherAgent(rows, ownedRows)) {
    return {
      allowed: false,
      ...reasons.capabilityOwnerMismatch(rows[0].agentId, actor.id),
      triggeredBy,
    };
  }
  const coveringRow = ownedRows.find((r) => covers(r.permission, needed));
  if (!coveringRow) {
    return { allowed: false, ...reasons.noCapability(needed, actor.id, targetPath), triggeredBy };
  }
  // Named only from here on: the token is this agent's own and covers the
  // target, so the decision below is a real use of it.
  const capabilityId = coveringRow.id;
  const agentAdmin = coveringRow.permission === "admin";
  if (ownedRows.some((r) => r.orgBeingDeleted)) {
    return {
      allowed: false,
      ...reasons.orgBeingDeleted(needed, "agent", targetPath),
      triggeredBy,
      capabilityId,
      agentAdmin,
    };
  }
  if (ownedRows.some((r) => r.agentDeactivated)) {
    return {
      allowed: false,
      ...reasons.agentDeactivated(needed, actor.id, targetPath),
      triggeredBy,
      capabilityId,
      agentAdmin,
    };
  }
  if (capabilityOutlivedItsGrant(ownedRows)) {
    return {
      allowed: false,
      ...reasons.capabilityOutlivedGrant(needed, actor.id, targetPath),
      triggeredBy,
      capabilityId,
      agentAdmin,
    };
  }
  if (issuerLacksAccess(coveringRow)) {
    return {
      allowed: false,
      ...reasons.issuerLacksAccess(needed, actor.id, targetPath),
      triggeredBy,
      capabilityId,
      agentAdmin,
    };
  }
  // Last: every other refusal is the caller's own and outlasts the restore, so it wins.
  if (needed !== "admin" && ownedRows.some((r) => r.reapplyDue)) {
    return { allowed: false, ...reasons.restoreIncomplete(needed, targetPath), triggeredBy, capabilityId, agentAdmin };
  }
  return { allowed: true, ...reasons.capabilityAllows(needed, targetPath), triggeredBy, capabilityId, agentAdmin };
}

/**
 * The access decision itself: default deny, one rule per branch, first failure
 * wins. check() wraps this with the audit row; can() calls it bare.
 */
async function evaluate(ctx: AccessContext, needed: Permission, targetPath: string): Promise<AccessDecision> {
  // No real identity to attribute this call to (a caller-side gap upstream —
  // see agentContextFromRuntime in services/agents/tools.ts) must
  // never fall through to a scope/token check that only asks "is this
  // permission covered," not "who is this." Deny before the DB round trip so
  // a valid capability token can't paper over a missing actor id.
  if (!ctx.actor.id) {
    return { allowed: false, ...reasons.missingActorIdentity(needed, targetPath) };
  }
  // An org being deleted: people may only read. Its agent tokens were revoked at the
  // request, and evaluateAgentCapability refuses any that was not, inside the lookup
  // it already makes. Reads skip this one, so the common path costs nothing.
  if (ctx.actor.type === "human" && needed !== "read" && (await orgDeletionOpen(ctx.orgId))) {
    return { allowed: false, ...reasons.orgBeingDeleted(needed, "human", targetPath) };
  }
  return ctx.actor.type === "human"
    ? evaluateHumanGrants(ctx.orgId, ctx.actor, needed, targetPath)
    : evaluateAgentCapability(ctx.orgId, ctx.actor, needed, targetPath);
}

/** The most scopes one listing decides with a can() call each (GET
 * /api/memory/scopes). A caller who can read more gets the first ones by path and
 * `truncated: true`. Reads do not use it: see MAX_SEARCHED_DESCENDANT_SCOPES. */
export const MAX_DESCENDANT_SCOPES = 50;

/** The most scopes below the authorized one that a single read searches. The graph
 * store asks all of them in one request, about a hundred per search inside it, so
 * this bounds one read at about ten graph searches. A read over more says so and names
 * the scopes it did not search (DescendantScopes.unsearched). */
export const MAX_SEARCHED_DESCENDANT_SCOPES = 1_000;

/** Result of descendantScopePaths. `paths` are the scopes to search; `unsearched`
 * are the registered descendants past MAX_SEARCHED_DESCENDANT_SCOPES, in path order.
 * `partial` is true when `paths` does not cover every registered descendant: some are
 * unsearched, or the lookup failed (and then which ones is not known). Readers pass
 * this on to their caller, so an incomplete read is reported instead of looking like
 * "nothing else exists". */
export interface DescendantScopes {
  paths: string[];
  unsearched: string[];
  partial: boolean;
}

/**
 * Real, registered scope paths strictly BELOW `targetPath` within `orgId` —
 * the source of truth for an authorized-descendant query. `targetPath` is
 * assumed to already be an authorized read target (callers only call this
 * with the scope check()/evaluate() already validated, e.g.
 * guarded-store.ts's `target`); every strict descendant of an authorized
 * scope is itself covered by the same grant (this function mirrors
 * evaluate()'s own `@>` containment direction, one level down), so this
 * never widens what's readable, it only enumerates what's already inside
 * the caller's own authorized envelope.
 *
 * Exists because Graphiti (graphiti-store.ts) partitions on an EXACT
 * group_id with no ltree containment of its own — unlike pgvector's
 * containment predicate (pgvector-store.ts), which finds descendant content in
 * one query, Graphiti has to be told every real descendant scope, which the
 * guarded reads then ask in one call (see guarded-store.ts's retrieve() and
 * entity()). The lookup is scope-registry.ts's strictDescendantScopePaths().
 * This function runs no per-path authorization of its own, and its callers
 * query Graphiti over the returned paths without re-checking them, so the
 * containment must be exact: ltree `<@`, never a LIKE prefix, whose `_`
 * wildcard would hand back a sibling scope. `scopes` is the authoritative
 * registry of scopes that actually exist, and every `Source.scopePath`
 * (Drive-sourced ingest) is created against a real row here
 * (app/api/sources/route.ts), so a descendant scope with real Drive-extracted
 * content is always found by this query.
 *
 * Never caller-supplied: the only inputs are the org id and an
 * already-authorized target path, both server-derived.
 *
 * Fails soft (no paths, `partial: true`), same resilience posture as
 * pgvector-store.ts's own schema-not-ready fallback: a lookup failure here
 * degrades to Graphiti's exact-groupId-only read, never turning an
 * otherwise-successful, already-authorized read into a hard failure.
 */
export async function descendantScopePaths(orgId: string, targetPath: string): Promise<DescendantScopes> {
  try {
    const rows = await strictDescendantScopePaths(orgId, targetPath);
    const unsearched = rows.slice(MAX_SEARCHED_DESCENDANT_SCOPES);
    if (unsearched.length > 0) {
      console.warn(
        `[access] descendantScopePaths: org ${orgId} scope ${targetPath} has ${rows.length} registered descendant scopes; searching the first ${MAX_SEARCHED_DESCENDANT_SCOPES} and reporting the rest`,
      );
    }
    return {
      paths: rows.slice(0, MAX_SEARCHED_DESCENDANT_SCOPES),
      unsearched,
      partial: unsearched.length > 0,
    };
  } catch (e) {
    console.warn(
      `[access] descendantScopePaths: lookup failed for org ${orgId} scope ${targetPath}, degrading to zero descendants:`,
      e instanceof Error ? e.message : e,
    );
    return { paths: [], unsearched: [], partial: true };
  }
}

async function recordAudit(
  ctx: AccessContext,
  req: AccessRequest,
  targetPath: string,
  decision: AccessDecision,
): Promise<string> {
  const row = await writeAuditRow({
    orgId: ctx.orgId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    action: req.action,
    target: req.target ? `${targetPath}/${req.target}` : targetPath,
    decision: decision.allowed ? "allow" : "deny",
    // The operator's half, so the row names the scope the request really
    // resolved to even though the caller's copy does not.
    reason: decision.auditReason ?? decision.reason,
    metadata: {
      ...(decision.triggeredBy ? { triggeredBy: decision.triggeredBy } : {}),
      ...(decision.capabilityId ? { capabilityId: decision.capabilityId } : {}),
      ...(decision.agentAdmin ? { agentAdmin: true } : {}),
    },
    runId: ctx.runId,
    origin: ctx.origin,
  });
  return row.id;
}

/**
 * Records that a `memory.write`/`memory.delete` was not merely authorized but
 * actually APPLIED — the store write it gated really landed. `check()`'s own
 * `recordAudit()` row fires at AUTHORIZATION time, before the real write
 * happens; the generic async ingest path (`lib/inngest.ts`'s
 * `memoryIngest`/`runMemoryIngest`) can still fail after that row is written
 * (3 retries then a dead job), and the synchronous `memory.delete` path has
 * the same ordering with a narrower window. `auditChangesUnderScope()` below
 * reads THESE rows, not `recordAudit()`'s, so a brief's staleness flag only
 * ever reflects evidence a write genuinely landed.
 *
 * Call this only after the real store mutation has resolved successfully —
 * never speculatively, never before the `await` that does the actual write.
 * Always records `allow` (a call that reaches here already succeeded; there
 * is no applied-but-denied case). `tag`, when given, must be the exact same
 * string the gating `check()` call passed as `req.target`, so this row's
 * `target` matches what `recordAudit()` writes for the same logical action
 * (e.g. persist/correct's `brief:${id}`) — that's what lets
 * `auditChangesUnderScope()`'s `excludeTarget` match a caller's own
 * self-write.
 */
export async function recordAppliedChange(
  params: {
    orgId: string;
    actorType: string;
    actorId: string;
    action: "memory.write" | "memory.delete";
    scopePath: string;
    tag?: string;
    runId?: string;
    /** The entry point the applied write came in through. */
    origin: AuditOrigin;
  },
  /** An open transaction to write through, when the row must commit with another
   *  write (the change-feed event for the same ingest). Defaults to the global client. */
  client: Pick<Prisma.TransactionClient, "auditLog"> = db,
): Promise<void> {
  const { orgId, actorType, actorId, action, scopePath, tag, runId, origin } = params;
  // Annotated, not inlined: the annotation is what makes `audit_log.action`
  // values a closed set the audit map must cover, rather than free strings.
  const appliedAction: DerivedAuditAction = `${action}.applied`;
  await writeAuditRow(
    {
      orgId,
      actorType,
      actorId,
      action: appliedAction,
      target: tag ? `${scopePath}/${tag}` : scopePath,
      decision: "allow",
      runId,
      origin,
    },
    client,
  );
}

/**
 * Real audit rows recording an allowed `memory.write`/`memory.delete` at or
 * under `scopePath`, after `after`, excluding `excludeTarget` — the read-side
 * counterpart to `recordAudit()`'s target convention above (`targetPath` or
 * `targetPath/tag`). Used by GET /api/briefs/:id/staleness to flag a
 * handoff brief as stale when memory changed under its scope since it was
 * generated.
 *
 * Raw SQL, not Prisma's `startsWith`/`OR`, because containment here needs a
 * real `LIKE ... ESCAPE` (`escapeLikePrefix()`): Postgres LIKE treats `_` as
 * "any single character", and `isValidLtreePath()` above permits `_` in an
 * ordinary scope label, so a bare `startsWith` leaks a sibling scope
 * differing only at an `_`/`-` position (an org holding both `dept-sales` and
 * `dept_sales` would leak one into the other's brief).
 *
 * Filters on `memory.write.applied`/`memory.delete.applied`
 * (`recordAppliedChange()` above), not the plain `memory.write`/
 * `memory.delete` authorization-time rows `recordAudit()` writes: an async
 * ingest failure, or a synchronous delete that authorizes then fails, would
 * otherwise flag a brief stale for a write that never landed.
 */
export async function auditChangesUnderScope(params: {
  orgId: string;
  scopePath: string;
  after: Date;
  excludeTarget: string;
  limit: number;
}): Promise<Array<{ action: string; target: string | null; at: Date }>> {
  const { orgId, scopePath, after, excludeTarget, limit } = params;
  const escapedScope = escapeLikePrefix(scopePath);
  const query = Prisma.sql`
    SELECT "action", "target", "at" FROM "audit_log"
    WHERE "orgId" = ${orgId}
      AND "action" IN ('memory.write.applied', 'memory.delete.applied')
      AND "decision" = 'allow'
      AND "at" > ${after}
      AND (
        "target" = ${scopePath}
        OR "target" LIKE ${escapedScope + ".%"} ESCAPE '\\'
        OR "target" LIKE ${escapedScope + "/%"} ESCAPE '\\'
      )
      AND "target" <> ${excludeTarget}
    ORDER BY "at" ASC
    LIMIT ${limit}
  `;
  return db.$queryRaw<Array<{ action: string; target: string | null; at: Date }>>(...flattenSql(query));
}

/**
 * Audit actions that record text leaving the store: an applied delete, a person
 * erasure (each committed step, the closing row, and a failed attempt whose earlier
 * steps already committed), and an admin's permanent removal of a record. Every one is
 * written after, or in the same transaction as, the removal it records.
 */
export const REMOVAL_AUDIT_ACTIONS = [
  "memory.delete.applied",
  "memory.delete.effect",
  "person.erasure_step",
  "person.erased",
  "person.erasure_failed",
  "record.removed",
] as const satisfies readonly DerivedAuditAction[];

/**
 * What a cache of text derived from one scope must be keyed on, so that it never
 * outlives its source. Both are counters in Postgres that triggers keep (migration
 * 20261024120000_scope_cache_epoch), read here with two primary-key lookups, so the
 * read costs the same however large the audit log grows.
 *
 * - `erasureEpoch`: org-wide, moves on every removal of text anywhere in the org: a
 *   {@link REMOVAL_AUDIT_ACTIONS} row, a delete/supersede/revoke on the change feed, a
 *   `memory_chunks` row deleted or rewritten, or {@link bumpRemovalEpoch} for a removal
 *   only the graph held. An erasure targets the org root, not a scope, and a person's
 *   text can sit in any scope, so a removal anywhere invalidates every cached scan in
 *   the org.
 * - `changeCount`: every applied write and delete ever recorded at the scope or below
 *   it. It only grows, so any new change moves it; nothing is windowed. It includes a
 *   brief's own persist/correct writes, which costs that brief one extra scan.
 *
 * The bumps commit with the removal (deferred triggers), so a reader sees the removal
 * and the new epoch together. Read the stamp BEFORE computing what is cached, so a
 * removal that commits while the computation runs leaves the entry under the old epoch,
 * where the next read misses.
 */
export interface ScopeCacheStamp {
  erasureEpoch: string;
  changeCount: string;
}

export async function scopeCacheStamp(params: { orgId: string; scopePath: string }): Promise<ScopeCacheStamp> {
  const { orgId, scopePath } = params;
  const query = Prisma.sql`
    SELECT
      (SELECT "epoch" FROM "org_removal_epochs" WHERE "orgId" = ${orgId})::text AS "epoch",
      (SELECT sum("count") FROM "scope_change_counts"
        WHERE "orgId" = ${orgId}
          AND ("scopePath" = ${scopePath} OR "scopePath" LIKE ${escapeLikePrefix(scopePath) + ".%"} ESCAPE '\\')
      )::text AS "changes"
  `;
  const [row] = await db.$queryRaw<Array<{ epoch: string | null; changes: string | null }>>(...flattenSql(query));
  return { erasureEpoch: row?.epoch ?? "0", changeCount: row?.changes ?? "0" };
}

/**
 * Move `orgId`'s removal epoch, for a removal that only the graph held (a source's facts
 * retired, a late ingest's episodes withdrawn): no Postgres row goes with it for the
 * triggers to see. Call it after the graph removal returns, and never inside a
 * transaction: it is its own statement, so it holds the counter's row lock only for
 * itself. A crash between the graph removal and this call leaves other processes'
 * cached scans unmoved until their next removal or restart.
 */
export async function bumpRemovalEpoch(orgId: string): Promise<void> {
  await db.$executeRaw`SELECT public.bump_org_removal_epoch(${orgId})`;
}

/**
 * Run `remove`, a removal of `orgId`'s text that only the graph holds, between two
 * {@link bumpRemovalEpoch} calls. The bump before invalidates every scan cached before the
 * removal began, so a crash part-way leaves only scans cached during the removal; the bump
 * after, which also runs when `remove` throws part-way, invalidates those.
 */
export async function removingFromGraph<T>(orgId: string, remove: () => Promise<T>): Promise<T> {
  await bumpRemovalEpoch(orgId);
  try {
    return await remove();
  } finally {
    await bumpRemovalEpoch(orgId);
  }
}

/** The tag `recordBriefAcknowledgement`/`latestBriefAcknowledgement` share for a
 * brief's own acknowledgement rows, same target-tagging convention as
 * `recordAudit`'s `${targetPath}/${req.target}` above. */
function briefAckTarget(scopePath: string, briefId: string): string {
  return `${scopePath}/brief:${briefId}/acknowledged`;
}

/**
 * Record that a grantee has acknowledged a handoff brief. `stale` is the
 * staleness verdict AT THE MOMENT of acknowledgement (the caller computes it
 * with services/memory/brief-staleness.ts, and this just records it) — a later
 * reader can then tell "acknowledged while current" from "acknowledged while
 * already stale" instead of the acknowledgement silently erasing that
 * context, and a receipt copied after the brief was flagged stale cannot
 * attest a clean handoff.
 *
 * A plain audit row, not a `check()` call: this isn't an
 * authorization decision (the caller already gated the read that produced
 * `stale`), it's a record of what the grantee attested, the same "additive,
 * not gating" shape as `recordReadFactIds` below.
 */
export async function recordBriefAcknowledgement(params: {
  orgId: string;
  scopePath: string;
  briefId: string;
  actorType: AccessContext["actor"]["type"];
  actorId: string;
  stale: boolean;
  /** The entry point the acknowledgement came in through. */
  origin: AuditOrigin;
}): Promise<{ id: string; at: Date }> {
  const { orgId, scopePath, briefId, actorType, actorId, stale, origin } = params;
  return writeAuditRow({
    orgId,
    actorType,
    actorId,
    action: "brief.acknowledged" satisfies DerivedAuditAction,
    target: briefAckTarget(scopePath, briefId),
    decision: "allow",
    metadata: { stale },
    origin,
  });
}

/**
 * The most recent acknowledgement of a brief, if any — read-side counterpart
 * to `recordBriefAcknowledgement()` above, so a page reload can show a prior
 * acknowledgement instead of losing it back to "not yet acknowledged".
 */
export async function latestBriefAcknowledgement(params: {
  orgId: string;
  scopePath: string;
  briefId: string;
}): Promise<{ at: Date; stale: boolean } | null> {
  const { orgId, scopePath, briefId } = params;
  const row = await db.auditLog.findFirst({
    where: {
      orgId,
      action: "brief.acknowledged" satisfies DerivedAuditAction,
      target: briefAckTarget(scopePath, briefId),
    },
    orderBy: { at: "desc" },
    select: { at: true, metadata: true },
  });
  if (!row) return null;
  const metadata = row.metadata as { stale?: unknown } | null;
  return { at: row.at, stale: metadata?.stale === true };
}

/**
 * Record the specific fact id(s) a `memory.read` call actually returned,
 * linked to its already-written audit_log row (`check()`'s returned
 * `decision.auditLogId`) via `metadata.auditLogId`. The read is already
 * gated + audited by check() before this runs — this writes a SEPARATE row
 * rather than mutating the original one, since audit_log is append-only
 * (see the model's doc comment): the
 * fact ids are still recoverable via a join on `auditLogId`, but no row is
 * ever mutated after creation. Additive only: never touches the allow/deny
 * decision, and a caller that doesn't have an auditLogId (or has nothing to
 * annotate) simply skips it.
 */
export async function recordReadFactIds(
  ctx: AccessContext,
  decision: AccessDecision,
  factIds: string[],
): Promise<void> {
  if (!decision.allowed || !decision.auditLogId) return;
  await writeAuditRow({
    orgId: ctx.orgId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    action: "memory.read.factIds" satisfies DerivedAuditAction,
    decision: "allow",
    metadata: { auditLogId: decision.auditLogId, factIds },
    runId: ctx.runId,
    origin: ctx.origin,
  });
}

/**
 * Record which group/partition a `memory.write`/`memory.delete` was actually
 * EXECUTED against, linked to its authorizing audit_log row (`check()`'s
 * returned `decision.auditLogId`) via `metadata.auditLogId`.
 *
 * `check()` records the scope it authorized. The guarded store's destructive
 * methods run the real store mutation against `scope ?? input.groupId`, which
 * is a different string whenever the caller passes no scope -- the
 * authorization row reads `org_<orgId>`, the delete ran against the bare,
 * untagged `<orgId>` partition. `recordAppliedChange()` above does not close
 * that: it deliberately records the authorized `scopePath`, because
 * `auditChangesUnderScope()` matches briefs on it. Without this row the trail
 * shows that a destructive write was allowed and that it landed, but not
 * where -- the one fact needed to tell a correctly scoped delete from a
 * wrongly scoped one.
 *
 * Call this only after the real store mutation has resolved successfully, for
 * the same reason `recordAppliedChange()` says so: a row here asserts the
 * write happened.
 *
 * Additive, never gating: it writes a separate row rather than mutating the
 * append-only original, and a decision carrying no `auditLogId` has nothing to
 * link to, so it is skipped -- the same contract as {@link recordReadFactIds}.
 *
 * `tag` must be the same string the gating `check()` call passed as
 * `req.target` (`entity:<id>`, `fact:<id>`, `merge:<old>-><new>`), so the row
 * reads `<partition>/<tag>` -- `recordAudit()`'s convention, over the EXECUTED
 * partition instead of the authorized one. It is required rather than
 * optional because unlike {@link recordReadFactIds}, whose rows no audit
 * surface displays, these rows are always visible, and
 * `components/audit/format.ts`'s `parseTarget()` both dereferences `target`
 * and needs a `/` in it to resolve a scope label at all.
 *
 * The partition half comes from {@link resolveExecutedPartition}, never from
 * the raw `group_id`: the executed partition is frequently in the group_id
 * namespace rather than the scope-path one, and only the resolved form says
 * which, so the row distinguishes the untagged partition from the org-root
 * scope instead of rendering both as "Org root".
 */
export async function recordWriteEffect(
  ctx: AccessContext,
  decision: AccessDecision,
  action: "memory.write" | "memory.delete",
  executed: ExecutedPartition,
  tag: string,
): Promise<void> {
  if (!decision.allowed || !decision.auditLogId) return;
  const effectAction: DerivedAuditAction = `${action}.effect`;
  await writeAuditRow({
    orgId: ctx.orgId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    action: effectAction,
    target: `${executed.targetPath}/${tag}`,
    decision: "allow",
    metadata: { auditLogId: decision.auditLogId, executedGroupId: executed.groupId },
    runId: ctx.runId,
    origin: ctx.origin,
  });
}
