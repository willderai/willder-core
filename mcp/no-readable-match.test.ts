// memory_query's no-readable-match note around the value check, driven through the real
// registerWillderTools handler, check() and guardedMemory. The database, the raw memory
// store and the check over readable memory (services/memory/readable-values.ts) are
// stubbed, so these tests pin what the tool and the guarded read do with the check's
// answer, its failure and its gate. The check itself runs on Postgres in
// mcp/no-readable-match.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/services/memory/own-pending-facts", () => ({ loadOwnPendingFacts: async () => [] }));
vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: vi.fn(async () => ({ settings: {} })) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
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
vi.mock("./change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/memory/readable-values", () => ({
  readableMemoryHolds: vi.fn(),
  graphOnlyContentReachable: vi.fn(),
}));

import { db } from "@/lib/db";
import { memory } from "@/services/memory/store";
import { graphOnlyContentReachable, readableMemoryHolds } from "@/services/memory/readable-values";
import { registerWillderTools } from "./tools";
import { NO_READABLE_MATCH_NOTE, READ_GRANT_NOTE, UNHELD_VALUES_META_KEY } from "./read-notes";
import { REVISION_META_KEY, withRevisionReceipt } from "./revision-receipt";
import type { AccessContext } from "@/services/access";
import type { MemoryFact } from "@/types/memory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface Result {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const ORG = "org_nrm";
const SCOPE = `${ORG}.care`;
const GUESS = "Yes or no: did the temporary safe number end in 0174?";

function memoryQuery(): Handler {
  const tools = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler) };
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_nrm" },
    origin: "mcp",
  };
  registerWillderTools(server as unknown as McpServer, ctx, { orgId: ORG, agentId: "agent_1", scopePath: SCOPE });
  return tools.get("memory_query")!;
}

const fact = (uuid: string, text: string, store: MemoryFact["store"] = "semantic"): MemoryFact => ({
  uuid,
  fact: text,
  validAt: null,
  store,
});
const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

async function ask(facts: MemoryFact[], query = GUESS): Promise<Result> {
  vi.mocked(memory.retrieve).mockResolvedValue({ facts });
  const result = await memoryQuery()({ query });
  expect(result.isError, textOf(result)).not.toBe(true);
  return result;
}

describe("memory_query and the value check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(db.org.findUnique).mockResolvedValue({ settings: {} } as never);
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
    vi.mocked(graphOnlyContentReachable).mockResolvedValue(false);
    vi.mocked(readableMemoryHolds).mockResolvedValue([false]);
  });

  it("gives the fixed note and the unheld positions when no readable memory holds the value, and never the value", async () => {
    const result = await ask([fact("f1", "Portal-only contact is active.")]);
    expect(result.content[0]!.text).toBe(
      `• Portal-only contact is active. — uncited · version f1\n\n${NO_READABLE_MATCH_NOTE}\n\n${READ_GRANT_NOTE}`,
    );
    expect(result._meta?.[UNHELD_VALUES_META_KEY]).toEqual([0]);
    expect(textOf(result)).not.toContain("0174");
    // The check is asked over the read's own scope, with the value the question names.
    expect(vi.mocked(readableMemoryHolds).mock.calls[0]![0]).toEqual({
      orgId: ORG,
      scope: SCOPE,
      includeUntagged: false,
    });
    expect(vi.mocked(readableMemoryHolds).mock.calls[0]![1].map((v) => v.key)).toEqual(["0174"]);
  });

  it.each([
    ["a page with records ends with", [fact("f1", "Portal-only contact is active.")], true],
    ["an empty page never carries", [], false],
  ])("%s the read-grant note", async (_case, facts, expected) => {
    vi.mocked(readableMemoryHolds).mockResolvedValue([true]);
    const result = await ask(facts);
    expect(result.content[0]!.text.endsWith(`\n\n${READ_GRANT_NOTE}`)).toBe(expected);
    expect(textOf(result).includes(READ_GRANT_NOTE)).toBe(expected);
  });

  it("gives the note on an empty page too", async () => {
    const result = await ask([]);
    expect(textOf(result)).toContain(`No facts found.\n\n${NO_READABLE_MATCH_NOTE}`);
  });

  it("gives no note when readable memory holds the value", async () => {
    vi.mocked(readableMemoryHolds).mockResolvedValue([true]);
    const result = await ask([fact("f1", "Portal-only contact is active.")]);
    expect(textOf(result)).not.toContain(NO_READABLE_MATCH_NOTE);
    expect(result._meta?.[UNHELD_VALUES_META_KEY]).toEqual([]);
  });

  it("gives no note when a fact the read returned holds the value, whatever the check found", async () => {
    const result = await ask([fact("g1", "The temporary line ended in 0174.", "graph")]);
    expect(textOf(result)).not.toContain(NO_READABLE_MATCH_NOTE);
    expect(result._meta?.[UNHELD_VALUES_META_KEY]).toEqual([]);
  });

  it("does not ask the check for a question that names no value, and reports none unheld", async () => {
    const result = await ask([fact("f1", "Portal-only contact is active.")], "What contact preference is active?");
    expect(readableMemoryHolds).not.toHaveBeenCalled();
    expect(result._meta?.[UNHELD_VALUES_META_KEY]).toEqual([]);
    expect(textOf(result)).not.toContain(NO_READABLE_MATCH_NOTE);
  });

  it("makes no claim, and still answers, when the check fails", async () => {
    vi.mocked(readableMemoryHolds).mockRejectedValue(new Error("connection reset"));
    const result = await ask([fact("f1", "Portal-only contact is active.")]);
    expect(textOf(result)).toContain("Portal-only contact is active.");
    expect(textOf(result)).not.toContain(NO_READABLE_MATCH_NOTE);
    expect(result._meta).not.toHaveProperty(UNHELD_VALUES_META_KEY);
    expect(result._meta?.[REVISION_META_KEY]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("makes no claim when the read could reach graph content the check cannot search", async () => {
    vi.mocked(graphOnlyContentReachable).mockResolvedValue(true);
    const result = await ask([fact("f1", "Portal-only contact is active.")]);
    expect(readableMemoryHolds).not.toHaveBeenCalled();
    expect(textOf(result)).not.toContain(NO_READABLE_MATCH_NOTE);
    expect(result._meta).not.toHaveProperty(UNHELD_VALUES_META_KEY);
  });

  it("checks without the graph gate on a tier that never asks the graph store", async () => {
    vi.mocked(db.org.findUnique).mockResolvedValue({ settings: { accountTier: "team" } } as never);
    vi.mocked(graphOnlyContentReachable).mockResolvedValue(true);
    const result = await ask([fact("f1", "Portal-only contact is active.")]);
    expect(graphOnlyContentReachable).not.toHaveBeenCalled();
    expect(textOf(result)).toContain(NO_READABLE_MATCH_NOTE);
  });
});

describe("the revision of a result with metadata", () => {
  const result = (meta?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: "No facts found." }],
    ...(meta ? { _meta: meta } : {}),
  });
  const revision = (meta?: Record<string, unknown>) =>
    withRevisionReceipt("memory_query", { q: 1 }, undefined, result(meta))._meta?.[REVISION_META_KEY];

  it("changes when only the metadata does, so a receipt never stands in for different metadata", () => {
    expect(revision({ [UNHELD_VALUES_META_KEY]: [0] })).not.toBe(revision({ [UNHELD_VALUES_META_KEY]: [1] }));
    expect(revision({ [UNHELD_VALUES_META_KEY]: [0] })).not.toBe(revision());
    expect(revision({ [UNHELD_VALUES_META_KEY]: [0] })).toBe(revision({ [UNHELD_VALUES_META_KEY]: [0] }));
  });

  it("matches the receipt the caller holds when the metadata has not changed", () => {
    const held = revision({ [UNHELD_VALUES_META_KEY]: [0] }) as string;
    const again = withRevisionReceipt("memory_query", { q: 1 }, held, result({ [UNHELD_VALUES_META_KEY]: [0] }));
    expect(again._meta?.["willder/unchanged"]).toBe(true);
    expect(again._meta?.[UNHELD_VALUES_META_KEY]).toEqual([0]);
  });
});
