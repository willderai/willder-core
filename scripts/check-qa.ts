// QA agent (UC8) — check. Run with: npm run qa:check
// Two parts:
//   • The SSRF / host allow-list guard (always runs, no stack): the QA agent may only
//     reach the target host(s) it was given — never loopback, private ranges, cloud
//     metadata, or an off-target host, no matter what the model asks. This is the
//     security spine of black-box testing and is pure logic, so it's asserted directly.
//   • Scoped capability plumbing (live on Neon): a QA capability provisioned for a
//     sub-scope grant covers exactly that sub-scope, not a sibling and not the org root
//     — same as the other agents (the run can't read wider than the human's grant).
// Exits non-zero on any failure. Cleans up its throwaway org.
import { db } from "@/lib/db";
import { check, orgRootPath } from "@/services/access";
import { provisionQaAgentCapability, qaAgentContext } from "@/lib/qa-agent";
import { resolveAndAssertAllowed } from "@/services/agents/qa-tools";

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
function blocks(pathOrUrl: string, base: string, allowed: string[], msg: string) {
  try {
    resolveAndAssertAllowed(pathOrUrl, base, allowed);
    fail(`${msg} (expected block, was allowed)`);
  } catch {
    ok(msg);
  }
}
function allows(pathOrUrl: string, base: string, allowed: string[], msg: string) {
  try {
    resolveAndAssertAllowed(pathOrUrl, base, allowed);
    ok(msg);
  } catch (e) {
    fail(`${msg} (expected allow, was blocked: ${e instanceof Error ? e.message : e})`);
  }
}

async function main() {
  console.log("\n  QA AGENT CHECK (UC8)\n");

  // ---- Part 1: allow-list / SSRF guard (pure) ----
  const base = "https://api.acme.com";
  const allowed = ["api.acme.com"];
  allows("/health", base, allowed, "relative path on the target host is allowed");
  allows("https://api.acme.com/v1/users", base, allowed, "absolute URL on the target host is allowed");
  blocks("https://evil.com/steal", base, allowed, "off-target host is blocked");
  blocks("http://127.0.0.1/", base, ["127.0.0.1"], "loopback is blocked even if listed");
  blocks("http://localhost:3000/", base, ["localhost:3000"], "localhost is blocked");
  blocks("http://169.254.169.254/latest/meta-data/", base, ["169.254.169.254"], "cloud metadata IP is blocked");
  blocks("http://10.0.0.5/", base, ["10.0.0.5"], "private 10.x is blocked");
  blocks("http://192.168.1.1/", base, ["192.168.1.1"], "private 192.168.x is blocked");
  blocks("ftp://api.acme.com/", base, allowed, "non-http(s) scheme is blocked");
  allows("/x", base, ["api.acme.com", "cdn.acme.com"], "multiple allowed hosts honored");
  blocks("https://cdn.acme.com/x", base, allowed, "host not in the list is blocked");

  // ---- Part 2: scoped capability plumbing (live on Neon) ----
  const org = await db.org.create({ data: { name: "__qa_check__" } });
  try {
    const root = orgRootPath(org.id);
    await db.scope.create({ data: { orgId: org.id, path: root, name: "Org root" } });
    const engScope = await db.scope.create({
      data: { orgId: org.id, path: `${root}.engineering`, name: "Engineering" },
    });
    const salesScope = await db.scope.create({ data: { orgId: org.id, path: `${root}.sales`, name: "Sales" } });

    const admin = await db.user.create({
      data: { orgId: org.id, clerkId: `__qa_admin_${org.id}`, email: "admin@qa.test", role: "admin" },
    });
    // Human holds a read grant on engineering only.
    await db.grant.create({
      data: { orgId: org.id, scopeId: engScope.id, granteeType: "user", granteeId: admin.id, permission: "read" },
    });

    // Provision a QA capability scoped to the engineering sub-scope (as the route does).
    const token = await provisionQaAgentCapability(org.id, engScope.path, admin.id);
    const ctx = qaAgentContext(org.id, token);

    const inScope = await check(ctx, { action: "memory.read", scope: engScope.path });
    assert(inScope.allowed, "QA capability can read its granted sub-scope");

    const sibling = await check(ctx, { action: "memory.read", scope: salesScope.path });
    assert(!sibling.allowed, "QA capability is DENIED a sibling scope");

    const rootRead = await check(ctx, { action: "memory.read", scope: root });
    assert(!rootRead.allowed, "QA capability is DENIED the org root (strictly bounded)");

    const write = await check(ctx, { action: "memory.write", scope: engScope.path });
    assert(!write.allowed, "QA capability is read-only (write denied)");
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
