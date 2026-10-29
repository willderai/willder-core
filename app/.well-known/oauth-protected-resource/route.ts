// Protected Resource Metadata at the host root. An MCP client that got no
// `resource_metadata` hint tries the path-specific location first
// (./api/mcp/route.ts) and this one second, so both serve the same document;
// see mcp/oauth-discovery.ts.
import { protectedResourceMetadataResponse } from "@/mcp/oauth-discovery";

export function GET(req: Request): Response {
  return protectedResourceMetadataResponse(req);
}
