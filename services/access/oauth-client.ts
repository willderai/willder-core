// OAuth clients of Willder's authorization server, registered by dynamic client
// registration (RFC 7591), the way claude.ai and ChatGPT register themselves.
//
// Registering grants nothing. A client is a name and a list of redirect URIs; it
// reaches Willder only after a signed-in person consents on the authorize page
// (./oauth-authorization.ts), and then only as the capability that person chose.
// Every client is public: no secret is issued, and PKCE binds each authorization
// code to the client that started the request.
//
// The one rule this file enforces: an authorization response goes only to a
// redirect URI the client registered, compared exactly, except that the port of a
// loopback http URI is ignored (RFC 8252 section 7.3), because native clients
// such as Claude Code listen on a new port each session.

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

const CLIENT_ID_PREFIX = "wcl_";
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 200;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

/** A registered client, as the authorize page and token endpoint read it. */
export interface OAuthClientView {
  id: string;
  name: string | null;
  redirectUris: string[];
}

/** The registration response body (RFC 7591 section 3.2.1). */
export interface OAuthClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
}

/** A refusal in RFC 7591 section 3.2.2's shape. */
export interface OAuthRegistrationError {
  error: "invalid_redirect_uri" | "invalid_client_metadata";
  error_description: string;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** Why `uri` cannot be registered, or null when it can. */
function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri) return "each redirect URI must be a non-empty string";
  if (uri.length > MAX_REDIRECT_URI_LENGTH)
    return `a redirect URI must be at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${uri} is not an absolute URL`;
  }
  if (url.hash || uri.includes("#")) return `${uri} has a fragment, which OAuth forbids in a redirect URI`;
  if (url.username || url.password) return `${uri} carries credentials`;
  if (url.protocol !== "https:" && !isLoopback(url)) {
    return `${uri} must be https, or http to localhost, 127.0.0.1 or [::1]`;
  }
  return null;
}

/**
 * Register a client from its RFC 7591 metadata. Only `redirect_uris` is required;
 * `client_name` is kept for the consent page, unverified. The client is always
 * registered as public (`token_endpoint_auth_method: "none"`), whatever it asked
 * for, and the response says so, as RFC 7591 section 3.2.1 allows.
 */
export async function registerOAuthClient(
  metadata: unknown,
): Promise<{ ok: true; client: OAuthClientRegistration } | { ok: false; error: OAuthRegistrationError }> {
  const invalid = (error: OAuthRegistrationError["error"], description: string) => ({
    ok: false as const,
    error: { error, error_description: description },
  });
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return invalid("invalid_client_metadata", "the registration body must be a JSON object");
  }
  const {
    redirect_uris: redirectUris,
    client_name: clientName,
    grant_types: grantTypes,
    response_types: responseTypes,
  } = metadata as Record<string, unknown>;

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return invalid("invalid_redirect_uri", "redirect_uris must list at least one redirect URI");
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return invalid("invalid_redirect_uri", `redirect_uris may list at most ${MAX_REDIRECT_URIS} URIs`);
  }
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) return invalid("invalid_redirect_uri", problem);
  }

  if (clientName !== undefined && typeof clientName !== "string") {
    return invalid("invalid_client_metadata", "client_name must be a string");
  }
  const name = clientName?.trim().slice(0, MAX_CLIENT_NAME_LENGTH) || null;

  const grants = grantTypes ?? ["authorization_code"];
  if (!Array.isArray(grants) || grants.some((g) => typeof g !== "string" || !SUPPORTED_GRANT_TYPES.has(g))) {
    return invalid("invalid_client_metadata", "grant_types may list only authorization_code and refresh_token");
  }
  const responses = responseTypes ?? ["code"];
  if (!Array.isArray(responses) || responses.some((r) => r !== "code")) {
    return invalid("invalid_client_metadata", "response_types may list only code");
  }

  const client = await db.oAuthClient.create({
    data: {
      id: CLIENT_ID_PREFIX + randomBytes(32).toString("base64url"),
      name,
      redirectUris: [...new Set(redirectUris as string[])],
    },
  });
  return {
    ok: true,
    client: {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      ...(client.name ? { client_name: client.name } : {}),
      redirect_uris: client.redirectUris,
      // A client that may refresh is always told so: every token response carries a refresh token.
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

/** The registered client with this id, or null. */
export async function findOAuthClient(clientId: string): Promise<OAuthClientView | null> {
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  return db.oAuthClient.findUnique({ where: { id: clientId }, select: { id: true, name: true, redirectUris: true } });
}

/** True when `registered` and `requested` name the same loopback endpoint, any port. */
function sameLoopbackEndpoint(registered: URL, requested: URL): boolean {
  return (
    isLoopback(registered) &&
    isLoopback(requested) &&
    registered.hostname === requested.hostname &&
    registered.pathname === requested.pathname &&
    registered.search === requested.search
  );
}

/**
 * The redirect URI an authorization response for `client` goes to, or null when
 * `requested` is not one it registered. With no `requested`, a client that
 * registered exactly one URI gets that one (OAuth 2.1 section 4.1.1).
 */
export function resolveRedirectUri(client: OAuthClientView, requested: string | undefined): string | null {
  if (requested === undefined) return client.redirectUris.length === 1 ? client.redirectUris[0] : null;
  if (client.redirectUris.includes(requested)) return requested;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  return client.redirectUris.some((uri) => sameLoopbackEndpoint(new URL(uri), url)) ? requested : null;
}

/** True when every redirect URI the client registered is a loopback address: the consent page warns. */
export function onlyLoopbackRedirects(client: OAuthClientView): boolean {
  return client.redirectUris.every((uri) => isLoopback(new URL(uri)));
}
