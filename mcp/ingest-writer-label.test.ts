// memory_query names who wrote a fact, and that name is fixed when
// memory_ingest stores it. A token minted under a free-text agent id that spells a
// built-in agent another way (`qa_agent` for `qa-agent`) must be cited as what it is,
// never in a form a reader would take for the built-in agent or the system.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { registerWillderTools } from "./tools";
import { formatCitedFacts } from "./fact-citation";
import { QA_AGENT_NAME } from "@/services/access/system-actors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_writer_label";

/** The citation memory_query gives a fact memory_ingest stored for a token minted under `agentId`. */
async function citationFor(agentId: string, agentRows: { agentKey: string; name: string }[] = []): Promise<string> {
  vi.mocked(db.agent.findMany).mockResolvedValue(agentRows as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId }] as never);
  const tools = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _c: unknown, h: Handler) => void tools.set(name, h)) };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: "wcap_xyz" }, origin: "mcp" },
    { orgId: ORG, agentId, scopePath: ORG },
  );
  const result = await tools.get("memory_ingest")!({ content: "Release moved to Friday", name: "Release" });
  expect(result.isError).not.toBe(true);
  const stored = vi.mocked(ingestMemory).mock.calls.at(-1)![0];
  const line = await formatCitedFacts(ORG, [
    { fact: "Release moved to Friday", actorName: stored.actorName, actorType: stored.actorType } as never,
  ]);
  return line.slice(line.lastIndexOf(" — ") + 3);
}

/** How a reader compares two citations by eye. */
const looksLike = (citation: string) => citation.toLowerCase().replace(/[^a-z0-9]+/g, "");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
});

describe("memory_query's writer citation", () => {
  it("cites a lookalike free-text id as a token, apart from every built-in writer", async () => {
    const real = [
      `from: ${QA_AGENT_NAME} (agent)`, // the built-in QA agent's own writes
      await citationFor("qa-agent"), // a token issued to the built-in id with no Agent row
      await citationFor("qa-agent", [{ agentKey: "qa-agent", name: QA_AGENT_NAME }]), // and with its seeded row
      await citationFor("system"),
    ].map(looksLike);
    for (const spoof of ["qa_agent", "QA Agent", "qa agent", "System"]) {
      const cited = await citationFor(spoof);
      expect(cited).toBe(`from: ${JSON.stringify(spoof)} (agent token) (agent)`);
      expect(real).not.toContain(looksLike(cited));
    }
  });

  it("cites an Agent row named like a built-in agent with its own key", async () => {
    const cited = await citationFor("custom-1", [{ agentKey: "custom-1", name: QA_AGENT_NAME }]);
    expect(cited).toBe(`from: QA agent Agent (agent key "custom-1") (agent)`);
  });

  it("leaves the built-in agent's citation as it was", async () => {
    expect(await citationFor("qa-agent")).toBe("from: Qa Agent Agent (agent)");
    expect(await citationFor("qa-agent", [{ agentKey: "qa-agent", name: QA_AGENT_NAME }])).toBe(
      "from: QA agent Agent (agent)",
    );
  });
});
