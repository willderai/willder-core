import { describe, expect, it, vi } from "vitest";
import { READ_GRANT_NOTE } from "@/mcp/read-notes";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CLAUDE_MCP_ADD_COMMAND,
  CLAUDE_MCP_JSON,
  curlExample,
  LIST_REQUEST,
  MCP_URL,
  QUERY_REQUEST,
  TOOL_DOCS,
} from "@/lib/docs";
import { NO_DRIFT, toolListDrift } from "@/mcp/tool-list-drift.testsupport";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
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
  guardedMemory: { retrieve: vi.fn(async () => ({ facts: [{ fact: "Project Atlas launches on 15 October 2026." }] })) },
}));
// Change notices (mcp/change-notices.ts) are out of this file's scope; a silent
// notice keeps them from adding their own queries and audit row to each call.
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { POST } from "./route";
import { registerWillderTools } from "@/mcp/tools";
import { guardedMemory } from "@/services/memory";

// Exercise the exact curl body and headers shown on /docs/connect. Identity
// and the memory boundary are faked; transport and tool handlers are real.
async function runSnippet(request: object) {
  const snippet = curlExample(request);
  const body = /--data '(.*?)'$/.exec(snippet)?.[1];
  expect(body).toBeDefined();
  expect(snippet).not.toContain("\n+");
  const headers = Object.fromEntries(
    [...snippet.matchAll(/-H ["']([^:]+): ([^"']+)["']/g)].map(([, name, value]) => [
      name,
      value.replace("$WILLDER_TOKEN", "docs-test-token"),
    ]),
  );
  const response = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers, body }));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}

describe("public MCP documentation against the real implementation", () => {
  it("lists exactly the documented tools and required input fields", async () => {
    const result = await runSnippet(LIST_REQUEST);
    expect(
      toolListDrift(
        result.tools.map((tool: { name: string }) => tool.name),
        TOOL_DOCS.map((tool) => tool.name),
      ),
      "Document each unlisted tool in TOOL_DOCS (lib/docs.ts) with its fields and an example, and delete each stale entry",
    ).toEqual(NO_DRIFT);
    for (const doc of TOOL_DOCS) {
      const tool = result.tools.find((entry: { name: string }) => entry.name === doc.name);
      expect(Object.keys(tool.inputSchema.properties).sort(), doc.name).toEqual(
        doc.fields.map((field) => field.name).sort(),
      );
      expect((tool.inputSchema.required ?? []).sort(), doc.name).toEqual(
        doc.fields
          .filter((field) => field.required)
          .map((field) => field.name)
          .sort(),
      );
    }
  });

  it("accepts every published argument example through the registered Zod schema", () => {
    const schemas = new Map<string, z.ZodRawShape>();
    const server = {
      registerTool: (name: string, config: { inputSchema: z.ZodRawShape }) => {
        schemas.set(name, config.inputSchema);
      },
    } as unknown as McpServer;
    registerWillderTools(
      server,
      { orgId: "org_1", actor: { type: "agent", id: "agent_1", capabilityToken: "docs-test-token" }, origin: "mcp" },
      { orgId: "org_1", agentId: "agent_1", scopePath: "org_org_1" },
    );
    for (const doc of TOOL_DOCS) {
      const schema = schemas.get(doc.name);
      expect(schema, doc.name).toBeDefined();
      expect(z.object(schema!).strict().safeParse(doc.example).success, doc.name).toBe(true);
    }
  });

  it("runs the published query snippet and returns the documented text result", async () => {
    const result = await runSnippet(QUERY_REQUEST);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: `• Project Atlas launches on 15 October 2026. — uncited\n\n${READ_GRANT_NOTE}` },
      { type: "text", text: expect.stringMatching(/^revision: [0-9a-f]{16}$/) },
    ]);
    expect(guardedMemory.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1" }),
      { groupId: "org_1", query: QUERY_REQUEST.params.arguments.query, limit: 5 },
      "org_org_1",
      { checkNamedValues: true },
    );
  });

  // /docs/claude-code: the one command and the .mcp.json example. Claude Code sends the
  // header it was given, the token in place of the variable, on the URL it was given.
  it.each([
    [
      "claude mcp add",
      /--header "([^:]+): ([^"]+)"/.exec(CLAUDE_MCP_ADD_COMMAND)!.slice(1),
      / (https:\/\/\S+) /.exec(CLAUDE_MCP_ADD_COMMAND)![1],
    ],
    [
      ".mcp.json",
      Object.entries(CLAUDE_MCP_JSON.mcpServers.willder.headers)[0],
      CLAUDE_MCP_JSON.mcpServers.willder.url,
    ],
  ])("authenticates the Claude Code setup from %s", async (_, [name, value], url) => {
    expect(url).toBe(MCP_URL);
    const filled = value.replace(/\$\{?WILLDER_TOKEN\}?/, "docs-test-token");
    expect(filled).toBe("Bearer docs-test-token");
    const headers = {
      [name]: filled,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify(LIST_REQUEST) }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools.length).toBeGreaterThan(0);
  });
});
