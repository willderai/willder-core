// Revision receipts on memory_query and memory_entity, driven through the real
// registerWillderTools handlers, check() and guardedMemory. Only the database and
// the raw memory store are stubbed; the database side is covered in
// revision-receipt.realdb.test.ts.
import { READ_GRANT_NOTE } from "./read-notes";
import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));
// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) serves them as they are; it is proven against
// real rows in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
// The caller's own not-yet-extracted versions are read from Postgres and covered by
// mcp/graph-read-your-writes.realdb.test.ts; this file's db mock answers every query alike.
vi.mock("@/services/memory/own-pending-facts", () => ({ loadOwnPendingFacts: async () => [] }));

vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    source: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
vi.mock("@/services/memory/store", () => ({
  memory: {
    retrieve: vi.fn(),
    entity: vi.fn(),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  },
  graphitiStore: {},
}));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
// Change notices are appended after the receipt and are covered in their own files.
vi.mock("./change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/lib/db";
import { memory } from "@/services/memory/store";
import { registerWillderTools } from "./tools";
import { REVISION_META_KEY, UNCHANGED_META_KEY, withRevisionReceipt } from "./revision-receipt";
import type { AccessContext } from "@/services/access";
import type { MemoryFact } from "@/types/memory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface Result {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const ORG = "org_rev";

function tool(name: "memory_query" | "memory_entity"): Handler {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (toolName: string, _config: unknown, handler: Handler) => tools.set(toolName, handler),
  };
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_rev" },
    origin: "mcp",
  };
  registerWillderTools(server as unknown as McpServer, ctx, { orgId: ORG, agentId: "agent_1", scopePath: ORG });
  return tools.get(name)!;
}

const fact = (uuid: string, text: string): MemoryFact => ({ uuid, fact: text, validAt: null });

async function query(facts: MemoryFact[], args: Record<string, unknown> = {}): Promise<Result> {
  vi.mocked(memory.retrieve).mockResolvedValueOnce({ facts });
  return tool("memory_query")({ query: "release", ...args });
}

const revisionOf = (result: Result) => result._meta?.[REVISION_META_KEY] as string;
const allText = (result: Result) => result.content.map((c) => c.text).join("\n");

describe("memory_query revision receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
  });

  it("keeps the answer as the first block and adds the revision after it", async () => {
    const result = await query([fact("f1", "The release ships on Friday")]);

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe(`• The release ships on Friday — uncited\n\n${READ_GRANT_NOTE}`);
    expect(revisionOf(result)).toMatch(/^[0-9a-f]{16}$/);
    expect(result.content[1].text).toBe(`revision: ${revisionOf(result)}`);
    expect(result._meta?.[UNCHANGED_META_KEY]).toBe(false);
  });

  it("returns an unchanged receipt, with no fact text, when the caller already holds the answer", async () => {
    const facts = [fact("f1", "The release ships on Friday")];
    const first = await query(facts);
    const auditRowsPerRead = vi.mocked(db.auditLog.create).mock.calls.length;

    const second = await query(facts, { ifRevision: revisionOf(first) });

    expect(second.content).toEqual([
      { type: "text", text: expect.stringMatching(new RegExp(`^Unchanged since revision ${revisionOf(first)}\\.`)) },
    ]);
    expect(allText(second)).not.toContain("release ships");
    expect(second._meta).toMatchObject({ [REVISION_META_KEY]: revisionOf(first), [UNCHANGED_META_KEY]: true });
    // The read still ran through check() and was audited; only the payload was skipped.
    expect(memory.retrieve).toHaveBeenCalledTimes(2);
    expect(auditRowsPerRead).toBeGreaterThan(0);
    expect(db.auditLog.create).toHaveBeenCalledTimes(2 * auditRowsPerRead);
  });

  it("returns the full answer and a new revision once a fact changes", async () => {
    const first = await query([fact("f1", "The release ships on Friday")]);

    const second = await query([fact("f1", "The release ships on Monday")], { ifRevision: revisionOf(first) });

    expect(second.content[0].text).toBe(`• The release ships on Monday — uncited\n\n${READ_GRANT_NOTE}`);
    expect(revisionOf(second)).not.toBe(revisionOf(first));
  });

  it("does not accept a revision from a different question, even when the answer text matches", async () => {
    const facts = [fact("f1", "The release ships on Friday")];
    const first = await query(facts);

    const other = await query(facts, { query: "launch", ifRevision: revisionOf(first) });

    expect(other.content[0].text).toBe(`• The release ships on Friday — uncited\n\n${READ_GRANT_NOTE}`);
    expect(revisionOf(other)).not.toBe(revisionOf(first));
  });

  it("gives an empty answer a revision too", async () => {
    const first = await query([]);
    expect(first.content[0].text).toBe("No facts found.");

    const second = await query([], { ifRevision: revisionOf(first) });
    expect(second._meta?.[UNCHANGED_META_KEY]).toBe(true);
  });

  it("returns the full answer for a malformed or stale ifRevision", async () => {
    const result = await query([fact("f1", "The release ships on Friday")], { ifRevision: "not-a-revision" });

    expect(result.content[0].text).toBe(`• The release ships on Friday — uncited\n\n${READ_GRANT_NOTE}`);
    expect(result._meta?.[UNCHANGED_META_KEY]).toBe(false);
  });

  it("denies a caller without access even when it sends the current revision, and gives no revision", async () => {
    const facts = [fact("f1", "The release ships on Friday")];
    const held = revisionOf(await query(facts));

    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    const denied = await query(facts, { ifRevision: held });

    expect(denied.isError).toBe(true);
    expect(allText(denied)).toMatch(/^Access denied/);
    expect(allText(denied)).not.toContain("Unchanged");
    expect(denied._meta?.[REVISION_META_KEY]).toBeUndefined();
  });
});

describe("memory_entity revision receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
  });

  const acme = {
    uuid: "e1",
    name: "Acme",
    type: "company",
    summary: "A customer",
    facts: [fact("f1", "Acme renewed")],
  };

  it("returns an unchanged receipt for the same entity at the same revision", async () => {
    vi.mocked(memory.entity).mockResolvedValue(acme as never);
    const first = await tool("memory_entity")({ entityId: "e1" });
    expect(first.content[0].text).toBe("Acme (company)\nA customer\n• Acme renewed");

    const second = await tool("memory_entity")({ entityId: "e1", ifRevision: revisionOf(first) });

    expect(second._meta?.[UNCHANGED_META_KEY]).toBe(true);
    expect(allText(second)).not.toContain("Acme renewed");
  });

  it("returns the full entity again once one of its facts changes", async () => {
    vi.mocked(memory.entity).mockResolvedValueOnce(acme as never);
    const first = await tool("memory_entity")({ entityId: "e1" });

    vi.mocked(memory.entity).mockResolvedValueOnce({ ...acme, facts: [fact("f1", "Acme churned")] } as never);
    const second = await tool("memory_entity")({ entityId: "e1", ifRevision: revisionOf(first) });

    expect(second.content[0].text).toBe("Acme (company)\nA customer\n• Acme churned");
  });

  it("gives 'Entity not found.' no revision, so hidden and absent stay alike", async () => {
    vi.mocked(memory.entity).mockResolvedValue(null);
    const result = await tool("memory_entity")({ entityId: "e404" });

    expect(result.content).toEqual([{ type: "text", text: "Entity not found." }]);
    expect(result._meta?.[REVISION_META_KEY]).toBeUndefined();
  });
});

describe("withRevisionReceipt", () => {
  it("passes an error result through without a revision", () => {
    const error = { content: [{ type: "text" as const, text: "Access denied: no capability" }], isError: true };

    expect(withRevisionReceipt("memory_query", {}, undefined, error)).toBe(error);
  });
});
