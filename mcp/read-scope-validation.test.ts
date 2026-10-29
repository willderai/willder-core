// memory_query / memory_entity: a caller-supplied scopePath is both normalized
// and validated before it reaches check().
//
// Two one-line helpers cover two different cases: `normalizeScopePath()`
// (services/access/check.ts) for the empty/whitespace case, and
// `isValidLtreePath()` for the malformed case. Normalization alone is not
// enough, because a NON-empty but non-ltree scopePath passes through it:
//
//   • `normalizeScopePath("org_1.deal A")` returns it unchanged — it only
//     collapses empty/whitespace, by design (its own doc comment says so).
//   • So `normalizeScopePath(scopePath) ?? cap.scopePath ?? orgRootPath(...)`
//     alone would hand `check()` the raw caller string.
//   • `check()`/`evaluate()` binds that value into a `::ltree` cast. A label
//     outside ltree syntax (a space, a quote) fails the cast, so the query
//     throws BEFORE `recordAudit()` runs — an unaudited failed access attempt,
//     with the raw Postgres error handed back through `toolError()`.
//
// The assertion below is deliberately about BEHAVIOR, not mechanism: the raw
// caller-supplied string must never be what gets bound into check()'s query.
// Rejecting it up front with a clean tool error, or falling back to the token's
// own cap.scopePath the way the whitespace case does, both satisfy it.
//
// The `limit` case at the bottom is a second, independent finding from the same
// head — see its own comment.
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

vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
vi.mock("@/services/memory/store", () => ({
  memory: {
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
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

import { db } from "@/lib/db";
import { memory } from "@/services/memory/store";
import { registerWillderTools } from "./tools";
import { orgRootPath, type AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SearchInput } from "@/types/memory";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_read_scope_test";

function handlers(capScopePath: string = ORG) {
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => {
      tools.set(name, handler);
    }),
  };
  registerWillderTools(server as unknown as McpServer, ctx, {
    orgId: ORG,
    agentId: "agent_1",
    scopePath: capScopePath,
  });
  return tools;
}

/** Every value bound into any check() query this call made. */
function boundValues(): unknown[] {
  return vi.mocked(db.$queryRaw).mock.calls.flatMap((call) => call.slice(1));
}

// ---------------------------------------------------------------------------
// A malformed (but non-empty) caller scopePath must not reach check() raw
// ---------------------------------------------------------------------------

describe("memory_query / memory_entity — a malformed caller-supplied scopePath must never reach check()'s ltree cast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
    vi.mocked(memory.retrieve).mockResolvedValue({ facts: [] });
  });

  // A space is invalid ltree syntax (42601) on Postgres. A hyphen casts fine
  // and is legal — not a real malformed case.
  const MALFORMED = `${ORG}.deal A`;

  it("memory_query: a malformed (space-containing) scopePath is not handed to check() verbatim", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    const result = await memoryQuery({ query: "anything", scopePath: MALFORMED });

    // Whatever the chosen remedy, the raw non-ltree string must not be what
    // gets bound into the capability/grant lookup — that is the value the
    // real `::ltree` cast throws on, before recordAudit() ever runs.
    expect(boundValues()).not.toContain(MALFORMED);

    // And if it is rejected rather than defaulted, the caller gets a real
    // validation answer, never a raw Postgres error string.
    if (result.isError) {
      expect(JSON.stringify(result.content)).not.toMatch(/ltree|syntax error|invalid input/i);
    }
  });

  it("memory_entity: the same malformed scopePath is not handed to check() verbatim", async () => {
    vi.mocked(memory.entity).mockResolvedValue(null);
    const memoryEntity = handlers().get("memory_entity")!;
    const result = await memoryEntity({ entityId: "e1", scopePath: MALFORMED });

    expect(boundValues()).not.toContain(MALFORMED);
    if (result.isError) {
      expect(JSON.stringify(result.content)).not.toMatch(/ltree|syntax error|invalid input/i);
    }
  });

  it("a well-formed caller scopePath is still honored — the guard must not swallow valid narrowing", async () => {
    // Control, so the fix above can't be "ignore scopePath entirely": a valid
    // ltree path the caller supplies must still reach check() as the target.
    const VALID = `${ORG}.dealA`;
    const memoryQuery = handlers().get("memory_query")!;
    await memoryQuery({ query: "anything", scopePath: VALID });

    expect(boundValues()).toContain(VALID);
  });
});

// ---------------------------------------------------------------------------
// The bare-org fallback must not return up to 2x the requested limit
// ---------------------------------------------------------------------------
//
// The bare-org fallback re-runs the read against the bare-org group and merges
// the two result sets (`mergeFacts(result.facts, orgWide.facts)`). Both legs
// are themselves capped at `limit` (graphiti-store passes
// `limit: input.limit ?? 10`; pgvector's SQL ends `LIMIT ${limit}`), so without
// truncation after the merge a scoped read can hand back as many as 2x what was
// asked for. `memory_query` advertises `limit` as "Max facts to return" and
// caps it at 50 in its own schema, and /api/memory/query clamps to 50 as well,
// so a caller who asks for the documented maximum could receive 100.
//
// Not a leak — every fact returned is one the same caller was already entitled
// to on one of the two legs — but a contract break, and an unbounded-by-schema
// response size on a path that feeds an LLM context window.
describe("memory_query — the bare-org fallback must not return more facts than the caller asked for", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
  });

  it("honors `limit` even when the scoped leg and the bare-org leg both return a full page", async () => {
    const LIMIT = 3;
    // A REAL capability scope, i.e. one that differs from the bare org id —
    // orgRootPath() is what every root-scoped token actually carries, and it is
    // precisely the `target !== input.groupId` condition that arms the fallback.
    const CAP_SCOPE = orgRootPath(ORG);

    // Each leg independently returns a full page of DISTINCT facts, exactly as
    // the real backends would: the scoped Graphiti group and the bare-org
    // Graphiti group hold different episodes, and each is capped at `limit`.
    vi.mocked(memory.retrieve).mockImplementation(async (input: SearchInput) => {
      const leg = input.groupId === ORG ? "orgwide" : "scoped";
      return {
        facts: Array.from({ length: LIMIT }, (_, i) => ({
          uuid: `${leg}-${i}`,
          fact: `${leg} fact ${i}`,
          validAt: null,
        })),
      };
    });

    const memoryQuery = handlers(CAP_SCOPE).get("memory_query")!;
    const result = await memoryQuery({ query: "anything", limit: LIMIT });

    expect(result.isError).not.toBe(true);
    // One bullet per fact in the handler's rendered output.
    const bullets = (result.content[0]?.text ?? "").split("\n").filter((l) => l.startsWith("•"));
    expect(bullets.length).toBeLessThanOrEqual(LIMIT);
  });
});
