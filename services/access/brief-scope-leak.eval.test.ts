// Brief scope leak — does `get_my_brief`'s `briefId` branch actually keep a
// scoped capability inside its own subtree?
//
// Why this file exists: an earlier fix gated five previously-ungated MCP tools
// through check(). That fix is real and it closed the revocation hole — a dead
// token is now refused on all five. But `check()` only ever authorizes the
// scope it is HANDED; it knows nothing about the row the handler goes on to
// fetch. `get_my_brief` hands it `scopePath ?? cap.scopePath` and then, in the
// `briefId` branch, selects on `{ id, orgId }` alone.
//
// `Brief.scopePath` is not incidental metadata. Its own schema comment says
// "The memory scope this brief was retrieved from — bounds what it could see",
// and the tool's own description says "Defaults to the most recent brief within
// your token's own scope". So a brief generated for `org.dealB` is, by the data
// model's own statement, dealB-bounded content — and a `org.dealA` capability
// reading it by id is a same-tenant cross-scope read.
//
// Seam under test: the REAL hosted endpoint (app/api/mcp/route.ts) over a real
// socket via mcp/http-test-server.ts, same harness as
// services/access/token-lifecycle.eval.test.ts. Only @/lib/db and the outbound
// hops are mocked; resolveCapability(), check(), recordAudit() and the real
// tool body all run. The $queryRaw mock below implements ltree ancestor-or-self
// containment for real rather than always returning a row, so the gate can
// genuinely deny — getting that backwards would make every case here vacuous.
//
// ─────────────────────────────────────────────────────────────────────────────
// The case that was tagged `GAP:` is fixed: the `briefId` branch now
// re-checks against the FETCHED brief's own scopePath — the scope its content
// actually belongs to — instead of only authorizing the caller's own scope and
// fetching by `{ id, orgId }` alone. A dealA capability reading dealB's brief
// by id is now denied and audited as a deny against dealB, not a misleading
// allow against dealA. The two cases either side were NOT gaps — they passed
// before this fix and still pass now, and they are what shows the hole was the
// `briefId` branch specifically, not the gate itself.
// ─────────────────────────────────────────────────────────────────────────────
//
// Scope-completeness counterpart (see services/access/SCOPE_COMPLETENESS.md):
// every case above asserts dealB's content is withheld from a dealA token.
// None of them assert that a caller's OWN in-scope brief is actually returned
// — that narrowing-direction failure mode has shipped four separate times,
// caught by a person each time rather than by a test. Fixed below with a
// dealA-scoped brief (exact-match) and a root-scoped token (ancestor grant,
// descendant content), same fixture shape as draft-scope-leak.eval.test.ts /
// campaign-scope-leak.eval.test.ts's own "control: still sees it" / "sees a
// dealA-scoped X too" pair.
//
// Tenant counterpart: every case above is one org, two scopes, which left
// `orgId` — a predicate separate from `scopePath`, and the only one the
// `briefId` lookup applies before it reads the row — with nothing asserting it.
// Covered below by a second tenant's brief, which must be indistinguishable
// from an id that does not exist.
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
import { matchWhere } from "@/lib/db-where.testsupport";
import { generateCapabilityToken, hashCapabilityToken, orgRootPath } from "@/services/access";
import { NOT_RETIRED } from "@/services/memory/brief-retirement";
import { startMcpTestServer, type McpTestServer } from "@/mcp/http-test-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ORG_ID = "org_briefscope_test";
const ROOT = orgRootPath(ORG_ID);
const DEAL_A = `${ROOT}.dealA`;
const DEAL_B = `${ROOT}.dealB`;

// A second tenant, for the tenant-boundary case below.
const OTHER_ORG_ID = "org_briefscope_other_tenant";
const OTHER_ORG_ROOT = orgRootPath(OTHER_ORG_ID);

// One live, unexpired, un-revoked capability, scoped to dealA only — the
// ordinary "contractor on one deal" case willder's whole access story is about.
const dealAToken = generateCapabilityToken();
const dealAHash = hashCapabilityToken(dealAToken);

// A root-scoped capability — the "internal team member, sees the whole org"
// case — added for the scope-completeness cases below (ancestor grant,
// descendant content). Mirrors draft-scope-leak.eval.test.ts /
// campaign-scope-leak.eval.test.ts's own rootToken.
const rootToken = generateCapabilityToken();
const rootHash = hashCapabilityToken(rootToken);

/** ltree ancestor-or-self, the same relation Postgres `@>` gives check(). */
const covers = (granted: string, target: string): boolean => target === granted || target.startsWith(`${granted}.`);

/** dealB's brief — content that, by Brief.scopePath's own definition, was
 *  retrieved from dealB's subtree and therefore belongs to it. */
const DEAL_B_BRIEF = {
  id: "brief_dealB",
  orgId: ORG_ID,
  type: "handoff",
  granteeName: "Contractor B",
  granteeRole: null,
  scopePath: DEAL_B,
  title: "DealB handoff",
  summary: "DealB is closing at $310k with a 3-year term.",
  sections: [{ heading: "Commercials", content: "Floor is $290k. Do not go below." }],
  diagram: null,
  diagramUrl: null,
  googleDocUrl: null,
  retirements: [],
  // The most recent brief in the org, deliberately: the default branch orders by
  // `createdAt desc` and filters on `scopePath`, so "newest in the org" and
  // "newest in dealA's scope" have to be different rows for the leak-direction
  // control below to be able to fail when that scope predicate goes missing.
  createdAt: new Date("2026-09-03T00:00:00Z"),
};

/** dealA's own brief — the scope-completeness fixture: content that DOES
 *  belong to the caller's own subtree, and must actually come back. */
const DEAL_A_BRIEF = {
  id: "brief_dealA",
  orgId: ORG_ID,
  type: "handoff",
  granteeName: "Contractor A",
  granteeRole: null,
  scopePath: DEAL_A,
  title: "DealA handoff",
  summary: "DealA is closing at $180k with a 2-year term.",
  sections: [{ heading: "Commercials", content: "Floor is $160k. Do not go below." }],
  diagram: null,
  diagramUrl: null,
  googleDocUrl: null,
  /** Set by the one case below that retires this brief, empty otherwise. */
  retirements: [] as { reason: string }[],
  createdAt: new Date("2026-09-02T00:00:00Z"),
};

/** Another tenant's brief. Nothing in this org may reach it, and — because an
 *  unauthorized caller must not be able to tell a hidden row from an absent one
 *  — it must be indistinguishable from an id that does not exist at all. */
const OTHER_ORG_BRIEF = {
  ...DEAL_A_BRIEF,
  id: "brief_other_org",
  orgId: OTHER_ORG_ID,
  scopePath: `${OTHER_ORG_ROOT}.dealA`,
  granteeName: "Contractor Elsewhere",
  title: "Other tenant handoff",
  summary: "OtherCo is closing at $420k with a 5-year term.",
  sections: [{ heading: "Commercials", content: "Floor is $400k. Do not go below." }],
  createdAt: new Date("2026-09-04T00:00:00Z"),
};

const ALL_BRIEFS = [DEAL_B_BRIEF, DEAL_A_BRIEF, OTHER_ORG_BRIEF];

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

  // Identity lookup — resolves the token to its org/agent/scope. No lifecycle
  // filter here by design (services/access/check.ts).
  vi.mocked(db.capability.findUnique).mockImplementation(((args: unknown) => {
    const hash = (args as { where: { tokenHash: string } }).where.tokenHash;
    if (hash === dealAHash) return Promise.resolve({ orgId: ORG_ID, agentId: "agent-dealA", scopePath: DEAL_A });
    if (hash === rootHash) return Promise.resolve({ orgId: ORG_ID, agentId: "agent-root", scopePath: ROOT });
    return Promise.resolve(null);
  }) as never);

  // Enforcement query — the real predicate is
  //   tokenHash = $2 AND revokedAt IS NULL AND expiresAt > now() AND scopePath @> $3
  // Both tokens are live, so only containment can filter either out. A root
  // grant covers dealA (and dealB); a dealA grant covers only itself and its
  // own descendants — implementing that for real is what keeps both the deny
  // cases and the scope-completeness cases below honest.
  vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
    const [, hash, targetPath] = values as [string, string, string];
    const granted = hash === dealAHash ? DEAL_A : hash === rootHash ? ROOT : null;
    if (!granted || !covers(granted, targetPath)) return Promise.resolve([]);
    const agentId = hash === dealAHash ? "agent-dealA" : "agent-root";
    return Promise.resolve([{ permission: "read", createdBy: null, agentId }]);
  }) as never);

  // Filters the way Prisma filters: on the keys the `where` clause carries, and
  // no others. A query that omits `orgId` therefore matches a row whatever org
  // it belongs to, and one that omits `scopePath` matches whatever scope it
  // belongs to — which is what lets the cases below fail for the reasons they
  // name. Refusing an absent key instead would make a handler that dropped one
  // miss every row, so the boundary tests would keep passing on a fail-closed
  // accident rather than on the boundary they claim.
  //
  // A key this fake does NOT model throws, rather than being ignored: a
  // predicate added to `get_my_brief` later would otherwise go unenforced here
  // and leave the suite green, which is the same silence one step along.
  //
  // The two branches of `get_my_brief` differ in the `where` they pass — the
  // `briefId` branch selects on `{ id, orgId }`, the default branch on
  // `{ orgId, scopePath }` — so that difference, the whole point of this file,
  // shows up here as a difference in what gets filtered, not as a branch in the
  // fake itself.
  vi.mocked(db.brief.findFirst).mockImplementation(((args: unknown) => {
    const { where, orderBy } = args as {
      where: Record<string, unknown>;
      orderBy?: { createdAt?: "asc" | "desc" };
    };
    // `NOT_RETIRED` is a relation filter `matchWhere` cannot compare, so it is
    // applied here, and only when the handler passes it: dropping it from the
    // handler broadens the result, as it would against Postgres.
    const { retirements, ...columns } = where;
    if (retirements !== undefined) expect(retirements).toEqual(NOT_RETIRED.retirements);
    const matches = matchWhere(ALL_BRIEFS, columns, ["id", "orgId", "scopePath"]).filter(
      (brief) => retirements === undefined || brief.retirements.length === 0,
    );
    // `findFirst` returns the first row in the requested order, so the default
    // branch's `orderBy: { createdAt: "desc" }` decides which of several
    // matching briefs a caller actually gets.
    if (orderBy?.createdAt) {
      const direction = orderBy.createdAt === "desc" ? -1 : 1;
      matches.sort((a, b) => direction * (a.createdAt.getTime() - b.createdAt.getTime()));
    }
    return Promise.resolve(matches[0] ?? null);
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
  const client = new Client({ name: "brief-scope-eval", version: "0.0.0" });
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
    .mock.calls.map(([arg]) => (arg as { data: { action: string; decision: string; target: string } }).data);

describe("get_my_brief — a dealA capability and a dealB brief", () => {
  // Control 1: the gate itself works. Ask for dealB's scope OUT LOUD and
  // check()'s ltree containment refuses, because dealA does not cover dealB.
  // This is what gating the tool through check() bought, and it is genuinely
  // enforced.
  it("denies an explicit request for a sibling scope, and audits the denial", async () => {
    const res = await callTool(dealAToken, "get_my_brief", { scopePath: DEAL_B });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Access denied/i);
    expect(db.brief.findFirst).not.toHaveBeenCalled();
    const denies = auditRows().filter((r) => r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0].target).toContain(DEAL_B);
  });

  // Control 2: the default (no-id) branch is correct — it passes scopePath into
  // the query, so dealB's brief is not reachable that way either. (dealA DOES
  // have its own brief in this fixture — the scope-completeness describe
  // block below asserts THAT comes back; this control is about dealB's
  // content specifically staying out, the leak-direction half.)
  it("the default branch never surfaces dealB's content for a dealA token, even though a real (different) brief exists at dealA's own scope", async () => {
    const res = await callTool(dealAToken, "get_my_brief", {});

    expect(res.isError).not.toBe(true);
    expect(res.text).not.toMatch(/\$310k/);
    expect(res.text).not.toMatch(/DealB handoff/);
  });

  // Was a GAP: the same capability, the same tool, one argument different.
  // `briefId` used to make check() authorize dealA (which passes, correctly)
  // and then fetch by id with `{ id, orgId }` — no scope predicate — so
  // dealB's commercials came back, audited as a clean "allow on dealA" even
  // though dealB content is what actually crossed the boundary. Fixed: the
  // branch now re-checks against the fetched brief's own scopePath (dealB),
  // which dealA does not cover, so the read is denied and audited as a deny
  // against dealB — the trail names the scope the content really came from.
  // The caller is told exactly what an id that names nothing gets, so the
  // answer does not say the brief exists.
  it("denies a sibling scope's brief by id, answers it like an absent id, and audits it as a denied dealB read", async () => {
    const res = await callTool(dealAToken, "get_my_brief", { briefId: "brief_dealB" });
    const absent = await callTool(dealAToken, "get_my_brief", { briefId: "brief_dealB_never_issued" });

    // dealB's confidential body never reaches a dealA token.
    expect(res).toEqual({ ...absent, text: absent.text.replace("brief_dealB_never_issued", "brief_dealB") });
    expect(res.text).toMatch(/not found/);
    expect(res.text).not.toMatch(/\$310k/);
    expect(res.text).not.toMatch(/Floor is \$290k/);

    // ...and the trail names the scope the content actually came from.
    const denies = auditRows().filter((r) => r.decision === "deny");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0].target).toContain(DEAL_B);
  });
});

// ---------------------------------------------------------------------------
// The tenant boundary. Every case above is one org, two scopes. `orgId` is a
// separate predicate from `scopePath`, and on the `briefId` branch it is the
// only one applied before the row is read — the scope re-check runs against the
// fetched row's own `scopePath`, which cannot help until that row is already in
// hand. So it needs a case that fails when it goes missing.
//
// The default (no-id) branch carries `orgId` too, but there it is belt to the
// scope predicate's braces rather than load-bearing on its own: that branch
// runs check() on the target scope BEFORE it queries, and a target outside this
// org is not covered by an in-org capability, so it is denied before any row is
// read — and `scopePath` is org-rooted besides, so its equality match could not
// land on another tenant's brief even then. Dropping `orgId` there turns
// nothing red, correctly. Recorded here so its absence below reads as
// deliberate rather than as a missed case.
// ---------------------------------------------------------------------------

describe("get_my_brief — the tenant boundary", () => {
  it("another tenant's brief id is indistinguishable from an id that does not exist", async () => {
    const res = await callTool(dealAToken, "get_my_brief", { briefId: OTHER_ORG_BRIEF.id });
    const absent = await callTool(dealAToken, "get_my_brief", { briefId: "brief_no_such_id" });

    // The other tenant's content never reaches this org...
    expect(res.isError).not.toBe(true);
    expect(res.text).not.toMatch(/\$420k/);
    expect(res.text).not.toMatch(/Other tenant handoff/);

    // ...and neither does the fact that the row exists. A caller outside the
    // tenant gets the same answer for a hidden row as for an absent one, so the
    // hit/miss pair is not an existence oracle across the boundary.
    const withoutId = (text: string, id: string) => text.replace(id, "<id>");
    expect(withoutId(res.text, OTHER_ORG_BRIEF.id)).toBe(withoutId(absent.text, "brief_no_such_id"));
  });
});

// ---------------------------------------------------------------------------
// Scope-completeness (services/access/SCOPE_COMPLETENESS.md): the leak tests
// above prove dealB's content never reaches a dealA token. None of them prove
// the mirror image — that content genuinely inside the caller's own scope
// actually comes back, not silently dropped or misdirected. That is the
// narrowing-direction failure mode, which has shipped four separate times and
// was caught by a person each time. Same fixture as above (DEAL_A_BRIEF,
// ALL_BRIEFS), plus a root-scoped token for the ancestor-grant relationship.
// ---------------------------------------------------------------------------

describe("get_my_brief — scope-completeness: in-scope content IS returned, not just out-of-scope withheld", () => {
  it("exact-match, default branch: a dealA token's own brief comes back, not just an empty result", async () => {
    const res = await callTool(dealAToken, "get_my_brief", {});

    expect(res.isError).not.toBe(true);
    expect(res.text).toMatch(/DealA handoff/);
    expect(res.text).toMatch(/Floor is \$160k/);
    const allows = auditRows().filter((r) => r.decision === "allow");
    expect(allows.length).toBeGreaterThan(0);
  });

  it("exact-match, briefId branch: a dealA token can also fetch its own brief by id", async () => {
    const res = await callTool(dealAToken, "get_my_brief", { briefId: "brief_dealA" });

    expect(res.isError).not.toBe(true);
    expect(res.text).toMatch(/DealA handoff/);
    expect(res.text).toMatch(/Floor is \$160k/);
  });

  // A retired brief (services/memory/brief-retirement.ts) could quote content
  // that has left its scope, so neither branch may return it, even to the
  // token whose own scope it sits at.
  it("a retired brief at the token's own scope comes back on neither branch", async () => {
    DEAL_A_BRIEF.retirements = [{ reason: "source_moved" }];
    try {
      const byId = await callTool(dealAToken, "get_my_brief", { briefId: "brief_dealA" });
      const latest = await callTool(dealAToken, "get_my_brief", {});

      expect(byId.text).not.toMatch(/Floor is \$160k/);
      expect(latest.text).not.toMatch(/Floor is \$160k/);
      expect(latest.text).toMatch(/No brief found for this scope/);
    } finally {
      DEAL_A_BRIEF.retirements = [];
    }
  });

  // Ancestor grant, descendant content — the briefId branch re-checks against
  // the FETCHED brief's own scopePath via check()'s real ltree ancestor-or-self
  // containment (`root @> dealA`), so a broader (root-scoped) grant must still
  // reach content nested below it — the same parent-lists-descendant
  // relationship draft_list and campaign_list already enforce.
  it("ancestor grant, descendant content, briefId branch: a root-scoped token can read dealA's brief by id too", async () => {
    const res = await callTool(rootToken, "get_my_brief", { briefId: "brief_dealA" });

    expect(res.isError).not.toBe(true);
    expect(res.text).toMatch(/DealA handoff/);
    expect(res.text).toMatch(/Floor is \$160k/);
  });

  // The one relationship that does NOT hold here, on purpose — recorded so a
  // reader doesn't mistake its absence above for a missed case. Unlike
  // draft_list/campaign_list, the default (no-id) branch queries
  // `{ orgId, scopePath: target }` by EXACT equality (mcp/tools.ts), not ltree
  // containment — "the most recent brief within your token's own scope", by
  // its own tool description, deliberately does not widen to a broader list.
  // A root token's default call resolves target = its own scopePath (ROOT),
  // which does not equal dealA's, so this stays a miss — correctly, not a
  // completeness gap.
  it("control: a root-scoped token's default (no-id) call does NOT surface dealA's brief — exact match only, by design", async () => {
    const res = await callTool(rootToken, "get_my_brief", {});

    expect(res.isError).not.toBe(true);
    expect(res.text).toMatch(/No brief found for this scope/);
    expect(res.text).not.toMatch(/DealA handoff/);
  });
});
