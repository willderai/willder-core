// The Server-Timing header on /api/mcp, through the real route handler.
//
// A tool call's reply time at the client is the handler's own work plus anything before
// the handler ran (a function instance starting) and the network. The header names the
// handler's share, how long this instance had been up when the request arrived, and how
// many database connections the pool opened while the request ran, so a slow call can be
// read as instance start, connection setup or the work itself.
//
// Only the capability lookup and the tool set are replaced: the tool below stands for any
// tool whose call makes the pool open a connection.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { countConnectionOpened } from "@/lib/db-connections";

vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  resolveCapability: vi.fn(async () => ({ orgId: "org_1", agentId: "agent_1", scopePath: "org_org_1" })),
}));

vi.mock("@/mcp/tools", () => ({
  registerWillderTools: (server: McpServer) => {
    server.registerTool("open_connections", { inputSchema: { count: z.number().int() } }, async ({ count }) => {
      for (let i = 0; i < count; i++) countConnectionOpened();
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
  },
}));

const { POST } = await import("./route");

function call(method: string, params: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wcap_test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}

/** The entries of a Server-Timing value, by name. */
function entries(header: string | null): Map<string, string> {
  return new Map(
    (header ?? "").split(",").map((entry) => {
      const [name, ...params] = entry.trim().split(";");
      return [name!, params.join(";")];
    }),
  );
}

describe("Server-Timing on /api/mcp", () => {
  it("counts the connections the pool opened while this request ran, and only those", async () => {
    countConnectionOpened(); // opened before the request: not this request's
    const response = await call("tools/call", { name: "open_connections", arguments: { count: 2 } });

    expect(response.status).toBe(200);
    expect(entries(response.headers.get("server-timing")).get("db-connections-opened")).toBe('desc="2"');
  });

  it("names the handler's time and the instance's age on a request that ran no tool", async () => {
    const response = await call("tools/list", {});

    const timing = entries(response.headers.get("server-timing"));
    expect(timing.get("handler")).toMatch(/^dur=\d+\.\d$/);
    expect(timing.get("instance-age")).toMatch(/^dur=\d+\.\d$/);
    expect(timing.get("db-connections-opened")).toBe('desc="0"');
    expect(timing.has("task-start")).toBe(false);
  });

  it("is not sent to a caller without a token", async () => {
    const response = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("server-timing")).toBeNull();
  });
});
