// OAuth discovery for the hosted MCP endpoint (`/api/mcp`).
//
// An MCP client that speaks OAuth (claude.ai, ChatGPT) finds out how to sign in from
// two documents: the endpoint's Protected Resource Metadata (RFC 9728), which names
// the resource and its authorization server, and that server's metadata (RFC 8414),
// which names its endpoints. Willder is its own authorization server, on the same
// host as the endpoint (services/access/oauth-authorization.ts). This file builds
// both documents and the `WWW-Authenticate` challenge a 401 carries.
//
// The one rule this file enforces: with MCP_OAUTH_ENABLED anything but `true` there
// is no OAuth surface. Neither document exists (404), the 401 carries no challenge,
// and /api/mcp treats an OAuth token as an unknown capability token. mcpOAuthEnabled()
// is the one reading of the flag, so the authorize page, the register and token
// endpoints and /api/access/oauth-connections switch on and off with discovery.

// The leaf module, not the `@/services/access` barrel, which builds the database client on import.
import { canonicalResource, OAUTH_SCOPES } from "@/services/access/oauth-protocol";

/** The path of the MCP resource on this server. */
const MCP_RESOURCE_PATH = "/api/mcp";

/** Where RFC 9728 section 3.1 places the metadata for the resource at MCP_RESOURCE_PATH. */
const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;

/** The authorization server's endpoints, relative to its issuer (this origin). */
const AUTHORIZATION_ENDPOINT_PATH = "/oauth/authorize";
const TOKEN_ENDPOINT_PATH = "/api/oauth/token";
const REGISTRATION_ENDPOINT_PATH = "/api/oauth/register";

/** The scopes a client is told to request. What it reaches is chosen on the consent page. */
const CHALLENGE_SCOPE = OAUTH_SCOPES.join(" ");

/**
 * True only when MCP_OAUTH_ENABLED is exactly `true`. Any other value leaves every
 * OAuth surface off.
 */
export function mcpOAuthEnabled(): boolean {
  return process.env.MCP_OAUTH_ENABLED === "true";
}

/**
 * The canonical MCP resource URLs this server issues OAuth tokens for, from
 * MCP_OAUTH_RESOURCES (comma-separated). A token is accepted on /api/mcp only for one
 * of them. The list is configured, never taken from the request's Host header, which
 * the caller controls. Entries that are not absolute URLs are dropped.
 */
export function mcpOAuthResources(): string[] {
  return (process.env.MCP_OAUTH_RESOURCES ?? "")
    .split(",")
    .map((entry) => canonicalResource(entry.trim()))
    .filter((resource): resource is string => resource !== null);
}

/**
 * The `WWW-Authenticate` value for a 401 from `/api/mcp`, or null when OAuth is off.
 * `origin` is the origin the client called, so the metadata URL it names is on the
 * same host as the resource. `scope` tells the client what to request (MCP
 * authorization, scope selection). `invalidToken` adds RFC 6750's
 * `error="invalid_token"` for a token that was presented and refused, so the client
 * refreshes or signs in again; a request with no token gets no error code, as RFC
 * 6750 section 3.1 asks.
 */
export function mcpBearerChallenge(origin: string, { invalidToken = false } = {}): string | null {
  if (!mcpOAuthEnabled()) return null;
  const error = invalidToken ? `, error="invalid_token"` : "";
  return `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}", scope="${CHALLENGE_SCOPE}"${error}`;
}

/**
 * The 503 for a host whose MCP URL is not in MCP_OAUTH_RESOURCES, or null when it is.
 * A client that read metadata for an unlisted resource would sign the person in and
 * then be refused every token, so discovery refuses up front and names the fix.
 */
function unlistedResourceResponse(resource: string): Response | null {
  if (mcpOAuthResources().includes(resource)) return null;
  return Response.json(
    {
      error:
        `MCP_OAUTH_ENABLED is true but ${resource} is not listed in MCP_OAUTH_RESOURCES, so no OAuth token ` +
        "can be issued for it. Add this endpoint's public URL to MCP_OAUTH_RESOURCES (docs/environment.md), " +
        "or unset MCP_OAUTH_ENABLED.",
    },
    { status: 503 },
  );
}

/**
 * Serves the Protected Resource Metadata document for `/api/mcp`.
 *
 * The resource and the issuer are named from the request's own origin: RFC 9728
 * section 3.3 has a client reject metadata whose `resource` differs from the URL it is
 * connecting to. Which resources may actually receive tokens is still the configured
 * list, checked here and again on every token.
 */
export function protectedResourceMetadataResponse(req: Request): Response {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });
  const origin = new URL(req.url).origin;
  const resource = `${origin}${MCP_RESOURCE_PATH}`;
  const unlisted = unlistedResourceResponse(resource);
  if (unlisted) return unlisted;

  return Response.json({
    resource,
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  });
}

/**
 * Serves the Authorization Server Metadata document (RFC 8414) at
 * `/.well-known/oauth-authorization-server`. The issuer is this origin, so it equals
 * the `authorization_servers` entry above exactly, as ChatGPT requires.
 *
 * Clients register by dynamic client registration and are public: they authenticate
 * at the token endpoint with PKCE alone (`none`). `iss` is returned on every
 * authorization response (RFC 9207), which lets ChatGPT use its stable redirect URI.
 * Client ID Metadata Documents are not supported, so they are not advertised, and
 * claude.ai and ChatGPT both fall back to registration.
 */
export function authorizationServerMetadataResponse(req: Request): Response {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });
  const origin = new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZATION_ENDPOINT_PATH}`,
    token_endpoint: `${origin}${TOKEN_ENDPOINT_PATH}`,
    registration_endpoint: `${origin}${REGISTRATION_ENDPOINT_PATH}`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });
}
