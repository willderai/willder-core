// GET /api/access/oauth-connections — the signed-in person's live connections in this
// org, newest first: the apps they can see and disconnect (Integrations, Connected apps).
//
// POST /api/access/oauth-connections — connect an OAuth client for the signed-in
// person: issue a capability at the scope and permission they choose and bind it to
// (org, person, client). The OAuth authorize flow (app/api/oauth/authorize) binds
// through the same function, connectOAuthClient, with its rules in
// services/access/oauth-connection.ts. No token is returned: the client gets OAuth
// tokens from the token endpoint and never holds the capability's own token.
//
// Both answer 404 unless MCP_OAUTH_ENABLED is `true`, before reading the session or body.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { mcpOAuthEnabled } from "@/mcp/oauth-discovery";
import { connectOAuthClient, listOAuthConnections } from "@/services/access";

export async function GET() {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });

  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({ connections: await listOAuthConnections(rc.ctx) });
}

export async function POST(req: Request) {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });

  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { clientId?: string; agentId?: string; scopePath?: string; permission?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const result = await connectOAuthClient(rc.ctx, {
    clientId: body.clientId,
    agentId: body.agentId,
    scopePath: body.scopePath,
    permission: body.permission,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.connection, { status: 201 });
}
