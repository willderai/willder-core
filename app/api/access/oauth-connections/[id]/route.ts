// DELETE /api/access/oauth-connections/:id — the signed-in person disconnects one of
// their own OAuth clients. The connection and its capability are both revoked, so the
// client's next call is refused. Only the person who connected may do this here; an
// admin ends anyone's connection by revoking its capability on the Access page.
//
// Answers 404 unless MCP_OAUTH_ENABLED is `true`, before reading the session.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { mcpOAuthEnabled } from "@/mcp/oauth-discovery";
import { revokeOAuthConnection } from "@/services/access";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });

  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const revoked = await revokeOAuthConnection(rc.ctx, id);
  if (!revoked) return NextResponse.json({ error: "connection not found" }, { status: 404 });
  return NextResponse.json({ revoked: id, ...revoked });
}
