// What `_meta["willder/capture"] = "session-state"` changes on a memory_ingest call, and
// what it does not: the write skips graph extraction and carries no notices, and it is
// still checked like any other write. End to end, with the hook itself and a real
// database, in mcp/session-state-capture.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    auditLog: { create: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    source: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue({ readableNow: true, versionId: "v1" }) }));
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue("Changed in your scope since your last call:\n- create fact f9 by agent-b"),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { toolCallNotice } from "@/mcp/change-notices";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAPTURE_META_KEY, SESSION_STATE_CAPTURE, isSessionStateCapture } from "./session-capture";
import { registerWillderTools } from "./tools";

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_capture";
const capture = {
  _meta: { [CAPTURE_META_KEY]: SESSION_STATE_CAPTURE, "willder/session": "s-1", "willder/task": "WEB-412" },
};
const write = {
  content: "Session state captured automatically.",
  name: "Session state: WEB-412, session s-1",
  role: "progress",
};

function tool(name: string, permission: "read" | "write" = "write"): Handler {
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission, createdBy: null, agentId: "writer" }] as never);
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((toolName: string, _config: unknown, handler: Handler) => void tools.set(toolName, handler)),
  };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: "writer", capabilityToken: "wcap_xyz" }, origin: "mcp" },
    { orgId: ORG, agentId: "writer", scopePath: ORG },
  );
  return tools.get(name)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
});

describe("isSessionStateCapture", () => {
  it("reads the mark the hook sends", async () => {
    const hook = await import("@/cli/hooks/willder-capture.mjs");
    expect([hook.CAPTURE_META_KEY, hook.CAPTURE_ENV_VALUE]).toEqual([CAPTURE_META_KEY, SESSION_STATE_CAPTURE]);
  });

  it("is true only for the exact mark", () => {
    expect(isSessionStateCapture(capture)).toBe(true);
    expect(isSessionStateCapture({ _meta: { [CAPTURE_META_KEY]: "everything" } })).toBe(false);
    expect(isSessionStateCapture({ _meta: {} })).toBe(false);
    expect(isSessionStateCapture(undefined)).toBe(false);
  });
});

describe("memory_ingest marked as a session-state capture", () => {
  it("asks the pipeline to skip graph extraction; an unmarked write does not", async () => {
    const ingest = tool("memory_ingest");
    await ingest(write, capture);
    await ingest(write, { _meta: { "willder/session": "s-1" } });

    const calls = vi.mocked(ingestMemory).mock.calls.map(([input]) => input);
    expect(calls[0]).toMatchObject({ skipGraphExtraction: true, role: "progress", task: "WEB-412" });
    expect(calls[1]).not.toHaveProperty("skipGraphExtraction");
  });

  it("carries no change notices and claims no task-start block, so the session's agent still hears them", async () => {
    const ingest = tool("memory_ingest");
    const captured = await ingest(write, capture);
    expect(captured.content).toHaveLength(1);
    expect(toolCallNotice).not.toHaveBeenCalled();

    const ordinary = await ingest(write, { _meta: { "willder/session": "s-1" } });
    expect(ordinary.content).toHaveLength(2);
    expect(toolCallNotice).toHaveBeenCalledTimes(1);
  });

  it("is still refused for a token that may not write", async () => {
    const result = await tool("memory_ingest", "read")(write, capture);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Access denied/);
    expect(ingestMemory).not.toHaveBeenCalled();
  });
});
