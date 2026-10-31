// memory_entity dates each fact as memory_query dates it (mcp/fact-citation.ts servedDate): a
// stored version by its own date, a fact derived from stored versions by the newest of them,
// never by the graph's extraction clock when a version is known. An earlier statement on an
// entity is told from a later one by its day, in UTC.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { entity, readVersionStamps } = vi.hoisted(() => ({ entity: vi.fn(), readVersionStamps: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/services/access", () => ({ resolveCallerScopePath: vi.fn(async () => "org_1.eng") }));
vi.mock("@/services/memory", () => ({ guardedMemory: { entity } }));
vi.mock("@/services/memory/versions", () => ({ readVersionStamps }));
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
  registerMemoryEntity(
    server as unknown as McpServer,
    {
      ctx: { orgId: "org_1", actor: { type: "agent", id: "agent_1" } },
      cap: { scopePath: "org_1.eng" },
      notifyingRead: (h: Handler) => h,
    } as unknown as ToolContext,
  );
  return registered!;
}

beforeEach(() => {
  entity.mockReset();
  readVersionStamps.mockReset().mockResolvedValue(new Map());
});

describe("memory_entity — each fact's day", () => {
  it("dates a stored version by its own date and a derived fact by the newest version behind it", async () => {
    readVersionStamps.mockResolvedValue(
      new Map([
        ["c1", { writer: null, datedAt: "2026-02-01T00:00:00.000Z" }],
        ["c2", { writer: null, datedAt: "2026-05-01T12:00:00.000Z" }],
      ]),
    );
    entity.mockResolvedValue({
      uuid: "ent_db",
      name: "Database",
      type: "entity",
      facts: [
        { uuid: "row_1", fact: "We use Postgres", validAt: "2026-01-10T09:00:00.000Z", store: "semantic" },
        // From the graph's entity view: no store named, its own date the extraction's clock.
        {
          uuid: "edge_1",
          fact: "The team moved to MySQL",
          validAt: "2026-10-30T00:00:00.000Z",
          chunkIds: ["c1", "c2"],
        },
        { uuid: "edge_2", fact: "Someone mentioned SQLite", validAt: null },
      ],
    });
    const text = (await handler()({ entityId: "ent_db" })).content[0].text;
    expect(text).toContain("• We use Postgres (as of 2026-01-10)\n");
    expect(text).toContain("• The team moved to MySQL (as of 2026-05-01)\n");
    expect(text).toMatch(/• Someone mentioned SQLite$/m);
    expect(readVersionStamps).toHaveBeenCalledWith("org_1", ["c1", "c2"]);
  });

  it("keeps the graph's date for a derived fact none of whose versions is the caller's", async () => {
    entity.mockResolvedValue({
      uuid: "ent_db",
      name: "Database",
      type: "entity",
      facts: [{ uuid: "e", fact: "MySQL", validAt: "2025-12-31T23:30:00.000Z", chunkIds: ["elsewhere"] }],
    });
    expect((await handler()({ entityId: "ent_db" })).content[0].text).toContain("• MySQL (as of 2025-12-31)");
  });
});
