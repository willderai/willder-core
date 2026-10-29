// get_my_brief's `briefId` branch: fetch-then-check must not open an
// authorization bypass.
//
// The branch re-checks against the FETCHED brief's own scopePath, so a
// dealA-scoped token cannot read dealB's content behind a clean-looking ALLOW
// row (brief-scope-leak.eval.test.ts pins that). To check against the brief's
// own scope, the branch has to fetch the row before the check() gate. Two
// consequences follow from that ordering, both reproduced here against the
// real MCP path rather than by reading the code:
//
//   1. AUTHORIZATION BYPASS. If an `if (!brief) return "not found"` early exit
//      sits between the DB read and the only check() call on this path, a
//      REVOKED or EXPIRED token that names an id which does not exist gets a
//      successful response and writes NO audit row at all. A revoked token
//      must not reach get_my_brief unaudited. Because an EXISTING id still
//      reaches check() and is denied+audited, the pair of responses is also an
//      unaudited brief-existence oracle for a dead token.
//
//   2. SCOPE-LESS QA BRIEFS BECOME UNREADABLE. A brief row may carry a
//      human-readable label `(target) <host>` in Brief.scopePath when a run
//      has no memory scope. check() casts its target to ::ltree, and that
//      label is not a valid ltree literal (spaces, parentheses). Feeding
//      brief.scopePath to check() therefore turns an ordinary read of an
//      advertised QA output into a database cast error — for a fully valid,
//      org-root-scoped capability. get_my_brief's own description advertises
//      QA agent output, so this is a live path, not a hypothetical one.
//
// The rule: gate ONLY the miss path (run check() against the caller's own
// scope before the "not found" return — never restore a gate-then-fetch order,
// which would reopen the cross-brief scope leak), and fall back to the org
// root when the fetched brief's own scopePath isn't a valid ltree value
// instead of letting the cast throw. The control cases either side show the
// hole is the early-return/ordering specifically, not revocation enforcement
// itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    capability: { findUnique: vi.fn() },
    // resolveCapability asks whether the token's agent is deactivated; no Agent row means it is not.
    agent: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    brief: { findFirst: vi.fn() },
    draft: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    campaign: { findMany: vi.fn() },
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
import { generateCapabilityToken, hashCapabilityToken, orgRootPath } from "@/services/access";
import { startMcpTestServer, type McpTestServer } from "@/mcp/http-test-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ORG_ID = "org_briefauthz_test";
const ROOT = orgRootPath(ORG_ID);
const DEAL_A = `${ROOT}.dealA`;

// A token that RESOLVES (identity lookup succeeds — resolveCapability has no
// lifecycle filter, by design) but is revoked, so check()'s enforcement query
// returns nothing. This is exactly the state the gate exists to reject.
const revokedToken = generateCapabilityToken();
const revokedHash = hashCapabilityToken(revokedToken);

// A completely healthy org-root capability — nothing wrong with it at all.
// Used only for the QA-brief case, to show that case is not about revocation.
const liveRootToken = generateCapabilityToken();
const liveRootHash = hashCapabilityToken(liveRootToken);

/** ltree ancestor-or-self, the same relation Postgres `@>` gives check(). */
const covers = (granted: string, target: string): boolean => target === granted || target.startsWith(`${granted}.`);

/**
 * Postgres ltree accepts a dot-separated path of [A-Za-z0-9_] labels. check()
 * casts its target with `${targetPath}::ltree`, so anything else raises at the
 * cast before any containment is evaluated. Modelling that here is what makes
 * the QA case below a real finding rather than a story about one: the harness
 * already implements `covers` for real for the same reason.
 */
const isValidLtree = (path: string): boolean =>
  path.length > 0 && path.split(".").every((label) => /^[A-Za-z0-9_]+$/.test(label));

/** The label both QA persistence paths write when a run has no memory scope. */
const QA_LABEL = "(target) api.acme.com";

const QA_BRIEF = {
  id: "brief_qa",
  orgId: ORG_ID,
  type: "qa_review",
  granteeName: null,
  granteeRole: null,
  scopePath: QA_LABEL,
  title: "QA review of api.acme.com",
  summary: "PASS — no blocking defects.",
  sections: [{ heading: "Findings", content: "Checkout flow is clean." }],
  diagram: null,
  diagramUrl: null,
  googleDocUrl: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

const DEAL_A_BRIEF = {
  ...QA_BRIEF,
  id: "brief_dealA",
  type: "handoff",
  scopePath: DEAL_A,
  title: "DealA handoff",
};

// The current write shape: scopePath is always a real, valid scope (org root
// for a scope-less run) and the host label lives in its own scopeLabel column
// instead of being crammed into scopePath. QA_BRIEF above still models a
// legacy/malformed row, which the guard tests below cover as defense in depth.
const QA_BRIEF_POST_FIX = {
  ...QA_BRIEF,
  id: "brief_qa_post_fix",
  scopePath: ROOT,
  scopeLabel: QA_LABEL,
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
  vi.mocked(db.brief.findFirst).mockClear();

  // Identity lookup only — no revokedAt/expiresAt filter, per check.ts's own
  // contract comment. BOTH tokens resolve here, including the revoked one.
  vi.mocked(db.capability.findUnique).mockImplementation(((args: unknown) => {
    const hash = (args as { where: { tokenHash: string } }).where.tokenHash;
    if (hash === revokedHash) {
      return Promise.resolve({ orgId: ORG_ID, agentId: "agent-revoked", scopePath: DEAL_A });
    }
    if (hash === liveRootHash) {
      return Promise.resolve({ orgId: ORG_ID, agentId: "agent-root", scopePath: ROOT });
    }
    return Promise.resolve(null);
  }) as never);

  // Enforcement query — the real predicate is
  //   tokenHash = $2 AND revokedAt IS NULL AND expiresAt > now()
  //     AND scopePath::ltree @> $3::ltree
  // The revoked token is filtered out by `revokedAt IS NULL` no matter the
  // scope; the root token passes lifecycle and is filtered only by containment.
  // The ltree cast is evaluated for either one, so an invalid target raises
  // before containment is reached — the same order Postgres does it in.
  vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
    const [, hash, targetPath] = values as [string, string, string];
    if (!isValidLtree(targetPath)) {
      return Promise.reject(new Error(`syntax error at position 0 near "${targetPath.slice(0, 1)}"`));
    }
    if (hash === revokedHash) return Promise.resolve([]); // revokedAt IS NOT NULL
    if (hash !== liveRootHash) return Promise.resolve([]);
    if (!covers(ROOT, targetPath)) return Promise.resolve([]);
    return Promise.resolve([{ permission: "read", createdBy: null, agentId: "agent-root" }]);
  }) as never);

  // `{ id, orgId }` lookup: the row exists in this org, or it doesn't.
  vi.mocked(db.brief.findFirst).mockImplementation(((args: unknown) => {
    const where = (args as { where: Record<string, unknown> }).where;
    if (where.id === QA_BRIEF.id) return Promise.resolve(QA_BRIEF);
    if (where.id === QA_BRIEF_POST_FIX.id) return Promise.resolve(QA_BRIEF_POST_FIX);
    if (where.id === DEAL_A_BRIEF.id) return Promise.resolve(DEAL_A_BRIEF);
    if (typeof where.id === "string") return Promise.resolve(null); // unknown id
    return Promise.resolve(DEAL_A_BRIEF);
  }) as never);
});

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; text: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "brief-authz-eval", version: "0.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError as boolean | undefined, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
  }
}

const auditRows = (): { action: string; decision: string; target: string }[] =>
  vi
    .mocked(db.auditLog.create)
    .mock.calls.map(([arg]: [unknown]) => (arg as { data: { action: string; decision: string; target: string } }).data);

describe("get_my_brief briefId branch — the revocation gate survives fetch-before-check", () => {
  // NOT a gap. Revocation itself still works on this path: a revoked token
  // naming a brief that EXISTS is denied and audited. This is what proves the
  // case below is about the early return specifically, not broken revocation.
  it("denies and audits a revoked token that names an existing brief", async () => {
    const res = await callTool(revokedToken, "get_my_brief", { briefId: DEAL_A_BRIEF.id });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    expect(res.text).not.toMatch(/DealA handoff/);

    const denies = auditRows().filter((r) => r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
  });

  // NOT a gap. The default (non-id) branch gates before touching the DB, so
  // the hole is not get_my_brief as a whole.
  it("denies and audits a revoked token on the default branch", async () => {
    const res = await callTool(revokedToken, "get_my_brief", {});

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    expect(auditRows().filter((r) => r.decision === "deny").length).toBeGreaterThan(0);
  });

  // An early return before the only check() on this path would answer a dead
  // token naming an id that does not exist successfully and leave no trail.
  // The miss path runs check() against the caller's own scope before
  // returning "not found".
  it("denies and audits a revoked token's probe of a nonexistent id", async () => {
    const res = await callTool(revokedToken, "get_my_brief", { briefId: "brief_does_not_exist" });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);

    // The append-only trail now shows this call happened.
    const denies = auditRows().filter((r) => r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
  });

  // If the hit and the miss differed observably, a revoked token could
  // enumerate which brief ids exist in the org, with only the hits audited.
  // Both answers are gated the same way, so a dead token cannot distinguish
  // "exists but denied" from "does not exist" — and both are on the record.
  it("gates the hit and the miss identically for a revoked token", async () => {
    const hit = await callTool(revokedToken, "get_my_brief", { briefId: DEAL_A_BRIEF.id });
    const hitRows = auditRows().length;

    vi.mocked(db.auditLog.create).mockClear();

    const miss = await callTool(revokedToken, "get_my_brief", { briefId: "brief_does_not_exist" });
    const missRows = auditRows().length;

    // The two responses are no longer distinguishable...
    expect(hit.isError).toBe(true);
    expect(miss.isError).toBe(true);
    // ...and both are on the record.
    expect(hitRows).toBeGreaterThan(0);
    expect(missRows).toBeGreaterThan(0);
  });

  // The miss is decided once, inside authorizeBrief, and that one decision is
  // what both gates the call and records it. A second check() on the miss path
  // would write a second row, so a miss would cost more than a hit and leave a
  // trail a hit does not: the row count itself would tell the two apart.
  it("records a live token's miss as exactly one decision on the probed id, like a hit", async () => {
    const hit = await callTool(liveRootToken, "get_my_brief", { briefId: DEAL_A_BRIEF.id });
    const hitRows = auditRows();

    vi.mocked(db.auditLog.create).mockClear();

    const miss = await callTool(liveRootToken, "get_my_brief", { briefId: "brief_does_not_exist" });
    const missRows = auditRows();

    expect(hit.isError).toBeFalsy();
    expect(miss.isError).toBeFalsy();
    expect(miss.text).toMatch(/brief_does_not_exist not found/);
    expect(missRows).toHaveLength(hitRows.length);
    expect(missRows).toHaveLength(1);
    expect(missRows[0]).toMatchObject({
      decision: "allow",
      target: expect.stringContaining("brief:brief_does_not_exist"),
    });
  });
});

describe("get_my_brief briefId branch — scope-less QA briefs", () => {
  // NOT a gap. A healthy root capability reads an ordinary ltree-scoped brief
  // by id perfectly well. This is the control that shows the case below is
  // about the stored scopePath value, not about the token or the new check().
  it("lets a live org-root capability read an ltree-scoped brief by id", async () => {
    const res = await callTool(liveRootToken, "get_my_brief", { briefId: DEAL_A_BRIEF.id });

    expect(res.isError).not.toBe(true);
    expect(res.text).toMatch(/DealA handoff/);
    expect(auditRows().some((r) => r.decision === "allow")).toBe(true);
  });

  // A legacy row carrying `(target) <host>` in Brief.scopePath, fed straight
  // to check(), crashes the ltree cast for a capability that covers the
  // entire org. The handler falls back to the org root when the stored
  // scopePath isn't a valid ltree value, so a root-scoped capability reads it
  // fine. (The real fix is never storing a display label in the
  // authorization-bearing column; this is the guard for rows that already do.)
  it("lets a live org-root capability read a scope-less QA brief by id", async () => {
    const res = await callTool(liveRootToken, "get_my_brief", { briefId: QA_BRIEF.id });

    expect(res.isError).not.toBe(true);
    expect(res.text).not.toMatch(/syntax error/i);
    expect(res.text).not.toMatch(/Access denied/i);

    // The QA brief the tool advertises is reachable by id again.
    expect(res.text).toMatch(/no blocking defects/i);
  });

  // The current write shape, not just the guard above: a scope-less QA brief
  // has scopePath = org root (a normal ltree scope, no guard fallback needed
  // at all) and the tested host preserved separately in scopeLabel.
  // formatBrief must still show that host in its "Scope:" line — the whole
  // point of scopeLabel is that the display doesn't regress once scopePath
  // stops doubling as the label.
  it("shows the scopeLabel host in the Scope: line for a post-fix scope-less QA brief", async () => {
    const res = await callTool(liveRootToken, "get_my_brief", { briefId: QA_BRIEF_POST_FIX.id });

    expect(res.isError).not.toBe(true);
    expect(res.text).toContain(`Scope: ${QA_LABEL}`);
    expect(res.text).not.toContain(`Scope: ${ROOT}`);
  });
});
