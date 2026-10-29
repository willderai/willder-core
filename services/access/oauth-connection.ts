// OAuth connections: the capability an OAuth client's requests run as.
//
// An MCP client that a person connects through Willder's authorization server
// (./oauth-authorization.ts) never decides what it may read or write. A connection
// does: it binds (org, person, client) to an ordinary capability, issued through
// issueCapability() like every other, so a client reaches no more than the person
// administers and check() decides each call as it does for a `wcap_` token. The
// capability's raw token is discarded at issue; a connected client holds only OAuth
// tokens bound to the capability's id.
//
// The one rule this file enforces: a person has at most one connection per client
// per org, and it is live only while the connection and its capability are both
// unrevoked and the capability is unexpired. Connecting again binds a new capability
// and revokes the one it replaces, in one transaction; revoking a connection revokes
// its capability, and revoking the capability alone ends the connection too.
// A connection always names its scope: an omitted one is refused, never read as the
// org root.

import { db } from "@/lib/db";
import { writeAuditRow } from "./audit-row";
import type { AccessContext, DerivedAuditAction, Permission } from "./check";
import { issueCapability, MAX_CAPABILITY_TTL_HOURS } from "./issue-capability";

/** Longer than any client id or metadata-document URL a real client sends. */
const MAX_CLIENT_ID_LENGTH = 2048;

/** Advisory-lock namespace serializing connects for one (org, person, client). */
const CONNECTION_LOCK_NAMESPACE = 8_241_003;

/** A person's connection from one client, as its owner may see it. */
export interface OAuthConnectionView {
  id: string;
  clientId: string;
  capabilityId: string;
  /** The capability's agent id: the name its calls carry in the audit log. */
  agentId: string;
  scopePath: string;
  permission: Permission;
  expiresAt: Date;
  connectedAt: Date;
}

/** What a person asks for on the connect page. Unchecked until {@link connectOAuthClient} runs. */
export interface OAuthConnectRequest {
  clientId?: string;
  /** The name the client's calls carry in the audit log, as POST /api/access/capabilities takes it. */
  agentId?: string;
  scopePath?: string;
  permission?: string;
}

/** The outcome of {@link connectOAuthClient}; a refusal carries a status and a client-safe error. */
export type OAuthConnectResult =
  | { ok: true; connection: OAuthConnectionView }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Connect an OAuth client for the person in `ctx`, in `ctx`'s org.
 *
 * Issues a capability at the requested scope and permission, with the longest
 * lifetime a capability may have (two hours for `admin`), through the same checks as
 * POST /api/access/capabilities, and binds it to (org, person, client). A previous
 * connection from the same client is replaced and its capability revoked. Nothing
 * is written when the issue is refused.
 */
export async function connectOAuthClient(
  ctx: AccessContext,
  request: OAuthConnectRequest,
): Promise<OAuthConnectResult> {
  const clientId = request.clientId?.trim();
  if (!clientId) {
    return { ok: false, status: 400, error: "clientId is required: the client_id of the OAuth authorization request" };
  }
  if (clientId.length > MAX_CLIENT_ID_LENGTH) {
    return { ok: false, status: 400, error: `clientId must be at most ${MAX_CLIENT_ID_LENGTH} characters` };
  }
  // issueCapability() reads a missing scope as the org root, which suits an admin
  // minting a token on purpose. A client connected that way would reach the whole
  // org without the person ever choosing that, so the connect page must name it.
  const scopePath = request.scopePath?.trim();
  if (!scopePath) {
    return { ok: false, status: 400, error: "scopePath is required: the scope the app may reach" };
  }
  const userId = ctx.actor.id;

  return db.$transaction(async (tx) => {
    // Two connects from one client at once would otherwise both find no row, or
    // both find the same old capability, and leave one capability live and unbound.
    await tx.$queryRaw`
      SELECT true AS locked
      FROM pg_advisory_xact_lock(
        ${CONNECTION_LOCK_NAMESPACE}::int4,
        hashtext(${`${ctx.orgId}\n${userId}\n${clientId}`})::int4
      )
    `;

    const issued = await issueCapability(
      ctx,
      {
        agentRef: request.agentId,
        scopePath,
        permission: request.permission,
        ttlHours: MAX_CAPABILITY_TTL_HOURS,
      },
      tx,
    );
    if (!issued.ok) return issued;
    const capability = issued.capability;

    const key = { orgId_userId_clientId: { orgId: ctx.orgId, userId, clientId } };
    const previous = await tx.oAuthConnection.findUnique({ where: key, select: { capabilityId: true } });
    const connectedAt = new Date();
    const connection = await tx.oAuthConnection.upsert({
      where: key,
      create: { orgId: ctx.orgId, userId, clientId, capabilityId: capability.id, connectedAt },
      update: { capabilityId: capability.id, connectedAt, revokedAt: null },
      select: { id: true },
    });
    if (previous) {
      await tx.capability.updateMany({
        where: { id: previous.capabilityId, orgId: ctx.orgId, revokedAt: null },
        data: { revokedAt: connectedAt },
      });
    }

    return {
      ok: true as const,
      connection: {
        id: connection.id,
        clientId,
        capabilityId: capability.id,
        agentId: capability.agentId,
        scopePath: capability.scopePath,
        permission: capability.permission,
        expiresAt: capability.expiresAt,
        connectedAt,
      },
    };
  });
}

/**
 * The live connection from `clientId` for this person in this org, or null when
 * there is none: never connected, revoked, or its capability revoked or expired.
 */
export async function liveOAuthConnection(
  orgId: string,
  userId: string,
  clientId: string,
): Promise<OAuthConnectionView | null> {
  const now = new Date();
  const row = await db.oAuthConnection.findFirst({
    where: {
      orgId,
      userId,
      clientId,
      revokedAt: null,
      capability: { revokedAt: null, expiresAt: { gt: now } },
    },
    select: {
      id: true,
      clientId: true,
      connectedAt: true,
      capability: { select: { id: true, agentId: true, scopePath: true, permission: true, expiresAt: true } },
    },
  });
  return row && toView(row);
}

function toView(row: {
  id: string;
  clientId: string;
  connectedAt: Date;
  capability: { id: string; agentId: string; scopePath: string; permission: Permission; expiresAt: Date };
}): OAuthConnectionView {
  const { capability, ...connection } = row;
  return {
    ...connection,
    capabilityId: capability.id,
    agentId: capability.agentId,
    scopePath: capability.scopePath,
    permission: capability.permission,
    expiresAt: capability.expiresAt,
  };
}

/**
 * The person's live connections in `ctx`'s org, newest first, each with its scope's
 * name: the apps they have connected and can still disconnect. Another person's
 * connections are never listed, whatever the caller's role; an admin sees every
 * capability on the Access page.
 */
export async function listOAuthConnections(
  ctx: AccessContext,
): Promise<(OAuthConnectionView & { scopeName: string })[]> {
  const rows = await db.oAuthConnection.findMany({
    where: {
      orgId: ctx.orgId,
      userId: ctx.actor.id,
      revokedAt: null,
      capability: { revokedAt: null, expiresAt: { gt: new Date() } },
    },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      clientId: true,
      connectedAt: true,
      capability: { select: { id: true, agentId: true, scopePath: true, permission: true, expiresAt: true } },
    },
  });
  const scopes = await db.scope.findMany({
    where: { orgId: ctx.orgId, path: { in: rows.map((row) => row.capability.scopePath) } },
    select: { path: true, name: true },
  });
  const nameOf = new Map(scopes.map((scope) => [scope.path, scope.name]));
  return rows.map((row) => ({
    ...toView(row),
    scopeName: nameOf.get(row.capability.scopePath) ?? row.capability.scopePath,
  }));
}

/**
 * Revoke one of the person's own connections in `ctx`'s org, and its capability.
 *
 * Returns null for an id that is not theirs in this org, so another person's
 * connection answers like one that does not exist. Revoking twice keeps the first
 * timestamp: that is when access ended. A capability an admin already revoked keeps
 * its own timestamp. The first revoke writes one `oauth.disconnected` audit row, in
 * the same transaction, naming the app and the scope it could reach.
 */
export async function revokeOAuthConnection(
  ctx: AccessContext,
  connectionId: string,
): Promise<{ revokedAt: Date; alreadyRevoked: boolean } | null> {
  return db.$transaction(async (tx) => {
    // Locked, so a reconnect cannot bind a new capability between this read and
    // the revoke below and leave that capability live under a revoked connection.
    const [connection] = await tx.$queryRaw<
      { clientId: string; capabilityId: string; scopePath: string; revokedAt: Date | null }[]
    >`
      SELECT oc."clientId", oc."capabilityId", c."scopePath", oc."revokedAt"
      FROM "oauth_connections" oc
      JOIN "capabilities" c ON c."id" = oc."capabilityId"
      WHERE oc."id" = ${connectionId} AND oc."orgId" = ${ctx.orgId} AND oc."userId" = ${ctx.actor.id}
      FOR UPDATE OF oc
    `;
    if (!connection) return null;
    if (connection.revokedAt) return { revokedAt: connection.revokedAt, alreadyRevoked: true };

    const revokedAt = new Date();
    await tx.oAuthConnection.update({ where: { id: connectionId }, data: { revokedAt } });
    await tx.capability.updateMany({
      where: { id: connection.capabilityId, orgId: ctx.orgId, revokedAt: null },
      data: { revokedAt },
    });
    await writeAuditRow(
      {
        orgId: ctx.orgId,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        action: "oauth.disconnected" satisfies DerivedAuditAction,
        target: `${connection.scopePath}/oauth_connection:${connectionId}`,
        decision: "allow",
        metadata: { connectionId, clientId: connection.clientId, capabilityId: connection.capabilityId },
        runId: ctx.runId,
        origin: ctx.origin,
      },
      tx,
    );
    return { revokedAt, alreadyRevoked: false };
  });
}
