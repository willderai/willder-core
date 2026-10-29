// Per-org OAuth for knowledge-source connectors (Slack, Figma): the customer
// authorizes Willder against their own workspace/account, and the resulting
// token is stored encrypted on that org's Integration row. The mailbox OAuth
// flow (./mailbox.ts) is separate because it sends mail and registers push
// watches; this module only reads.
//
// The one rule this file enforces: a callback is accepted only for a pending
// Integration that the signed `state` names, belonging to the org of the
// signed-in owner/admin completing it. `state` is an HMAC over the integration
// id, org id, provider and expiry, so a forged, replayed-after-expiry or
// cross-org callback cannot attach a token to someone else's row. The mailbox
// callback (gmail | outlook) uses the same signed state, so both OAuth flows
// share one state format and one key.
//
// Fixture mode follows the connector modules' own flags (SLACK_MOCK /
// FIGMA_MOCK), which are forced off in production. In fixture mode the
// authorize URL points straight back at our callback and no token is stored,
// so a fixture connection is never mistaken for a real one.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SLACK_MOCK } from "@/services/connectors/slack";
import { FIGMA_MOCK } from "@/services/connectors/figma";
import type { MailboxProvider } from "@/services/integrations/mailbox";

export type ConnectorOAuthProvider = "slack" | "figma";
export const CONNECTOR_OAUTH_PROVIDERS: ConnectorOAuthProvider[] = ["slack", "figma"];
export const isConnectorOAuthProvider = (v: string): v is ConnectorOAuthProvider =>
  (CONNECTOR_OAUTH_PROVIDERS as string[]).includes(v);

/** How long a connect attempt may take before its state stops being accepted. */
export const STATE_TTL_MS = 10 * 60 * 1000;

interface ProviderConfig {
  authorizeUrl: string;
  /** Read-only scopes: exactly what services/connectors/<provider>.ts calls. */
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  isMock: () => boolean;
}

const PROVIDERS: Record<ConnectorOAuthProvider, ProviderConfig> = {
  slack: {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    // conversations.history and conversations.replies, plus conversations.list for picking a channel.
    scopes: ["channels:history", "channels:read"],
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
    isMock: () => SLACK_MOCK,
  },
  figma: {
    authorizeUrl: "https://www.figma.com/oauth",
    // GET /v1/files/:key/comments.
    scopes: ["file_comments:read"],
    clientIdEnv: "FIGMA_CLIENT_ID",
    clientSecretEnv: "FIGMA_CLIENT_SECRET",
    isMock: () => FIGMA_MOCK,
  },
};

export const isConnectorOAuthMock = (provider: ConnectorOAuthProvider) => PROVIDERS[provider].isMock();

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";

/** The redirect URI registered with the provider's OAuth app. */
export const connectorRedirectUri = (provider: ConnectorOAuthProvider) =>
  `${appUrl()}/api/integrations/${provider}/callback`;

function clientCredentials(provider: ConnectorOAuthProvider): { clientId: string; clientSecret: string } {
  const { clientIdEnv, clientSecretEnv } = PROVIDERS[provider];
  const clientId = process.env[clientIdEnv];
  const clientSecret = process.env[clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new ConnectorOAuthConfigError(`${clientIdEnv} and ${clientSecretEnv} must be set to connect ${provider}`);
  }
  return { clientId, clientSecret };
}

/** The server is missing the provider's OAuth app credentials. */
export class ConnectorOAuthConfigError extends Error {}

/**
 * Throws ConnectorOAuthConfigError when a real (non-fixture) connect could not
 * complete, so the route can refuse before creating a pending row.
 */
export function assertConnectorOAuthConfigured(provider: ConnectorOAuthProvider): void {
  if (!isConnectorOAuthMock(provider)) clientCredentials(provider);
  stateKey();
}

// ── Signed state ─────────────────────────────────────────────────────────────

/** Every provider whose OAuth callback resolves its pending row through a signed state. */
export type SignedStateProvider = ConnectorOAuthProvider | MailboxProvider;

function stateKey(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64)
    throw new ConnectorOAuthConfigError("APP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  // A derived key, so the state MAC and the token cipher never share key material.
  return createHmac("sha256", Buffer.from(hex, "hex")).update("connector-oauth-state").digest();
}

function stateMac(integrationId: string, orgId: string, provider: string, expiresAtMs: number): Buffer {
  return createHmac("sha256", stateKey()).update(`${integrationId}\n${orgId}\n${provider}\n${expiresAtMs}`).digest();
}

/** `<integrationId>.<expiresAtMs>.<mac>`; the org is bound by the MAC, not carried. */
export function signState(opts: {
  integrationId: string;
  orgId: string;
  provider: SignedStateProvider;
  now?: number;
}): { state: string; expiresAt: Date } {
  const expiresAtMs = (opts.now ?? Date.now()) + STATE_TTL_MS;
  const mac = stateMac(opts.integrationId, opts.orgId, opts.provider, expiresAtMs).toString("base64url");
  return { state: `${opts.integrationId}.${expiresAtMs}.${mac}`, expiresAt: new Date(expiresAtMs) };
}

/** The integration id a state names, before its MAC is checked; null if malformed. */
export function stateIntegrationId(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[0])) return null;
  return parts[0];
}

/** True only if `state` was signed for exactly this integration, org and provider and has not expired. */
export function verifyState(
  state: string,
  expected: { integrationId: string; orgId: string; provider: SignedStateProvider; now?: number },
): boolean {
  const [integrationId, expiresAtRaw, macRaw] = state.split(".");
  if (integrationId !== expected.integrationId || !/^\d{1,16}$/.test(expiresAtRaw ?? "") || !macRaw) return false;
  const expiresAtMs = Number(expiresAtRaw);
  if (expiresAtMs <= (expected.now ?? Date.now())) return false;
  const want = stateMac(expected.integrationId, expected.orgId, expected.provider, expiresAtMs);
  const got = Buffer.from(macRaw, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ── Authorize URL ────────────────────────────────────────────────────────────

/** Where to send the browser to authorize. In fixture mode, straight to our callback. */
export function buildAuthorizeUrl(provider: ConnectorOAuthProvider, state: string): string {
  const redirectUri = connectorRedirectUri(provider);
  if (isConnectorOAuthMock(provider)) {
    const params = new URLSearchParams({ mock: "1", state, code: `mock_code_${randomUUID().slice(0, 8)}` });
    return `${redirectUri}?${params}`;
  }
  const { authorizeUrl, scopes } = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: clientCredentials(provider).clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(","),
    state,
    response_type: "code",
  });
  return `${authorizeUrl}?${params}`;
}

// ── Code exchange ────────────────────────────────────────────────────────────

export interface ConnectedAccount {
  /** Slack team id / Figma user id: the unique account key per (org, provider). */
  accountId: string;
  /** Token material to seal at rest; null in fixture mode, where none exists. */
  tokens: Record<string, unknown> | null;
  /** Non-secret display metadata for the Integration row. */
  meta: Record<string, string | boolean | null>;
}

/** Exchange an authorization code for the org's token. Never returns a token in `meta`. */
export async function exchangeConnectorCode(provider: ConnectorOAuthProvider, code: string): Promise<ConnectedAccount> {
  if (isConnectorOAuthMock(provider)) {
    return { accountId: `mock_${provider}_${randomUUID().slice(0, 8)}`, tokens: null, meta: { mock: true } };
  }
  return provider === "slack" ? exchangeSlackCode(code) : exchangeFigmaCode(code);
}

async function exchangeSlackCode(code: string): Promise<ConnectedAccount> {
  const { clientId, clientSecret } = clientCredentials("slack");
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: connectorRedirectUri("slack"),
    }),
  });
  // Slack reports failures as HTTP 200 with ok:false and a short error code.
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    team?: { id?: string; name?: string };
  };
  if (!res.ok || !body.ok || !body.access_token || !body.team?.id) {
    throw new Error(`Slack token exchange failed: ${body.error ?? res.status}`);
  }
  return {
    accountId: body.team.id,
    tokens: { access_token: body.access_token },
    meta: { teamName: body.team.name ?? null, scopes: body.scope ?? null },
  };
}

async function exchangeFigmaCode(code: string): Promise<ConnectedAccount> {
  const { clientId, clientSecret } = clientCredentials("figma");
  const res = await fetch("https://api.figma.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      redirect_uri: connectorRedirectUri("figma"),
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Figma token exchange failed: ${res.status}`);
  const body = (await res.json()) as {
    user_id_string?: string;
    user_id?: number;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const accountId = body.user_id_string ?? (body.user_id !== undefined ? String(body.user_id) : undefined);
  if (!body.access_token || !accountId) throw new Error("Figma token exchange failed: incomplete response");
  return {
    accountId,
    tokens: {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? null,
      expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    },
    meta: { scopes: PROVIDERS.figma.scopes.join(",") },
  };
}

// ── Revocation ───────────────────────────────────────────────────────────────

/**
 * Ask the provider to invalidate a token on disconnect. Slack supports this
 * (auth.revoke); Figma has no token revocation endpoint, so its token is only
 * deleted on our side. Throws when the provider refuses, so the caller decides
 * whether to proceed.
 */
export async function revokeConnectorToken(
  provider: ConnectorOAuthProvider,
  tokens: Record<string, unknown>,
): Promise<void> {
  if (provider !== "slack" || isConnectorOAuthMock(provider)) return;
  const token = tokens.access_token;
  if (typeof token !== "string") return;
  const res = await fetch("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  // An already-invalid token is the outcome we wanted.
  if (!body.ok && body.error !== "invalid_auth" && body.error !== "token_revoked") {
    throw new Error(`Slack auth.revoke failed: ${body.error ?? res.status}`);
  }
}
