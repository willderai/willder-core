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
import { describeVersion, MISSING_VERSION_ID, registerMemoryVersion } from "./memory-version";
import type { MemoryVersion } from "@/services/memory/versions";
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

// A history question ("what was it before, and when did it change") is answered from one version
// and the dates of the versions its lineage names, each a day in UTC.
describe("describeVersion — dates", () => {
  const base: MemoryVersion = {
    id: "v2",
    kind: "fact",
    scopePath: "org_o.eng",
    content: "We use MySQL.",
    subject: "Database",
    actorId: "agent_1",
    createdAt: new Date("2026-03-01T09:00:00.000Z"),
    status: "current",
    supersededById: null,
    supersedesIds: [],
  };

  it("dates a superseded version's replacement, and says when the supersede was recorded only when that is another day", () => {
    const text = describeVersion(
      {
        ...base,
        status: "superseded",
        supersededById: "v3",
        supersededAt: new Date("2026-06-01T10:00:00Z"),
        lineageDatedAt: { v3: new Date("2026-06-01T08:00:00Z") },
      },
      undefined,
    );
    expect(text).toContain("superseded by: v3 (as of 2026-06-01)\n");
    expect(text).not.toContain("recorded");
    const imported = describeVersion(
      {
        ...base,
        status: "superseded",
        supersededById: "v3",
        supersededAt: new Date("2026-10-30T10:00:00Z"),
        lineageDatedAt: { v3: new Date("2024-05-15T00:00:00Z") },
      },
      undefined,
    );
    expect(imported).toContain("superseded by: v3 (as of 2024-05-15), recorded 2026-10-30\n");
  });

  it("dates each version it replaced, and names one with no known date alone", () => {
    const text = describeVersion(
      { ...base, supersedesIds: ["v1", "v0"], lineageDatedAt: { v1: new Date("2026-01-05T08:00:00Z") } },
      undefined,
    );
    expect(text).toContain("supersedes: v1 (as of 2026-01-05), v0\n");
  });

  it("says a dated fact's own date beside when it was written, only when the day differs", () => {
    expect(describeVersion({ ...base, occurredAt: new Date("2026-02-20T00:00:00Z") }, undefined)).toContain(
      "written by agent_1 at 2026-03-01T09:00:00.000Z, as of 2026-02-20\n",
    );
    expect(describeVersion({ ...base, occurredAt: new Date("2026-03-01T01:00:00Z") }, undefined)).toContain(
      "written by agent_1 at 2026-03-01T09:00:00.000Z\n",
    );
  });

  it("is the text it always was for a version read without lineage dates", () => {
    const text = describeVersion(
      { ...base, status: "superseded", supersededById: "v3", supersedesIds: ["v1"] },
      undefined,
    );
    expect(text).toBe(
      "fact v2 (superseded)\nscope: org_o.eng\nwritten by agent_1 at 2026-03-01T09:00:00.000Z\nsuperseded by: v3\nsupersedes: v1\n\nWe use MySQL.",
    );
  });

  it("keeps the replacement's id first after `superseded by: `, where readers take it from", () => {
    const text = describeVersion(
      { ...base, status: "superseded", supersededById: "v3", lineageDatedAt: { v3: new Date("2026-06-01T08:00:00Z") } },
      undefined,
    );
    expect(/^superseded by: (\S+)/m.exec(text)?.[1]).toBe("v3");
  });
});
