// A handoff a session records for the next (services/memory/session-handoff.ts): memory_ingest
// refuses one missing a part, naming what to add, and stores a complete one as progress, without
// graph extraction. The next session's block lays it out (mcp/task-start-boundary.test.ts).
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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWillderTools } from "../tools";

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_handoff";
const session = { _meta: { "willder/session": "s-1", "willder/task": "WEB-412" } };
const COMPLETE = [
  "Still failing or unfinished: the cross-agent overlap case",
  "Done and checked: npx vitest run tests/overlap.test.ts: 12 passed",
  "Decisions: key the cache by org, since agent ids repeat across orgs",
  "Rejected: none",
  "Not yet checked: the retry path",
  "Next step: verify the cross-agent test fails on main, then extend possibleOverlap",
].join("\n");

function ingestTool(): Handler {
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "writer" }] as never);
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((toolName: string, _config: unknown, handler: Handler) => void tools.set(toolName, handler)),
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

describe("memory_ingest of a handoff", () => {
  it.each([
    [
      "a part is missing",
      "Handoff: WEB-412, session s-1",
      COMPLETE.replace("Rejected: none\n", ""),
      /missing Rejected:/,
    ],
    [
      "checked work names no evidence",
      "Handoff: WEB-412, session s-1",
      COMPLETE.replace("npx vitest run tests/overlap.test.ts: 12 passed", "the tests pass"),
      /names no evidence/,
    ],
    [
      "the name is spelled in lower case",
      "handoff: WEB-412",
      COMPLETE.replace("Next step:", "Then:"),
      /missing Next step:/,
    ],
  ])(
    "is refused before anything is checked or stored when %s, and says what to add",
    async (_name, name, content, problem) => {
      const reply = await ingestTool()({ name, content }, session);

      expect(reply.isError).toBe(true);
      expect(reply.content[0]!.text).toMatch(/^incomplete_handoff: nothing was stored\./);
      expect(reply.content[0]!.text).toMatch(problem);
      expect(ingestMemory).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("is stored as progress, without graph extraction, when complete; a role it states is kept", async () => {
    const ingest = ingestTool();
    const first = await ingest({ name: "Handoff: WEB-412, session s-1", content: COMPLETE }, session);
    await ingest({ name: "Handoff: WEB-412, session s-2", content: COMPLETE, role: "decision" }, session);

    expect(first.isError).toBeUndefined();
    expect(first.content[0]!.text).toContain("Version: v1.");
    const calls = vi.mocked(ingestMemory).mock.calls.map(([input]) => input);
    expect(calls[0]).toMatchObject({ role: "progress", skipGraphExtraction: true, task: "WEB-412", sessionKey: "s-1" });
    expect(calls[1]).toMatchObject({ role: "decision", skipGraphExtraction: true });
  });

  it("never checks a rule named like a handoff: a convention or decision is not a session's handoff", async () => {
    const reply = await ingestTool()(
      { name: "Handoff: how we hand work over", content: "Hand off at five.", kind: "convention" },
      session,
    );

    expect(reply.content[0]!.text).not.toMatch(/^incomplete_handoff/);
  });

  it("leaves any other fact as it was: no check, no role, extraction as usual", async () => {
    await ingestTool()({ name: "Handoffs we make", content: "We hand off at five." }, session);

    const [input] = vi.mocked(ingestMemory).mock.calls[0]!;
    expect(input).not.toHaveProperty("skipGraphExtraction");
    expect(input.role).toBeUndefined();
  });
});
