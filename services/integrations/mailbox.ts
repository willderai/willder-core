// Mailbox (Gmail/Outlook) integration: OAuth links and code exchange, sealing
// and unsealing stored tokens (AES-256-GCM under APP_ENCRYPTION_KEY), and
// revoking the grant on disconnect.
//
// A connection asks only for the account's identity (MAILBOX_SCOPES): nothing in
// Willder reads, sends or watches mail, so no mail permission is requested until a
// feature needs one. A mailbox saves nothing to memory.
//
// The one rule this file enforces: a token is sealed with sealTokens() before
// it is persisted; nothing stores a raw OAuth token.
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Set MAILBOX_OAUTH_MOCK=false to use real Gmail/Outlook OAuth. */
export const MAILBOX_OAUTH_MOCK = process.env.MAILBOX_OAUTH_MOCK !== "false";

export type MailboxProvider = "gmail" | "outlook";
export const MAILBOX_PROVIDERS: MailboxProvider[] = ["gmail", "outlook"];
export const isMailboxProvider = (v: string): v is MailboxProvider => (MAILBOX_PROVIDERS as string[]).includes(v);

/**
 * Every permission a mailbox connection requests: who the account is, nothing in
 * the mailbox. Gmail still asks for offline access (a refresh token) so that a
 * disconnect can revoke the grant at Google after the access token has expired.
 * Outlook needs `User.Read` for the profile lookup in exchangeCode.
 */
export const MAILBOX_SCOPES: Readonly<Record<MailboxProvider, readonly string[]>> = {
  gmail: ["openid", "email"],
  outlook: ["openid", "email", "User.Read"],
};

export interface ExchangedAccount {
  accountId: string;
  email?: string;
  tokens: Record<string, unknown>;
}

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
const redirectUri = (provider: MailboxProvider) => `${appUrl()}/api/integrations/${provider}/callback`;

// ── Auth link ──────────────────────────────────────────────────────────────────

/**
 * Where to send the browser to authorize. `state` is the signed state from
 * services/integrations/connector-oauth.ts's signState, which the callback
 * verifies before touching any row. In mock mode the URL points straight back at
 * our callback with a fake code, carrying the same signed state.
 */
export function createAuthLink(opts: { provider: MailboxProvider; state: string }): string {
  if (MAILBOX_OAUTH_MOCK) {
    const params = new URLSearchParams({
      mock: "1",
      state: opts.state,
      code: `mock_code_${randomUUID().slice(0, 8)}`,
    });
    return `${redirectUri(opts.provider)}?${params}`;
  }

  const base =
    opts.provider === "gmail"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

  const clientId = opts.provider === "gmail" ? process.env.GOOGLE_CLIENT_ID! : process.env.MICROSOFT_CLIENT_ID!;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(opts.provider),
    response_type: "code",
    state: opts.state,
    scope: MAILBOX_SCOPES[opts.provider].join(" "),
    ...(opts.provider === "gmail" ? { access_type: "offline", prompt: "consent" } : {}),
  });

  return `${base}?${params}`;
}

// ── Code exchange ──────────────────────────────────────────────────────────────

export async function exchangeCode(opts: { provider: MailboxProvider; code: string }): Promise<ExchangedAccount> {
  if (MAILBOX_OAUTH_MOCK) {
    const accountId = `mock_${opts.provider}_${randomUUID().slice(0, 8)}`;
    const email = `demo-${opts.provider}@example.com`;
    return { accountId, email, tokens: { mock: true, code: opts.code } };
  }

  if (opts.provider === "gmail") {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: opts.code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri("gmail"),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Gmail token exchange failed: ${err}`);
    }
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    // Fetch the user's email address
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = (await profileRes.json()) as { sub: string; email?: string };

    return {
      accountId: profile.sub,
      email: profile.email,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        token_type: tokens.token_type,
      },
    };
  }

  // Outlook
  const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      redirect_uri: redirectUri("outlook"),
      grant_type: "authorization_code",
      scope: MAILBOX_SCOPES.outlook.join(" "),
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Outlook token exchange failed: ${err}`);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const profileRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = (await profileRes.json()) as { id: string; mail?: string; userPrincipalName?: string };

  return {
    accountId: profile.id,
    email: profile.mail ?? profile.userPrincipalName,
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    },
  };
}

// ── Token encryption (AES-256-GCM) ────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("APP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  return Buffer.from(hex, "hex");
}

export function sealTokens(tokens: Record<string, unknown>): string {
  if (MAILBOX_OAUTH_MOCK) return `mock:${JSON.stringify(tokens)}`;

  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(tokens), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext — all base64
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function unsealTokens(sealed: string): Record<string, unknown> {
  if (sealed.startsWith("mock:")) {
    try {
      return JSON.parse(sealed.slice(5)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  const key = getEncryptionKey();
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
}

// ── Disconnect ────────────────────────────────────────────────────────────────

/**
 * Where a person removes Willder's Outlook consent themselves. Microsoft's identity
 * platform has no endpoint an app can call to revoke a user's own grant, so a
 * disconnect can only delete our copy of the token and point here.
 */
const OUTLOOK_CONSENT_PAGES =
  "https://myapps.microsoft.com (work or school) or https://account.live.com/consent/Manage (personal)";

/**
 * Revoke the mailbox grant at the provider, so the account no longer lists Willder
 * as having access. A mock connection has nothing upstream and returns at once. Throws when the provider did not confirm the revoke; the caller
 * deletes its own copy of the token either way and reports the failure.
 *
 * Gmail: the refresh token is revoked at Google, which ends the whole grant. An
 * `invalid_token` answer for a refresh token means it was already revoked, which is
 * the outcome we wanted; for an access token it may only mean the token expired
 * while the grant lives on, so it is a failure.
 *
 * Outlook: always throws, naming the pages where the user removes the consent.
 */
export async function revokeMailboxGrant(provider: MailboxProvider, tokens: Record<string, unknown>): Promise<void> {
  // Decided by what was stored, not by the current MAILBOX_OAUTH_MOCK setting: a
  // real grant connected before the flag was flipped on must still be revoked.
  if (tokens.mock === true) return;

  if (provider === "outlook") {
    throw new Error(`Microsoft has no revoke endpoint for a user's grant; remove Willder at ${OUTLOOK_CONSENT_PAGES}`);
  }

  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
  const token = refreshToken ?? (typeof tokens.access_token === "string" ? tokens.access_token : undefined);
  if (!token) throw new Error("Google revoke skipped: the stored grant holds no token");

  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (refreshToken && body.error === "invalid_token") return;
  throw new Error(`Google revoke failed: HTTP ${res.status}${body.error ? ` ${body.error}` : ""}`);
}
