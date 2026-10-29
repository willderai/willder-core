// Copy agent access path — live check. Run with: npm run campaigns:check
//
// This script used to also exercise a campaign/prospect/draft lifecycle and
// an opt-in live Groq draft generation — both deleted along with
// Campaign/CampaignProspect/Draft and services/drafting, with outbound sales.
// What's left is genuinely independent of that removal: the copy agent's access
// path (UC2 × UC4) still exists (lib/copy-agent.ts is shared "Test run" infra for
// EVERY agent, see app/api/agents/[id]/run/route.ts), so this still-relevant
// live check() + audit_log coverage is kept, just no longer under a misleadingly
// campaign-named header. (The script/package.json alias "campaigns:check" is
// left as-is — a rename is a good follow-up but out of scope for this removal.)
//
//   • The copy agent's access path (UC2 × UC4): a scoped capability lets the agent
//     read its scope (allowed, audited) but NOT a sibling scope (denied) — scoped access
//     applies to the drafting agent, end to end against the live check() + audit_log.
// Exits non-zero on any failure. Complements the mocked unit tests (*.test.ts).
import { db } from "@/lib/db";
import { check, generateCapabilityToken, hashCapabilityToken, orgRootPath } from "@/services/access";
import { provisionCopyAgentCapability, copyAgentContext, COPY_AGENT_ID } from "@/lib/copy-agent";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function checkCopyAgentAccess(orgId: string) {
  console.log("Copy agent access path (UC2 × UC4) on live check() + audit_log...");

  // Org-root, read-only capability (what the campaign-start route provisions): the
  // agent can read memory across the org root and the read is audited.
  // No person issues this check's token, so it carries a system label; any other
  // issuer that names nobody in the org is refused at mint.
  const token = await provisionCopyAgentCapability(orgId, "system:scripts/check-campaigns.ts");
  const ctx = copyAgentContext(orgId, token);
  const allow = await check(ctx, { action: "memory.read", target: "campaigns-check:root-read" });
  assert(allow.allowed, "copy agent reads memory under its org-root capability");

  const auditedAllow = await db.auditLog.findFirst({
    where: { orgId, actorType: "agent", actorId: COPY_AGENT_ID, decision: "allow" },
    orderBy: { at: "desc" },
  });
  assert(!!auditedAllow, "the agent's allowed read is written to the audit log");

  // A capability scoped to a CHILD scope must NOT read a sibling scope — containment.
  const scopedToSales = generateCapabilityToken();
  await db.capability.create({
    data: {
      orgId,
      agentId: "scoped-agent",
      tokenHash: hashCapabilityToken(scopedToSales),
      scopePath: `${orgRootPath(orgId)}.dept_sales`,
      permission: "read",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const scopedCtx = {
    orgId,
    actor: { type: "agent" as const, id: "scoped-agent", capabilityToken: scopedToSales },
    origin: "script" as const,
  };
  const denySibling = await check(scopedCtx, {
    action: "memory.read",
    scope: `${orgRootPath(orgId)}.dept_eng`,
    target: "campaigns-check:sibling",
  });
  assert(!denySibling.allowed, "a sales-scoped agent is DENIED reading the eng scope (default deny + containment)");
  const allowOwn = await check(scopedCtx, {
    action: "memory.read",
    scope: `${orgRootPath(orgId)}.dept_sales`,
    target: "campaigns-check:own",
  });
  assert(allowOwn.allowed, "the same agent reads within its own scope");
}

async function main() {
  console.log("Checking the copy agent's access path ...\n");
  const org = await db.org.create({ data: { name: "__campaigns_check__" } });
  try {
    await checkCopyAgentAccess(org.id);
    console.log("\nCampaigns check healthy.");
  } finally {
    await db.org.delete({ where: { id: org.id } }); // cascade removes capabilities/audit
  }
}

main()
  .catch((e) => {
    console.error("Campaigns check FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
