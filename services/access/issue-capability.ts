// Issue an agent capability: the one code path that creates a `capabilities` row.
//
// POST /api/access/capabilities hands the raw token to the caller; an OAuth
// connection (./oauth-connection.ts) binds the capability to a client and never
// discloses the token. Both mint here, so both are held to the same rules.
//
// The one rule this file enforces: a capability is never wider than its issuer.
// The issuer must be a person, never an agent acting on a token, and must hold
// `access.manage` (admin) on the scope the capability is for, decided by check() at
// that scope and recorded in the audit log, allowed or not. A scope the issuer
// cannot read answers like one that does not exist. Every capability expires, at
// most MAX_CAPABILITY_TTL_HOURS after it is issued, an `admin` one at most two hours
// after, and records who issued it. The database holds the same lines at insert
// (triggers `capabilities_issuer_bound` and `capabilities_admin_window`), so a race
// between the check and the insert is refused too, and check() holds them again at
// every use.

import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { authorizeRecord } from "./authorize-record";
import { canonicalAgentId } from "./agent-identity";
import { generateCapabilityToken, hashCapabilityToken, isIssuerBoundRefusal } from "./capabilities";
import { deriveGrantGovernance, orgRootPath, pathCovers, readableScopePaths } from "./check";
import type { AccessContext, Permission } from "./check";
import { recordRefusal } from "./refusal";

const PERMISSIONS: readonly Permission[] = ["read", "write", "admin"];

/** The lifetime of a capability issued without an explicit one. */
const DEFAULT_TTL_HOURS = 24 * 7;

/** No capability lives longer than this, whatever the issuer asks for. */
export const MAX_CAPABILITY_TTL_HOURS = 24 * 90;

/** What an issuer asks for, as a request body states it. Unchecked until {@link issueCapability} runs. */
export interface CapabilityRequest {
  /** The agent the capability is for: an Agent's key, id or name, or a free-text client name. */
  agentRef?: string;
  /** The scope the capability covers. Defaults to the org root. */
  scopePath?: string;
  /** `read`, `write` or `admin`. Defaults to `read`. */
  permission?: string;
  /**
   * Hours until expiry. Defaults to seven days; capped at {@link MAX_CAPABILITY_TTL_HOURS}.
   * An `admin` capability is cut to two hours from its mint by the database
   * (migration 20261014210000_capability_admin_window), whatever is asked here.
   */
  ttlHours?: number;
}

/** A capability just created, with its raw token. The token exists only in this value. */
export interface IssuedCapability {
  id: string;
  agentId: string;
  scopePath: string;
  permission: Permission;
  expiresAt: Date;
  token: string;
}

/**
 * The outcome of {@link issueCapability}. A refusal carries the HTTP status a route
 * answers with and an error that is safe to return to the caller.
 */
export type CapabilityIssue =
  | { ok: true; capability: IssuedCapability }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Issue a capability on behalf of the person in `ctx`.
 *
 * Refuses, writing nothing: an agent as the issuer (403), a missing agent or an
 * unknown permission (400), a scope that does not exist or that the issuer cannot
 * read (404), a scope the issuer can read but does not administer (403), an agent id
 * the product reserves (400), and a capability the database finds wider than the
 * issuer at insert (403). The scope decision is a check() call, so allowed and
 * refused alike leave an audit row; an agent issuer's refusal leaves one too.
 *
 * `writer` is the client the row is created with. Pass a transaction client to
 * create the capability atomically with rows that depend on it.
 */
export async function issueCapability(
  ctx: AccessContext,
  request: CapabilityRequest,
  writer: Prisma.TransactionClient = db,
): Promise<CapabilityIssue> {
  // A token only ever comes from a person. An agent that could mint one could
  // mint itself a longer or wider one, which is the standing power admin must not be.
  if (ctx.actor.type !== "human") {
    await recordRefusal(ctx, {
      action: "access.manage",
      target: `${orgRootPath(ctx.orgId)}/capabilities:issue`,
      auditReason: `agent ${ctx.actor.id} tried to issue a capability; only a person can issue one`,
    });
    return { ok: false, status: 403, error: "an agent cannot issue tokens; ask a person in your org to issue one" };
  }

  const agentRef = request.agentRef?.trim();
  if (!agentRef) return { ok: false, status: 400, error: "agentId is required" };

  const permission = PERMISSIONS.find((p) => p === (request.permission ?? "read"));
  if (!permission) {
    return { ok: false, status: 400, error: "permission must be read|write|admin" };
  }

  const scopePath = request.scopePath?.trim() || orgRootPath(ctx.orgId);
  const access = await authorizeRecord(
    ctx,
    () => db.scope.findUnique({ where: { orgId_path: { orgId: ctx.orgId, path: scopePath } } }),
    { action: "access.manage", scopeOf: (s) => s.path, target: `capabilities:issue:${scopePath}` },
  );
  if (access.status === "absent") return { ok: false, status: 404, error: "scope not found" };
  if (access.status === "denied") return { ok: false, status: 403, error: access.decision.reason };

  // Store the same identifier an agent grant stores, or revoking that grant
  // cannot find this capability (see agent-identity.ts).
  const resolved = await canonicalAgentId(ctx.orgId, agentRef);
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
  const agentId = resolved.agentId;

  const ttlHours = Math.min(
    typeof request.ttlHours === "number" && request.ttlHours > 0 ? request.ttlHours : DEFAULT_TTL_HOURS,
    MAX_CAPABILITY_TTL_HOURS,
  );
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  const token = generateCapabilityToken();
  // Grant governance is stamped at issue from the grants that exist for this
  // agent now; deriveGrantGovernance() says why it cannot be re-derived later.
  const governance = await deriveGrantGovernance(ctx.orgId, agentId);
  let capability;
  try {
    capability = await writer.capability.create({
      data: {
        orgId: ctx.orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt,
        createdBy: ctx.actor.id,
        ...governance,
      },
      select: { id: true, agentId: true, scopePath: true, permission: true, expiresAt: true },
    });
  } catch (error) {
    // The access.manage check above normally rules this out first; this answers
    // the race where the issuer's access changes between that check and the insert.
    if (isIssuerBoundRefusal(error)) {
      return {
        ok: false,
        status: 403,
        error: `you do not hold ${permission} on this scope, so you cannot issue a token for it`,
      };
    }
    throw error;
  }
  return { ok: true, capability: { ...capability, token } };
}

/** A scope a person may issue a capability on. */
export interface IssuableScope {
  path: string;
  name: string;
}

/**
 * The scopes in the person's org that they administer, root first: every scope at
 * or below one they hold an admin grant on. For offering choices in a form; the
 * issue itself is still decided by check() in {@link issueCapability}.
 */
export async function issuableScopes(ctx: AccessContext): Promise<IssuableScope[]> {
  const administered = await readableScopePaths(ctx, "admin");
  if (administered.length === 0) return [];
  const scopes = await db.scope.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { path: "asc" },
    select: { path: true, name: true },
  });
  return scopes.filter((scope) => administered.some((granted) => pathCovers(granted, scope.path)));
}

/**
 * The narrowest of `scopes`: the deepest path, the earlier one in path order on a
 * tie. Undefined for an empty list. A form that offers {@link issuableScopes}
 * preselects this, so accepting the default never grants more than the person chose.
 */
export function narrowestScopePath(scopes: readonly IssuableScope[]): string | undefined {
  let narrowest: string | undefined;
  for (const { path } of scopes) {
    if (
      narrowest === undefined ||
      depth(path) > depth(narrowest) ||
      (depth(path) === depth(narrowest) && path < narrowest)
    ) {
      narrowest = path;
    }
  }
  return narrowest;
}

function depth(path: string): number {
  return path.split(".").length;
}
