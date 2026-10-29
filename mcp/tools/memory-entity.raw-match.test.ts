// W7 at the MCP door: when the org's tier does not read the graph, memory_entity's answer
// says the entity was matched by name in stored memory, so an agent never takes it for the
// graph's entity. The graph's own entity reads exactly as before, with no such line.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { entity } = vi.hoisted(() => ({ entity: vi.fn() }));
vi.mock("@/services/access", () => ({ resolveCallerScopePath: vi.fn(async () => "org_1.eng") }));
vi.mock("@/services/memory", () => ({ guardedMemory: { entity } }));
vi.mock("./tool-context", () => ({
  recordServedFacts: vi.fn(),
  recordServedScopes: vi.fn(),
  toolError: (e: unknown) => ({ content: [{ type: "text", text: String(e) }], isError: true }),
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryEntity } from "./memory-entity";
import type { ToolContext } from "./tool-context";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;

function handler(): Handler {
  let registered: Handler | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: Handler) => (registered = h) };
  const passthrough = (h: Handler) => h;
  registerMemoryEntity(
    server as unknown as McpServer,
    {
      ctx: { orgId: "org_1", actor: { type: "agent", id: "agent_1" } },
      cap: { scopePath: "org_1.eng" },
      notifyingRead: passthrough,
    } as unknown as ToolContext,
  );
  return registered!;
}

const FACT = { uuid: "chunk_1", fact: "Acme Corp renewed for 2027", validAt: null };
const MATCHED = "Matched by name in stored memory";

beforeEach(() => entity.mockReset());

describe("memory_entity's answer", () => {
  it("says the entity was matched by name when the raw-row fallback answered", async () => {
    entity.mockResolvedValue({
      uuid: "Acme Corp",
      name: "Acme Corp",
      type: "entity",
      facts: [FACT],
      matchedBy: "raw-name",
    });
    const text = (await handler()({ entityId: "Acme Corp" })).content[0].text;
    expect(text).toContain(MATCHED);
    expect(text).toContain("• Acme Corp renewed for 2027");
  });

  it("carries no such line for the graph's own entity", async () => {
    entity.mockResolvedValue({ uuid: "ent_acme", name: "Acme Corp", type: "company", facts: [FACT] });
    const text = (await handler()({ entityId: "ent_acme" })).content[0].text;
    expect(text).not.toContain(MATCHED);
    expect(text.startsWith("Acme Corp (company)\n• Acme Corp renewed for 2027")).toBe(true);
  });
});
