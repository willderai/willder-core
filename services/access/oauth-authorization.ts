// Willder's OAuth 2.1 authorization server for the hosted MCP endpoint: the
// authorization request, the person's consent, the code exchange with PKCE, refresh
// token rotation, and the lookup /api/mcp runs on every OAuth access token.
//
// A person consents on the authorize page by choosing a scope and a permission.
// That choice becomes an ordinary capability, minted by connectOAuthClient() through
// issueCapability(), so it is never wider than what the person administers. Every
// code and token is bound to that capability and runs as nothing else: check()
// decides each tool call exactly as it does for a `wcap_` token.
//
// The one rule this file enforces: an OAuth token is live only while its own row is
// unrevoked and unexpired, it was issued for a resource this server serves, its
// connection is unrevoked and still bound to the token's capability, and that
// capability resolves. Revoking the connection or the capability, or connecting the
// client again, ends every token issued before it on the next request.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import type { AccessContext, Permission } from "./check";
import { connectOAuthClient } from "./oauth-connection";
import { findOAuthClient, resolveRedirectUri, type OAuthClientView } from "./oauth-client";
import { canonicalResource } from "./oauth-protocol";

const ACCESS_TOKEN_PREFIX = "wat_";
const REFRESH_TOKEN_PREFIX = "wrt_";
const CODE_PREFIX = "wac_";

/** An access token lives an hour, or less when its capability expires sooner. */
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** An authorization code must be exchanged within five minutes. */
const CODE_TTL_MS = 5 * 60 * 1000;
/**
 * A refresh token presented again within this window of its first use is refused
 * without revoking its family. A client that refreshes twice at once (on a 401 and on
 * its own timer) would otherwise lose its connection to its own race.
 */
const REFRESH_REUSE_LEEWAY_MS = 60 * 1000;

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
/** A base64url SHA-256 digest: 43 characters. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const newSecret = (prefix: string) => prefix + randomBytes(32).toString("base64url");

/** True when `token` has the shape of an access token this server issues. Shape only. */
export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

/** The permissions a request's OAuth `scope` lets the person choose from. */
export function permissionsForScope(scope: string | undefined): Permission[] {
  const requested = new Set((scope ?? "").split(" ").filter(Boolean));
  // Asking only for read caps the consent at read. Asking for write, or for no
  // scope this server defines, leaves the choice to the person.
  return requested.has("memory:read") && !requested.has("memory:write") ? ["read"] : ["read", "write"];
}

/** The OAuth scope a token reports for the permission its capability carries. */
function scopeForPermission(permission: Permission): string {
  return permission === "read" ? "memory:read" : "memory:read memory:write";
}

/** An authorization request that passed every check, ready for the consent page. */
export interface AuthorizationRequest {
  client: OAuthClientView;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | undefined;
  scope: string | undefined;
  permissions: Permission[];
}

/**
 * The outcome of {@link validateAuthorizationRequest}. A refusal is shown to the
 * person and never sent to the redirect URI: with open registration a redirect URI
 * proves nothing about the app, so redirecting errors to it would make the authorize
 * page an open redirector (RFC 9700 section 4.11.2).
 */
export type AuthorizationValidation = { ok: true; request: AuthorizationRequest } | { ok: false; show: string };

/**
 * Check an authorization request's parameters, in the order OAuth 2.1 requires: the
 * client and its redirect URI first, everything else after. `resources` are the
 * canonical MCP resource URLs this server issues tokens for; a request naming no
 * resource gets the first.
 */
export async function validateAuthorizationRequest(
  params: URLSearchParams,
  resources: string[],
): Promise<AuthorizationValidation> {
  const single = (name: string): string | undefined | null => {
    const values = params.getAll(name);
    if (values.length > 1) return null;
    return values[0] || undefined;
  };

  const clientId = single("client_id");
  if (!clientId)
    return { ok: false, show: "The request names no app (client_id). Start the connection again from your app." };
  const client = await findOAuthClient(clientId);
  if (!client) {
    return {
      ok: false,
      show: "The app in this request is not registered with Willder. Start the connection again from your app.",
    };
  }
  const requestedRedirect = single("redirect_uri");
  const redirectUri = requestedRedirect === null ? null : resolveRedirectUri(client, requestedRedirect);
  if (!redirectUri) {
    return {
      ok: false,
      show: "The app asked to be answered at an address it did not register. Start the connection again from your app.",
    };
  }

  const state = single("state") ?? undefined;
  const fail = (description: string): AuthorizationValidation => ({
    ok: false,
    show: `The app's request is not valid: ${description}. Start the connection again from your app.`,
  });

  const duplicated = ["response_type", "code_challenge", "code_challenge_method", "resource", "scope", "state"].find(
    (name) => single(name) === null,
  );
  if (duplicated) return fail(`${duplicated} is repeated`);
  if (single("response_type") !== "code") return fail("response_type must be code");

  const codeChallenge = single("code_challenge");
  if (!codeChallenge || single("code_challenge_method") !== "S256" || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    return fail("PKCE is required: send code_challenge with code_challenge_method=S256");
  }

  const requestedResource = single("resource");
  const resource = requestedResource ? canonicalResource(requestedResource) : resources[0];
  if (!resource || !resources.includes(resource)) {
    return fail("resource is not an MCP endpoint this server issues tokens for");
  }

  const scope = single("scope") ?? undefined;
  return {
    ok: true,
    request: { client, redirectUri, codeChallenge, resource, state, scope, permissions: permissionsForScope(scope) },
  };
}

/**
 * The URL an authorization response sends the person's browser to: the client's
 * verified redirect URI with `params`, the request's `state`, and `iss` (RFC 9207),
 * so the client can tell which server answered. Parameters the registered URI
 * already carries are kept.
 */
export function authorizationResponseUrl(
  redirectUri: string,
  issuer: string,
  state: string | undefined,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

/**
 * The audit-log name a connection gets when the person types none: the client's own
 * name plus a piece of its client id, such as "Claude (k3J9x_Qa)". The client chooses
 * its name, so the name alone could equal an Agent in the org and run as that agent
 * (canonicalAgentId resolves names), or merge two different apps under one id.
 */
export function defaultAgentName(client: OAuthClientView): string {
  return `${client.name ?? "OAuth app"} (${client.id.slice(4, 12)})`;
}

/** What the person chose on the consent page. Unchecked until {@link approveAuthorization} runs. */
export interface ConsentChoice {
  scopePath?: string;
  permission?: string;
  /** The name the client's calls carry in the audit log. Defaults to the client's own name. */
  agentName?: string;
}

/**
 * Record the person's consent to `request`: connect the client at the scope and
 * permission they chose (connectOAuthClient, which refuses anything wider than they
 * administer), then issue a one-time code bound to that capability.
 */
export async function approveAuthorization(
  ctx: AccessContext,
  request: AuthorizationRequest,
  choice: ConsentChoice,
): Promise<{ ok: true; code: string } | { ok: false; status: 400 | 403 | 404; error: string }> {
  const permission = request.permissions.find((p) => p === choice.permission);
  if (!permission) {
    return { ok: false, status: 400, error: `permission must be one of: ${request.permissions.join(", ")}` };
  }
  const connected = await connectOAuthClient(ctx, {
    clientId: request.client.id,
    agentId: choice.agentName?.trim() || defaultAgentName(request.client),
    scopePath: choice.scopePath,
    permission,
  });
  if (!connected.ok) return connected;

  const code = newSecret(CODE_PREFIX);
  await db.oAuthAuthorizationCode.create({
    data: {
      codeHash: hash(code),
      clientId: request.client.id,
      connectionId: connected.connection.id,
      capabilityId: connected.connection.capabilityId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scope: scopeForPermission(permission),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return { ok: true, code };
}

/** A token endpoint success body (RFC 6749 section 5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** A token endpoint refusal (RFC 6749 section 5.2). */
export interface TokenError {
  error: "invalid_request" | "invalid_grant" | "unsupported_grant_type" | "invalid_target";
  error_description: string;
}

type TokenResult = { ok: true; body: TokenResponse } | { ok: false; error: TokenError };

const grantRefused = (description: string): TokenResult => ({
  ok: false,
  error: { error: "invalid_grant", error_description: description },
});

/** True when base64url(SHA-256(verifier)) equals the stored challenge. */
function verifierMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * The capability's expiry when the connection is unrevoked, still bound to
 * `capabilityId`, and the capability is unrevoked and unexpired; null otherwise.
 */
async function liveBindingExpiry(connectionId: string, capabilityId: string): Promise<Date | null> {
  const connection = await db.oAuthConnection.findFirst({
    where: {
      id: connectionId,
      capabilityId,
      revokedAt: null,
      capability: { revokedAt: null, expiresAt: { gt: new Date() } },
    },
    select: { capability: { select: { expiresAt: true } } },
  });
  return connection?.capability.expiresAt ?? null;
}

/** Issue an access and refresh token pair in `familyId`, bound to one capability. */
async function issueTokenPair(binding: {
  clientId: string;
  connectionId: string;
  capabilityId: string;
  familyId: string;
  resource: string;
  scope: string;
  capabilityExpiresAt: Date;
}): Promise<TokenResponse> {
  const { capabilityExpiresAt, ...row } = binding;
  const now = Date.now();
  const accessExpiresAt = new Date(Math.min(now + ACCESS_TOKEN_TTL_MS, capabilityExpiresAt.getTime()));
  const accessToken = newSecret(ACCESS_TOKEN_PREFIX);
  const refreshToken = newSecret(REFRESH_TOKEN_PREFIX);
  await db.oAuthToken.createMany({
    data: [
      { ...row, kind: "access", tokenHash: hash(accessToken), expiresAt: accessExpiresAt },
      { ...row, kind: "refresh", tokenHash: hash(refreshToken), expiresAt: capabilityExpiresAt },
    ],
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((accessExpiresAt.getTime() - now) / 1000)),
    refresh_token: refreshToken,
    scope: binding.scope,
  };
}

/** Revoke every token issued from one authorization code. */
async function revokeFamily(familyId: string): Promise<void> {
  await db.oAuthToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/**
 * The `authorization_code` grant. The code is spent by the first request that
 * presents it, before anything else is checked, so a wrong verifier or client burns
 * it. A code presented a second time revokes every token issued from it
 * (OAuth 2.1 section 4.1.3).
 */
export async function exchangeAuthorizationCode(request: {
  code?: string;
  clientId?: string;
  redirectUri?: string;
  codeVerifier?: string;
  resource?: string;
}): Promise<TokenResult> {
  const { code, clientId, codeVerifier } = request;
  if (!code || !clientId || !codeVerifier) {
    return {
      ok: false,
      error: { error: "invalid_request", error_description: "code, client_id and code_verifier are required" },
    };
  }

  const codeHash = hash(code);
  const spent = await db.oAuthAuthorizationCode.updateMany({
    where: { codeHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  const row = await db.oAuthAuthorizationCode.findUnique({ where: { codeHash } });
  if (!row) return grantRefused("the authorization code is not valid");
  if (spent.count === 0) {
    // Only the client the code was issued to ends its tokens by replaying it; anyone
    // else holding a spent code is refused without touching the client's connection.
    if (row.clientId === clientId) await revokeFamily(row.id);
    return grantRefused("the authorization code was already used; every token issued from it is revoked");
  }

  if (row.expiresAt <= new Date()) return grantRefused("the authorization code has expired; sign in again");
  if (row.clientId !== clientId) return grantRefused("the authorization code was issued to another client");
  if (request.redirectUri !== undefined && request.redirectUri !== row.redirectUri) {
    return grantRefused("redirect_uri does not match the authorization request");
  }
  if (!CODE_VERIFIER_PATTERN.test(codeVerifier) || !verifierMatches(codeVerifier, row.codeChallenge)) {
    return grantRefused("code_verifier does not match the code_challenge");
  }
  if (request.resource !== undefined && canonicalResource(request.resource) !== row.resource) {
    return {
      ok: false,
      error: { error: "invalid_target", error_description: "resource does not match the authorization request" },
    };
  }

  const capabilityExpiresAt = await liveBindingExpiry(row.connectionId, row.capabilityId);
  if (!capabilityExpiresAt) return grantRefused("the access this app was given has been revoked or has expired");

  return {
    ok: true,
    body: await issueTokenPair({
      clientId: row.clientId,
      connectionId: row.connectionId,
      capabilityId: row.capabilityId,
      familyId: row.id,
      resource: row.resource,
      scope: row.scope,
      capabilityExpiresAt,
    }),
  };
}

/**
 * The `refresh_token` grant, with rotation: each refresh token is exchanged once, for
 * a new pair in the same family. A spent refresh token presented again after the
 * leeway revokes the whole family, since only a copy could still be presenting it.
 */
export async function refreshAccessToken(request: {
  refreshToken?: string;
  clientId?: string;
  resource?: string;
}): Promise<TokenResult> {
  const { refreshToken, clientId } = request;
  if (!refreshToken || !clientId) {
    return {
      ok: false,
      error: { error: "invalid_request", error_description: "refresh_token and client_id are required" },
    };
  }

  const row = await db.oAuthToken.findUnique({ where: { tokenHash: hash(refreshToken) } });
  if (!row || row.kind !== "refresh" || row.clientId !== clientId)
    return grantRefused("the refresh token is not valid");
  if (row.revokedAt) return grantRefused("the refresh token was revoked; sign in again");

  const spent = await db.oAuthToken.updateMany({
    where: { id: row.id, usedAt: null, revokedAt: null },
    data: { usedAt: new Date() },
  });
  if (spent.count === 0) {
    const usedAt = (await db.oAuthToken.findUnique({ where: { id: row.id }, select: { usedAt: true } }))?.usedAt;
    if (!usedAt || Date.now() - usedAt.getTime() > REFRESH_REUSE_LEEWAY_MS) await revokeFamily(row.familyId);
    return grantRefused("the refresh token was already used");
  }

  if (row.expiresAt <= new Date()) return grantRefused("the refresh token has expired; sign in again");
  if (request.resource !== undefined && canonicalResource(request.resource) !== row.resource) {
    return {
      ok: false,
      error: { error: "invalid_target", error_description: "resource does not match the original authorization" },
    };
  }
  const capabilityExpiresAt = await liveBindingExpiry(row.connectionId, row.capabilityId);
  if (!capabilityExpiresAt) {
    await revokeFamily(row.familyId);
    return grantRefused("the access this app was given has been revoked or has expired; sign in again");
  }

  return {
    ok: true,
    body: await issueTokenPair({
      clientId: row.clientId,
      connectionId: row.connectionId,
      capabilityId: row.capabilityId,
      familyId: row.familyId,
      resource: row.resource,
      scope: row.scope,
      capabilityExpiresAt,
    }),
  };
}

/**
 * The capability an OAuth access token runs as, or null when the token is unknown,
 * revoked, expired, or issued for a resource not in `resources`.
 *
 * `bindingLive` is false when the token's connection was revoked or bound to a new
 * capability since the token was issued: the caller must refuse it. The capability
 * itself is not checked here. The caller resolves it with resolveCapability(), which
 * refuses a revoked or expired one and records the refusal as it does for a dead
 * `wcap_` token, so a disconnected app's next call leaves a row in the audit log.
 */
export async function resolveOAuthAccessToken(
  token: string,
  resources: string[],
): Promise<{ capabilityId: string; bindingLive: boolean } | null> {
  const row = await db.oAuthToken.findUnique({
    where: { tokenHash: hash(token) },
    select: {
      kind: true,
      capabilityId: true,
      resource: true,
      expiresAt: true,
      revokedAt: true,
      connection: { select: { capabilityId: true, revokedAt: true } },
    },
  });
  if (!row || row.kind !== "access" || row.revokedAt || row.expiresAt <= new Date()) return null;
  if (!resources.includes(row.resource)) return null;
  const bindingLive = !row.connection.revokedAt && row.connection.capabilityId === row.capabilityId;
  return { capabilityId: row.capabilityId, bindingLive };
}
