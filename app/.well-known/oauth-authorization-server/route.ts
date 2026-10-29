// Authorization Server Metadata (RFC 8414) for Willder's own OAuth server, at the
// location section 3 derives from an issuer with no path. The protected-resource
// metadata for /api/mcp names this origin as its authorization server; see
// mcp/oauth-discovery.ts.
import { authorizationServerMetadataResponse } from "@/mcp/oauth-discovery";

export function GET(req: Request): Response {
  return authorizationServerMetadataResponse(req);
}
