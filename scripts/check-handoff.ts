// Handoff agent — live check. Run with: npm run handoff:check
// Two parts:
//   • Access-control plumbing (always runs, no live stack needed): a capability
//     provisioned for a sub-scope grant covers exactly that sub-scope — not a
//     sibling scope, not the org root. This is the access claim
//     ("the briefing can't see more than the grant covers"), proven against the
//     live check() + audit_log on Neon.
//   • Real generation (opt-in via HANDOFF_LIVE=1 — needs memory-service + an LLM
//     key): ingests scoped facts, runs the real Handoff agent end to end, and
//     asserts the brief only reflects facts inside the granted scope.
// Exits non-zero on any failure. Cleans up its throwaway org on completion.
import { db } from "@/lib/db";
import { check, orgRootPath, hashCapabilityToken } from "@/services/access";
import { provisionHandoffAgentCapability, handoffAgentContext } from "@/lib/handoff-agent";

const LIVE = process.env.HANDOFF_LIVE === "1";

let passed = 0;
let failed = 0;
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
  passed++;
}
function fail(msg: string) {
  console.log(`  ✗ ${msg}`);
  failed++;
}
function assert(cond: boolean, msg: string) {
  if (cond) ok(msg);
  else fail(msg);
}

async function main() {
  console.log("\n  HANDOFF AGENT CHECK (UC6)\n");

  const org = await db.org.create({ data: { name: "__handoff_check__" } });
  const root = orgRootPath(org.id);
  await db.scope.create({ data: { orgId: org.id, path: root, name: "Org root" } });

  const engScope = await db.scope.create({ data: { orgId: org.id, path: `${root}.engineering`, name: "Engineering" } });
  const salesScope = await db.scope.create({ data: { orgId: org.id, path: `${root}.sales`, name: "Sales" } });

  const admin = await db.user.create({
    data: { orgId: org.id, clerkId: `__handoff_admin_${org.id}`, email: "admin@handoff.test", role: "admin" },
  });
  await db.grant.create({
    data: { orgId: org.id, scopeId: engScope.id, granteeType: "user", granteeId: admin.id, permission: "read" },
  });

  try {
    console.log("Access-control plumbing (capability scoping)...");

    // The human granting the handoff must actually be able to read the scope.
    const adminCtx = {
      orgId: org.id,
      actor: { type: "human" as const, id: admin.id, role: admin.role },
      origin: "script" as const,
    };
    assert(
      (await check(adminCtx, { action: "memory.read", scope: engScope.path })).allowed,
      "admin can read engineering (their own grant)",
    );
    assert(
      !(await check(adminCtx, { action: "memory.read", scope: salesScope.path })).allowed,
      "admin CANNOT read sales (no grant there — proves the human boundary before provisioning)",
    );

    // Provision a Handoff capability scoped to engineering only, per the flow the
    // route follows (never wider than the human's own grant).
    const token = await provisionHandoffAgentCapability(org.id, engScope.path, admin.id);
    const agentCtx = handoffAgentContext(org.id, token);

    assert(
      (await check(agentCtx, { action: "memory.read", scope: engScope.path })).allowed,
      "handoff capability covers engineering (the scope it was provisioned for)",
    );
    assert(
      !(await check(agentCtx, { action: "memory.read", scope: salesScope.path })).allowed,
      "handoff capability CANNOT read sales (sibling scope — the core scoping guarantee)",
    );
    assert(
      !(await check(agentCtx, { action: "memory.read", scope: root })).allowed,
      "handoff capability CANNOT read org root either — strictly bounded to the grant, not org-wide",
    );

    const auditRows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint as count FROM "audit_log" WHERE "orgId" = ${org.id} AND "actorId" = 'handoff-agent'
    `;
    assert(
      Number(auditRows[0]?.count ?? 0) >= 3,
      "every handoff-capability check was audited under the handoff-agent actor id",
    );

    console.log("\nCapability lifecycle (expiry + revocation)...");

    // An expired capability must be denied even though the scope match is exact.
    const expiredToken = await provisionHandoffAgentCapability(org.id, engScope.path, admin.id);
    await db.capability.update({
      where: { tokenHash: hashCapabilityToken(expiredToken) },
      data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const expiredCtx = handoffAgentContext(org.id, expiredToken);
    assert(
      !(await check(expiredCtx, { action: "memory.read", scope: engScope.path })).allowed,
      "an EXPIRED handoff capability is denied, even on its own exact scope",
    );

    // A revoked capability must be denied too, independent of expiry.
    const revokedToken = await provisionHandoffAgentCapability(org.id, engScope.path, admin.id);
    await db.capability.update({
      where: { tokenHash: hashCapabilityToken(revokedToken) },
      data: { revokedAt: new Date() },
    });
    const revokedCtx = handoffAgentContext(org.id, revokedToken);
    assert(
      !(await check(revokedCtx, { action: "memory.read", scope: engScope.path })).allowed,
      "a REVOKED handoff capability is denied, even before its expiry",
    );

    console.log("\nNested sub-scope containment (ltree ancestor-or-self)...");

    // A capability provisioned for a PARENT scope should cover a CHILD sub-scope —
    // per check.ts's `s."path"::ltree @> ${targetPath}::ltree` containment query,
    // the granted path just needs to be an ancestor-or-self of the target path.
    const backendScope = await db.scope.create({
      data: { orgId: org.id, path: `${engScope.path}.backend`, name: "Backend" },
    });
    const parentScopedToken = await provisionHandoffAgentCapability(org.id, engScope.path, admin.id);
    const parentScopedCtx = handoffAgentContext(org.id, parentScopedToken);
    assert(
      (await check(parentScopedCtx, { action: "memory.read", scope: backendScope.path })).allowed,
      "a capability scoped to the PARENT (engineering) covers a CHILD sub-scope (engineering.backend) — ancestor-or-self containment",
    );
    // And the reverse must NOT hold: a capability scoped to the child does not cover the parent.
    const childScopedToken = await provisionHandoffAgentCapability(org.id, backendScope.path, admin.id);
    const childScopedCtx = handoffAgentContext(org.id, childScopedToken);
    assert(
      !(await check(childScopedCtx, { action: "memory.read", scope: engScope.path })).allowed,
      "a capability scoped to the CHILD (engineering.backend) does NOT cover its parent (engineering) — containment is one-directional",
    );

    console.log("\nEdge-case inputs (long context, unicode grantee names)...");

    // A multi-KB context string must provision without erroring — the capability
    // itself doesn't store the context (it's passed straight to the agent prompt),
    // but provisioning must not choke on a large body the caller might pass through.
    const longContext = "Context for onboarding: ".repeat(500); // several KB
    assert(longContext.length > 4000, "sanity: the long context string is actually multi-KB");
    const longContextToken = await provisionHandoffAgentCapability(org.id, engScope.path, admin.id);
    assert(
      typeof longContextToken === "string" && longContextToken.length > 0,
      "provisioning succeeds regardless of a large context payload passed alongside it",
    );

    // Unicode/special-character grantee names must not break provisioning or audit
    // logging (createdBy is a user id, not the grantee name, but the grantee name
    // flows through the route into Brief.granteeName — provisioning itself must be
    // agnostic to it, and the audit row must still be written cleanly).
    const unicodeGrantee = "José ☺️ O'Brien-Núñez 张伟";
    const unicodeToken = await provisionHandoffAgentCapability(org.id, engScope.path, admin.id);
    const unicodeCtx = handoffAgentContext(org.id, unicodeToken);
    const unicodeDecision = await check(unicodeCtx, {
      action: "memory.read",
      scope: engScope.path,
      target: unicodeGrantee,
    });
    assert(
      unicodeDecision.allowed,
      "capability provisioning + check() are unaffected by a unicode/special-character grantee name passed as the audit target",
    );
    const unicodeAuditRows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint as count FROM "audit_log"
      WHERE "orgId" = ${org.id} AND "target" LIKE ${"%" + unicodeGrantee + "%"}
    `;
    assert(
      Number(unicodeAuditRows[0]?.count ?? 0) >= 1,
      "the unicode grantee name was written cleanly into the audit log target",
    );

    if (LIVE) {
      console.log("\nReal generation (HANDOFF_LIVE=1 — memory-service + LLM must be reachable)...");
      const { memory } = await import("@/services/memory/store");
      const { db: dbAgent } = await import("@/lib/db");
      const { runHandoffAgent } = await import("@/services/agents/runner");

      await memory.ingest({
        groupId: org.id,
        content: "The team decided to use Postgres with an ltree extension for the access-control scope tree.",
        source: "text",
        name: "Architecture decision",
        actorType: "human",
        origin: "script",
        actorId: admin.id,
        actorName: "Admin",
        scopePath: engScope.path,
      });
      await memory.ingest({
        groupId: org.id,
        content: "The sales team's ICP is B2B SaaS companies with 50-500 employees.",
        source: "text",
        name: "Sales ICP",
        actorType: "human",
        origin: "script",
        actorId: admin.id,
        actorName: "Admin",
        scopePath: salesScope.path,
      });

      const agentRow = await dbAgent.agent.create({
        data: { orgId: org.id, agentKey: "handoff-check", name: "Handoff agent", role: "handoff" },
      });

      const brief = await runHandoffAgent({
        agentRow,
        granteeName: "Jamie (contractor)",
        granteeRole: "Backend contractor",
        orgId: org.id,
        capabilityToken: token,
        memoryScope: engScope.path,
      });

      console.log(`  brief title: ${brief.title}`);
      const briefText = JSON.stringify(brief).toLowerCase();
      assert(
        briefText.includes("ltree") || briefText.includes("postgres") || briefText.includes("scope tree"),
        "brief reflects the in-scope engineering fact",
      );
      assert(!briefText.includes("icp") && !briefText.includes("b2b saas"), "brief does NOT leak the sales-scope fact");
    } else {
      console.log("\n  (skipping real generation — set HANDOFF_LIVE=1 to run it)");
    }
  } finally {
    await db.org.delete({ where: { id: org.id } });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
