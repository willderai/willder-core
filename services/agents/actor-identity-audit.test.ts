import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
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

// memory_read requires a real actorId. agentContextFromRuntime never falls back
// to a literal actor like "agent" when the caller's RuntimeContext has no real
// actorId, and memory_read guards on actorId the way it guards on
// orgId/capabilityToken: a call with no identity is rejected, never silently
// ALLOWED and audited under a plausible-looking but fabricated actor.
//
// services/access/check.test.ts and services/agents/tools.test.ts prove the two
// halves in isolation (evaluate()'s guard; agentContextFromRuntime not masking a
// missing actorId). Neither proves the two actually meet at
// the real audit_log write. This drives the real chokepoint — check() and
// GuardedMemoryStore unmocked — with only the DB and the raw backing store
// stubbed, the same minimal-mock discipline as services/memory/access-flow.test.ts
// and services/memory/access-leakage-eval.test.ts.
//
// Verified against the pre-fix code before writing the fix: reverting
// agentContextFromRuntime's actorId fallback to `?? "agent"` (with evaluate()'s
// guard also reverted) turns the "denies" case below green-for-the-wrong-reason
// into a real failure — it resolves facts and audits actorId "agent" instead of
// denying, so this test does not pass vacuously.

vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
// The raw backend the real `guardedMemory` singleton wraps (services/memory/
// store.ts) — stubbed so importing it doesn't boot a real Graphiti/pgvector
// backend. Reached only if check() were to (wrongly) allow the denied case.
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
}));
// Mocked rather than left to load for real: the real module pulls in
// services/agents/runner.ts, which circularly imports back into this file's own
// module ("./tools") — safe when something else loads the barrel first, but a
// crash when this test file is the very first thing to import "./tools" (same
// gap noted in services/agents/tools.test.ts).
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { db } from "@/lib/db";
import { memory as rawStore } from "@/services/memory/store";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { memoryReadTool } from "./tools";

function run(tool: { execute?: (args: never) => Promise<unknown> }, args: never) {
  if (!tool.execute) throw new Error("tool has no execute");
  return tool.execute(args) as Promise<{ facts: unknown[]; error?: string }>;
}

function makeRc(vals: Record<string, string> = {}) {
  const rc = new RuntimeContext();
  for (const [k, v] of Object.entries(vals)) rc.set(k, v);
  return rc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(rawStore.retrieve).mockResolvedValue({ facts: [] } as never);
  // A capability that would legitimately allow the read if identity weren't the
  // problem — isolates the denial to the missing actorId, not scope/permission.
  // Issued to "agent_research", matching the positive-control case's real actorId
  // below, since evaluate() also compares the two.
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "admin", agentId: "agent_research" }] as never);
});

describe("memory_read requires a real actorId, end to end", () => {
  it("denies and audits a deny instead of resolving facts under the fallback actor 'agent'", async () => {
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test" }); // no actorId
    const res = await run(memoryReadTool, {
      context: { query: "deal status" },
      runtimeContext: rc,
    } as never);

    expect(res.facts).toEqual([]);
    expect(res.error).toMatch(/actor identity required/i);
    expect(rawStore.retrieve).not.toHaveBeenCalled();

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(data.decision).toBe("deny");
    expect(data.reason).toMatch(/actor identity required/);
    expect(data.actorId).not.toBe("agent");
  });

  it("still resolves and audits under the real actor id when one is present", async () => {
    const rc = makeRc({ orgId: "org_1", capabilityToken: "wcap_test", actorId: "agent_research" });
    const res = await run(memoryReadTool, {
      context: { query: "deal status" },
      runtimeContext: rc,
    } as never);

    expect(res.error).toBeUndefined();
    const data = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(data.decision).toBe("allow");
    expect(data.actorId).toBe("agent_research");
  });
});
