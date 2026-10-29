// memory_ingest loads its write pipeline (lib/inngest, agent naming) on the first write
// instead of at module load, so a cold /api/mcp instance does not pay for it
// (app/api/mcp/route.cold-start.test.ts). Loading it late must not change what a failed
// write looks like to the caller: a pipeline that rejects, or a pipeline module that
// cannot load at all, is a refused write the agent sees, never a reply that says stored.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn() },
    source: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_lazy_pipeline";
const AGENT = "agent-lazy";

/** memory_ingest's handler, from a freshly loaded tools module with the current mocks. */
async function memoryIngest(): Promise<Handler> {
  const { db } = await import("@/lib/db");
  vi.mocked(db.agent.findMany).mockResolvedValue([] as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: AGENT }] as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
  const { registerWillderTools } = await import("./tools");
  const tools = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _c: unknown, h: Handler) => void tools.set(name, h)) };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: AGENT, capabilityToken: "wcap_xyz" }, origin: "mcp" },
    { orgId: ORG, agentId: AGENT, scopePath: ORG },
  );
  return tools.get("memory_ingest")!;
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/inngest");
});

describe("memory_ingest with a lazily loaded write pipeline", () => {
  it("stores through the pipeline it loads on the first write", async () => {
    const ingestMemory = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/inngest", () => ({ ingestMemory }));
    const result = await (await memoryIngest())({ content: "Release moved to Friday", name: "Release" });
    expect(result.isError).not.toBe(true);
    expect(ingestMemory).toHaveBeenCalledOnce();
  });

  it("refuses the write when the pipeline rejects it", async () => {
    const ingestMemory = vi.fn().mockRejectedValue(new Error("inngest unreachable"));
    vi.doMock("@/lib/inngest", () => ({ ingestMemory }));
    const result = await (await memoryIngest())({ content: "Release moved to Friday", name: "Release" });
    expect(ingestMemory).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/stored|Version:/i);
  });

  it("refuses the write when the pipeline module cannot load", async () => {
    vi.doMock("@/lib/inngest", () => {
      throw new Error("pipeline module failed to load");
    });
    const result = await (await memoryIngest())({ content: "Release moved to Friday", name: "Release" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/stored|Version:/i);
  });
});
