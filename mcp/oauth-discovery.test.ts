// The OAuth discovery documents for the hosted MCP endpoint, requested through the
// real route handlers an MCP client reaches: Protected Resource Metadata (RFC 9728)
// at the path-specific location for `/api/mcp` and the host-root fallback, and
// Authorization Server Metadata (RFC 8414). Only the environment is set per test;
// nothing is mocked. The fields asserted are the ones claude.ai and ChatGPT read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getAtResourcePath } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as getAtRoot } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as getServerMetadata } from "@/app/.well-known/oauth-authorization-server/route";

const LOCATIONS = [
  { name: "the path-specific location", get: getAtResourcePath, path: "/.well-known/oauth-protected-resource/api/mcp" },
  { name: "the host-root location", get: getAtRoot, path: "/.well-known/oauth-protected-resource" },
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(LOCATIONS)("OAuth protected-resource metadata at $name", ({ get, path }) => {
  const request = (origin: string) => new Request(`${origin}${path}`, { method: "GET" });

  it("stays off for any value other than exactly true", async () => {
    vi.stubEnv("MCP_OAUTH_RESOURCES", "https://willder.ai/api/mcp");
    for (const value of ["", "1", "TRUE", "yes", " true"]) {
      vi.stubEnv("MCP_OAUTH_ENABLED", value);
      const res = get(request("https://willder.ai"));
      expect(res.status, value).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("names /api/mcp as the resource and this same origin as its only authorization server", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    vi.stubEnv("MCP_OAUTH_RESOURCES", "https://willder.ai/api/mcp");

    const res = get(request("https://willder.ai"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      resource: "https://willder.ai/api/mcp",
      authorization_servers: ["https://willder.ai"],
      scopes_supported: ["memory:read", "memory:write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("names a listed preview deployment's own URL, so its metadata matches the URL the client called", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    vi.stubEnv("MCP_OAUTH_RESOURCES", "https://willder.ai/api/mcp, https://willder-git-branch.vercel.app/api/mcp/");

    const body = await get(request("https://willder-git-branch.vercel.app")).json();

    expect(body.resource).toBe("https://willder-git-branch.vercel.app/api/mcp");
    expect(body.authorization_servers).toEqual(["https://willder-git-branch.vercel.app"]);
  });

  it("refuses with 503 naming the variable when this host's /api/mcp is not a listed resource", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    for (const value of ["", "not a url", "https://willder.ai/api/mcp"]) {
      vi.stubEnv("MCP_OAUTH_RESOURCES", value);

      const res = get(request("https://evil.example"));

      expect(res.status, value).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("MCP_OAUTH_RESOURCES");
      expect(JSON.stringify(body)).not.toContain("authorization_servers");
    }
  });
});

describe("OAuth authorization server metadata", () => {
  const request = (origin: string) =>
    new Request(`${origin}/.well-known/oauth-authorization-server`, { method: "GET" });

  it("does not exist while MCP_OAUTH_ENABLED is off", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "");
    const res = getServerMetadata(request("https://willder.ai"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("names its issuer exactly as the resource metadata does, S256 PKCE, public clients, registration and iss", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    vi.stubEnv("MCP_OAUTH_RESOURCES", "https://willder.ai/api/mcp");

    const metadata = await getServerMetadata(request("https://willder.ai")).json();
    const resource = await getAtResourcePath(
      new Request("https://willder.ai/.well-known/oauth-protected-resource/api/mcp"),
    ).json();

    expect(metadata.issuer).toBe(resource.authorization_servers[0]);
    expect(metadata).toEqual({
      issuer: "https://willder.ai",
      authorization_endpoint: "https://willder.ai/oauth/authorize",
      token_endpoint: "https://willder.ai/api/oauth/token",
      registration_endpoint: "https://willder.ai/api/oauth/register",
      scopes_supported: ["memory:read", "memory:write"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
    // Advertising CIMD would make both clients skip registration for a flow this server does not serve.
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
  });
});
