// QA: memory_ingest carries its own memory.write allow row onto the ingest, so the change
// event it lands names the visible audit row that authorized it; a rule (kind set)
// authorizes itself inside recordConvention, and the fact that stores the rule's text
// carries that same row.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/memory/conventions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/conventions")>()),
  recordAuthorizedConvention: vi.fn().mockResolvedValue({ id: "rule-1", authorizedById: "audit-rule-1" }),
}));
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

const ORG = "org_qa_ingest_authz";
const DEAL = `${ORG}.deal_a`;

function ingestHandler(): Handler {
  const tools = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _c: unknown, h: Handler) => void tools.set(name, h)) };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" }, origin: "mcp" },
    { orgId: ORG, agentId: "agent_1", scopePath: DEAL },
  );
  return tools.get("memory_ingest")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  vi.mocked(db.auditLog.create).mockImplementation((async () => ({ id: `audit-${++n}` })) as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "agent_1" }] as never);
});

describe("memory_ingest authorizedById", () => {
  it("carries the id of the memory.write allow row it was authorized by", async () => {
    const result = await ingestHandler()({ content: "Deal A moved to legal", name: "Deal A", scopePath: DEAL });
    expect(result.isError).not.toBe(true);
    const created = vi
      .mocked(db.auditLog.create)
      .mock.calls.map(([a]) => (a as { data: { action: string; decision: string } }).data);
    const allowIndex = created.findIndex((d) => d.action === "memory.write" && d.decision === "allow");
    expect(allowIndex).toBeGreaterThanOrEqual(0);
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ authorizedById: `audit-${allowIndex + 1}` }));
  });

  it("carries the rule's own allow row onto the fact that stores the rule's text", async () => {
    const result = await ingestHandler()({
      content: "Always cc legal",
      name: "Deal A",
      scopePath: DEAL,
      kind: "convention",
    });
    expect(result.isError).not.toBe(true);
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ authorizedById: "audit-rule-1" }));
    // The rule authorized the whole call, so no second memory.write decision is audited.
    const created = vi.mocked(db.auditLog.create).mock.calls.map(([a]) => (a as { data: { action: string } }).data);
    expect(created.filter((d) => d.action === "memory.write")).toHaveLength(0);
  });
});
