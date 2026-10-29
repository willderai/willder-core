// Re-apply an org's past person erasures after a database restore: step 3 of the
// restore procedure in docs/consent-deletion-suite.md, "Bar 3: after a backup restore".
//
// Run against the RESTORED database, once its suppression list has been copied back
// from the live one (step 2), before it serves any traffic:
//
//   DATABASE_URL=<restored database> GRAPHITI_SERVICE_URL=<memory service> \
//   GRAPHITI_SERVICE_API_KEY=<key> bash scripts/run-check.sh scripts/reapply-erasures.ts <orgId> <adminUserId>
//
// `adminUserId` is the person on whose behalf the erasures run: a user with
// `access.manage` on the org root, checked by `check()` against the restored
// grants, and named on every audit row the run writes. Prints one JSON line of
// counts and request ids, never a value it removed. Exit 0 on success, 1 when the run
// was refused or did not finish; sending it again completes a run that stopped part-way.
import type { AccessContext } from "@/services/access";

async function main(): Promise<void> {
  const [orgId, adminUserId] = process.argv.slice(2);
  if (!orgId || !adminUserId) {
    throw new Error("Usage: scripts/reapply-erasures.ts <orgId> <adminUserId>");
  }
  const { db } = await import("@/lib/db");
  const { reapplyErasures } = await import("@/services/memory/erasure-reapply");
  try {
    // The role comes from the restored database, never from the command line: a role
    // grant would otherwise let any id through by claiming to be an admin.
    const user = await db.user.findFirst({ where: { id: adminUserId, orgId }, select: { role: true } });
    if (!user) throw new Error(`no user ${adminUserId} in org ${orgId}`);
    const ctx: AccessContext = { orgId, actor: { type: "human", id: adminUserId, role: user.role }, origin: "script" };
    console.log(JSON.stringify({ orgId, ...(await reapplyErasures(ctx)) }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(`reapply-erasures: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
