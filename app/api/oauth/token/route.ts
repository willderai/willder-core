// POST /api/oauth/token — the token endpoint of Willder's OAuth server: the
// authorization_code grant with PKCE, and the refresh_token grant with rotation.
// Clients are public, so a client authenticates by client_id alone and PKCE binds
// the code to it. The rules are in services/access/oauth-authorization.ts.
//
// The body is application/x-www-form-urlencoded (RFC 6749 section 4.1.3); claude.ai
// and ChatGPT send that for both grants. Every answer carries `Cache-Control:
// no-store` (section 5.1). Answers 404 unless MCP_OAUTH_ENABLED is `true`.
import { mcpOAuthEnabled } from "@/mcp/oauth-discovery";
import { exchangeAuthorizationCode, refreshAccessToken } from "@/services/access";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function refuse(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: NO_STORE });
}

/** The client_id from the body, or from an HTTP Basic header a client sent anyway (RFC 6749 section 2.3.1). */
function clientIdOf(form: URLSearchParams, req: Request): string | undefined {
  const fromBody = form.get("client_id") ?? undefined;
  if (fromBody) return fromBody;
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!basic) return undefined;
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const id = decoded.slice(0, decoded.includes(":") ? decoded.indexOf(":") : undefined);
  try {
    return id ? decodeURIComponent(id) : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return refuse("invalid_request", "the token request body must be application/x-www-form-urlencoded");
  }
  const form = new URLSearchParams(await req.text());
  const repeated = [...new Set(form.keys())].find((key) => form.getAll(key).length > 1);
  if (repeated) return refuse("invalid_request", `${repeated} is repeated`);

  const field = (name: string) => form.get(name) ?? undefined;
  const clientId = clientIdOf(form, req);
  const grantType = field("grant_type");
  const result =
    grantType === "authorization_code"
      ? await exchangeAuthorizationCode({
          code: field("code"),
          clientId,
          redirectUri: field("redirect_uri"),
          codeVerifier: field("code_verifier"),
          resource: field("resource"),
        })
      : grantType === "refresh_token"
        ? await refreshAccessToken({ refreshToken: field("refresh_token"), clientId, resource: field("resource") })
        : null;
  if (!result) return refuse("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  if (!result.ok) return Response.json(result.error, { status: 400, headers: NO_STORE });
  return Response.json(result.body, { status: 200, headers: NO_STORE });
}
