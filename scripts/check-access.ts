// UC2 access-control live check. Run any time with: npm run access:check
// Exercises the REAL check() against Neon — ltree scope containment, default deny,
// grants (user/role/everyone), time-bound expiry, agent capability tokens, and the
// audit log — on a throwaway org, then cleans up. Exits non-zero on any failure.
// Complements the unit tests (services/access/check.test.ts), which mock the DB.
import { db } from "@/lib/db";
import {
  check,
  orgRootPath,
  generateCapabilityToken,
  hashCapabilityToken,
  type AccessContext,
} from "@/services/access";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  console.log("Checking UC2 access control (check() + ltree + audit) on Neon...");

  // Throwaway tenant + a two-level scope tree (root → dept) + a member user.
  const org = await db.org.create({ data: { name: "__access_check__" } });
  const root = orgRootPath(org.id);
  const deptPath = `${root}.dept_sales`;
  const rootScope = await db.scope.create({ data: { orgId: org.id, path: root, name: "Org" } });
  await db.scope.create({ data: { orgId: org.id, path: deptPath, name: "Sales" } });
  const member = await db.user.create({
    data: { orgId: org.id, clerkId: "__ac_" + org.id, email: "m@willder.dev", role: "member" },
  });

  const ctx: AccessContext = {
    orgId: org.id,
    actor: { type: "human", id: member.id, role: "member" },
    origin: "script",
  };

  try {
    // 1. Default deny: a member with no grant cannot read.
    assert(!(await check(ctx, { action: "memory.read" })).allowed, "default deny: member read denied");

    // 2. Grant the member read on the root → now allowed.
    const grant = await db.grant.create({
      data: { orgId: org.id, scopeId: rootScope.id, granteeType: "user", granteeId: member.id, permission: "read" },
    });
    assert((await check(ctx, { action: "memory.read" })).allowed, "grant on root → member read allowed");

    // 3. ltree inheritance: a grant on the root covers a descendant scope.
    assert(
      (await check(ctx, { action: "memory.read", scope: deptPath })).allowed,
      "root grant covers descendant scope (ltree @>)",
    );

    // 4. Permission ranking: read does not satisfy write.
    assert(!(await check(ctx, { action: "memory.write" })).allowed, "read grant does not cover write");

    // 5. Narrow grant does NOT climb: move the grant to the dept; root read now denied.
    await db.grant.update({
      where: { id: grant.id },
      data: {
        scopeId: (await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: org.id, path: deptPath } } })).id,
      },
    });
    assert(
      !(await check(ctx, { action: "memory.read", scope: root })).allowed,
      "dept grant does not cover ancestor root",
    );
    assert((await check(ctx, { action: "memory.read", scope: deptPath })).allowed, "dept grant still covers dept");

    // 6. Time-bound expiry: an expired grant is ignored.
    await db.grant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert(!(await check(ctx, { action: "memory.read", scope: deptPath })).allowed, "expired grant denied");

    // 7. "everyone" baseline: a scope-common read grant lets any member read.
    await db.grant.create({
      data: { orgId: org.id, scopeId: rootScope.id, granteeType: "everyone", granteeId: "*", permission: "read" },
    });
    assert((await check(ctx, { action: "memory.read" })).allowed, "everyone baseline → member read allowed");

    // 8. Agent capability token: valid token covers, missing/expired denied.
    const token = generateCapabilityToken();
    await db.capability.create({
      data: {
        orgId: org.id,
        agentId: "agent_x",
        tokenHash: hashCapabilityToken(token),
        scopePath: root,
        permission: "read",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const agentCtx: AccessContext = {
      orgId: org.id,
      actor: { type: "agent", id: "agent_x", capabilityToken: token },
      origin: "script",
    };
    assert(
      (await check(agentCtx, { action: "memory.read", scope: deptPath })).allowed,
      "valid capability → agent read allowed (covers descendant)",
    );
    const badAgent: AccessContext = {
      orgId: org.id,
      actor: { type: "agent", id: "agent_x", capabilityToken: "wcap_nope" },
      origin: "script",
    };
    assert(!(await check(badAgent, { action: "memory.read" })).allowed, "unknown capability token denied");

    // 9. Audit: every check above wrote a row (allow + deny), tenant-scoped.
    const [allows, denies] = await Promise.all([
      db.auditLog.count({ where: { orgId: org.id, decision: "allow" } }),
      db.auditLog.count({ where: { orgId: org.id, decision: "deny" } }),
    ]);
    assert(allows > 0 && denies > 0, `audit log recorded both decisions (allow:${allows} deny:${denies})`);

    console.log("Access control healthy.");
  } finally {
    await db.org.delete({ where: { id: org.id } }); // cascade removes scopes/grants/capabilities/audit/user
  }
}

main()
  .catch((e) => {
    console.error("Access check FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
