import { describe, expect, it, vi } from "vitest";

// GET /api/mcp: this endpoint serves no event stream, so an authenticated GET
// answers 405 instead of opening one. A legacy HTTP+SSE client (and the
// mcp-remote bridge in its SSE-first mode) starts with exactly this request;
// a 405 tells it to fall back to Streamable HTTP, where an empty stream that
// never ends would leave it waiting on a handshake that never arrives.
//
// Only db.capability.findUnique is faked, and honestly: it returns a live row
// for the one issued token's hash and nothing for any other. resolveCapability,
// the route and the MCP transport behind POST are real.

vi.mock("@/lib/db", () => ({
  db: {
    capability: { findUnique: vi.fn() },
    // resolveCapability asks whether the token's agent is deactivated; no Agent row means it is not.
    agent: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn(async () => ({ id: "al_1" })) },
  },
}));

import { db } from "@/lib/db";
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access";
import { GET, POST } from "./route";

const token = generateCapabilityToken();
const tokenHash = hashCapabilityToken(token);

vi.mocked(db.capability.findUnique).mockImplementation((async (args: { where: { tokenHash: string } }) =>
  args.where.tokenHash === tokenHash
    ? {
        id: "cap_get",
        orgId: "org_get",
        agentId: "agent_get",
        scopePath: "org_org_get",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    : null) as unknown as typeof db.capability.findUnique);

const URL_ = "http://localhost/api/mcp";

function get(headers: Record<string, string>): Promise<Response> {
  return GET(new Request(URL_, { method: "GET", headers }));
}

describe("GET /api/mcp", () => {
  it("answers 405 with an Allow header to an authenticated event-stream request", async () => {
    const res = await get({ accept: "text/event-stream", authorization: `Bearer ${token}` });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("answers 401, not 405, when the bearer token is missing", async () => {
    const res = await get({ accept: "text/event-stream" });

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Missing bearer capability token/);
  });

  it("answers 401, not 405, when the bearer token is unknown", async () => {
    const res = await get({ accept: "text/event-stream", authorization: `Bearer ${generateCapabilityToken()}` });

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Invalid or unknown capability token/);
  });
});

describe("POST /api/mcp beside the GET change", () => {
  it("still completes an initialize handshake for a live token", async () => {
    const res = await POST(
      new Request(URL_, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "get-test", version: "0" } },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe("willder");
  });
});
