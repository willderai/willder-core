// memory_version called with no id, through the real MCP schema validation: refused with how to
// make the call, never a bare validation error, while the advertised schema still requires the id. An agent that loaded the tool from a task-start
// line called it with empty arguments in a paired study
// and got an error that named no fix.
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/services/memory/versions", () => ({ readMemoryVersion: vi.fn(async () => null) }));
vi.mock("../derived-write", () => ({ derivedMarkersFor: vi.fn(async () => new Map()) }));

import { readMemoryVersion } from "@/services/memory/versions";
import { MISSING_VERSION_ID, registerMemoryVersion } from "./memory-version";
import type { ToolContext } from "./tool-context";

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "memory-version-test", version: "0.0.0" });
  const passThrough = ((handler: unknown) => handler) as ToolContext["notifyingRead"];
  registerMemoryVersion(server, { ctx: {}, cap: {}, notifyingRead: passThrough } as unknown as ToolContext);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "memory-version-test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { text: string }[]).map((part) => part.text).join("\n");

describe("memory_version with no id", () => {
  it.each([
    ["no arguments at all", {}],
    ["an empty id", { versionId: "" }],
    ["a blank id", { versionId: "   " }],
    ["an id that is not a string", { versionId: 5 }],
  ])("%s: says what to pass and where the id is, and reads nothing", async (_case, args) => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "memory_version", arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(MISSING_VERSION_ID);
    expect(readMemoryVersion).not.toHaveBeenCalled();
  });

  // A client, the public docs and the refusal probe read this list; an optional id would let the
  // probe call the tool with nothing and never reach the access decision.
  it("advertises versionId as required", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "memory_version")?.inputSchema.required).toEqual(["versionId"]);
  });

  it("still reads the version an id names", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "memory_version", arguments: { versionId: " v_1 " } });
    expect(textOf(result)).toBe("Version not found.");
    expect(readMemoryVersion).toHaveBeenCalledWith(expect.anything(), "v_1");
  });
});
