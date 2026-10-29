// The shared scope guard vs. the REAL Postgres ltree contract.
//
// Routing every caller-supplied scopePath through one resolveCallerScopePath()
// makes "a malformed scopePath reaches check()'s ::ltree cast raw" structurally
// impossible only if isValidLtreePath(), the single gate for all four call
// sites, matches what Postgres accepts. The contract, from the database itself:
//
//   SELECT 'org_x.deal-A'::ltree                      -> org_x.deal-A     (VALID)
//   SELECT 'org_x'::ltree @> 'org_x.deal-A'::ltree    -> true             (containment works)
//   SELECT ('org_x.' || repeat('a',1001))::ltree      -> ERROR 42622 "label string is too long"
//                                                        "Label length is 1001, must be at most 1000"
//   SELECT ('org_x.' || repeat('a',1000))::ltree      -> OK
//   SELECT 'org_x.deal A'::ltree                      -> ERROR 42601 "ltree syntax error"
//
// Two failure directions, both pinned:
//
// UNDER-STRICT (the gate lets a genuinely malformed value through). A label
// over 1000 bytes that passes isValidLtreePath() reaches the cast, which throws
// before recordAudit() runs — an unaudited failed access attempt with a raw
// Postgres error handed back to an external MCP caller, through all four call
// sites at once via the one shared gate.
//
// OVER-STRICT (the gate rejects a genuinely valid value). A hyphen IS a legal
// ltree label character. A gate that rejects it discards a scopePath the
// caller's token covers and runs the query against cap.scopePath instead, so
// the caller is silently handed a different brief (or told none exists). Not a
// leak — check() still authorizes only what the token covers — but a silently
// wrong answer reported as success.
//
// Postgres measures the 1000 in BYTES, not characters, so a multi-byte label
// can be under 1000 chars and over the limit: the gate uses
// Buffer.byteLength(label), never label.length.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    brief: { findFirst: vi.fn() },
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

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { registerWillderTools } from "./tools";
import { isValidLtreePath, type AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_ltree_contract_test";

/** Exactly at Postgres's documented per-label maximum; casts fine. */
const AT_LIMIT = `${ORG}.${"a".repeat(1000)}`;
/** One byte over it; Postgres throws 42622 "label string is too long". */
const OVER_LIMIT = `${ORG}.${"a".repeat(1001)}`;
/** A hyphenated label: VALID ltree, and containment against it works. */
const HYPHENATED = `${ORG}.deal-A`;

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

describe("isValidLtreePath must match the deployed Postgres ltree contract", () => {
  it("accepts a label exactly at the 1000-byte maximum — control, this one really is valid", () => {
    expect(isValidLtreePath(AT_LIMIT)).toBe(true);
  });

  it("rejects a label over the 1000-byte maximum — Postgres throws 42622 on it", () => {
    // An accepted over-limit label sails through the gate into check()'s
    // ::ltree cast and throws before recordAudit().
    expect(isValidLtreePath(OVER_LIMIT)).toBe(false);
  });

  it("accepts a hyphenated label — Postgres 18.6 casts it fine and containment works", () => {
    // A rejected hyphen discards a legitimately valid scope as malformed.
    expect(isValidLtreePath(HYPHENATED)).toBe(true);
  });

  it("still rejects the values Postgres genuinely refuses — a space, and an empty label", () => {
    // Control, so the fix for the two cases above cannot be "accept everything".
    expect(isValidLtreePath(`${ORG}.deal A`)).toBe(false);
    expect(isValidLtreePath(`${ORG}.deal.`)).toBe(false);
    expect(isValidLtreePath("")).toBe(false);
  });

  // The per-label regex/byte checks above say nothing about how MANY labels a
  // path has. Postgres's ltree extension is compiled with LTREE_MAX_LEVELS =
  // 65535, so a 65536-label path raises a real, distinct error (54000 "number
  // of ltree levels ... exceeds the maximum allowed") on the exact same
  // `::ltree` cast this whole guard exists to protect — same defect class, a
  // different malformed shape than the per-label cases above.
  it("accepts a path exactly at the 65535-label maximum — control, this one really is valid", () => {
    const atLabelLimit = Array.from({ length: 65535 }, (_, i) => `l${i}`).join(".");
    expect(isValidLtreePath(atLabelLimit)).toBe(true);
  });

  it("rejects a path over the 65535-label maximum — Postgres throws 54000 on it", () => {
    const overLabelLimit = Array.from({ length: 65536 }, (_, i) => `l${i}`).join(".");
    expect(isValidLtreePath(overLabelLimit)).toBe(false);
  });
});

describe("the over-limit label must not reach check() through any call site", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "agent_1" }] as never);
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
  });

  it("memory_query (read): falls back to the token's scope instead of binding the raw over-limit value", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    await memoryQuery({ query: "anything", scopePath: OVER_LIMIT });

    expect(boundValues()).not.toContain(OVER_LIMIT);
    expect(boundValues()).toContain(ORG);
  });

  it("get_my_brief (read): same — the over-limit value never reaches the cast", async () => {
    const getMyBrief = handlers().get("get_my_brief")!;
    await getMyBrief({ scopePath: OVER_LIMIT });

    expect(boundValues()).not.toContain(OVER_LIMIT);
    expect(boundValues()).toContain(ORG);
  });

  it("memory_ingest (write): refuses it outright rather than widening, per the read/write asymmetry", async () => {
    const memoryIngest = handlers().get("memory_ingest")!;
    const result = await memoryIngest({
      content: "secret deal note",
      name: "Deal A",
      scopePath: OVER_LIMIT,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not a valid scope path");
    expect(vi.mocked(ingestMemory)).not.toHaveBeenCalled();
    // And the raw over-limit value must never have reached check()'s cast.
    expect(boundValues()).not.toContain(OVER_LIMIT);
  });
});

describe("a hyphenated scope the token covers must be honored, not silently swapped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "agent_1" }] as never);
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
  });

  it("get_my_brief: the brief lookup uses the hyphenated scope the caller asked for", async () => {
    // The reachable production path: app/api/agents/[id]/handoff/route.ts
    // normalizes but does not reject a hyphenated scopePath, calls check() with
    // it (which succeeds — the cast is valid), provisions a capability for it,
    // and persists it straight into Brief.scopePath via db.brief.create. The
    // scopePath backfill is a one-time migration, not a CHECK constraint, so
    // nothing stops such a row existing. A gate that drops the hyphenated value
    // hands an org-root token asking for that deal's brief the ORG's brief.
    const getMyBrief = handlers(ORG).get("get_my_brief")!;
    await getMyBrief({ scopePath: HYPHENATED });

    const where = vi.mocked(db.brief.findFirst).mock.calls.at(-1)?.[0] as { where: { scopePath?: string } } | undefined;
    expect(where?.where.scopePath).toBe(HYPHENATED);
  });

  it("get_my_brief: check() is asked to authorize that same hyphenated scope", async () => {
    const getMyBrief = handlers(ORG).get("get_my_brief")!;
    await getMyBrief({ scopePath: HYPHENATED });

    // Containment (`org_x @> org_x.deal-A`) is what decides this, and it
    // returns true on the deployed Postgres — so gating on the real requested
    // scope is both correct and safe.
    expect(boundValues()).toContain(HYPHENATED);
  });
});
