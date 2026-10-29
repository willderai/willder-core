// memory_ingest's optional `occurredAt`: when the content happened, as opposed to when it
// is stored. A valid value reaches the ingest pipeline as `occurredAt`, never as the graph's
// reference time, which stays the server clock; an invalid or future one is refused before
// anything is written; an omitted one leaves the write ordered by its store time.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    // Records the version the reply names as served to the writer.
    $executeRaw: vi.fn().mockResolvedValue(1),
    auditLog: { create: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    source: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { registerWillderTools } from "./tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
type ToolConfig = {
  inputSchema: Record<string, { description?: string; safeParse: (v: unknown) => { success: boolean } }>;
};

const ORG = "org_occurred_at";

function memoryIngest(): { handler: Handler; config: ToolConfig } {
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "writer" }] as never);
  const tools = new Map<string, { handler: Handler; config: ToolConfig }>();
  const server = {
    registerTool: vi.fn(
      (name: string, config: ToolConfig, handler: Handler) => void tools.set(name, { handler, config }),
    ),
  };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: "writer", capabilityToken: "wcap_xyz" }, origin: "mcp" },
    { orgId: ORG, agentId: "writer", scopePath: ORG },
  );
  return tools.get("memory_ingest")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
});

describe("memory_ingest occurredAt", () => {
  it("passes a valid event time to the pipeline normalized to UTC, and leaves the graph's reference time to the server", async () => {
    const { handler } = memoryIngest();
    const result = await handler({
      content: "Follow-up moved to Friday 9:00",
      name: "Patient follow-up",
      occurredAt: "2026-03-13T08:00:00-07:00",
    });

    expect(result.isError).not.toBe(true);
    const sent = vi.mocked(ingestMemory).mock.calls.at(-1)![0];
    expect(sent.occurredAt).toBe("2026-03-13T15:00:00.000Z");
    expect(sent).not.toHaveProperty("referenceTime");
  });

  it("sends no reference time when the caller gives none, so the write is ordered by when it was stored", async () => {
    const { handler } = memoryIngest();
    await handler({ content: "Release moved to Friday", name: "Release" });

    expect(vi.mocked(ingestMemory).mock.calls.at(-1)![0]).not.toHaveProperty("occurredAt");
  });

  it("refuses a malformed event time and writes nothing", async () => {
    const { handler } = memoryIngest();
    const result = await handler({ content: "x", name: "y", occurredAt: "last Tuesday" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/occurredAt/);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("refuses an event time in the future and writes nothing", async () => {
    const { handler } = memoryIngest();
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = await handler({ content: "x", name: "y", occurredAt: nextYear });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/future/);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("says so when the text was already stored with another date, naming the date that stands", async () => {
    vi.mocked(ingestMemory).mockResolvedValueOnce({
      readableNow: true,
      versionId: "v-first",
      storedDateKept: { occurredAt: "2026-02-01T00:00:00.000Z" },
    });
    const { handler } = memoryIngest();
    const result = await handler({ content: "Release moved to Friday", name: "Release", occurredAt: "2026-03-01" });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toMatch(/occurredAt was not applied.*v-first.*2026-02-01T00:00:00.000Z/);
  });

  it("tells an undated write that the identical text it found keeps its stated date", async () => {
    vi.mocked(ingestMemory).mockResolvedValueOnce({
      readableNow: true,
      versionId: "v-first",
      storedDateKept: { occurredAt: "2020-01-01T00:00:00.000Z" },
    });
    const { handler } = memoryIngest();
    const result = await handler({ content: "Release moved to Friday", name: "Release" });

    expect(result.content[0].text).toMatch(/v-first.*dated 2020-01-01T00:00:00.000Z/);
    expect(result.content[0].text).not.toMatch(/occurredAt was not applied/);
  });

  it("says a found version without a stated date is dated by when it was stored", async () => {
    vi.mocked(ingestMemory).mockResolvedValueOnce({
      readableNow: true,
      versionId: "v-first",
      storedDateKept: { occurredAt: null },
    });
    const { handler } = memoryIngest();
    const result = await handler({ content: "Release moved to Friday", name: "Release", occurredAt: "2026-03-01" });

    expect(result.content[0].text).toMatch(/occurredAt was not applied.*v-first.*dated by when it was stored/);
  });

  it("documents the field in the tool schema as optional", () => {
    const { config } = memoryIngest();
    const field = config.inputSchema.occurredAt;

    expect(field.description).toMatch(/when the content happened/i);
    expect(field.safeParse(undefined).success).toBe(true);
  });
});
