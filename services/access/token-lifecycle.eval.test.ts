// Capability-token lifecycle eval — what a REVOKED or EXPIRED token can still
// do against the hosted MCP endpoint, and what a malformed one does to the
// audit trail.
//
// Why this file exists: the rest of the suite proves the access gate is
// correct for a *valid* token — services/access/check.test.ts covers
// allow/deny, and services/memory/access-leakage-eval.test.ts covers scope
// isolation of the data that comes back. Neither asks what happens once a
// token's lifecycle ends. Revocation is the single control a customer relies
// on when a contractor engagement ends — if revoking a token does not actually
// revoke access, the access-control boundary has a hole in exactly the moment
// it is supposed to matter most.
//
// Seam under test: the REAL hosted endpoint (app/api/mcp/route.ts) driven over
// a real socket by a real MCP-SDK client, via the same harness
// app/api/mcp/route.test.ts already uses (mcp/http-test-server.ts). Only
// @/lib/db, the raw memory store, the Inngest hop, and the signals recorder are
// mocked; resolveCapability(), check(), recordAudit() and every tool body in
// mcp/tools.ts run for real.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE "FIXING" A FAILURE IN THIS FILE.
//
// Several cases below are CHARACTERIZATION tests: they assert the CURRENT
// behavior, and that current behavior is a BUG. They are written this way
// deliberately, following the precedent set by access-leakage-eval.test.ts's
// "MCP read-path gap" case — the bugs are pinned here rather than fixed in
// place. Every such case is tagged `GAP:` in its name and says what the
// correct behavior would be. If one starts FAILING because someone fixed the
// underlying bug, that is the fix landing, not a regression: flip the
// assertion to the documented correct behavior and delete the tag. Do not
// weaken a `GAP:` assertion to make something else pass.
// ─────────────────────────────────────────────────────────────────────────────
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    capability: { findUnique: vi.fn() },
    // resolveCapability asks whether the token's agent is deactivated; no Agent row means it is not.
    agent: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    brief: { findFirst: vi.fn() },
  },
}));

vi.mock("@/services/memory/store", () => ({
  memory: {
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn().mockResolvedValue(null),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  },
  graphitiStore: {},
}));

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import {
  check,
  generateCapabilityToken,
  hashCapabilityToken,
  orgRootPath,
  type AccessContext,
} from "@/services/access";
import { startMcpTestServer, type McpTestServer } from "@/mcp/http-test-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ORG_ID = "org_lifecycle_test";
const ROOT = orgRootPath(ORG_ID);

// Three tokens, all issued the way a real customer issues them via
// POST /api/access/capabilities. The DIFFERENCE between them lives only in what
// the two DB queries return — which is exactly how it works in production:
//
//   resolveCapability()  → SELECT ... FROM capabilities WHERE tokenHash = $1
//                          (services/access/check.ts — NO revokedAt/expiresAt
//                           filter, identity lookup only, by design)
//   check()'s evaluate() → SELECT ... WHERE tokenHash = $1 AND revokedAt IS NULL
//                          AND expiresAt > now() AND scopePath @> target
//
// So a revoked/expired row still RESOLVES (the row exists) but never AUTHORIZES.
// The mocks below reproduce that split faithfully; getting it backwards would
// make every case here vacuous.
const liveToken = generateCapabilityToken();
const revokedToken = generateCapabilityToken();
const expiredToken = generateCapabilityToken();

const liveHash = hashCapabilityToken(liveToken);
const revokedHash = hashCapabilityToken(revokedToken);
const expiredHash = hashCapabilityToken(expiredToken);

const AGENT_BY_HASH: Record<string, string> = {
  [liveHash]: "agent-live",
  [revokedHash]: "agent-revoked",
  [expiredHash]: "agent-expired",
};

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  vi.mocked(db.auditLog.create).mockClear();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
  vi.mocked(ingestMemory).mockClear();
  vi.mocked(db.brief.findFirst).mockClear();

  // Identity lookup: the row still EXISTS for all three tokens. Revocation sets
  // revokedAt on the row, it does not delete it — so findUnique still returns it.
  vi.mocked(db.capability.findUnique).mockImplementation(((args: unknown) => {
    const hash = (args as { where: { tokenHash: string } }).where.tokenHash;
    const agentId = AGENT_BY_HASH[hash];
    if (!agentId) return Promise.resolve(null);
    return Promise.resolve({ orgId: ORG_ID, agentId, scopePath: ROOT });
  }) as never);

  // Enforcement query: ONLY the live token's row survives the
  // `revokedAt IS NULL AND expiresAt > now()` predicate, so revoked/expired
  // return zero rows — the same thing real Postgres would return.
  vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
    const hash = values[1];
    if (hash === liveHash)
      return Promise.resolve([{ permission: "write", createdBy: null, agentId: AGENT_BY_HASH[liveHash] }]);
    return Promise.resolve([]);
  }) as never);
});

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "lifecycle-eval", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Call one MCP tool with `token` and hand back the result, always closing the client. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; text: string }> {
  const client = await connect(token);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError as boolean | undefined, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
  }
}

const auditRows = (): { action: string; decision: string; actorId: string }[] =>
  vi
    .mocked(db.auditLog.create)
    .mock.calls.map(([arg]) => (arg as { data: { action: string; decision: string; actorId: string } }).data);

// ---------------------------------------------------------------------------
// Baseline — the control. Without this, every "revoked token still worked"
// assertion below could just as well mean "the tool is broken for everyone".
// ---------------------------------------------------------------------------

describe("token lifecycle — control: a LIVE token behaves as documented", () => {
  it("a live token is allowed on memory_query and the call is audited", async () => {
    const res = await callTool(liveToken, "memory_query", { query: "what do we know about Acme?" });
    expect(res.isError).not.toBe(true);
    const allows = auditRows().filter((r) => r.action === "memory.read" && r.decision === "allow");
    expect(allows.length).toBeGreaterThan(0);
    expect(allows[0].actorId).toBe("agent-live");
  });
});

// ---------------------------------------------------------------------------
// The memory tools DO honour revocation — establishing that the gap below is
// specific to the ungated tools, not a broken mock.
// ---------------------------------------------------------------------------

describe("token lifecycle — memory tools correctly reject a dead token", () => {
  it("a REVOKED token is denied on memory_query, and the denial is audited", async () => {
    const res = await callTool(revokedToken, "memory_query", { query: "what do we know about Acme?" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    const denies = auditRows().filter((r) => r.action === "memory.read" && r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0].actorId).toBe("agent-revoked");
  });

  it("an EXPIRED token is denied on memory_ingest and never reaches the ingest pipeline", async () => {
    const res = await callTool(expiredToken, "memory_ingest", {
      content: "Acme is opening a new Austin office",
      name: "Acme Corp",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    expect(ingestMemory).not.toHaveBeenCalled();
    const denies = auditRows().filter((r) => r.action === "memory.write" && r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
  });

  it("a REVOKED token is denied on memory_entity", async () => {
    const res = await callTool(revokedToken, "memory_entity", { entityId: "ent_1" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
  });
});

// ---------------------------------------------------------------------------
// Revocation on get_my_brief.
//
// app/api/mcp/route.ts's own comment says real enforcement — including
// whether this token is even still valid — happens per tool call inside
// mcp/tools.ts via check(). That must hold for get_my_brief as much as for the
// three memory tools above: a tool that goes straight to db.* with only
// `orgId` as a filter makes revoking a capability token do nothing to it.
// get_my_brief runs through check() first (a read gate), so a revoked or
// expired token is refused and the refusal is audited.
// ---------------------------------------------------------------------------

describe("token lifecycle — revocation is enforced on get_my_brief", () => {
  it("a REVOKED token is denied on get_my_brief, and the denial is audited", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      id: "brief_1",
      title: "Acme handoff",
      summary: "Everything the contractor needs about the Acme deal.",
      sections: [{ heading: "Pricing", content: "Floor is $80k, walk-away is $70k" }],
      granteeName: "Contractor",
      scopePath: `${ROOT}.dealA`,
      googleDocUrl: null,
      createdAt: new Date(),
    } as never);

    const res = await callTool(revokedToken, "get_my_brief", {});

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    expect(db.brief.findFirst).not.toHaveBeenCalled();
    const denies = auditRows().filter((r) => r.action === "memory.read" && r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0].actorId).toBe("agent-revoked");
  });
});

// ---------------------------------------------------------------------------
// get_my_brief and the capability's own scope.
//
// prisma/schema.prisma calls Brief.scopePath "the memory scope this brief was
// retrieved from — bounds what it could see", i.e. a brief is a packaged
// summary of everything inside one scope. A Deal A token could reach Deal B's
// brief two different ways:
//
//   1. by asking out loud — `scopePath ?? cap.scopePath` letting a
//      caller-supplied scope override the token's own.  ← CLOSED.
//   2. by id — the briefId branch filtering on `{ id, orgId }`, no scope
//      predicate at all.                                 ← STILL OPEN here.
//
// The tool is gated through check(), which runs on the resolved target. Since
// check() does ltree ancestor-or-self containment, asking for a scope the
// capability doesn't cover is refused — that closes (1).
//
// The case below overrides this file's shared `$queryRaw` mock, which returns
// a permission row for any target regardless of containment and so cannot
// observe the deny that real Postgres gives. A case that can only ever pass is
// decorative; with real containment in the mock, the case asserts the deny
// and stays honest if anyone ever loosens the gate again.
//
// (2) is still tagged `GAP:` below. The gate makes it worse, not better:
// check() writes an `allow` row naming the authorized scope before the
// unscoped fetch runs, so the audit trail shows a clean Deal A read for content
// that came out of Deal B. Full pinning, with a containment-aware mock and both
// controls, lives in services/access/brief-scope-leak.eval.test.ts.
//
// CORRECT behavior for (2): constrain the brief lookup to scopes the token's
// own scopePath covers, or re-check the fetched row's scopePath and deny
// (audited) when it falls outside.
// ---------------------------------------------------------------------------

describe("token lifecycle — get_my_brief and the token's own scope", () => {
  it("an explicitly requested sibling scope is denied, since check() does ltree containment", async () => {
    vi.mocked(db.brief.findFirst).mockImplementation(((args: unknown) => {
      const where = (args as { where: { orgId: string; scopePath?: string } }).where;
      return Promise.resolve({
        id: "brief_dealB",
        title: "Deal B handoff",
        summary: `Brief for ${where.scopePath}: Deal B renewal is at risk, churn flagged.`,
        sections: [],
        granteeName: null,
        scopePath: where.scopePath ?? ROOT,
        googleDocUrl: null,
        createdAt: new Date(),
      });
    }) as never);

    // A LIVE token whose capability is scoped to Deal A — nothing about this
    // token is expired or revoked, so what's under test here is scope, not
    // lifecycle.
    vi.mocked(db.capability.findUnique).mockResolvedValue({
      orgId: ORG_ID,
      agentId: "agent-dealA",
      scopePath: `${ROOT}.dealA`,
    } as never);

    // Override the file-level enforcement mock with REAL ltree ancestor-or-self
    // containment. Without this the case cannot observe the deny at all — the
    // shared mock hands back a permission row for every target.
    vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
      const [, hash, targetPath] = values as [string, string, string];
      if (hash !== liveHash) return Promise.resolve([]);
      const granted = `${ROOT}.dealA`;
      const covered = targetPath === granted || targetPath.startsWith(`${granted}.`);
      return Promise.resolve(covered ? [{ permission: "write", createdBy: null, agentId: "agent-dealA" }] : []);
    }) as never);

    const res = await callTool(liveToken, "get_my_brief", { scopePath: `${ROOT}.dealB` });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    // The sibling scope's brief was never even queried.
    expect(db.brief.findFirst).not.toHaveBeenCalled();
    expect(res.text).not.toMatch(/Deal B renewal is at risk/);
    // And the attempt is on the record, which is the half of this that an
    // operator actually relies on.
    const denies = auditRows().filter((r) => r.action === "memory.read" && r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
  });

  it("GAP: the briefId branch filters on orgId alone, so any brief in the org is fetchable by id", async () => {
    // agentId matches the file-level enforcement mock's AGENT_BY_HASH[liveHash]
    // ("agent-live") rather than an arbitrary value — evaluate() compares the
    // two, and this case is about the missing scope predicate on
    // get_my_brief's briefId branch, not about capability-owner identity.
    vi.mocked(db.capability.findUnique).mockResolvedValue({
      orgId: ORG_ID,
      agentId: AGENT_BY_HASH[liveHash],
      scopePath: `${ROOT}.dealA`,
    } as never);
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      id: "brief_dealB",
      title: "Deal B handoff",
      summary: "Deal B: competitor is Acme, floor price $200k.",
      sections: [],
      granteeName: null,
      scopePath: `${ROOT}.dealB`,
      googleDocUrl: null,
      createdAt: new Date(),
    } as never);

    const res = await callTool(liveToken, "get_my_brief", { briefId: "brief_dealB" });

    expect(res.isError).not.toBe(true);
    expect(res.text).toMatch(/floor price \$200k/);
    // The lookup carried no scope predicate at all — only id + orgId.
    const where = vi.mocked(db.brief.findFirst).mock.calls.at(-1)?.[0] as
      | { where: Record<string, unknown> }
      | undefined;
    expect(where?.where).toEqual({ id: "brief_dealB", orgId: ORG_ID, retirements: { none: {} } });
    expect(where?.where).not.toHaveProperty("scopePath");
  });
});

// ---------------------------------------------------------------------------
// GAP — a malformed scope path leaves NO audit row.
//
// check() builds `${targetPath}::ltree` and lets Postgres do containment. An
// ltree label is [A-Za-z0-9_], so a scope carrying a hyphen, a space, or a
// quote makes Postgres raise on the cast — and that raise happens inside
// evaluate(), BEFORE recordAudit() runs. A caller probing scopes with malformed
// paths therefore generates zero audit rows: the one surface an operator has
// for spotting someone poking at the access boundary stays completely empty.
//
// This is tested at the check() seam directly (not through MCP) because it is
// check()'s own ordering that causes it, and it applies to every caller.
//
// CORRECT behavior: validate the scope shape before the query and record a
// deny row for a malformed target, or wrap evaluate() so any failure still
// audits.
// ---------------------------------------------------------------------------

describe("token lifecycle — GAP: a malformed scope path is never audited", () => {
  const ctx: AccessContext = {
    orgId: ORG_ID,
    actor: { type: "agent", id: "agent-probe", capabilityToken: liveToken },
    origin: "mcp",
  };

  it("GAP: when Postgres rejects the ltree cast, check() throws and writes no audit row", async () => {
    // Real Postgres raises 42601 on `'deal a'::ltree` (a space is not a valid
    // ltree label character; a hyphen casts fine and is not a real rejection
    // case). Reproduce that as a rejected query.
    const ltreeSyntaxError = Object.assign(new Error("ltree syntax error"), {
      code: "42601",
    });
    vi.mocked(db.$queryRaw).mockRejectedValueOnce(ltreeSyntaxError as never);

    await expect(check(ctx, { action: "memory.read", scope: `${ROOT}.deal a` })).rejects.toThrow(/ltree/);

    // The whole point: a rejected access attempt that the audit trail never saw.
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("control: the SAME call on a well-formed scope does write exactly one audit row", async () => {
    // Proves the assertion above is about the malformed path, not about check()
    // failing to audit in general — without this control the case is vacuous.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([
      { permission: "read", createdBy: null, agentId: "agent-probe" },
    ] as never);

    const decision = await check(ctx, { action: "memory.read", scope: `${ROOT}.deal_a` });

    expect(decision.allowed).toBe(true);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
