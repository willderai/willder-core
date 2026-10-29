// The read/write direction of scope resolution, pinned per call site.
//
// The normalize + validate + resolve logic for a caller-supplied scopePath is
// ONE helper, resolveCallerScopePath() in services/access/check.ts, and the
// read/write asymmetry is carried as a parameter:
//
//   onInvalid: "fallback"  — read sites. A malformed scopePath is discarded and
//                            the token's own cap.scopePath is used instead.
//                            Safe BECAUSE a read can never return more than the
//                            token already covers.
//   onInvalid: "refuse"    — write sites. The same fallback on a write stores
//                            the caller's content at the WIDER scope while
//                            telling them "Stored." — a fail-open regression.
//
// With the direction a single word in an argument object, the two directions
// are one token apart, so each call site's direction needs its own pin.
// mcp/read-scope-validation.test.ts is deliberately remedy-agnostic (its
// malformed-scopePath assertions are `expect(boundValues()).not.toContain(
// MALFORMED)` plus a conditional `if (result.isError)`), so a refusing
// memory_query satisfies it. A behavioral assertion is only safe if every
// behavior it admits is safe, and here they are not equivalent: refusing a
// read is a correctness/availability regression (a caller entitled to their
// own scope gets AccessDeniedError plus a spurious deny audit row instead of
// their facts), not a leak. This file pins the read sites to "fallback".
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
// The write path queues through ingestMemory (@/lib/inngest), NOT through
// memory.ingest — mocking only the store leaves the real ingestMemory in place,
// which throws for its own unrelated reasons in this sandbox and makes a write
// "fail" whether or not it was actually refused. Same seam
// ingest-scope-validation.test.ts uses.
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { memory } from "@/services/memory/store";
import { registerWillderTools } from "./tools";
import type { AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_read_direction_test";

/** A genuinely malformed input: a SPACE. On Postgres,
 * `SELECT 'org_x.deal A'::ltree` throws 42601 "ltree syntax error".
 *
 * Deliberately NOT the hyphenated `org.deal-A` that read-scope-validation,
 * ingest-scope-validation and get-my-brief-scope-validation all use as their
 * "malformed" exemplar. That premise is wrong: the same live check shows
 * `SELECT 'org_x.deal-A'::ltree` casts fine and `org_x @> org_x.deal-A` is
 * true, so a hyphen is a perfectly legal ltree label on the deployed Postgres.
 * See mcp/scope-guard-ltree-contract.test.ts. Using a value Postgres really
 * rejects means this file keeps testing the direction invariant it is about,
 * before AND after isValidLtreePath is corrected. */
const MALFORMED = `${ORG}.deal A`;

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

/** The audit rows this call wrote that are the REFUSE path's signature: a deny
 * recorded against the malformed value the caller supplied. check()'s own
 * recordAudit() on the fallback path writes an ALLOW against the resolved
 * scope instead, so this distinguishes the two directions by their real
 * observable effect rather than by which branch ran. */
function denyRowsForMalformed(): unknown[] {
  return vi
    .mocked(db.auditLog.create)
    .mock.calls.map((call) => (call[0] as { data: Record<string, unknown> })?.data)
    .filter((data) => data?.decision === "deny" && data?.target === MALFORMED);
}

describe("read-side scope resolution stays FALLBACK, not refuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "agent_1" }] as never);
    vi.mocked(memory.retrieve).mockResolvedValue({ facts: [] });
    vi.mocked(memory.entity).mockResolvedValue(null);
  });

  // ── memory_query ─────────────────────────────────────────────────────────

  it("memory_query: a malformed scopePath still completes the read, it is not refused", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    const result = await memoryQuery({ query: "anything", scopePath: MALFORMED });

    // A refusing memory_query throws AccessDeniedError out of the resolver,
    // before the store is ever consulted. The read must actually happen.
    expect(vi.mocked(memory.retrieve)).toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
  });

  it("memory_query: the read falls back to the token's own scope, not the malformed value", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    await memoryQuery({ query: "anything", scopePath: MALFORMED });

    // guarded-store takes the resolved target as its scope argument (3rd arg).
    const scopeArg = vi.mocked(memory.retrieve).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(scopeArg)).not.toContain(MALFORMED);
  });

  it("memory_query: a malformed scopePath does not write a deny audit row against it", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    await memoryQuery({ query: "anything", scopePath: MALFORMED });

    // The refuse direction records a deny on a read the token was actually
    // entitled to make — a false negative in the audit trail, which items
    // 22/27/05/07 all treated as a real defect in the other direction.
    expect(denyRowsForMalformed()).toEqual([]);
  });

  // ── memory_entity ────────────────────────────────────────────────────────

  it("memory_entity: a malformed scopePath still completes the read, it is not refused", async () => {
    const memoryEntity = handlers().get("memory_entity")!;
    const result = await memoryEntity({ entityId: "e1", scopePath: MALFORMED });

    expect(vi.mocked(memory.entity)).toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
  });

  it("memory_entity: a malformed scopePath does not write a deny audit row against it", async () => {
    const memoryEntity = handlers().get("memory_entity")!;
    await memoryEntity({ entityId: "e1", scopePath: MALFORMED });

    expect(denyRowsForMalformed()).toEqual([]);
  });

  // ── the asymmetry itself ─────────────────────────────────────────────────

  it("the SAME malformed value is refused on the write site — the directions are not uniform", async () => {
    // The control that makes this file about the asymmetry rather than about
    // "everything falls back": if an edit made the helper uniformly fallback
    // (the fail-open regression, re-entered through the shared helper instead
    // of through a hand-rolled ?? chain), the five cases above would all still
    // pass. This one must not.
    //
    // Every assertion here is specific to REFUSAL, not to "an error happened".
    // `isError` alone is not enough: a fallback-mutated write can still fail
    // further down for an unrelated reason. An error is not evidence of the
    // error you meant.
    const memoryIngest = handlers().get("memory_ingest")!;
    const result = await memoryIngest({
      content: "secret deal note",
      name: "Deal A",
      scopePath: MALFORMED,
    });

    expect(result.isError).toBe(true);
    // Refused for the RIGHT reason, named back to the caller.
    expect(JSON.stringify(result.content)).toContain("not a valid scope path");
    // Nothing queued — a fallback-mutated write reaches ingestMemory with the
    // widened target instead.
    expect(vi.mocked(ingestMemory)).not.toHaveBeenCalled();
    // And the refusal is on the record, against the scope actually requested.
    expect(denyRowsForMalformed()).toHaveLength(1);
  });

  it("a read and a write given the same malformed value resolve in OPPOSITE directions", async () => {
    // Stated as one assertion so the invariant is legible to the next reader:
    // read completes and returns facts, write is refused and stores nothing —
    // same input, same org, same token. Compared on what each side actually
    // DID, not on `isError`, for the reason above.
    const tools = handlers();
    await tools.get("memory_query")!({ query: "anything", scopePath: MALFORMED });
    await tools.get("memory_ingest")!({
      content: "secret deal note",
      name: "Deal A",
      scopePath: MALFORMED,
    });

    expect({
      readReachedTheStore: vi.mocked(memory.retrieve).mock.calls.length > 0,
      writeReachedTheQueue: vi.mocked(ingestMemory).mock.calls.length > 0,
    }).toEqual({ readReachedTheStore: true, writeReachedTheQueue: false });
  });
});
