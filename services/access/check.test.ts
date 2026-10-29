// check() unit tests: the default-deny decision for a human grant and for an
// agent capability token. Asserts the one rule check() enforces — nothing is
// allowed without a live grant or token covering the target scope at the
// permission the action needs — and that every decision writes one audit row.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db: check() uses db.$queryRaw (grant/capability lookup) + db.auditLog.create.
// The ltree containment + expiry + everyone matching run in Postgres, so this unit
// test drives the JS decision logic (permission ranking, default deny, agent path,
// audit recording) by controlling what the query "returns". The live SQL/ltree
// behavior is covered end-to-end by scripts/check-access.ts.
vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_test_id" }),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    // deriveGrantGovernance()'s Prisma-client grant read, off check()'s own
    // $queryRaw decision path.
    grant: { findFirst: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import {
  auditChangesUnderScope,
  check,
  deriveGrantGovernance,
  descendantScopePaths,
  MAX_SEARCHED_DESCENDANT_SCOPES,
  latestBriefAcknowledgement,
  normalizeScopePath,
  orgRootPath,
  readableScopePaths,
  recordAppliedChange,
  recordBriefAcknowledgement,
  recordReadFactIds,
  type AccessContext,
} from "./check";

// agentId defaults to "agent_1" — the actor id every agent()/agentInRun() context
// in this file uses — so a plain rows(...) call keeps meaning "a capability that
// covers the action for the actor under test". Pass a different agentId
// explicitly to exercise a mismatch.
//
// The capability query selects two extra columns (grantGoverned/
// hasLiveCoveringGrant, see check.ts) in the same single query, so this helper
// (and every other test file's own db.$queryRaw mock across the repo) keeps
// returning the plain row shape. Those two fields come back `undefined` here,
// same as a real row that was never grant-governed, which is falsy everywhere
// check.ts reads it.
const rows = (perms: string[], agentId = "agent_1") =>
  vi.mocked(db.$queryRaw).mockResolvedValue(perms.map((p) => ({ permission: p, agentId })) as never);

const human = (role: "admin" | "member" = "member"): AccessContext => ({
  orgId: "org_1",
  actor: { type: "human", id: "user_1", role },
  origin: "app",
});
const agent = (): AccessContext => ({
  orgId: "org_1",
  actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
  origin: "mcp",
});
const agentInRun = (runId: string): AccessContext => ({
  orgId: "org_1",
  runId,
  actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
  origin: "mcp",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
});

describe("check() — human", () => {
  it("allows when a grant covers the needed permission", async () => {
    rows(["read"]);
    const d = await check(human(), { action: "memory.read" });
    expect(d.allowed).toBe(true);
  });

  it("default-denies when no grant matches (empty result)", async () => {
    rows([]);
    const d = await check(human(), { action: "memory.read" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no read grant/);
  });

  it("denies when the held permission is too low (read grant, write action)", async () => {
    rows(["read"]);
    const d = await check(human(), { action: "memory.write" });
    expect(d.allowed).toBe(false);
  });

  it("admin permission covers write and read (admin ⊇ write ⊇ read)", async () => {
    rows(["admin"]);
    expect((await check(human("admin"), { action: "memory.write" })).allowed).toBe(true);
    rows(["admin"]);
    expect((await check(human("admin"), { action: "access.manage" })).allowed).toBe(true);
  });

  it("decides from the person's live membership of the org, never the role the context carries", async () => {
    rows([]);
    await check(human("admin"), { action: "memory.read", scope: "org_1.engineering" });
    const [strings, ...values] = vi.mocked(db.$queryRaw).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain('FROM "org_memberships" m');
    expect(sql).toContain('m."removedAt" IS NULL');
    expect(sql).toContain(`g."granteeId" = m."role"::text`);
    expect(values.slice(0, 2)).toEqual(["org_1", "user_1"]);
    expect(values).not.toContain("admin");
  });

  // The database does not tie a grant's org to its scope's org, so the query
  // must check both against the membership's org.
  it("reads only grants and scopes of the membership's own org", async () => {
    rows([]);
    await check(human(), { action: "memory.read", scope: "org_1.engineering" });
    const [strings] = vi.mocked(db.$queryRaw).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?").replace(/\s+/g, " ");
    expect(sql).toContain('JOIN "grants" g ON g."orgId" = m."orgId"');
    expect(sql).toContain('JOIN "scopes" s ON s."id" = g."scopeId" AND s."orgId" = m."orgId"');
    expect(sql).toMatch(/WHERE m\."orgId" = \? AND m\."removedAt" IS NULL/);
  });

  it("defaults the target to the org root scope when no scope is given", async () => {
    rows(["read"]);
    await check(human(), { action: "memory.read" });
    // The audited target falls back to the org root path.
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.target).toBe(orgRootPath("org_1"));
  });
});

describe("check() — agent (capability token)", () => {
  it("allows when a valid capability covers the action", async () => {
    rows(["read"]);
    expect((await check(agent(), { action: "memory.read" })).allowed).toBe(true);
  });

  it("denies when no valid capability is found", async () => {
    rows([]);
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no valid capability/);
  });

  it("denies a token whose scope does not cover the target, and still names its provisioner", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "admin", agentId: "agent_1", createdBy: "user_9", coversTarget: false },
    ] as never);
    expect(await check(agent(), { action: "memory.read" })).toMatchObject({ allowed: false, triggeredBy: "user_9" });
  });

  // Postgres answers NULL for a comparison it cannot decide. Only a definite
  // "covers" may reach a decision rule; an unknown answer is a deny.
  it("denies when the database cannot say whether the token covers the target", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "admin", agentId: "agent_1", createdBy: "user_9", coversTarget: null },
    ] as never);
    expect((await check(agent(), { action: "memory.read" })).allowed).toBe(false);
  });
});

// check()'s human branch re-evaluates grants live on every call; the agent
// branch's capability row carries a scopePath/permission fixed at mint. A
// DELETE on a grants row cascades revokedAt to the capabilities it covers
// (exercised by the "revoked" leg of the tests above via the revokedAt/
// expiresAt filter baked into the mocked capability rows). That alone leaves
// a gap: a grant DEMOTED (a narrower grant now covers less than an existing,
// non-revoked capability once did) or REMOVED alongside others still on file
// for the same agent would leave the old, wider capability enforceable until
// natural expiry (up to 90 days). These tests pin the re-derivation that
// closes it. `grantGoverned` and `hasLiveCoveringGrant` are the two extra
// columns check.ts's single capability query selects — one plain column, one
// correlated EXISTS subquery, still one db.$queryRaw call (a second call
// would silently feed every OTHER test file's capability-only mock into this
// decision).
//
// `grantGoverned` is a plain column read off the capability's own persisted,
// stamped-once value (see check.ts's deriveGrantGovernance() and the
// grantGoverned schema comment), not a live EXISTS over "grants": a live
// query cannot distinguish "never grant-governed" from "grant-governed, but
// every grant was later hard-deleted outside the DELETE-route cascade" — both
// are zero current rows. The mocked fixtures below are a boolean the row
// either has or omits, because a mock cannot see the difference between
// "derived live" and "read from a column" — that distinction is only
// observable against a real Postgres, which
// services/access/agent-scope-full-removal-provenance-gap-live-sql.test.ts
// exercises directly (deletes the underlying grants row and proves the
// persisted flag does not go back to false).
describe("check() — agent scope re-derivation from current grants", () => {
  it("wide-after-remove: denies once the agent's only remaining grant is narrower than the scope its still-valid capability was minted for (the demotion gap)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_1", grantGoverned: true, hasLiveCoveringGrant: false },
    ] as never);

    const d = await check(agent(), { action: "memory.read" }); // default target = org root

    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/stale/i);
    // Still exactly one query for the whole agent branch, not a second round trip.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("narrow-after-add: a freshly widened or added agent grant never rescues a capability whose OWN permission does not cover the action (promotion still fails narrow, safe)", async () => {
    // Capability minted read-only, before promotion. Even if a live admin
    // grant now exists (hasLiveCoveringGrant: true, org-wide), it must not
    // matter — the capability's own permission never covered a write.
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_1", grantGoverned: true, hasLiveCoveringGrant: true },
    ] as never);

    const d = await check(agent(), { action: "memory.write" });

    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no valid capability/);
  });

  it("still allows when a live agent grant continues to cover the action (no regression on the common, unchanged case)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_1", grantGoverned: true, hasLiveCoveringGrant: true },
    ] as never);

    const d = await check(agent(), { action: "memory.read" });

    expect(d.allowed).toBe(true);
  });

  it("still allows an agent with zero grant rows on file (system agents like copy-agent/research-agent, minted directly with no /access/grants entry) — nothing to re-derive from, unaffected", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_1", grantGoverned: false, hasLiveCoveringGrant: false },
    ] as never);

    const d = await check(agent(), { action: "memory.read" });

    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/capability covers/);
  });

  it("a capability-only fixture that never sets grantGoverned/hasLiveCoveringGrant at all is allowed (undefined is falsy, not a deny)", async () => {
    rows(["read"]); // the plain shape every other test file in this repo uses
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(true);
  });

  // This is exactly the shape a full removal produces because grantGoverned
  // is persisted instead of live-derived — grantGoverned:true (stamped at
  // mint or by the grants-POST ratchet, unaffected by what happens to the
  // underlying grant rows afterward) and hasLiveCoveringGrant:false (the
  // grant that established governance is gone, full stop, not merely
  // demoted). Under a live EXISTS query this row is unreachable — deleting
  // every grant for the agentId would make it false too, landing in the
  // ungoverned branch (agent-scope-full-removal-provenance-gap-live-sql.test.ts
  // proves that against real Postgres, which this mock cannot reproduce).
  it("full-removal: denies when grantGoverned is persisted true but zero grants remain on file at all (not just demotion)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "write", agentId: "agent_1", grantGoverned: true, hasLiveCoveringGrant: false },
    ] as never);

    const d = await check(agent(), { action: "memory.write" });

    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/stale/i);
  });

  it("reports a capability that never covered the action as a missing capability, not as a stale one, even when its grant is also gone", async () => {
    // Pins the ORDER of the agent branch's last two rules, which every other
    // case here leaves free. Both rules deny this row: the capability's own
    // permission is `read` against a write, AND it is grant-governed with no
    // covering grant left. Only the reason tells the two orderings apart, and
    // the reason is what lands in the audit row an operator reads later:
    // "this token was never allowed to write" and "this token's grant was
    // revoked" are different incidents. Checking the capability's own
    // permission first is what makes the first one say so.
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_1", grantGoverned: true, hasLiveCoveringGrant: false },
    ] as never);

    const d = await check(agent(), { action: "memory.write" });

    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no valid capability/);
    expect(d.reason).not.toMatch(/stale/i);
  });
});

// The issuer gate. The capability query computes `issuerLacksAccess` so that it
// is never NULL (see check.ts); these pin the TypeScript side of the same rule,
// that only a definite "the issuer still holds access" lets the token through.
describe("check() — agent token issued by a person", () => {
  const issuerRow = (issuerLacksAccess: boolean | null) =>
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", agentId: "agent_1", issuerLacksAccess }] as never);

  it("allows when the issuer definitely still holds access", async () => {
    issuerRow(false);
    expect((await check(agent(), { action: "memory.read" })).allowed).toBe(true);
  });

  it("denies when the issuer no longer holds access", async () => {
    issuerRow(true);
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(false);
  });

  it("denies when the issuer check came back NULL, rather than reading the unknown as access", async () => {
    issuerRow(null);
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(false);
  });
});

// deriveGrantGovernance() decides what a NEW capability's
// grantGoverned/derivedFromGrantId columns are stamped with at mint — the
// one-time judgment call check.ts's agent branch never makes live on a
// check() call.
describe("deriveGrantGovernance() — provenance stamped at mint", () => {
  it("returns grantGoverned:true with the grant's own id when the agentId already has a current grant", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue({ id: "grant_9" } as never);

    const result = await deriveGrantGovernance("org_1", "agent_1");

    expect(result).toEqual({ grantGoverned: true, derivedFromGrantId: "grant_9" });
    expect(db.grant.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org_1", granteeType: "agent", granteeId: "agent_1" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("returns grantGoverned:false with a null id when the agentId has no current grant (system-agent case)", async () => {
    vi.mocked(db.grant.findFirst).mockResolvedValue(null);

    const result = await deriveGrantGovernance("org_1", "copy-agent");

    expect(result).toEqual({ grantGoverned: false, derivedFromGrantId: null });
  });
});

// A bare vi.fn() mock of db.$queryRaw accepts ANY argument shape, so every
// test above pins the generated SQL text/values but is structurally incapable
// of catching a change to HOW check() hands those args to the real client. A
// flattenSql() that returns Prisma.Sql's `strings`, a plain string[] with no
// `.raw`/`.sql`, is rejected by the real Prisma 7 client with
// PrismaClientValidationError before dispatch — invisible to every test here
// because the mock never checks. Pin the shape actually received, not just
// that a call happened.
describe("check() — flattenSql() calling-convention pin", () => {
  it("hands the human-grant query's first argument a real tagged-template-compatible object (a .raw array), not a plain string[]", async () => {
    rows(["read"]);
    await check(human(), { action: "memory.read" });
    const firstArg = vi.mocked(db.$queryRaw).mock.calls[0][0] as unknown as {
      raw?: readonly string[];
    };
    expect(Array.isArray(firstArg.raw)).toBe(true);
    expect(firstArg.raw!.length).toBeGreaterThan(0);
  });

  it("hands the capability query's first argument a real tagged-template-compatible object (a .raw array), not a plain string[]", async () => {
    rows(["read"]);
    await check(agent(), { action: "memory.read" });
    const firstArg = vi.mocked(db.$queryRaw).mock.calls[0][0] as unknown as {
      raw?: readonly string[];
    };
    expect(Array.isArray(firstArg.raw)).toBe(true);
    expect(firstArg.raw!.length).toBeGreaterThan(0);
  });
});

// A valid capability token proves the caller HOLDS a real token; it says
// nothing about who they're claiming to be. evaluate()'s agent branch must
// compare the presented actorId against the token's own Capability.agentId,
// not just token/org/scope/permission.
describe("check() — agent capability owner mismatch", () => {
  it("denies and audits a mismatch when the token's own agentId differs from the claimed actor", async () => {
    // agent() claims actor id "agent_1"; the token itself was issued to a
    // different agent entirely — a fabricated identity, same shape as the
    // missing-actor case but reached via a mismatched capability instead.
    rows(["admin"], "agent_someone_else");
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/agentId mismatch/i);
    // The claimed-vs-actual pair is the operator's half, and only the
    // operator's: handing the token's real owner back to the caller would
    // disclose the identity this deny exists to protect
    // (services/access/deny-reason.ts).
    expect(d.reason).not.toMatch(/agent_someone_else/);
    expect(d.auditReason).toMatch(/agent_someone_else/);
    expect(d.auditReason).toMatch(/agent_1/);
  });

  it("still allows when the token's own agentId matches the claimed actor (no regression)", async () => {
    rows(["admin"], "agent_1");
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(true);
  });

  it("audits the mismatch under the CLAIMED actor id, not the token's real owner — never a plausible-but-wrong audit row", async () => {
    rows(["admin"], "agent_someone_else");
    await check(agent(), { action: "memory.read" });
    const data = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(data.decision).toBe("deny");
    expect(data.actorId).toBe("agent_1");
  });

  it("a mismatch is checked across every matching row, not just the first, so a real permission on a mismatched row is never mistaken for a hit", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_someone_else" },
      { permission: "admin", agentId: "agent_someone_else" },
    ] as never);
    const d = await check(agent(), { action: "memory.read" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/agentId mismatch/i);
  });

  it("never borrows a stranger's permission: only the claimed actor's OWN rows can satisfy the action", async () => {
    // The discriminating case for evaluate()'s final `ownedRows.some(...)`. The
    // case directly above cannot pin it: BOTH its rows are unowned, so the early
    // mismatch return fires first and the test passes either way — swapping that
    // final line back to `rows.some(...)` leaves the rest of the suite green.
    //
    // Here the claimed actor DOES own a row, so the early return correctly does
    // not fire — but its own row only carries `read`, while the `admin` sitting
    // beside it belongs to another agent. Borrowing that stranger's permission is
    // the failure this pins: under `rows.some(...)` this flips to allowed.
    //
    // Not reachable in production today (Capability.tokenHash is @unique, so one
    // token resolves to at most one row). Pinned anyway: the chokepoint
    // enforces its own invariant rather than trusting a condition that merely
    // happens to hold elsewhere.
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", agentId: "agent_1" },
      { permission: "admin", agentId: "agent_someone_else" },
    ] as never);

    const d = await check(agent(), { action: "memory.write" });

    expect(d.allowed).toBe(false);
    // Denied as a plain no-capability, NOT as an owner mismatch: this actor really
    // does hold a valid row, it just doesn't cover a write.
    expect(d.reason).toMatch(/no valid capability/);
  });
});

// A caller with no real identity (actor.id empty) must be denied outright,
// never fall through to the token/scope check below. A valid capability token
// says nothing about who is asking; an empty actor.id means nobody real is on
// record, so it can't be allowed to "cover" the request.
describe("check() — missing actor identity", () => {
  it("denies without querying capabilities when the agent actor has no id", async () => {
    rows(["admin"]); // would allow if actor identity weren't the problem
    const ctx: AccessContext = {
      orgId: "org_1",
      actor: { type: "agent", id: "", capabilityToken: "wcap_xyz" },
      origin: "mcp",
    };
    const d = await check(ctx, { action: "memory.read" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/actor identity required/);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("still audits the denial, with the empty actor id — never the fallback 'agent'", async () => {
    rows(["admin"]);
    const ctx: AccessContext = {
      orgId: "org_1",
      actor: { type: "agent", id: "", capabilityToken: "wcap_xyz" },
      origin: "mcp",
    };
    await check(ctx, { action: "memory.read", target: "query:budget" });
    const data = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(data.decision).toBe("deny");
    expect(data.actorId).toBe("");
    expect(data.actorId).not.toBe("agent");
  });
});

describe("check() — audit", () => {
  it("records exactly one audit row per check, with the decision", async () => {
    rows([]);
    await check(human(), { action: "memory.read", target: "query:budget" });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(db.auditLog.create).mock.calls[0][0].data;
    expect(data).toMatchObject({
      orgId: "org_1",
      actorType: "human",
      actorId: "user_1",
      action: "memory.read",
      target: expect.stringContaining("query:budget"),
      decision: "deny",
    });
  });

  it("records allow decisions too", async () => {
    rows(["read"]);
    await check(human(), { action: "memory.read" });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.decision).toBe("allow");
  });

  it("returns the created row's id as decision.auditLogId", async () => {
    rows(["read"]);
    const d = await check(human(), { action: "memory.read" });
    expect(d.auditLogId).toBe("audit_test_id");
  });

  it("stamps ctx.runId onto the audit row when the caller is inside a tracked agent run", async () => {
    rows(["read"]);
    await check(agentInRun("run_A"), { action: "memory.read" });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.runId).toBe("run_A");
  });

  it("leaves runId unset for activity with no tracked run (a human actor, or an agent call outside a run)", async () => {
    rows(["read"]);
    await check(human(), { action: "memory.read" });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.runId).toBeUndefined();
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
    rows(["read"]);
    await check(agent(), { action: "memory.read" });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.runId).toBeUndefined();
  });
});

describe("recordReadFactIds() — per-fact audit annotation", () => {
  it("writes a NEW linked audit row with the fact ids when the read was allowed, never mutates the original (audit_log is append-only)", async () => {
    await recordReadFactIds(human(), { allowed: true, reason: "ok", auditLogId: "audit_test_id" }, [
      "fact-1",
      "fact-2",
    ]);
    expect(db.auditLog.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        orgId: "org_1",
        actorType: "human",
        actorId: "user_1",
        action: "memory.read.factIds",
        decision: "allow",
        metadata: { auditLogId: "audit_test_id", factIds: ["fact-1", "fact-2"], origin: "app" },
      },
    });
  });

  it("still writes the linked row when the original decision carried a triggeredBy — recoverable via the join, not duplicated onto the new row", async () => {
    await recordReadFactIds(
      agent(),
      { allowed: true, reason: "ok", auditLogId: "audit_test_id", triggeredBy: "user_1" },
      ["fact-1"],
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        orgId: "org_1",
        actorType: "agent",
        actorId: "agent_1",
        action: "memory.read.factIds",
        decision: "allow",
        metadata: { auditLogId: "audit_test_id", factIds: ["fact-1"], origin: "mcp" },
      },
    });
  });

  it("does nothing when the decision was denied — a denied read never touched real facts", async () => {
    await recordReadFactIds(human(), { allowed: false, reason: "no", auditLogId: "audit_test_id" }, []);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("stamps ctx.runId onto the linked factIds row too — the same run's memory.read and memory.read.factIds rows share one runId", async () => {
    await recordReadFactIds(agentInRun("run_A"), { allowed: true, reason: "ok", auditLogId: "audit_test_id" }, [
      "fact-1",
    ]);
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.runId).toBe("run_A");
  });

  it("does nothing when there's no auditLogId to annotate", async () => {
    await recordReadFactIds(human(), { allowed: true, reason: "ok" }, ["fact-1"]);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

// auditChangesUnderScope() reads THESE rows instead of check()'s
// authorization-time ones, so the write this function does is the one thing
// standing between "a write was allowed" and "a write actually landed" for
// the brief staleness flag.
describe("recordAppliedChange() — confirmed-applied signal, not authorization", () => {
  it("writes an allow row tagged with the *.applied action, target = bare scopePath when no tag is given", async () => {
    await recordAppliedChange({
      orgId: "org_1",
      actorType: "human",
      actorId: "user_1",
      origin: "mcp",
      action: "memory.write",
      scopePath: "org_1.engineering",
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        orgId: "org_1",
        actorType: "human",
        actorId: "user_1",
        action: "memory.write.applied",
        target: "org_1.engineering",
        decision: "allow",
        metadata: { origin: "mcp" },
        runId: undefined,
      },
    });
  });

  it("appends the tag onto the target exactly as recordAudit()'s own target/tag convention does, for self-write exclusion to keep matching", async () => {
    await recordAppliedChange({
      orgId: "org_1",
      actorType: "agent",
      actorId: "agent_brief_1",
      origin: "mcp",
      action: "memory.write",
      scopePath: "org_1.engineering",
      tag: "brief:brief_1",
    });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.target).toBe("org_1.engineering/brief:brief_1");
  });

  it("uses the memory.delete.applied action for a delete", async () => {
    await recordAppliedChange({
      orgId: "org_1",
      actorType: "human",
      actorId: "user_1",
      origin: "mcp",
      action: "memory.delete",
      scopePath: "org_1.engineering",
      tag: "fact:f1",
    });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data).toMatchObject({
      action: "memory.delete.applied",
      target: "org_1.engineering/fact:f1",
      decision: "allow",
    });
  });

  it("stamps runId when given, for the same run-disambiguation reason check()'s own rows do", async () => {
    await recordAppliedChange({
      orgId: "org_1",
      actorType: "agent",
      actorId: "agent_1",
      origin: "mcp",
      action: "memory.write",
      scopePath: "org_1.engineering",
      runId: "run_A",
    });
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data.runId).toBe("run_A");
  });
});

// Locks in the actual SQL action filter as a unit test that runs in ordinary
// CI, not only the real-Postgres QA suite (containment-realdb.qa.test.ts,
// skipped without QA_DATABASE_URL) — a revert of the `.applied` literal here
// would otherwise go undetected until someone happens to run the QA suite.
describe("auditChangesUnderScope() — reads the confirmed-applied actions, not authorization-time ones", () => {
  it("filters on memory.write.applied/memory.delete.applied, not the bare memory.write/memory.delete recordAudit() writes", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    await auditChangesUnderScope({
      orgId: "org_1",
      scopePath: "org_1.engineering",
      after: new Date("2026-09-01T00:00:00Z"),
      excludeTarget: "org_1.engineering/brief:b1",
      limit: 20,
    });
    const [strings] = vi.mocked(db.$queryRaw).mock.calls[0] as unknown as [TemplateStringsArray];
    const sqlText = strings.join("?");
    expect(sqlText).toContain("IN ('memory.write.applied', 'memory.delete.applied')");
    expect(sqlText).not.toContain("IN ('memory.write', 'memory.delete')");
  });
});

// An empty-string scopePath is falsy for `if (body.scopePath)` (so it would
// silently skip the check() gate at the route boundary) but truthy for `??`
// (so it would survive past `scopePath ?? orgRootPath(...)` downstream as a
// non-ltree value). normalizeScopePath() closes both gaps at the route
// boundary, before either the check() gate or the write path sees it.
describe("normalizeScopePath() — empty-string route-boundary gap", () => {
  it("collapses an empty string to undefined", () => {
    expect(normalizeScopePath("")).toBeUndefined();
  });

  it("collapses a whitespace-only string to undefined", () => {
    expect(normalizeScopePath("   ")).toBeUndefined();
  });

  it("passes undefined through unchanged", () => {
    expect(normalizeScopePath(undefined)).toBeUndefined();
  });

  it("trims surrounding whitespace off a real scope path", () => {
    expect(normalizeScopePath("  org_1.projects.backend  ")).toBe("org_1.projects.backend");
  });

  it("leaves a real scope path untouched", () => {
    expect(normalizeScopePath("org_1.projects.backend")).toBe("org_1.projects.backend");
  });
});

// The Graphiti retrieval leg's authorized-descendant-query source of truth.
// descendantScopePaths() is a separate, additive helper (never touches
// check()/evaluate() or the allow/deny decision) — these tests pin its own
// contract directly, the way this file pins evaluate()'s.
describe("descendantScopePaths() — authorized-descendant-query source of truth", () => {
  beforeEach(() => {
    vi.mocked(db.$queryRaw).mockReset();
  });

  /** The SQL text and bound values of the one registry query the helper sent. */
  const sentQuery = () => {
    const [strings, ...values] = vi.mocked(db.$queryRaw).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return { sql: strings.join("?"), values };
  };

  it("queries scopes strictly BELOW the target, scoped to the org, and returns their paths as complete", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { path: "org_1.dealA.notes" },
      { path: "org_1.dealA.notes.legal" },
    ] as never);

    const result = await descendantScopePaths("org_1", "org_1.dealA");

    expect(result).toEqual({ paths: ["org_1.dealA.notes", "org_1.dealA.notes.legal"], unsearched: [], partial: false });
    const { sql, values } = sentQuery();
    expect(sql).toMatch(/"orgId" = \? AND "path" <> \?/);
    expect(values.slice(0, 2)).toEqual(["org_1", "org_1.dealA"]);
  });

  it("uses ltree containment, never a LIKE prefix, so an underscore in a label is not a wildcard", async () => {
    // Postgres evaluates the difference; guarded-store.descendant-underscore
    // .realdb.test.ts proves it against a real registry. This pins the shape.
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    await descendantScopePaths("org_1", "org_1.dept_sales");
    const { sql } = sentQuery();
    expect(sql).toContain('"path"::ltree <@ ?::ltree');
    expect(sql).not.toMatch(/LIKE/i);
  });

  it("reads every descendant in path order, with no LIMIT that could drop one silently", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    await descendantScopePaths("org_1", "org_1.dealA");
    const { sql } = sentQuery();
    expect(sql).toMatch(/ORDER BY "path" ASC\s*$/);
    expect(sql).not.toMatch(/LIMIT/);
  });

  it("returns no paths, and not partial, when the target has no registered descendant scopes", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    expect(await descendantScopePaths("org_1", "org_1.dealA")).toEqual({ paths: [], unsearched: [], partial: false });
  });

  it.each([
    { descendants: MAX_SEARCHED_DESCENDANT_SCOPES, unsearched: 0 },
    { descendants: MAX_SEARCHED_DESCENDANT_SCOPES + 1, unsearched: 1 },
    { descendants: MAX_SEARCHED_DESCENDANT_SCOPES + 7, unsearched: 7 },
  ])(
    "searches at most the per-read bound and names the rest ($descendants descendants)",
    async ({ descendants, unsearched }) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const rows = Array.from({ length: descendants }, (_, i) => ({
        path: `org_1.dealA.c${String(i).padStart(4, "0")}`,
      }));
      vi.mocked(db.$queryRaw).mockResolvedValue(rows as never);

      const result = await descendantScopePaths("org_1", "org_1.dealA");

      expect(result.paths).toEqual(rows.slice(0, MAX_SEARCHED_DESCENDANT_SCOPES).map((r) => r.path));
      expect(result.unsearched).toEqual(rows.slice(MAX_SEARCHED_DESCENDANT_SCOPES).map((r) => r.path));
      expect(result.unsearched).toHaveLength(unsearched);
      expect(result.partial).toBe(unsearched > 0);
    },
  );

  it("fails soft to no paths, marked partial (never throws), when the lookup itself errors — a broad-scoped read must still return its own leg's facts, not fail outright", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection reset"));

    await expect(descendantScopePaths("org_1", "org_1.dealA")).resolves.toEqual({
      paths: [],
      unsearched: [],
      partial: true,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("readableScopePaths() — briefs/:id/staleness source-count existence-leak fix", () => {
  beforeEach(() => {
    vi.mocked(db.$queryRaw).mockReset();
  });

  const grants = (rows: { permission: string; scopePath: string }[]) =>
    vi.mocked(db.$queryRaw).mockResolvedValue(rows.map((r) => ({ userId: "user_1", role: "member", ...r })) as never);

  it("returns the granted scope paths that meet the needed permission", async () => {
    grants([{ permission: "read", scopePath: "org_1.engineering" }]);
    expect(await readableScopePaths(human())).toEqual(["org_1.engineering"]);
  });

  it("a write/admin grant covers a read request too (permission ranking, same as covers() elsewhere)", async () => {
    grants([
      { permission: "write", scopePath: "org_1.engineering" },
      { permission: "admin", scopePath: "org_1.sales" },
    ]);
    expect(await readableScopePaths(human())).toEqual(["org_1.engineering", "org_1.sales"]);
  });

  it("excludes a grant that doesn't meet the needed permission", async () => {
    // The query itself only asks Postgres for membership/grantee/expiry, not
    // permission — ranking is filtered in JS, same as evaluate()'s covers().
    grants([{ permission: "read", scopePath: "org_1.engineering" }]);
    expect(await readableScopePaths(human(), "write")).toEqual([]);
  });

  it("returns an empty array for an agent actor — agents authenticate via capability token, not a grant, and never reach the grants", async () => {
    expect(await readableScopePaths(agent())).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("asks the membership query check() decides with, for this person in this org, never the role the context carries", async () => {
    grants([]);
    await readableScopePaths(human("admin"));
    const [strings, ...values] = vi.mocked(db.$queryRaw).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain('FROM "org_memberships" m');
    expect(sql).toContain('m."removedAt" IS NULL');
    expect(sql).toContain(`g."granteeId" = m."role"::text`);
    expect(values.slice(0, 2)).toEqual(["org_1", "user_1"]);
    expect(values).not.toContain("admin");
  });
});

// The completion receipt carries the grantee's acknowledgement and the
// staleness verdict at that moment.
describe("recordBriefAcknowledgement / latestBriefAcknowledgement", () => {
  it("writes a brief.acknowledged row tagged with the same target convention recordAudit uses", async () => {
    vi.mocked(db.auditLog.create).mockResolvedValue({
      id: "audit_ack_1",
      at: new Date("2026-09-19T02:00:00Z"),
    } as never);
    const result = await recordBriefAcknowledgement({
      orgId: "org_1",
      scopePath: "org_1.engineering",
      briefId: "brief_1",
      actorType: "human",
      actorId: "user_1",
      origin: "mcp",
      stale: true,
    });
    expect(result).toEqual({ id: "audit_ack_1", at: new Date("2026-09-19T02:00:00Z") });
    const call = vi.mocked(db.auditLog.create).mock.calls[0][0] as {
      data: { orgId: string; action: string; target: string; decision: string; metadata: unknown };
    };
    expect(call.data).toMatchObject({
      orgId: "org_1",
      action: "brief.acknowledged",
      target: "org_1.engineering/brief:brief_1/acknowledged",
      decision: "allow",
      metadata: { stale: true },
    });
  });

  it("reads back the most recent acknowledgement, tagged the same way it was written", async () => {
    vi.mocked(db.auditLog.findFirst).mockResolvedValue({
      at: new Date("2026-09-19T02:00:00Z"),
      metadata: { stale: false },
    } as never);
    const result = await latestBriefAcknowledgement({
      orgId: "org_1",
      scopePath: "org_1.engineering",
      briefId: "brief_1",
    });
    expect(result).toEqual({ at: new Date("2026-09-19T02:00:00Z"), stale: false });
    const call = vi.mocked(db.auditLog.findFirst).mock.calls[0][0] as {
      where: { orgId: string; action: string; target: string };
      orderBy: { at: string };
    };
    expect(call.where).toEqual({
      orgId: "org_1",
      action: "brief.acknowledged",
      target: "org_1.engineering/brief:brief_1/acknowledged",
    });
    expect(call.orderBy).toEqual({ at: "desc" });
  });

  it("returns null when the brief has never been acknowledged", async () => {
    vi.mocked(db.auditLog.findFirst).mockResolvedValue(null as never);
    expect(
      await latestBriefAcknowledgement({ orgId: "org_1", scopePath: "org_1.engineering", briefId: "brief_1" }),
    ).toBeNull();
  });

  it("treats a missing/malformed metadata.stale as false rather than throwing", async () => {
    vi.mocked(db.auditLog.findFirst).mockResolvedValue({
      at: new Date("2026-09-19T02:00:00Z"),
      metadata: {},
    } as never);
    const result = await latestBriefAcknowledgement({
      orgId: "org_1",
      scopePath: "org_1.engineering",
      briefId: "brief_1",
    });
    expect(result?.stale).toBe(false);
  });
});
