// The parts of Willder's OAuth server that discovery and the token checks share and
// that touch no database: the scopes it defines, and how resource URLs compare.
// Kept apart from ./oauth-authorization.ts so mcp/oauth-discovery.ts can import them
// without building the database client.

/** The OAuth scopes this server defines. What a token reaches is still its capability. */
export const OAUTH_SCOPES = ["memory:read", "memory:write"] as const;

/**
 * `uri` in the form two resource URLs are compared in: scheme and host lowercased by
 * the URL parser, no trailing slash, no fragment. Null when it is not an absolute
 * http(s) URL or carries a fragment, which RFC 8707 forbids.
 */
export function canonicalResource(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash || uri.includes("#")) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}
