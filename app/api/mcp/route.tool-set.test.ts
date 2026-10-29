// The tool set a hosted connection is listed (mcp/tool-set.ts), through the real route and
// transport: which tools each X-Willder-Tools value lists, that the Claude Code setup the docs
// publish is listed the coding set, and that a call to an unlisted tool is answered with how to
// list it and runs nothing; and that every tool set is sent the server instructions at initialize.
// Identity and the memory boundary are faked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_MCP_JSON } from "@/lib/docs";
import { SERVER_HEADERS } from "@/cli/willder.mjs";

vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  resolveCapability: vi.fn(async () => ({
    orgId: "org_1",
    agentId: "agent_1",
    permission: "read",
    scopePath: "org_org_1",
  })),
}));
vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  guardedMemory: {
    retrieve: vi.fn(async () => ({ facts: [] })),
    entity: vi.fn(async () => null),
  },
}));
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { POST } from "./route";
import { WILLDER_TOOL_NAMES, registerWillderTools } from "@/mcp/tools";
import { calledToolOf } from "@/mcp/tool-set";
import { SERVER_INSTRUCTIONS } from "@/mcp/willder-server";
import { guardedMemory } from "@/services/memory";

function send(body: object, extraHeaders: Record<string, string> = {}) {
  const headers = {
    authorization: "Bearer test-token",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  return POST(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
}

async function post(body: object, extraHeaders: Record<string, string> = {}) {
  const response = await send(body, extraHeaders);
  expect(response.status).toBe(200);
  return response.json();
}

async function listedTools(headers: Record<string, string>): Promise<string[]> {
  const payload = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, headers);
  return payload.result.tools.map((tool: { name: string }) => tool.name).sort();
}

const call = (name: string, args: object) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});

beforeEach(() => vi.clearAllMocks());

describe("X-Willder-Tools", () => {
  const every = [...WILLDER_TOOL_NAMES].sort();
  // Pinned here rather than read from CODING_TOOLS, so dropping or adding a coding tool fails.
  const coding = ["memory_changes", "memory_ingest", "memory_query", "memory_version"];

  it.each([
    ["no header", {}, every],
    ["coding", { "x-willder-tools": "coding" }, coding],
    ["any case, padded", { "X-Willder-Tools": "  Coding " }, coding],
    ["the header sent twice", { "x-willder-tools": "coding, coding" }, coding],
    ["coding and all together", { "x-willder-tools": "coding, all" }, every],
    ["a value containing coding", { "x-willder-tools": "nocoding" }, every],
    ["all", { "x-willder-tools": "all" }, every],
    ["an unknown value", { "x-willder-tools": "lean" }, every],
    ["empty", { "x-willder-tools": "" }, every],
  ])("%s lists the expected tools", async (_, headers, expected) => {
    expect(await listedTools(headers)).toEqual(expected);
  });

  // The headers the docs' .mcp.json and `willder init` write, token filled, task unset.
  it.each([
    [".mcp.json on /docs/claude-code", CLAUDE_MCP_JSON.mcpServers.willder.headers],
    ["willder init", SERVER_HEADERS],
  ])("the Claude Code setup from %s is listed the coding set", async (_, headers) => {
    const filled = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        value.replace("${WILLDER_TOKEN}", "test-token").replace("${WILLDER_TASK:-}", ""),
      ]),
    );
    expect(await listedTools(filled)).toEqual(coding);
  });
});

describe("a call to a tool the connection does not list", () => {
  it("is answered with the header that hides it and how to list it, and runs nothing", async () => {
    const payload = await post(call("memory_entity", { entityId: "e_1" }), { "x-willder-tools": "coding" });
    expect(payload.id).toBe(7);
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toMatch(
      /^memory_entity is not listed on this connection: it sends X-Willder-Tools: coding.*remove that header/,
    );
    expect(guardedMemory.entity).not.toHaveBeenCalled();
  });

  it("runs the same call on a connection that lists every tool", async () => {
    const payload = await post(call("memory_entity", { entityId: "e_1" }));
    expect(payload.result.content[0].text).not.toMatch(/not listed on this connection/);
    expect(guardedMemory.entity).toHaveBeenCalledTimes(1);
  });

  it("runs a listed tool on a coding connection", async () => {
    const payload = await post(call("memory_query", { query: "sessions" }), { "x-willder-tools": "coding" });
    expect(payload.result.content[0].text).not.toMatch(/not listed on this connection/);
    expect(guardedMemory.retrieve).toHaveBeenCalledTimes(1);
  });

  it("sends no reply to a notification, as JSON-RPC requires", async () => {
    const { id: _id, ...notification } = call("memory_entity", { entityId: "e_1" });
    const response = await send(notification, { "x-willder-tools": "coding" });
    expect(response.status).toBe(202);
    expect(guardedMemory.entity).not.toHaveBeenCalled();
  });

  it("leaves a name that is no Willder tool to the SDK's own not-found reply", async () => {
    const payload = await post(call("memory_teleport", {}), { "x-willder-tools": "coding" });
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toMatch(/Tool memory_teleport not found$/);
  });
});

// Each request builds its own server, and every tool registered on it builds its schemas and
// closures: CPU that every request sharing an instance pays under concurrent load.
// A single tools/call needs only the tool it calls; anything else registers what it always did.
describe("which tools a request registers", () => {
  const every = [...WILLDER_TOOL_NAMES].sort();
  const coding = ["memory_changes", "memory_ingest", "memory_query", "memory_version"];

  it.each([
    ["a call to a listed tool", call("memory_version", { versionId: "v_1" }), {}, ["memory_version"]],
    [
      "a call to a coding tool on a coding connection",
      call("memory_query", { query: "q" }),
      { "x-willder-tools": "coding" },
      ["memory_query"],
    ],
    ["a notification calling a listed tool", (({ id: _id, ...n }) => n)(call("memory_note", {})), {}, ["memory_note"]],
    ["tools/list", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {}, every],
    [
      "tools/list on a coding connection",
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { "x-willder-tools": "coding" },
      coding,
    ],
    ["a name that is no Willder tool", call("memory_teleport", {}), {}, every],
    ["a name inherited from Object", call("toString", {}), {}, every],
    ["a call with no name", { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }, {}, every],
    ["a batch", [call("memory_version", { versionId: "v_1" })], {}, every],
  ])("%s", async (_, body, headers, expected) => {
    const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
    try {
      await send(body, headers);
      expect((registerTool.mock.calls as unknown[][]).map(([name]) => name as string).sort()).toEqual(expected);
    } finally {
      registerTool.mockRestore();
    }
  });

  it.each([
    ["tools/list", "tools/list"],
    ["initialize", "initialize"],
  ])("never reads a tool name from %s's params", (_, method) => {
    expect(calledToolOf({ jsonrpc: "2.0", id: 1, method, params: { name: "memory_query" } })).toBeUndefined();
  });

  // The route answers a call to an unlisted tool before registering anything; this is the
  // backstop behind it, for any caller of registerWillderTools.
  it("never registers a tool the connection does not list, whatever the request names", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const registerTool = vi.spyOn(server, "registerTool");
    registerWillderTools(
      server,
      { orgId: "o", actor: { type: "agent", id: "a", capabilityToken: "t" }, origin: "mcp" },
      { orgId: "o", agentId: "a", scopePath: "org_o", createdBy: null },
      { tools: "coding", calls: "memory_note" },
    );
    expect((registerTool.mock.calls as unknown[][]).map(([name]) => name as string).sort()).toEqual(coding);
  });

  it("answers the one tool it registered as it did with every tool registered", async () => {
    const payload = await post(call("memory_entity", { entityId: "e_1" }));
    expect(payload.id).toBe(7);
    expect(guardedMemory.entity).toHaveBeenCalledTimes(1);
  });
});

describe("the initialize result", () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  };

  it.each([
    ["every tool", {}],
    ["the coding set", { "x-willder-tools": "coding" }],
  ])("carries the server instructions on a connection listed %s", async (_, headers) => {
    const payload = await post(initialize, headers);
    expect(payload.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });
});
