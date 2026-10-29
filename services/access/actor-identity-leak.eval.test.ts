// Missing-caller-identity leak scenario.
//
// The guarded defect is a MISATTRIBUTION leak, not a scope leak: a memory_read
// arriving with a valid capability token but no real caller identity must be
// denied, never allowed and audited under a fabricated placeholder actor such as
// "agent". An audit trail that reads as a clean, plausible allow for an actor
// that never made the call is the same "wrong but plausible-looking audit row"
// family as a missing runId or a mis-scoped target.
//
// This file is deliberately NOT a copy of
// services/agents/actor-identity-audit.test.ts. Two differences that matter:
//
//  1. The raw backing store here returns REAL FACTS. That file's double
//     resolves `{ facts: [] }`, so its "nothing came back" assertion holds
//     whether or not the guard fires — the teeth are entirely in the
//     "retrieve was never called" assertion. Here a regression genuinely
//     surfaces confidential fact text to a caller with no identity, so the
//     leak assertion is a real one.
//  2. It pins the audit row's actorId to exactly "" rather than merely
//     "not 'agent'". `not.toBe("agent")` would stay green if a change
//     substituted some other fabricated placeholder ("unknown", "system", the
//     agent's display name); the rule is that NOTHING is fabricated, so the
//     empty identity has to survive to the audit row verbatim.
//
// Seam: the real memoryReadTool -> real agentContextFromRuntime -> real
// GuardedMemoryStore -> real check() chain. Only @/lib/db and the raw store
// singleton are mocked, the same minimal-mock discipline as
// services/memory/access-leakage-eval.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
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
    auditLog: { create: vi.fn(), update: vi.fn() },
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
}));
// services/agents/tools.ts <-> services/agents/runner.ts is a circular import;
// mocking the inngest edge keeps this file safe as the first importer of
// "./tools" (same note as services/agents/actor-identity-audit.test.ts).
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { db } from "@/lib/db";
import { memory as rawStore } from "@/services/memory/store";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { memoryReadTool } from "@/services/agents/tools";

const ORG = "org_identity";
const SECRET = "Acme renewal is at risk, legal flagged the indemnity clause";

type ToolResult = { facts: { fact: string }[]; error?: string };

function run(rc: RuntimeContext<Record<string, never>>): Promise<ToolResult> {
  const tool = memoryReadTool as unknown as { execute?: (a: never) => Promise<unknown> };
  if (!tool.execute) throw new Error("memoryReadTool has no execute");
  return tool.execute({ context: { query: "renewal risk" }, runtimeContext: rc } as never) as Promise<ToolResult>;
}

function rcWith(vals: Record<string, string>) {
  const rc = new RuntimeContext();
  for (const [k, v] of Object.entries(vals)) rc.set(k, v);
  return rc as RuntimeContext<Record<string, never>>;
}

/** Every audit_log row check() wrote during the case under test. */
function auditRows() {
  return vi.mocked(db.auditLog.create).mock.calls.map(([arg]) => (arg as { data: Record<string, unknown> }).data);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_1" } as never);
  // A capability that genuinely covers this read, issued to the same agent
  // ("agent_research") the positive-control case below claims to be — so the
  // ONLY thing that can deny the call is the missing identity, never scope,
  // permission, or a capability-owner mismatch.
  vi.mocked(db.$queryRaw).mockResolvedValue([
    { permission: "admin", createdBy: "user_1", agentId: "agent_research" },
  ] as never);
  // Real content behind the chokepoint. If the guard regresses, this leaks.
  vi.mocked(rawStore.retrieve).mockResolvedValue({
    facts: [{ fact: SECRET, confidence: 0.9, actorType: "human", uuid: "f1" }],
  } as never);
});

describe("a memory_read with no caller identity leaks nothing and is audited as a deny", () => {
  it("returns no facts, never reaches the memory backend, and writes a deny row attributed to no one", async () => {
    const res = await run(rcWith({ orgId: ORG, capabilityToken: "wcap_valid" })); // no actorId

    // Nothing out of the store surfaces to an unidentified caller.
    expect(res.facts).toEqual([]);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(rawStore.retrieve).not.toHaveBeenCalled();
    expect(res.error).toMatch(/actor identity required/i);

    // The attempt is audited, as a deny, against no fabricated actor.
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("deny");
    expect(rows[0].action).toBe("memory.read");
    expect(rows[0].orgId).toBe(ORG);
    // Exactly "", not "agent" and not any other placeholder identity.
    expect(rows[0].actorId).toBe("");
    expect(rows[0].reason).toMatch(/actor identity required/i);
  });

  it("does not write a fabricated actor id on ANY row for the unidentified call", async () => {
    await run(rcWith({ orgId: ORG, capabilityToken: "wcap_valid" }));

    for (const row of auditRows()) {
      expect(row.actorId).not.toBe("agent");
      expect(row.actorId).toBeFalsy();
    }
  });

  it("still serves a caller that HAS an identity, audited under that real id", async () => {
    // The positive control: proves the deny above is specific to the missing
    // identity rather than the guard having broken agent reads outright.
    const res = await run(rcWith({ orgId: ORG, capabilityToken: "wcap_valid", actorId: "agent_research" }));

    expect(res.error).toBeUndefined();
    expect(res.facts.map((f) => f.fact)).toContain(SECRET);
    expect(rawStore.retrieve).toHaveBeenCalledTimes(1);

    const rows = auditRows();
    expect(rows[0].decision).toBe("allow");
    expect(rows[0].actorId).toBe("agent_research");
  });

  it("a NON-EMPTY but fabricated actor id claiming another agent's token is denied and audited as a mismatch", async () => {
    // The missing-identity guard asks only "is actor.id non-empty". If the
    // agent branch of evaluate() authorized purely on token/org/scope/
    // permission, never comparing `Capability.agentId` (the column that
    // records which agent the token was actually issued to), a context
    // presenting agent A's valid token while claiming to be agent B would be
    // ALLOWED, and recordAudit would write the claimed B onto the row
    // verbatim — the same misattribution, reached through a fabricated
    // identity instead of an absent one.
    //
    // Enforced at the chokepoint (evaluate()'s agent branch, not this tool):
    // every matching capability row is filtered to `agentId ===
    // ctx.actor.id` before the permission check, and a token that resolves to
    // rows but none owned by the claimed actor is denied+audited as a
    // mismatch, distinct from "no valid capability" (which still means "no
    // row at all").
    //
    // No trusted caller trips this: all five
    // lib/{research,copy,handoff,qa,architecture}-agent.ts sites construct
    // `actor.id` from the exact same exported constant (`RESEARCH_AGENT_ID`
    // etc.) they pass as `agentId` to `db.capability.create()` when
    // provisioning that agent's own token, and both MCP entry points
    // (mcp/server.ts, app/api/mcp/route.ts) set `actor.id: cap.agentId`
    // directly from `resolveCapability()`'s own return value. The chokepoint
    // makes that invariant enforced, not just true by construction at every
    // caller.
    const REAL_OWNER = "agent_real_owner";
    const IMPOSTOR = "agent_impostor";
    // Faithful to production: the real query returns the owning capability row
    // for a valid token without regard to who is claiming to use it — the
    // comparison against the claimed actor happens in evaluate(), not the SQL.
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "admin", createdBy: "u1", agentId: REAL_OWNER }] as never);

    const res = await run(rcWith({ orgId: ORG, capabilityToken: "wcap_belongs_to_another_agent", actorId: IMPOSTOR }));

    // The read is refused outright — nothing leaks to the impostor.
    expect(res.facts).toEqual([]);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(rawStore.retrieve).not.toHaveBeenCalled();
    expect(res.error).toMatch(/mismatch/i);

    // ...and the audit trail records BOTH the claimed (impostor) actor and a
    // reason naming the mismatch — a deny that says exactly what happened,
    // not a plausible-looking allow under the wrong identity.
    const rows = auditRows();
    expect(rows[0]).toMatchObject({ decision: "deny", actorId: IMPOSTOR });
    expect(rows[0].reason).toMatch(/mismatch/i);
  });

  it("denies the unidentified caller BEFORE the capability lookup, not after it", async () => {
    // Ordering matters for more than efficiency: if identity were checked
    // after the token query, a valid token's ALLOW decision would already have
    // been computed, and any future refactor that returned it early would
    // resurrect the exact bug. Pinning "no DB capability round trip happened"
    // pins the guard's position in evaluate(), not just its existence.
    await run(rcWith({ orgId: ORG, capabilityToken: "wcap_valid" }));

    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
