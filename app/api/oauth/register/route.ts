// POST /api/oauth/register — dynamic client registration (RFC 7591) for MCP clients
// such as claude.ai and ChatGPT. Unauthenticated, as the RFC's open registration is:
// a registered client reaches nothing until a signed-in person consents on the
// authorize page. The rules are in services/access/oauth-client.ts.
//
// Answers 404 unless MCP_OAUTH_ENABLED is `true`, before reading the body.
import { mcpOAuthEnabled } from "@/mcp/oauth-discovery";
import { registerOAuthClient } from "@/services/access";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request): Promise<Response> {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });

  let metadata: unknown;
  try {
    metadata = await req.json();
  } catch {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "the registration body must be JSON" },
      { status: 400, headers: NO_STORE },
    );
  }
  const result = await registerOAuthClient(metadata);
  if (!result.ok) return Response.json(result.error, { status: 400, headers: NO_STORE });
  return Response.json(result.client, { status: 201, headers: NO_STORE });
}
