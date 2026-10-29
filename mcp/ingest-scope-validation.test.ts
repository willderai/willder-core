// memory_ingest, the WRITE side of the MCP tool surface: a write outside the
// caller's granted scope is rejected, audited, and never reaches the ingest
// pipeline.
//
// The permission axis (read-only token denied, expired token denied) is covered
// elsewhere (app/api/mcp/route.test.ts, services/access/token-lifecycle.eval.test.ts).
// This file covers the scope-containment axis of the write gate, which those
// tests never exercise because none of them passes a `scopePath` at all. Real
// coverage on one axis reads as coverage of the whole gate unless the missing
// axis is named.
//
// The `$queryRaw` mock below models scope containment for real rather than
// answering "yes" to every lookup. Ancestor-or-self is implemented here from
// ltree's own contract (labels are [A-Za-z0-9_]+, dot-separated, `@>` is
// ancestor-or-self), independently of anything mcp/tools.ts does, so a handler
// that hands check() the wrong target scope fails these tests instead of being
// rubber-stamped.
//
// The malformed case asserts the stated contract: normalizeScopePath() is called
// at every route boundary that accepts a body-supplied scopePath, before it
// reaches check() or a `scopePath ?? orgRootPath(...)` write path, and
// isValidLtreePath() covers the non-empty-but-malformed remainder.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
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
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
// Change notices (mcp/change-notices.ts) are out of this file's scope; a silent
// notice keeps them from adding their own queries and audit row to each call.
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { registerWillderTools } from "./tools";
import type { AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_ingest_scope_test";
const DEAL_A = `${ORG}.dealA`;
const DEAL_B = `${ORG}.dealB`;

/** ltree label contract, straight from the spec check.ts documents: one or more
 * `[A-Za-z0-9_]` labels joined by dots. Written here independently of
 * mcp/tools.ts's own isValidLtreePath so this file is not asserting the app
 * against itself. */
function isLtree(value: string): boolean {
  return value.length > 0 && value.split(".").every((label) => /^[A-Za-z0-9_]+$/.test(label));
}

/** ltree `@>` — is `granted` an ancestor of, or equal to, `target`? */
function covers(granted: string, target: string): boolean {
  const g = granted.split(".");
  const t = target.split(".");
  return g.length <= t.length && g.every((label, i) => label === t[i]);
}

/**
 * Stand-in for the capability lookup inside evaluate(). Its bound values are
 * `[orgId, tokenHash, targetPath]` — see services/access/check.ts's agent
 * branch. Two behaviors modelled honestly:
 *
 *  1. A malformed target makes the real query throw on the `::ltree` cast,
 *     BEFORE recordAudit() runs. That ordering is the whole reason the read
 *     tools guard their input, so the mock reproduces it rather than quietly
 *     accepting garbage.
 *  2. A well-formed target returns the fixture capability row only when the
 *     token's own scope actually covers it.
 */
function mockCapabilityLookup(capScopePath: string, permission: "read" | "write" | "admin") {
  vi.mocked(db.$queryRaw).mockImplementation((async (_s: unknown, ...values: unknown[]) => {
    const targetPath = String(values[values.length - 1]);
    if (!isLtree(targetPath)) {
      throw new Error(`syntax error at position 0 near "" — invalid input syntax for type ltree`);
    }
    return covers(capScopePath, targetPath) ? [{ permission, createdBy: null, agentId: "agent_1" }] : [];
  }) as never);
}

function ingestHandler(capScopePath: string): Handler {
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
  return tools.get("memory_ingest")!;
}

/** Every value bound into any check() query this call made. */
function boundValues(): unknown[] {
  return vi.mocked(db.$queryRaw).mock.calls.flatMap((call) => call.slice(1));
}

/** Audit rows recordAudit() wrote during this call. */
function auditRows(): { action: string; decision: string; scopePath?: string }[] {
  return vi
    .mocked(db.auditLog.create)
    .mock.calls.map(([arg]) => (arg as { data: { action: string; decision: string; scopePath?: string } }).data);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
});

// ---------------------------------------------------------------------------
// The leak-scenario test itself — sibling scope, write side.
// ---------------------------------------------------------------------------

describe("memory_ingest — a write outside the caller's granted scope is rejected", () => {
  it("a Deal A write token targeting sibling Deal B is denied, audited, and never reaches the ingest pipeline", async () => {
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    const result = await memoryIngest({
      content: "Deal B is closing at 400k",
      name: "Deal B",
      scopePath: DEAL_B,
    });

    // Denied to the caller...
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Access denied/i);
    // ...and, the part a deny row alone does not prove, the write never happened.
    expect(ingestMemory).not.toHaveBeenCalled();
    // ...and it is on the record.
    const denies = auditRows().filter((r) => r.action === "memory.write" && r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
    // The audit row must name the scope actually attempted, not the token's own
    // scope — otherwise the trail cannot tell a legitimate in-scope write from
    // an attempted cross-scope one.
    expect(boundValues()).toContain(DEAL_B);
  });

  it("the same token writing into its OWN scope is allowed and does reach the pipeline", async () => {
    // Control. Without this, the test above passes just as well against a
    // handler that rejects every write, which would be a broken tool rather
    // than an enforced one.
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    const result = await memoryIngest({
      content: "Deal A moved to legal review",
      name: "Deal A",
      scopePath: DEAL_A,
    });

    expect(result.isError).not.toBe(true);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ scopePath: DEAL_A }));
  });

  it("a descendant of the token's own scope is allowed — containment is ancestor-or-self, not string equality", async () => {
    const CHILD = `${DEAL_A}.thread1`;
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    const result = await memoryIngest({ content: "note", name: "Deal A", scopePath: CHILD });

    expect(result.isError).not.toBe(true);
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ scopePath: CHILD }));
  });

  it("an ANCESTOR of the token's own scope is denied — a deal-scoped token cannot write org-wide", async () => {
    // The direction that actually leaks: writing upward puts content where
    // every sibling scope can read it.
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    const result = await memoryIngest({ content: "org-wide note", name: "Acme", scopePath: ORG });

    expect(result.isError).toBe(true);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("an unscoped call defaults to the token's OWN scope, never the org root", async () => {
    // Mirrors memory_query's counterpart in access-leakage-eval.test.ts: the
    // absent-scopePath default must not silently widen a deal-scoped token to
    // org-wide write access.
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    await memoryIngest({ content: "note", name: "Deal A" });

    expect(boundValues()).toContain(DEAL_A);
    expect(boundValues()).not.toContain(`org_${ORG}`);
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ scopePath: DEAL_A }));
  });

  it("stores the fact under the agent's own name, the one the audit log and the Timeline show", async () => {
    mockCapabilityLookup(DEAL_A, "write");
    vi.mocked(db.agent.findMany).mockResolvedValueOnce([{ agentKey: "agent_1", name: "Release" }] as never);
    await ingestHandler(DEAL_A)({ content: "note", name: "Deal A" });
    expect(ingestMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: "agent_1", actorName: "Release Agent" }),
    );

    // An agent key with no row reads as the audit log's fallback: the key itself, as a token.
    mockCapabilityLookup(DEAL_A, "write");
    await ingestHandler(DEAL_A)({ content: "note", name: "Deal A" });
    expect(ingestMemory).toHaveBeenLastCalledWith(expect.objectContaining({ actorName: '"agent_1" (agent token)' }));
  });
});

// ---------------------------------------------------------------------------
// The caller-supplied scopePath input-validation class, on the write path.
// ---------------------------------------------------------------------------
//
// memory_query and memory_entity normalize and validate the caller-supplied
// scopePath before it reaches check()'s `::ltree` cast; memory_ingest takes the
// same field to the same destination and must guard it too. Assertions below
// are about BEHAVIOR, not mechanism — rejecting the input up front with a clean
// tool error, or falling back to cap.scopePath the way the read tools do, both
// satisfy them.
describe("memory_ingest — a malformed or empty caller scopePath must not reach check()'s ltree cast (write side)", () => {
  it("a malformed (space-containing) scopePath is not handed to check() verbatim, and the failure is still audited", async () => {
    // A space is invalid ltree syntax (42601) on Postgres; a hyphen casts fine,
    // and is refused on a write for another reason (the next test but one).
    const MALFORMED = `${ORG}.deal A`;
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandler(ORG);

    const result = await memoryIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });

    // The raw non-ltree string is what the real cast throws on, before
    // recordAudit() ever runs.
    expect(boundValues()).not.toContain(MALFORMED);
    // Whatever happens, the attempt is on the record — an access attempt that
    // throws its way past the audit trail is the actual defect here.
    expect(auditRows().length).toBeGreaterThan(0);
    // And a caller never gets handed a raw Postgres error.
    if (result.isError) {
      expect(JSON.stringify(result.content)).not.toMatch(/ltree|syntax error|invalid input/i);
    }
    // The assertion this test was missing in its first round, and the reason
    // the fallback remedy shipped: the three above are all satisfied by
    // discarding MALFORMED and writing at cap.scopePath instead. On the READ
    // side that is genuinely safe — falling back to your own token's scope can
    // never return more than your token already covers. On the WRITE side the
    // same fallback runs the other way: the caller asked for a NARROWER target
    // and the content lands at the wider one, visible to every reader the
    // broader scope covers. So a non-empty scopePath that fails validation must
    // fail closed, not be silently reinterpreted.
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("a malformed narrowing request from an org-root token is refused, not silently widened org-wide", async () => {
    // The confidentiality case behind the assertion above, spelled out, because
    // "not.toHaveBeenCalled()" alone does not show why it matters.
    //
    // An ORG-ROOT-scoped write token narrows a sensitive write to one deal and
    // typos it with a space (invalid ltree syntax on Postgres, 42601).
    // cap.scopePath IS the org root

    // here, so the fallback target is maximally wide: the content the caller
    // scoped to one deal becomes readable by every root-scoped reader in the
    // org, and the caller is told "Stored." with nothing indicating the
    // target moved.
    //
    // Note this is strictly worse than the bug it replaced. Before the guard,
    // this same call threw on the ltree cast and stored NOTHING (unaudited, and
    // that was the real defect) — it failed CLOSED. Fixing the audit gap must
    // not convert it into a write that fails OPEN at a broader scope.
    const MALFORMED = `${ORG}.deal A`;
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandler(ORG);

    await memoryIngest({
      content: "Deal A is being sold for $2M — deal-team only",
      name: "Deal A price",
      scopePath: MALFORMED,
    });

    // Nothing is stored at all, and in particular nothing is stored org-wide.
    expect(ingestMemory).not.toHaveBeenCalled();
    const ingestedScopes = vi.mocked(ingestMemory).mock.calls.map(([arg]) => (arg as { scopePath?: string }).scopePath);
    expect(ingestedScopes).not.toContain(ORG);
    // Still audited — the audit-integrity half of the original fix must hold.
    expect(auditRows().length).toBeGreaterThan(0);
  });

  it("a dashed label, valid ltree that reads like a dot, is refused with its reason and stored nowhere", async () => {
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandler(ORG);

    const result = await memoryIngest({ content: "note", name: "Deal A", scopePath: `${ORG}.deal-A` });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("holds a dash");
    expect(ingestMemory).not.toHaveBeenCalled();
    expect(auditRows().length).toBeGreaterThan(0);
  });

  it("an empty-string scopePath falls back to the token's own scope instead of surviving `??`", async () => {
    // `"" ?? cap.scopePath` is `""` — empty string is not nullish, so it
    // survives every `??` default in the chain and travels all the way to
    // check() as the target. normalizeScopePath exists for exactly this and its
    // own doc comment names a "`scopePath ?? orgRootPath(...)` write path" as a
    // place it must be called.
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: "" });

    expect(boundValues()).not.toContain("");
    expect(boundValues()).toContain(DEAL_A);
  });

  it("a whitespace-only scopePath does the same", async () => {
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: "   " });

    expect(boundValues()).not.toContain("   ");
    expect(boundValues()).toContain(DEAL_A);
  });

  it("a well-formed caller scopePath is still honored — the guard must not swallow valid narrowing", async () => {
    // Control, so the three above cannot be satisfied by ignoring scopePath
    // entirely: a valid ltree path the caller supplies must still be the target.
    const CHILD = `${DEAL_A}.thread1`;
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: CHILD });

    expect(boundValues()).toContain(CHILD);
  });

  it("a padded but otherwise valid scopePath is trimmed and honored, not treated as malformed", async () => {
    // Coverage gap in this file's first round, found by mutating the fix rather
    // than reading it: replacing normalizeScopePath(scopePath) with a bare
    // `scopePath` left all 9 original cases green, so nothing here actually
    // required the trim to exist. It matters more under the fail-closed remedy
    // the two cases above now demand than it did under the fallback one — with
    // the trim a padded valid path is honored as the narrowing the caller
    // asked for; without it the value fails validation and the write is
    // refused outright.
    const CHILD = `${DEAL_A}.thread1`;
    mockCapabilityLookup(DEAL_A, "write");
    const memoryIngest = ingestHandler(DEAL_A);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: `  ${CHILD}  ` });

    expect(boundValues()).toContain(CHILD);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The refused-write audit row itself.
//
// "An audit row was written" is a much weaker claim than "the right audit row
// was written". Because check()'s `::ltree` cast throws on the malformed value
// before recordAudit() can run, memory_ingest writes this one row through
// db.auditLog directly instead of through check(). A hand-rolled copy of
// recordAudit()'s row is exactly the thing that drifts silently, so these cases
// pin its shape against the real thing rather than against a description of it.
//
// Each case below catches one mutation nothing else in the suite notices:
// decision "deny"->"allow", action "memory.write"->"memory.read", target -> the
// wrong scope, actorId -> "", reason -> null, runId dropped, and — the one that
// is not merely an audit defect — deleting the `throw` so the handler returns
// "Stored." to a caller whose write was refused.
// ---------------------------------------------------------------------------

/** Same fixture as mockCapabilityLookup, but with a real `createdBy` on the
 * capability row, so recordAudit()'s `metadata.triggeredBy` branch is actually
 * reachable and the comparison below is against a populated row rather than a
 * vacuous one. */
function mockCapabilityLookupWithIssuer(
  capScopePath: string,
  permission: "read" | "write" | "admin",
  createdBy: string,
) {
  vi.mocked(db.$queryRaw).mockImplementation((async (_s: unknown, ...values: unknown[]) => {
    const targetPath = String(values[values.length - 1]);
    if (!isLtree(targetPath)) {
      throw new Error(`syntax error at position 0 near "" — invalid input syntax for type ltree`);
    }
    return covers(capScopePath, targetPath) ? [{ permission, createdBy, agentId: "agent_1" }] : [];
  }) as never);
}

/** ingestHandler, but with an AgentRun id on the context, so the runId column
 * is non-undefined and dropping it is observable. */
function ingestHandlerInRun(capScopePath: string, runId: string): Handler {
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
    runId,
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
  return tools.get("memory_ingest")!;
}

type AuditRow = Record<string, unknown>;

/** Every field of every audit row written during this call, untyped, so a
 * MISSING column is visible as an absent key rather than as `undefined`. */
function rawAuditRows(): AuditRow[] {
  return vi.mocked(db.auditLog.create).mock.calls.map(([arg]) => (arg as { data: AuditRow }).data);
}

describe("memory_ingest — the refused write is reported to the caller as a refusal", () => {
  it('a refused write does not return "Stored." — the caller is told no', async () => {
    // The gap with real consequences outside the audit trail. Deleting the
    // `throw` and returning the success payload leaves every other assertion in
    // this file satisfied — ingestMemory is still never called, the audit row is
    // still written — while the caller is told their write landed when nothing
    // was stored at all. Silent data loss reads exactly like success.
    const MALFORMED = `${ORG}.deal A`;
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandlerInRun(ORG, "run_1");

    const result = await memoryIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toMatch(/Stored/i);
    expect(ingestMemory).not.toHaveBeenCalled();
  });
});

describe("memory_ingest — the refused-write audit row matches what recordAudit() writes", () => {
  const MALFORMED = `${ORG}.deal A`;

  it("records a DENY on memory.write, against the scope the caller actually asked for", async () => {
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandler(ORG);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });

    const rows = rawAuditRows();
    expect(rows).toHaveLength(1);
    // Not "allow" — a deny recorded as an allow is worse than no row at all,
    // and nothing in the suite required this before.
    expect(rows[0].decision).toBe("deny");
    // The action the caller attempted, not a read.
    expect(rows[0].action).toBe("memory.write");
    // The scope that was REFUSED, not cap.scopePath — an audit row naming the
    // token's own scope would describe a request nobody made, and would hide
    // exactly the attempted narrowing the refusal exists to catch.
    expect(rows[0].target).toBe(MALFORMED);
  });

  it("carries the real actor identity and org", async () => {
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandler(ORG);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });

    const row = rawAuditRows()[0];
    expect(row.orgId).toBe(ORG);
    expect(row.actorType).toBe("agent");
    expect(row.actorId).toBe("agent_1");
  });

  it("gives a reason that names the rejected value", async () => {
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandler(ORG);

    await memoryIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });

    const row = rawAuditRows()[0];
    expect(typeof row.reason).toBe("string");
    expect(String(row.reason)).toContain(MALFORMED);
  });

  it("stamps the AgentRun id, same as every recordAudit row", async () => {
    // An audit row that cannot be tied to a specific run is a blind spot. A
    // hand-rolled audit write that silently drops runId reintroduces it for the
    // one row check() cannot write.
    mockCapabilityLookup(ORG, "write");
    const memoryIngest = ingestHandlerInRun(ORG, "run_42");

    await memoryIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });

    expect(rawAuditRows()[0].runId).toBe("run_42");
  });

  it("writes the same columns recordAudit() writes for a real scope deny, with the same metadata", async () => {
    // The actual equivalence check, and the reason this file compares two live
    // rows instead of asserting against a remembered field list: the malformed
    // row is compared to a row recordAudit() really produced, in the same run,
    // for the closest well-formed analogue — a valid scopePath the token does
    // not cover. Both are scope-shaped denies, so if the direct write has
    // drifted from recordAudit()'s shape, it shows up here as a column the two
    // rows disagree about.
    //
    // Note metadata specifically. recordAudit() writes
    // `decision.triggeredBy ? { triggeredBy } : {}`, and triggeredBy is the
    // capability row's createdBy — so it is populated on a PERMISSION deny
    // (the token was found, it just isn't enough) and empty on a SCOPE deny
    // (no capability row matched at all, so there is no issuer to name). The
    // malformed case is scope-shaped, so `{}` is the faithful value here, not
    // a dropped field. The issuer is set on the fixture below precisely so
    // this distinction is exercised rather than assumed.
    const ISSUER = "user_who_issued_the_token";

    // 1. A real recordAudit() row: valid path, outside the token's scope.
    mockCapabilityLookupWithIssuer(DEAL_A, "write", ISSUER);
    const scopedIngest = ingestHandlerInRun(DEAL_A, "run_7");
    await scopedIngest({ content: "note", name: "Deal B", scopePath: DEAL_B });
    const viaRecordAudit = rawAuditRows();
    expect(viaRecordAudit).toHaveLength(1);
    expect(viaRecordAudit[0].decision).toBe("deny");

    // 2. The direct write: malformed path, same token, same run.
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    mockCapabilityLookupWithIssuer(DEAL_A, "write", ISSUER);
    const malformedIngest = ingestHandlerInRun(DEAL_A, "run_7");
    await malformedIngest({ content: "note", name: "Deal A", scopePath: MALFORMED });
    const viaDirectWrite = rawAuditRows();
    expect(viaDirectWrite).toHaveLength(1);

    // Same columns, no more and no fewer.
    expect(Object.keys(viaDirectWrite[0]).sort()).toEqual(Object.keys(viaRecordAudit[0]).sort());

    // And the same values everywhere the two calls genuinely agree.
    for (const field of ["orgId", "actorType", "actorId", "action", "decision", "runId"]) {
      expect({ [field]: viaDirectWrite[0][field] }).toEqual({ [field]: viaRecordAudit[0][field] });
    }
    // Both scope-shaped denies, so neither names an issuer; both record where the
    // request came in.
    expect(viaDirectWrite[0].metadata).toEqual({ origin: "mcp" });
    expect(viaRecordAudit[0].metadata).toEqual({ origin: "mcp" });
  });
});
