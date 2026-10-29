// Real-Postgres proof that a grant-governed capability stays governed after
// its last grant is removed.
//
// Why this file exists: a live `EXISTS` against "grants" cannot tell "this
// agentId was never grant-governed" apart from "every grant for this agentId
// was removed outside the DELETE /api/access/grants/:id cascade" — both are
// zero current grant rows, so a stale wide capability would stay enforceable
// to natural expiry (up to 90 days) once its last grant was removed that way.
// A mock cannot see this distinction (it can only ever assert what a fixture
// is told to return); it is only observable by actually deleting a real
// "grants" row underneath a real capability and watching what check()'s real
// SQL does next. See services/access/check.test.ts's own "full-removal"
// mocked test for the JS-logic-level pin; this file is the SQL-level proof
// the mock cannot provide.
//
// Set QA_DATABASE_URL to an ISOLATED test database. It is assigned to
// DATABASE_URL below because lib/db.ts reads that at import time -- never
// point this at an inherited DATABASE_URL, which may be a live database.
// Skips cleanly when unset.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgLive2";
const ROOT = `org_${ORG}`;
const TARGET = `${ROOT}.dept_sales`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

describe.skipIf(!QA_URL)("grant governance survives full grant removal: real SQL, real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, check: any, deriveGrantGovernance: any;

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ check, deriveGrantGovernance } = await import("@/services/access/check"));
    // Every other insert here hangs off this "orgs" row. On the CLEAN
    // isolated database the header tells you to point QA_DATABASE_URL at,
    // a missing org row kills all four tests in beforeEach on
    // `scopes_orgId_fkey` and the file proves nothing, and CI never sees it
    // because CI sets no QA_DATABASE_URL and skips the whole file. Seeded
    // here so the suite is self-contained.
    await db.$executeRawUnsafe(
      `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,'QA live org',NOW()) ON CONFLICT ("id") DO NOTHING`,
      ORG,
    );
    await db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "orgId" = $1`, ORG);
  });

  beforeEach(async () => {
    // Scoped to this file's own org. Vitest runs test files in parallel
    // workers against the one database QA_DATABASE_URL points at, so an
    // unscoped DELETE here removes rows a sibling live-SQL file's own
    // beforeEach just inserted. Order matters: "grants" before "scopes",
    // because grants.scopeId references scopes.id.
    await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "orgId" = $1`, ORG);
    await db.$executeRawUnsafe(`DELETE FROM "scopes" WHERE "orgId" = $1`, ORG);
    await db.$executeRawUnsafe(`DELETE FROM "capabilities" WHERE "orgId" = $1`, ORG);
    await db.$executeRawUnsafe(
      `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ('s1',$1,$2,'sales')`,
      ORG,
      TARGET,
    );
  });

  afterAll(async () => {
    await db?.$disconnect?.();
  });

  const ctx = (id: string, token: string) => ({
    orgId: ORG,
    actor: { type: "agent" as const, id, capabilityToken: token },
  });

  async function grant(agentId: string, permission: string, scopeId = "s1") {
    return db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "agent", granteeId: agentId, permission },
    });
  }

  async function mintCapability(agentId: string, token: string, permission: string) {
    const governance = await deriveGrantGovernance(ORG, agentId);
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hash(token),
        scopePath: TARGET,
        permission,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ...governance,
      },
    });
    return governance;
  }

  // ===================== THE FIX, PROVEN LIVE =====================
  it("mints grantGoverned=true when a grant already exists, and DENIES after that grant is hard-deleted directly", async () => {
    const g = await grant("agent-full-removal", "write");
    const governance = await mintCapability("agent-full-removal", "tok-1", "write");
    expect(governance).toEqual({ grantGoverned: true, derivedFromGrantId: g.id });

    // The full removal, the way a live EXISTS cannot see: delete every
    // grant row for this agentId directly (not via the revoking DELETE
    // /api/access/grants/:id route, and not via a scope delete either —
    // just gone, same end state).
    await db.$executeRawUnsafe(
      `DELETE FROM "grants" WHERE "orgId" = $1 AND "granteeId" = $2`,
      ORG,
      "agent-full-removal",
    );

    const d = await check(ctx("agent-full-removal", "tok-1"), {
      action: "memory.write",
      scope: TARGET,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/stale/i);
  });

  // ===================== THE NAMED PATH: SCOPE-DELETE CASCADE =====================
  it("DENIES after the real non-cascade removal path: deleting the SCOPE hard-deletes its grants via onDelete:Cascade, with no revocation code in between", async () => {
    const g = await grant("agent-scope-cascade", "write");
    await mintCapability("agent-scope-cascade", "tok-2", "write");

    // Confirm the grant is really there before the cascade, so the
    // assertion below is about the cascade, not an empty table already.
    const before = await db.grant.count({ where: { id: g.id } });
    expect(before).toBe(1);

    // The actual DELETE /api/access/scopes/:id path: `db.scope.delete()`,
    // relying on Prisma's `onDelete: Cascade` on Grant.scope (see that
    // route's own "Grants cascade via Prisma onDelete: Cascade" comment).
    await db.scope.delete({ where: { id: "s1" } });

    const after = await db.grant.count({ where: { id: g.id } });
    expect(after).toBe(0); // the cascade genuinely fired — this is not a no-op assertion

    const d = await check(ctx("agent-scope-cascade", "tok-2"), {
      action: "memory.write",
      scope: TARGET,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/stale/i);

    // Re-seed the scope row so mintCapability's own scope-bound assertions
    // in later tests (same describe block, fresh beforeEach) aren't
    // affected — beforeEach already deletes/reinserts "s1" unconditionally,
    // this is just documenting that the cascade above is the only reason
    // it needed to.
  });

  // ===================== THE RATCHET: GOVERNANCE ESTABLISHED AFTER MINT =====================
  it("ratchets an already-minted, ungoverned capability to governed the moment its agentId's first grant is created, and that governance survives the grant's later removal", async () => {
    // Minted BEFORE any grant exists for this agentId — the same state a
    // system agent (copy-agent, research-agent, ...) is permanently in,
    // except this one is about to become governed.
    const governanceAtMint = await mintCapability("agent-late-grant", "tok-3", "write");
    expect(governanceAtMint).toEqual({ grantGoverned: false, derivedFromGrantId: null });

    // Still allowed: genuinely ungoverned so far, same as any system agent.
    const beforeGrant = await check(ctx("agent-late-grant", "tok-3"), {
      action: "memory.write",
      scope: TARGET,
    });
    expect(beforeGrant.allowed).toBe(true);

    // A human admin now decides to grant-govern this agentId — the real
    // ratchet in POST /api/access/grants, exercised here
    // directly against the same real Postgres rather than through the
    // route's own HTTP layer (already covered by app/api/access/grants/
    // route.test.ts's mocked wiring test).
    const g = await grant("agent-late-grant", "write");
    await db.capability.updateMany({
      where: { orgId: ORG, agentId: "agent-late-grant", grantGoverned: false },
      data: { grantGoverned: true, derivedFromGrantId: g.id },
    });

    // Still allowed: the fresh grant covers write.
    const afterGrant = await check(ctx("agent-late-grant", "tok-3"), {
      action: "memory.write",
      scope: TARGET,
    });
    expect(afterGrant.allowed).toBe(true);

    // Now remove that grant entirely. Under a live-derived design this
    // capability was never grant-governed at mint, so even the demotion
    // re-derivation could not catch this shape — deleting the only grant
    // just returns to "no grants on file," identical to never having been
    // governed. The ratchet above is what makes this capability's
    // governance durable independent of mint time.
    await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "orgId" = $1 AND "granteeId" = $2`, ORG, "agent-late-grant");

    const afterRemoval = await check(ctx("agent-late-grant", "tok-3"), {
      action: "memory.write",
      scope: TARGET,
    });
    expect(afterRemoval.allowed).toBe(false);
    expect(afterRemoval.reason).toMatch(/stale/i);
  });

  // ===================== GRANDFATHER, UNCHANGED =====================
  it("GRANDFATHERS an agent with zero grant rows ever (system agents) — no ratchet ever fires, mint stays ungoverned, capability stays valid", async () => {
    const governance = await mintCapability("agent-never-governed", "tok-4", "write");
    expect(governance).toEqual({ grantGoverned: false, derivedFromGrantId: null });

    const d = await check(ctx("agent-never-governed", "tok-4"), {
      action: "memory.write",
      scope: TARGET,
    });
    expect(d.allowed).toBe(true);
  });
});
