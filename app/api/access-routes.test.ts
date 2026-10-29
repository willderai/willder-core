import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for the access management routes:
//   GET/POST  /api/access/grants       — list / create grants
//   DELETE    /api/access/grants/:id   — revoke a grant
//   GET/POST  /api/access/scopes       — list / create scopes
//   GET/POST  /api/access/capabilities — list / issue capability tokens
//   GET       /api/audit               — audit log
//   GET       /api/audit/actors        — distinct actors for the identity picker
// All DB + check() calls are mocked; we test auth gating, validation, scope-admin
// authority wiring, and idempotent grant upsert behaviour.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

// The decision and token stubs, shared by the barrel below and by the modules
// services/access/issue-capability.ts imports directly, so POST
// /api/access/capabilities runs the real issue rules against these stubs.
const accessStubs = vi.hoisted(() => ({
  check: vi.fn(),
  can: vi.fn(),
  deriveGrantGovernance: vi.fn(),
  generateCapabilityToken: vi.fn(() => "wcap_generated"),
  hashCapabilityToken: vi.fn((t: string) => `hash_${t}`),
}));
vi.mock("@/services/access/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access/check")>()),
  check: accessStubs.check,
  can: accessStubs.can,
  deriveGrantGovernance: accessStubs.deriveGrantGovernance,
}));
vi.mock("@/services/access/capabilities", async (importOriginal) => ({
  // Real isIssuerBoundRefusal: the 403 for a token wider than its issuer depends
  // on recognising the database's refusal, which is that function's whole job.
  ...(await importOriginal<typeof import("@/services/access/capabilities")>()),
  generateCapabilityToken: accessStubs.generateCapabilityToken,
  hashCapabilityToken: accessStubs.hashCapabilityToken,
}));
vi.mock("@/services/access", async () => {
  // The containment helper and its flattener are the REAL ones on purpose: the
  // cascade's correctness is the SQL predicate it builds (descendant-or-self,
  // parameterised), so a stub here would assert nothing worth asserting.
  const real = await vi.importActual<typeof import("@/services/access/scope-containment")>(
    "@/services/access/scope-containment",
  );
  // Same reasoning for the survivorship predicate: its own SQL shape is what
  // the "does another grant still cover this token" tests below assert
  // against.
  const realCheck = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  class FakeAccessDeniedError extends Error {
    constructor(readonly decision: { allowed: boolean; reason: string }) {
      super(decision.reason);
    }
  }
  const realAuthorizeRecord = await vi.importActual<typeof import("@/services/access/authorize-record")>(
    "@/services/access/authorize-record",
  );
  const { check, can } = accessStubs;
  const realAgentIdentity = await vi.importActual<typeof import("@/services/access/agent-identity")>(
    "@/services/access/agent-identity",
  );
  const realIssueCapability = await vi.importActual<typeof import("@/services/access/issue-capability")>(
    "@/services/access/issue-capability",
  );
  return {
    canonicalAgentId: realAgentIdentity.canonicalAgentId,
    issueCapability: realIssueCapability.issueCapability,
    // The real lookup-and-decide helper, deciding with the check() and can() stubs.
    authorizeRecord: realAuthorizeRecord.recordAuthorizer({ check, can }),
    check,
    can,
    orgRootPath: (id: string) => `org_${id}`,
    // Real ancestor-or-self relation (services/access/check.ts) — the grant-revoke
    // -> handoff-capability cascade filters with this, not a stub.
    pathCovers: (coveringPath: string, targetPath: string) =>
      targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
    AccessDeniedError: FakeAccessDeniedError,
    generateCapabilityToken: accessStubs.generateCapabilityToken,
    hashCapabilityToken: accessStubs.hashCapabilityToken,
    scopeContainsSql: real.scopeContainsSql,
    flattenSql: real.flattenSql,
    anotherLiveAgentGrantCoversSql: realCheck.anotherLiveAgentGrantCoversSql,
    // POST /api/access/capabilities calls this at mint time. Defaulted
    // ungoverned below (the common case: a brand-new agentId has no grant
    // yet) so every test in this file that never touches governance passes
    // unmodified; the governance-specific tests set their own value.
    deriveGrantGovernance: accessStubs.deriveGrantGovernance,
  };
});
vi.mock("@/lib/db", () => ({
  db: {
    grant: { findMany: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    scope: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    capability: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // GET /api/audit issues raw SQL through services/access/audit-query.ts
    // instead of typed auditLog.findMany/count -- see this file's own "GET
    // /api/audit" block for the $queryRaw mock and why (Prisma's typed
    // `where` API cannot express the `LIKE ... ESCAPE` clause the visibility
    // rule needs).
    $queryRaw: vi.fn(),
    // No audit route calls these typed methods -- GET /api/audit and GET
    // /api/audit/actors both use raw SQL, see $queryRaw above. They are kept
    // as spies so "GET /api/audit/actors"'s expectAuditLogUntouched() below
    // can still assert against them exhaustively, which is what stops a
    // future query-shape change from silently taking the deny-path guard
    // with it.
    auditLog: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    agent: {
      findMany: vi.fn().mockResolvedValue([]),
      // canonicalAgentId (real, below): no Agent row, so every agentId in this
      // file is free text and stored as given.
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // GET /api/audit resolves each row's changeIds (the change a write authorization
    // produced) and names a connector sync's lane after its source. Neither is what these
    // cases are about, so both answer with nothing.
    changeEvent: { findMany: vi.fn().mockResolvedValue([]) },
    source: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check, deriveGrantGovernance } from "@/services/access";
import { db } from "@/lib/db";
import { HANDOFF_AGENT_ID } from "@/lib/handoff-agent";

import { GET as grantsGET, POST as grantsPOST } from "./access/grants/route";
import { DELETE as grantDELETE } from "./access/grants/[id]/route";
import { GET as scopesGET, POST as scopesPOST } from "./access/scopes/route";
import { GET as capsGET, POST as capsPOST } from "./access/capabilities/route";
import { DELETE as capDELETE } from "./access/capabilities/[id]/route";
import { GET as auditGET } from "./audit/route";
import { ALWAYS_VISIBLE_ACTIONS, TARGET_CONDITIONAL_ACTIONS } from "@/services/audit/audit-actions";
import { VISIBILITY_VALUE_COUNT, parseVisibilityValues, rowIsVisible, sqlLike } from "./audit/sql-like.testsupport";
import { GET as auditActorsGET } from "./audit/actors/route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const post = (body: unknown) =>
  new Request("http://t", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(accessStubs.can).mockResolvedValue({ allowed: true, reason: "ok" });
  // agent-scope-full-removal-provenance-gap-20260918: ungoverned by default —
  // matches every pre-existing capability-mint test's implicit assumption
  // (no grant on file for the test's agentId).
  vi.mocked(deriveGrantGovernance).mockResolvedValue({
    grantGoverned: false,
    derivedFromGrantId: null,
  });
  vi.mocked(db.capability.findMany).mockResolvedValue([] as never);
  // Default: run the transaction callback against the same flat mock (tx === db),
  // so existing assertions against db.grant.delete/db.capability.* still see the
  // calls made inside DELETE /api/access/grants/:id's db.$transaction. Individual
  // tests (e.g. the scope-creation transaction below) override this per-test.
  vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
});

// ---------------------------------------------------------------------------
// GET /api/access/grants
// ---------------------------------------------------------------------------

describe("GET /api/access/grants", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await grantsGET(new Request("http://localhost/api/access/grants"))).status).toBe(401);
  });

  it("403 when access.manage is denied", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no admin grant" });
    expect((await grantsGET(new Request("http://localhost/api/access/grants"))).status).toBe(403);
  });

  it("200 lists this org's grants", async () => {
    vi.mocked(db.grant.findMany).mockResolvedValue([{ id: "g1" }] as never);
    const res = await grantsGET(new Request("http://localhost/api/access/grants"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ grants: [{ id: "g1" }] });
    expect(db.grant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: "org_1" } }));
  });

  it("400 names the fix for a page request with an order it does not offer, and checks access first", async () => {
    const res = await grantsGET(new Request("http://localhost/api/access/grants?page=1&sort=agent"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sort must be one of created, scope, grantee, expires" });
    expect(check).toHaveBeenCalledWith(expect.anything(), { action: "access.manage", target: "grants:list" });
    expect(db.grant.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/access/grants
// ---------------------------------------------------------------------------

const stubScope = { id: "s1", path: "org_org_1", name: "org root" };

describe("POST /api/access/grants", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await grantsPOST(post({}))).status).toBe(401);
  });

  it("400 for invalid granteeType", async () => {
    const res = await grantsPOST(post({ granteeType: "bot", permission: "read", granteeId: "u1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("granteeType") });
  });

  it("400 for invalid permission", async () => {
    const res = await grantsPOST(post({ granteeType: "user", permission: "superadmin", granteeId: "u1" }));
    expect(res.status).toBe(400);
  });

  it("400 when granteeId is missing for a non-everyone granteeType", async () => {
    const res = await grantsPOST(post({ granteeType: "user", permission: "read" }));
    expect(res.status).toBe(400);
    expect(db.grant.upsert).not.toHaveBeenCalled();
  });

  it("granteeId is not required for granteeType='everyone'", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.grant.upsert).mockResolvedValue({ id: "g1" } as never);
    const res = await grantsPOST(post({ granteeType: "everyone", permission: "read" }));
    expect(res.status).toBe(201);
    expect(db.grant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ granteeId: "*" }) }),
    );
  });

  it("404 when the scope doesn't exist in this org (resolved by scopeId)", async () => {
    vi.mocked(db.scope.findFirst).mockResolvedValue(null);
    const res = await grantsPOST(
      post({ granteeType: "user", permission: "read", granteeId: "u1", scopeId: "bad_scope" }),
    );
    expect(res.status).toBe(404);
  });

  it("403 when access.manage is denied on the target scope", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not a scope admin" });
    const res = await grantsPOST(post({ granteeType: "user", permission: "read", granteeId: "u1" }));
    expect(res.status).toBe(403);
    expect(db.grant.upsert).not.toHaveBeenCalled();
  });

  it("201 creates a grant and is idempotent (upsert refreshes expiry)", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.grant.upsert).mockResolvedValue({
      id: "g1",
      granteeType: "user",
      granteeId: "u1",
      permission: "read",
      expiresAt: null,
      createdAt: new Date().toISOString(),
      scope: stubScope,
    } as never);

    const res = await grantsPOST(post({ granteeType: "user", permission: "read", granteeId: "u1" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ grant: { id: "g1" } });
  });

  it("applies ttlHours as expiresAt when provided", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.grant.upsert).mockResolvedValue({ id: "g2" } as never);
    await grantsPOST(post({ granteeType: "user", permission: "read", granteeId: "u1", ttlHours: 24 }));
    const createArg = vi.mocked(db.grant.upsert).mock.calls[0][0].create;
    expect(createArg.expiresAt).toBeInstanceOf(Date);
  });

  it("no expiresAt when ttlHours is omitted", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.grant.upsert).mockResolvedValue({ id: "g3" } as never);
    await grantsPOST(post({ granteeType: "user", permission: "read", granteeId: "u1" }));
    const createArg = vi.mocked(db.grant.upsert).mock.calls[0][0].create;
    expect(createArg.expiresAt).toBeNull();
  });

  // agent-scope-full-removal-provenance-gap-20260918: an agent's FIRST grant
  // must retroactively ratchet grantGoverned=true onto any capability already
  // minted for that agentId before this grant existed — deriveGrantGovernance
  // only stamps governance at MINT time, so without this a capability minted
  // while ungoverned would never become governed even once a real grant shows
  // up for it later.
  it("ratchets every existing ungoverned capability for the same (org, agentId) when the grant is for an agent", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.grant.upsert).mockResolvedValue({ id: "g_agent" } as never);

    await grantsPOST(post({ granteeType: "agent", permission: "read", granteeId: "agent_1" }));

    expect(db.capability.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", agentId: "agent_1", grantGoverned: false },
      data: { grantGoverned: true, derivedFromGrantId: "g_agent" },
    });
  });

  it("never ratchets capabilities for a user/role/everyone grant — grantGoverned is agent-only", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.grant.upsert).mockResolvedValue({ id: "g_user" } as never);

    await grantsPOST(post({ granteeType: "user", permission: "read", granteeId: "u1" }));

    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });

  it("never ratchets when access.manage on the target scope is denied", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not a scope admin" });

    await grantsPOST(post({ granteeType: "agent", permission: "read", granteeId: "agent_1" }));

    expect(db.grant.upsert).not.toHaveBeenCalled();
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/access/grants/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/access/grants/:id", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await grantDELETE(new Request("http://t"), params({ id: "g1" }))).status).toBe(401);
  });

  it("404 when the grant is not in this org", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(null);
    expect((await grantDELETE(new Request("http://t"), params({ id: "g_other" }))).status).toBe(404);
  });

  it("403 when access.manage is denied on the grant's scope", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue({
      id: "g1",
      scope: { path: "org_org_1" },
    } as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not admin" });
    expect((await grantDELETE(new Request("http://t"), params({ id: "g1" }))).status).toBe(403);
    expect(db.grant.delete).not.toHaveBeenCalled();
  });

  it("200 deletes the grant and returns its id", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue({
      id: "g1",
      granteeType: "user",
      granteeId: "user_9",
      scope: { path: "org_org_1" },
    } as never);
    vi.mocked(db.grant.delete).mockResolvedValue({} as never);
    // The delete runs inside a transaction so the capability cascade can
    // never land without it.
    vi.mocked(db.$transaction).mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        grant: db.grant,
        capability: db.capability,
        $executeRaw: db.$executeRaw,
      }),
    );
    const res = await grantDELETE(new Request("http://t"), params({ id: "g1" }));
    expect(res.status).toBe(200);
    // revokedCapabilities is 0 for a human grantee: no tokens hang off it.
    expect(await res.json()).toEqual({ revoked: "g1", revokedCapabilities: 0 });
    expect(db.grant.delete).toHaveBeenCalledWith({ where: { id: "g1" } });
  });

  // A handoff capability minted off this grant's own scope
  // (lib/handoff-agent.ts's provisionHandoffAgentCapability, no stored link
  // back to the grant) must not keep passing check() for its full TTL after
  // the grant is gone. app/api/handoff-e2e-lifecycle.live.test.ts holds the
  // real-DB proof.
  it("revokes a live handoff capability minted at the grant's own scope", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue({
      id: "g1",
      scope: { path: "org_org_1.engineering" },
    } as never);
    vi.mocked(db.grant.delete).mockResolvedValue({} as never);
    vi.mocked(db.capability.findMany).mockResolvedValue([
      { id: "cap_at_scope", scopePath: "org_org_1.engineering" },
      { id: "cap_descendant", scopePath: "org_org_1.engineering.backend" },
    ] as never);

    const res = await grantDELETE(new Request("http://t"), params({ id: "g1" }));
    expect(res.status).toBe(200);
    expect(db.capability.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        agentId: HANDOFF_AGENT_ID,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true, scopePath: true },
    });
    expect(db.capability.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cap_at_scope", "cap_descendant"] } },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("leaves a live handoff capability alone when it sits outside the revoked grant's scope (a sibling, not a descendant)", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue({
      id: "g1",
      scope: { path: "org_org_1.engineering" },
    } as never);
    vi.mocked(db.grant.delete).mockResolvedValue({} as never);
    vi.mocked(db.capability.findMany).mockResolvedValue([{ id: "cap_sibling", scopePath: "org_org_1.sales" }] as never);

    const res = await grantDELETE(new Request("http://t"), params({ id: "g1" }));
    expect(res.status).toBe(200);
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/access/scopes
// ---------------------------------------------------------------------------

describe("GET /api/access/scopes", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await scopesGET()).status).toBe(401);
  });

  it("403 when access.manage is denied", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no admin" });
    expect((await scopesGET()).status).toBe(403);
  });

  it("200 lists this org's scopes", async () => {
    vi.mocked(db.scope.findMany).mockResolvedValue([{ id: "s1", path: "org_org_1", name: "root" }] as never);
    const res = await scopesGET();
    expect(res.status).toBe(200);
    expect(db.scope.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: "org_1" } }));
  });
});

// ---------------------------------------------------------------------------
// POST /api/access/scopes
// ---------------------------------------------------------------------------

describe("POST /api/access/scopes", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await scopesPOST(post({}))).status).toBe(401);
  });

  it("400 when name is missing", async () => {
    const res = await scopesPOST(post({}));
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("404 when the parent scope doesn't exist in this org", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(null);
    const res = await scopesPOST(post({ name: "Deals", parentPath: "nonexistent_path" }));
    expect(res.status).toBe(404);
  });

  it("403 when access.manage is denied on the parent scope", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no manage" });
    expect((await scopesPOST(post({ name: "Sub" }))).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("201 creates the scope and an owner grant in a transaction", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    const newScope = { id: "s2", path: "org_org_1.deals_abc123", name: "Deals", createdAt: new Date() };
    vi.mocked(db.$transaction).mockImplementation(async (fn) =>
      fn({ scope: { create: vi.fn().mockResolvedValue(newScope) }, grant: { create: vi.fn() } } as never),
    );
    const res = await scopesPOST(post({ name: "Deals" }));
    expect(res.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/access/capabilities
// ---------------------------------------------------------------------------

describe("GET /api/access/capabilities", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await capsGET(new Request("http://localhost/api/access/capabilities"))).status).toBe(401);
  });

  it("403 when access.manage is denied", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "denied" });
    expect((await capsGET(new Request("http://localhost/api/access/capabilities"))).status).toBe(403);
  });

  it("200 lists capabilities (never the raw token)", async () => {
    vi.mocked(db.capability.findMany).mockResolvedValue([
      {
        id: "cap_1",
        agentId: "ag_1",
        scopePath: "org_org_1",
        permission: "read",
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      },
    ] as never);
    const res = await capsGET(new Request("http://localhost/api/access/capabilities"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities).toHaveLength(1);
    expect(data.capabilities[0]).not.toHaveProperty("tokenHash");
    expect(data.capabilities[0]).not.toHaveProperty("token");
  });

  it("400 names the fix for a page request with a status it does not offer", async () => {
    const res = await capsGET(new Request("http://localhost/api/access/capabilities?page=1&status=paused"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "status must be one of active, expired, revoked, deactivated" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/access/capabilities
// ---------------------------------------------------------------------------

describe("POST /api/access/capabilities", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await capsPOST(post({}))).status).toBe(401);
  });

  it("400 when agentId is missing", async () => {
    expect((await capsPOST(post({ permission: "read" }))).status).toBe(400);
    expect(db.capability.create).not.toHaveBeenCalled();
  });

  it("400 for an invalid permission", async () => {
    expect((await capsPOST(post({ agentId: "ag_1", permission: "superuser" }))).status).toBe(400);
  });

  it("404 when the scope path doesn't exist in this org", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(null);
    const res = await capsPOST(post({ agentId: "ag_1", scopePath: "nonexistent" }));
    expect(res.status).toBe(404);
  });

  it("403 when access.manage is denied on the target scope", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "denied" });
    expect((await capsPOST(post({ agentId: "ag_1" }))).status).toBe(403);
    expect(db.capability.create).not.toHaveBeenCalled();
  });

  it("403, not 500, when the database refuses a token wider than its issuer", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    // The shape the pg driver adapter raises for the capabilities_issuer_bound trigger.
    const refusal = Object.assign(new Error("capability wider than its issuer"), {
      name: "DriverAdapterError",
      cause: { kind: "postgres", originalCode: "42501", code: "42501", message: "capability wider than its issuer" },
    });
    vi.mocked(db.capability.create).mockRejectedValue(refusal);
    const res = await capsPOST(post({ agentId: "ag_1", permission: "write" }));
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("token");
  });

  it("an unrelated database failure while minting still surfaces as an error", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.capability.create).mockRejectedValue(new Error("connection reset"));
    await expect(capsPOST(post({ agentId: "ag_1" }))).rejects.toThrow("connection reset");
  });

  it("201 mints a token and returns it exactly once", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.capability.create).mockResolvedValue({
      id: "cap_1",
      agentId: "ag_1",
      scopePath: "org_org_1",
      permission: "read",
      expiresAt: new Date(),
    } as never);
    const res = await capsPOST(post({ agentId: "ag_1" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty("token");
    expect(data.token).toBe("wcap_generated");
  });

  it("token hash (not the raw token) is stored in the DB", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.capability.create).mockResolvedValue({ id: "cap_1" } as never);
    await capsPOST(post({ agentId: "ag_1" }));
    expect(db.capability.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenHash: "hash_wcap_generated" }),
      }),
    );
  });

  it("default TTL is 7 days; custom ttlHours is applied", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.capability.create).mockResolvedValue({ id: "cap_2" } as never);
    await capsPOST(post({ agentId: "ag_1", ttlHours: 48 }));
    const expiresAt = new Date(vi.mocked(db.capability.create).mock.calls[0]![0].data.expiresAt);
    const diffHours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(diffHours).toBeGreaterThan(47);
    expect(diffHours).toBeLessThan(49);
  });

  it("ttlHours is capped at 90 days (2160 hours)", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.capability.create).mockResolvedValue({ id: "cap_3" } as never);
    await capsPOST(post({ agentId: "ag_1", ttlHours: 99999 }));
    const expiresAt = new Date(vi.mocked(db.capability.create).mock.calls[0]![0].data.expiresAt);
    const diffHours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(diffHours).toBeLessThanOrEqual(2161); // 90 days + 1h tolerance
  });

  // agent-scope-full-removal-provenance-gap-20260918: a new capability's
  // grantGoverned/derivedFromGrantId must be stamped from deriveGrantGovernance()
  // right here at mint, not left to whatever default Prisma applies — an
  // already-governed agentId minting a SECOND token must not get a token that
  // silently reads as ungoverned.
  it("stamps grantGoverned=true + the grant id when the agentId already has a current grant", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(deriveGrantGovernance).mockResolvedValue({
      grantGoverned: true,
      derivedFromGrantId: "grant_9",
    });
    vi.mocked(db.capability.create).mockResolvedValue({ id: "cap_4" } as never);

    await capsPOST(post({ agentId: "ag_governed" }));

    expect(deriveGrantGovernance).toHaveBeenCalledWith("org_1", "ag_governed");
    expect(db.capability.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ grantGoverned: true, derivedFromGrantId: "grant_9" }),
      }),
    );
  });

  it("stamps grantGoverned=false + a null grant id when the agentId has no current grant", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(db.capability.create).mockResolvedValue({ id: "cap_5" } as never);

    await capsPOST(post({ agentId: "mcp-client" }));

    expect(db.capability.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ grantGoverned: false, derivedFromGrantId: null }),
      }),
    );
  });

  it("never derives governance (or mints) when access.manage on the target scope is denied", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue(stubScope as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "denied" });

    await capsPOST(post({ agentId: "ag_1" }));

    expect(deriveGrantGovernance).not.toHaveBeenCalled();
    expect(db.capability.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/audit
// ---------------------------------------------------------------------------

// GET /api/audit issues raw SQL through services/access/audit-query.ts (item
// audit-route-scope-prefix-leak: Prisma's typed `where` API cannot express
// the `LIKE ... ESCAPE` clause its scope filter needs — see that module and
// app/api/audit/scope-containment.test.ts for the containment predicate
// itself). These helpers decode a flattenSql()-shaped db.$queryRaw call back
// into the conditions it expresses, positionally, matching audit-query.ts's
// fixed condition order (orgId, the target-aware visibility rule, [scope],
// [actorId+actorType], [decision]) -- distinguishing substrings are chosen so they
// can only appear in the WHERE clause they name. The decision filter is bound only
// on the entries query (`"decision" = ?`); the count query's own `'allow'`/`'deny'`
// FILTER literals bind nothing.
type AuditFixtureRow = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string;
  decision: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  at: Date;
};

function parseAuditCall(call: unknown[]) {
  const [strings, ...values] = call as [string[], ...unknown[]];
  const sql = strings.join("?");
  let i = 0;
  i++; // orgId, unused by any assertion below (every fixture row is already org_1)
  const visibility = parseVisibilityValues(values, i);
  i += VISIBILITY_VALUE_COUNT;
  // The visibility fragment emits LIKE legs of its own, so the scope filter is
  // detected by its own `"target" = ` equality leg, which nothing else emits.
  const scope = sql.includes('"target" = ')
    ? {
        exact: values[i++] as string,
        dotPattern: values[i++] as string,
        slashPattern: values[i++] as string,
      }
    : undefined;
  const actorFilter = sql.includes('"actorId" = ')
    ? { actorId: values[i++] as string, actorType: values[i++] as string }
    : undefined;
  const decision = sql.includes('"decision" = ?') ? (values[i++] as string) : undefined;
  return { visibility, decision, scope, actorFilter, isCount: sql.includes("COUNT(") };
}

function mockAuditRows(rows: AuditFixtureRow[]) {
  vi.mocked(db.$queryRaw).mockImplementation((async (...call: unknown[]) => {
    const q = parseAuditCall(call);
    const matched = rows.filter((r) => {
      if (!rowIsVisible(r, q.visibility)) return false;
      if (q.decision !== undefined && r.decision !== q.decision) return false;
      if (q.scope) {
        const inScope =
          r.target === q.scope.exact ||
          sqlLike(r.target, q.scope.dotPattern) ||
          sqlLike(r.target, q.scope.slashPattern);
        if (!inScope) return false;
      }
      if (q.actorFilter && (r.actorId !== q.actorFilter.actorId || r.actorType !== q.actorFilter.actorType)) {
        return false;
      }
      return true;
    });
    if (!q.isCount) return matched;
    const count = (decision: string) => matched.filter((r) => r.decision === decision).length;
    return [{ allowed: count("allow"), denied: count("deny") }];
  }) as never);
}

/** The entries query is always the 2nd of the 2 $queryRaw calls Promise.all
 * issues (array literals evaluate left-to-right before either promise is
 * awaited) -- reliable regardless of which optional filters are present. */
function entriesCallConditions() {
  const calls = vi.mocked(db.$queryRaw).mock.calls;
  return parseAuditCall(calls[1]!);
}

describe("GET /api/audit", () => {
  beforeEach(() => {
    vi.mocked(check).mockResolvedValue({ allowed: true } as never);
    mockAuditRows([]);
  });

  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await auditGET(new Request("http://t"))).status).toBe(401);
  });

  it("403 when access.manage is denied", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false } as never);
    expect((await auditGET(new Request("http://t"))).status).toBe(403);
  });

  it("200 returns entries and pagination meta", async () => {
    mockAuditRows([
      {
        id: "al1",
        actorType: "human",
        actorId: "u1",
        action: "memory.read",
        target: "org_1",
        decision: "allow",
        reason: null,
        metadata: null,
        at: new Date(),
      },
    ]);
    const res = await auditGET(new Request("http://t/api/audit"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; total: number };
    expect(body.entries).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("uses page-based pagination: LIMIT 50 OFFSET 0 on page 1, ordered newest-first", async () => {
    await auditGET(new Request("http://t/api/audit"));
    const [strings, ...values] = vi.mocked(db.$queryRaw).mock.calls[1]! as unknown as [string[], ...unknown[]];
    expect(strings.join("?")).toContain('ORDER BY "at" DESC');
    expect(values.slice(-2)).toEqual([50, 0]);
  });

  // check() writes an audit row for every access.manage decision (grant
  // create/revoke, dispute resolve: real admin mutations an org wants
  // visible; and grants:list/fact_disputes probe reads, which are internal
  // noise). A plain VISIBLE_ACTIONS allowlist would hard-exclude the whole
  // action, so who granted/revoked access would be recorded but never shown.
  // Guard-removal: this fails if the where clause reverts to a bare
  // `action: { in: [...] }` allowlist instead of spreading the canonical,
  // target-aware VISIBLE_AUDIT_ROW_WHERE.
  it("queries with the canonical target-aware visibility rule, not a bare action allowlist", async () => {
    await auditGET(new Request("http://t/api/audit"));
    const [strings, ...values] = vi.mocked(db.$queryRaw).mock.calls[1]! as unknown as [string[], ...unknown[]];
    const sql = strings.join("?");
    // The always-visible actions alone would be the bare allowlist this rule
    // replaced; what makes it target-aware is the access.manage arm.
    expect(sql).toContain('"action" = ');
    expect(values).toContain("access.manage");
    expect(values).toEqual(expect.arrayContaining(["%grants:create:%", "%grants:revoke:%", "%fact\\_dispute:%"]));
  });

  it("allow-case: a real access.manage mutation (grants:create) round-trips into the shaped entries", async () => {
    mockAuditRows([
      {
        id: "al_grant_create",
        actorType: "human",
        actorId: "user_synthetic_admin",
        action: "access.manage",
        target: "org_1/grants:create:org_1.dept",
        decision: "allow",
        reason: "human grant covers admin on org_1.dept",
        metadata: null,
        at: new Date(),
      },
    ]);
    const res = await auditGET(new Request("http://t/api/audit"));
    const body = (await res.json()) as { entries: { id: string; action: string; target: string }[] };
    expect(body.entries.map((e) => e.id)).toEqual(["al_grant_create"]);
    expect(body.entries[0]!.action).toBe("access.manage");
    expect(body.entries[0]!.target).toBe("org_1/grants:create:org_1.dept");
  });

  it("filters by ?decision=allow", async () => {
    await auditGET(new Request("http://t/api/audit?decision=allow"));
    expect(entriesCallConditions().decision).toBe("allow");
  });

  it("filters by ?decision=deny", async () => {
    await auditGET(new Request("http://t/api/audit?decision=deny"));
    expect(entriesCallConditions().decision).toBe("deny");
  });

  it("ignores unknown ?decision values (no filter)", async () => {
    await auditGET(new Request("http://t/api/audit?decision=bogus"));
    expect(entriesCallConditions().decision).toBeUndefined();
  });

  // ?scope= sets its own top-level `target: { startsWith }` clause, which sits
  // alongside (not inside) VISIBLE_AUDIT_ROW_WHERE's own nested `target`
  // conditions — both apply as separate ANDed predicates on the same column,
  // never overwriting one another.
  it("?scope= narrows target while still combining with the visibility rule's own target conditions", async () => {
    await auditGET(new Request("http://t/api/audit?scope=org_1.dept"));
    const conditions = entriesCallConditions();
    // Escaped, so the `_` in the requested path stays a literal character
    // rather than the LIKE wildcard that leaked sibling scopes.
    expect(conditions.scope).toEqual({
      exact: "org_1.dept",
      dotPattern: "org\\_1.dept.%",
      slashPattern: "org\\_1.dept/%",
    });
    expect(conditions.visibility.conditional).toHaveLength(1);
    expect(conditions.visibility.conditional[0]!.markerPatterns).toHaveLength(5);
  });

  // A third filter (actorId), identity-picker-first. Every actor/entry id
  // below is a clearly labeled synthetic fixture, not a captured real sample.

  it("filters by ?actorId=&actorType=, ANDed into the same org-scoped where the other filters already share", async () => {
    await auditGET(new Request("http://t/api/audit?actorId=user_synthetic_2&actorType=human&decision=deny"));
    const conditions = entriesCallConditions();
    expect(conditions.decision).toBe("deny");
    expect(conditions.actorFilter).toEqual({ actorId: "user_synthetic_2", actorType: "human" });
  });

  it("omitting ?actorId= (and ?actorType=) omits the clause entirely (no accidental actorId: undefined filter)", async () => {
    await auditGET(new Request("http://t/api/audit"));
    expect(entriesCallConditions().actorFilter).toBeUndefined();
  });

  // actorId alone is not a unique identity. A
  // human User.id and an agent capability agentKey/agentId are not
  // guaranteed disjoint namespaces, so filtering by actorId alone could
  // cross-match a human and an agent that happen to share the same id
  // string. ?actorId= with no ?actorType= must never reach the DB as a
  // bare actorId filter — treated as no filter at all, same as an
  // incomplete/unknown ?decision= value.
  it("?actorId= with no ?actorType= is treated as no filter at all, never a bare actorId match", async () => {
    await auditGET(new Request("http://t/api/audit?actorId=shared_synthetic_id"));
    expect(entriesCallConditions().actorFilter).toBeUndefined();
  });

  it("a human and an agent sharing the same actorId string do not merge or cross-match in the audit list", async () => {
    const sharedId = "shared_synthetic_id";
    const HUMAN_ROW = {
      id: "audit_synthetic_human",
      actorType: "human",
      actorId: sharedId,
      action: "memory.read",
      target: "org_1/graph",
      decision: "allow",
      reason: null,
      metadata: {},
      at: new Date("2026-09-14T00:00:00Z"),
    };
    const AGENT_ROW = {
      id: "audit_synthetic_agent",
      actorType: "agent",
      actorId: sharedId,
      action: "memory.write",
      target: "org_1/graph",
      decision: "allow",
      reason: null,
      metadata: {},
      at: new Date("2026-09-14T00:00:00Z"),
    };
    mockAuditRows([HUMAN_ROW, AGENT_ROW]);
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: sharedId, name: "Synthetic Human", email: "human@synthetic.test" },
    ] as never);
    vi.mocked(db.agent.findMany).mockResolvedValue([{ agentKey: sharedId, name: "Synthetic Agent" }] as never);

    const humanRes = await auditGET(new Request(`http://t/api/audit?actorId=${sharedId}&actorType=human`));
    const humanBody = (await humanRes.json()) as { entries: { id: string; actorType: string }[] };
    expect(humanBody.entries.map((e) => e.id)).toEqual(["audit_synthetic_human"]);
    expect(humanBody.entries.every((e) => e.actorType === "human")).toBe(true);

    const agentRes = await auditGET(new Request(`http://t/api/audit?actorId=${sharedId}&actorType=agent`));
    const agentBody = (await agentRes.json()) as { entries: { id: string; actorType: string }[] };
    expect(agentBody.entries.map((e) => e.id)).toEqual(["audit_synthetic_agent"]);
    expect(agentBody.entries.every((e) => e.actorType === "agent")).toBe(true);
  });

  // An empty agent id is a real identity, and filtering on it must not show
  // every entry:
  //
  //   services/agents/tools.ts agentContextFromRuntime() deliberately leaves
  //   actorId as "" when the runtime context carries no actorId ("a missing
  //   actorId is a caller identity gap, not an identity"), and
  //   services/access/check.ts evaluate() denies on that falsy id AND audits
  //   the attempt — services/access/actor-identity-leak.eval.test.ts already
  //   pins `rows[0].actorId).toBe("")` on exactly that row. So ("agent", "")
  //   is a REAL persisted audit identity, not a hypothetical.
  //
  //   GET /api/audit/actors groups by (actorType, actorId) over the visible
  //   rows (VISIBLE_AUDIT_ROW_WHERE) with nothing excluding the empty id, and
  //   the deny above is action "memory.read" — always visible. So the picker
  //   really does render that row, and the page really can emit
  //   ?actorId=&actorType=agent.
  //
  //   An `actorIdFilter && actorTypeFilter` truthiness gate would see "" and
  //   drop BOTH clauses, so the admin who clicked the one row that signals a
  //   caller-identity gap would be shown the ENTIRE visible org trail,
  //   presented as if filtered to that identity. Presence, not truthiness,
  //   is the correct test.
  it("?actorId=&actorType=agent (empty id is a real audited identity) filters on it instead of dropping the filter", async () => {
    await auditGET(new Request("http://t/api/audit?actorId=&actorType=agent"));
    expect(entriesCallConditions().actorFilter).toEqual({ actorId: "", actorType: "agent" });
  });

  it("selecting the unidentified-agent row does not return other actors' entries", async () => {
    const UNIDENTIFIED_AGENT = {
      id: "audit_synthetic_unidentified",
      actorType: "agent",
      actorId: "",
      action: "memory.read",
      target: "org_1/graph",
      decision: "deny",
      reason: "actor identity required: missing actor.id for memory.read on org_1/graph",
      metadata: {},
      at: new Date("2026-09-14T00:00:00Z"),
    };
    const OTHER_HUMAN = {
      id: "audit_synthetic_other_human",
      actorType: "human",
      actorId: "user_synthetic_9",
      action: "memory.read",
      target: "org_1/graph",
      decision: "allow",
      reason: null,
      metadata: {},
      at: new Date("2026-09-14T00:00:00Z"),
    };
    mockAuditRows([UNIDENTIFIED_AGENT, OTHER_HUMAN]);

    const res = await auditGET(new Request("http://t/api/audit?actorId=&actorType=agent"));
    const body = (await res.json()) as { entries: { id: string }[] };
    expect(body.entries.map((e) => e.id)).toEqual(["audit_synthetic_unidentified"]);
  });

  it("resolves a filtered actor's display name the same way the unfiltered list does (synthetic fixture)", async () => {
    mockAuditRows([
      {
        id: "audit_synthetic_1",
        actorType: "human",
        actorId: "user_synthetic_1",
        action: "memory.read",
        target: "org_1/graph",
        decision: "allow",
        reason: null,
        metadata: {},
        at: new Date("2026-09-13T00:00:00Z"),
      },
    ]);
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: "user_synthetic_1", name: "Synthetic Reviewer", email: "reviewer@synthetic.test" },
    ] as never);

    const res = await auditGET(new Request("http://t/api/audit?actorId=user_synthetic_1&actorType=human"));
    const body = (await res.json()) as { entries: { actorName: string }[] };
    expect(body.entries[0].actorName).toBe("Synthetic Reviewer");
  });
});

describe("GET /api/audit/actors", () => {
  beforeEach(() => {
    vi.mocked(check).mockResolvedValue({ allowed: true } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([] as never);
    vi.mocked(db.agent.findMany).mockResolvedValue([] as never);
  });

  // Asserts against EVERY read method on auditLog, not just the one this
  // route happens to call. An assertion naming only the method the route
  // calls today passes unconditionally once the query shape changes
  // (hoisting a real read above the auth gate leaves it green). Naming the
  // methods exhaustively is what keeps the guard from going quiet. $queryRaw
  // is included because GET /api/audit itself runs on it
  // (services/access/audit-query.ts), with the same risk.
  const auditLogReads = ["findMany", "groupBy", "count"] as const;
  function expectAuditLogUntouched() {
    for (const method of auditLogReads) {
      expect(db.auditLog[method], `deny path must not reach db.auditLog.${method}`).not.toHaveBeenCalled();
    }
    expect(db.$queryRaw, "deny path must not reach db.$queryRaw").not.toHaveBeenCalled();
  }

  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await auditActorsGET()).status).toBe(401);
    expectAuditLogUntouched();
  });

  it("403 when access.manage is denied — same admin gate as the audit list itself, not a weaker one", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false } as never);
    expect((await auditActorsGET()).status).toBe(403);
    expectAuditLogUntouched();
  });

  // This route runs raw SQL (services/access/audit-query.ts) rather than
  // Prisma's typed `groupBy`, because the visible-row rule needs a `LIKE ...
  // ESCAPE` clause the typed API cannot emit. Two properties are pinned on
  // the generated statement: the org scoping, and the visible-row rule being
  // applied at all. The escaping itself is owned by
  // audit-visibility-escape.test.ts, so removing it fails that suite and not
  // this one.
  it("dedupes distinct actors in Postgres, scoped to this org and under the same visible-row rule as the audit list", async () => {
    await auditActorsGET();
    const [strings, ...values] = vi.mocked(db.$queryRaw).mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/SELECT\s+DISTINCT\s+"actorType",\s*"actorId"/i);
    expect(sql).toMatch(/FROM\s+"audit_log"/i);
    expect(values[0]).toBe("org_1");
    // Asserted against services/audit/audit-actions.ts rather than a hardcoded
    // list, so adding a visible action or a marker cannot silently desync this
    // from the rule it is checking (the decoder itself is map-derived for
    // the same reason).
    const visibility = parseVisibilityValues(values, 1);
    expect(visibility.alwaysVisibleActions).toEqual([...ALWAYS_VISIBLE_ACTIONS]);
    expect(visibility.conditional.map((c) => c.action)).toEqual(TARGET_CONDITIONAL_ACTIONS.map((c) => c.action));
    expect(values).toHaveLength(1 + VISIBILITY_VALUE_COUNT);
  });

  // Allow-case: an admin who only ever
  // shows up via access.manage mutations (grants:create/revoke, dispute
  // resolve) must still appear in the identity picker, not just in the raw
  // audit list.
  it("allow-case: an actor who only performed access.manage mutations still appears in the picker", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ actorType: "human", actorId: "user_synthetic_admin" }] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: "user_synthetic_admin", name: "Synthetic Admin", email: "admin@synthetic.test" },
    ] as never);
    const res = await auditActorsGET();
    const body = (await res.json()) as { actors: { actorId: string; name: string }[] };
    expect(body.actors).toEqual([{ actorType: "human", actorId: "user_synthetic_admin", name: "Synthetic Admin" }]);
  });

  it("resolves and sorts synthetic human + agent actors by display name, falling back for an actor with no matching row", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { actorType: "human", actorId: "user_synthetic_1" },
      { actorType: "agent", actorId: "handoff-agent" },
      { actorType: "agent", actorId: "deleted-synthetic-agent" },
    ] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: "user_synthetic_1", name: "Zed Synthetic", email: "zed@synthetic.test" },
    ] as never);
    vi.mocked(db.agent.findMany).mockResolvedValue([
      { agentKey: "handoff-agent", name: "Handoff" },
      // deleted-synthetic-agent intentionally absent — exercises the fallback name.
    ] as never);

    const res = await auditActorsGET();
    const body = (await res.json()) as { actors: { actorType: string; actorId: string; name: string }[] };
    expect(body.actors).toEqual([
      { actorType: "agent", actorId: "deleted-synthetic-agent", name: '"deleted-synthetic-agent" (agent token)' },
      { actorType: "agent", actorId: "handoff-agent", name: "Handoff Agent" },
      { actorType: "human", actorId: "user_synthetic_1", name: "Zed Synthetic" },
    ]);
  });

  it("org-scopes the agent name lookup — never resolves an agentKey against another org's agents table", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ actorType: "agent", actorId: "qa-agent" }] as never);

    await auditActorsGET();

    expect(db.agent.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", agentKey: { in: ["qa-agent"] } },
      select: { agentKey: true, name: true },
    });
  });
});

// ── Capability token revocation ───────────────────────────────────────────────
//
// check() honours `revokedAt IS NULL`, and DELETE /api/access/capabilities/:id
// is the product surface that sets it: an agent token is a bearer credential
// minted with up to a 90-day TTL, and it has to be withdrawable once issued.
//
// These cases cover the write path and its authority, plus the half that is
// easier to miss: revoking an AGENT's grant has to reach that agent's tokens,
// because check()'s agent branch authenticates the token and reads the
// capability's own scope and permission. It never joins grants. Without the
// cascade, pulling an agent's grant changes what the access UI shows and
// nothing about what the agent can still do.
describe("DELETE /api/access/capabilities/:id", () => {
  const cap = { id: "cap_1", scopePath: "org_1.eng", revokedAt: null, agentId: "agent_7" };

  it("requires a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(res.status).toBe(401);
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });

  it("404s for a token in another org, without revealing it exists", async () => {
    vi.mocked(db.capability.findFirst).mockResolvedValue(null as never);
    const res = await capDELETE(new Request("http://t"), params({ id: "cap_other_org" }));
    expect(res.status).toBe(404);
    // The lookup is tenant-scoped, so cross-tenant revocation is not reachable.
    expect(vi.mocked(db.capability.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: "cap_other_org", orgId: "org_1" },
    });
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });

  it("checks access.manage against the token's own scope, not a caller-supplied one", async () => {
    vi.mocked(db.capability.findFirst).mockResolvedValue(cap as never);
    vi.mocked(db.capability.updateMany).mockResolvedValue({ count: 1 } as never);
    await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(check).toHaveBeenCalledWith(admin.ctx, {
      action: "access.manage",
      scope: "org_1.eng",
      target: "capabilities:revoke:cap_1",
    });
  });

  it("403s and writes nothing when the caller does not administer that scope", async () => {
    vi.mocked(db.capability.findFirst).mockResolvedValue(cap as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not a scope admin" } as never);
    const res = await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(res.status).toBe(403);
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });

  // The actual item-102 defect, as an assertion: the write path exists and runs.
  it("sets revokedAt on the token", async () => {
    vi.mocked(db.capability.findFirst).mockResolvedValue(cap as never);
    vi.mocked(db.capability.updateMany).mockResolvedValue({ count: 1 } as never);
    const res = await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(res.status).toBe(200);
    const call = vi.mocked(db.capability.updateMany).mock.calls[0][0];
    expect(call).toMatchObject({ where: { id: "cap_1", orgId: "org_1", revokedAt: null } });
    expect(call.data.revokedAt).toBeInstanceOf(Date);
  });

  // Revoking must not delete the row: check()'s predicate reads revokedAt, the
  // UIs list revoked tokens as inactive, and an access review needs the record
  // that the token existed at all.
  it("updates rather than deletes, so the token's history survives", async () => {
    vi.mocked(db.capability.findFirst).mockResolvedValue(cap as never);
    vi.mocked(db.capability.updateMany).mockResolvedValue({ count: 1 } as never);
    await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(db.capability.updateMany).toHaveBeenCalled();
    expect((db.capability as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  it("is idempotent and does not move the original revocation time", async () => {
    const earlier = new Date("2026-09-01T00:00:00Z");
    vi.mocked(db.capability.findFirst).mockResolvedValue({ ...cap, revokedAt: earlier } as never);
    const res = await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyRevoked: true });
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });

  // The write itself must carry `revokedAt: null` and orgId, not only the
  // earlier findFirst read: with a bare `update({ where: { id } })`, two
  // concurrent DELETEs -- or a DELETE racing the grant-revoke cascade in
  // app/api/access/grants/[id]/route.ts, which stamps this same column --
  // could both pass the read with revokedAt still null and then both write,
  // with whichever ran last silently overwriting the real revocation instant.
  // That breaks the route's idempotency guarantee under concurrency, the
  // exact failure mode an access review's "when did this access actually
  // end" question depends on.
  it("does not move the timestamp when a concurrent request already revoked it", async () => {
    vi.mocked(db.capability.findFirst)
      .mockResolvedValueOnce(cap as never) // pre-write read
      .mockResolvedValueOnce({ revokedAt: new Date("2026-09-21T10:00:00Z") } as never); // post-race reload
    vi.mocked(db.capability.updateMany).mockResolvedValue({ count: 0 } as never); // lost the race
    const res = await capDELETE(new Request("http://t"), params({ id: "cap_1" }));
    expect(res.status).toBe(200);
    const call = vi.mocked(db.capability.updateMany).mock.calls[0][0];
    // The write is guarded by the same predicate that made it lose the race.
    expect(call).toMatchObject({ where: { id: "cap_1", orgId: "org_1", revokedAt: null } });
    expect(await res.json()).toEqual({
      revoked: "cap_1",
      revokedAt: new Date("2026-09-21T10:00:00Z").toISOString(),
      alreadyRevoked: true,
    });
  });
});

describe("DELETE /api/access/grants/:id — cascade to the agent's tokens", () => {
  function grant(over: Record<string, unknown> = {}) {
    return { id: "g_1", granteeType: "agent", granteeId: "agent_7", scope: { path: "org_1.eng" }, ...over };
  }
  function runTransaction() {
    vi.mocked(db.$transaction).mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        grant: db.grant,
        capability: db.capability,
        $executeRaw: db.$executeRaw,
      }),
    );
  }

  beforeEach(() => {
    runTransaction();
    vi.mocked(db.$executeRaw).mockResolvedValue(2 as never);
  });

  it("revokes the agent's tokens in the same transaction as the grant delete", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant() as never);
    const res = await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    expect(res.status).toBe(200);
    expect(db.grant.delete).toHaveBeenCalledWith({ where: { id: "g_1" } });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ revoked: "g_1", revokedCapabilities: 2 });
  });

  it("scopes the cascade to that agent, that org, and still-live tokens", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant() as never);
    await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    const [strings, ...values] = vi.mocked(db.$executeRaw).mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/UPDATE "capabilities"/);
    expect(sql).toMatch(/"revokedAt" IS NULL/);
    expect(sql).toMatch(/<@/); // descendant-or-self containment, not a bare equality
    expect(values).toContain("org_1");
    expect(values).toContain("agent_7");
    expect(values).toContain("org_1.eng");
  });

  // The cascade filters on expiry as well as `revokedAt IS NULL`, matching
  // check()'s own agent-token liveness test (`revokedAt IS NULL AND
  // expiresAt > sqlUtcNow`, services/access/check.ts) and the handoff scan
  // (`expiresAt: { gt: new Date() }`). An already-expired token cannot pass
  // check() either way, so stamping revokedAt on it would only rewrite its
  // audit history from "expired" to "revoked" and inflate
  // revokedCapabilities with rows that were already dead.
  it("excludes already-expired tokens from the cascade", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant() as never);
    await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    const [strings] = vi.mocked(db.$executeRaw).mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join("?");
    // UTC wall-clock now, as the column stores it (lib/sql-utc-now.ts), not bare now().
    expect(sql).toMatch(/"expiresAt"\s*>\s*\(now\(\) AT TIME ZONE 'UTC'\)/);
  });

  // The case above only asserts that "org_1" and "agent_7" appear SOMEWHERE
  // in the bound values. That is value presence, not predicate shape, and
  // the two are very different for a mass UPDATE: rewriting the org filter
  // to `WHERE ${rc.org.id} = ${rc.org.id}` and the agent filter to `AND
  // ${grant.granteeId} = ${grant.granteeId}` still binds the values, they
  // just no longer constrain anything. The `<@` and `revokedAt IS NULL` legs
  // are asserted as SQL TEXT, so the gap is specific to these two.
  //
  // This is the one statement in the product that revokes credentials in bulk,
  // and the tenant filter is the thing standing between "revoke this org's agent"
  // and "revoke every org's". It gets a guard that fails when it is removed.
  /** The value bound to the placeholder that a given predicate binds, so the
   * assertion is about which COLUMN the value constrains, not merely that the
   * value was bound somewhere in the statement. */
  function boundBy(sql: string, values: unknown[], predicate: RegExp): unknown {
    const m = sql.match(predicate);
    if (!m || m.index === undefined) return undefined;
    const upToAndIncluding = sql.slice(0, m.index + m[0].length);
    return values[(upToAndIncluding.match(/\?/g) ?? []).length - 1];
  }

  it("binds the cascade's org and agent filters to their own columns", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant() as never);
    await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    const [strings, ...values] = vi.mocked(db.$executeRaw).mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join("?");
    expect(boundBy(sql, values, /"orgId"\s*=\s*\?/), "the org filter must constrain the orgId column").toBe("org_1");
    expect(boundBy(sql, values, /"agentId"\s*=\s*\?/), "the agent filter must constrain the agentId column").toBe(
      "agent_7",
    );
    expect(boundBy(sql, values, /"scopePath"::ltree\s*<@\s*\?/), "containment must constrain scopePath").toBe(
      "org_1.eng",
    );
  });

  // A human grant has no capability tokens behind it; touching the table there
  // would revoke tokens nobody asked about.
  it("does not touch tokens when the grantee is a user", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant({ granteeType: "user", granteeId: "user_9" }) as never);
    await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    expect(db.grant.delete).toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("does not touch tokens for an 'everyone' grant", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant({ granteeType: "everyone" }) as never);
    await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("revokes nothing when the caller is denied", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(grant() as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "nope" } as never);
    const res = await grantDELETE(new Request("http://t"), params({ id: "g_1" }));
    expect(res.status).toBe(403);
    expect(db.grant.delete).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/access/grants/:id — the two cascades COMPOSED
// ---------------------------------------------------------------------------
//
// The two cascades above are each well covered on their own, but every one of
// those cases exercises exactly one of them: the handoff cases mock a grant with
// no `granteeType` (so the agent branch cannot fire), and the agent cases inherit
// the global `capability.findMany -> []` (so the handoff branch finds nothing).
// Both must run for an agent grant; wrapping the handoff scan in an `else` of
// the `granteeType === "agent"` check disables the handoff cascade for
// precisely the grants that need both, and the cases below fail under that
// mutation.
describe("DELETE /api/access/grants/:id — both cascades compose", () => {
  const agentGrant = {
    id: "g_1",
    granteeType: "agent",
    granteeId: "agent_7",
    scope: { path: "org_org_1.engineering" },
  };

  beforeEach(() => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(agentGrant as never);
    vi.mocked(db.grant.delete).mockResolvedValue({} as never);
    vi.mocked(db.$executeRaw).mockResolvedValue(2 as never);
  });

  // An agent grant can have BOTH its own tokens and a handoff brief minted off
  // the same scope. Dropping either cascade here leaves live credentials behind
  // after an admin was told the access was revoked.
  it("revokes the agent's own tokens AND the handoff briefs under the same scope", async () => {
    vi.mocked(db.capability.findMany).mockResolvedValue([
      { id: "cap_brief_at_scope", scopePath: "org_org_1.engineering" },
      { id: "cap_brief_descendant", scopePath: "org_org_1.engineering.backend" },
    ] as never);

    const res = await grantDELETE(new Request("http://t"), params({ id: "g_1" }));

    expect(res.status).toBe(200);
    // Agent cascade fired.
    expect(db.$executeRaw).toHaveBeenCalled();
    // Handoff cascade fired too, scoped to the handoff agent.
    expect(db.capability.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        agentId: HANDOFF_AGENT_ID,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true, scopePath: true },
    });
    expect(db.capability.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cap_brief_at_scope", "cap_brief_descendant"] } },
      data: { revokedAt: expect.any(Date) },
    });
    // The reported count is the SUM of both populations, not either alone.
    expect(await res.json()).toEqual({ revoked: "g_1", revokedCapabilities: 4 });
  });

  // The handoff scan filters `revokedAt: null` and runs INSIDE the same
  // transaction as the agent UPDATE, so it reads that update's own writes. That
  // ordering is the entire reason the two cascades cannot double-revoke (and
  // double-count) a row even if their populations ever overlapped. Reordering
  // the two blocks would break that silently, so it gets a guard.
  it("runs the agent cascade before the handoff scan, so neither can double-revoke", async () => {
    vi.mocked(db.capability.findMany).mockResolvedValue([] as never);

    await grantDELETE(new Request("http://t"), params({ id: "g_1" }));

    const updateOrder = vi.mocked(db.$executeRaw).mock.invocationCallOrder[0];
    const scanOrder = vi.mocked(db.capability.findMany).mock.invocationCallOrder[0];
    expect(updateOrder, "the agent UPDATE must be issued before the handoff scan").toBeLessThan(scanOrder);
  });

  // The handoff cascade is unconditional by design: a brief minted off a USER
  // admin's access is the original revoke-does-not-revoke-brief-access case, and
  // must still be revoked when that user's grant is pulled.
  it("still revokes handoff briefs for a non-agent grantee, with no agent cascade", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue({
      ...agentGrant,
      granteeType: "user",
      granteeId: "user_9",
    } as never);
    vi.mocked(db.capability.findMany).mockResolvedValue([
      { id: "cap_brief_at_scope", scopePath: "org_org_1.engineering" },
    ] as never);

    const res = await grantDELETE(new Request("http://t"), params({ id: "g_1" }));

    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.capability.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cap_brief_at_scope"] } },
      data: { revokedAt: expect.any(Date) },
    });
    expect(await res.json()).toEqual({ revoked: "g_1", revokedCapabilities: 1 });
  });

  // A sibling brief is outside the revoked grant's scope and was never granted
  // by it; the composed handler must not over-revoke just because the agent
  // cascade also ran.
  it("does not over-revoke a sibling-scoped brief while the agent cascade runs", async () => {
    vi.mocked(db.capability.findMany).mockResolvedValue([{ id: "cap_sibling", scopePath: "org_org_1.sales" }] as never);

    const res = await grantDELETE(new Request("http://t"), params({ id: "g_1" }));

    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.capability.updateMany).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ revoked: "g_1", revokedCapabilities: 2 });
  });
});
