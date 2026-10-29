// Protected Resource Metadata (RFC 9728) for the hosted MCP endpoint, at the
// location section 3.1 derives from the resource URL `/api/mcp`. A 401 from
// that endpoint points here when MCP_OAUTH_ENABLED is true; see
// mcp/oauth-discovery.ts.
import { protectedResourceMetadataResponse } from "@/mcp/oauth-discovery";

export function GET(req: Request): Response {
  return protectedResourceMetadataResponse(req);
}
