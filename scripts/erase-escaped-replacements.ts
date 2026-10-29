// Find, and with --apply remove, versions that escaped person erasures made before erasures
// followed what replaced the versions they removed (services/memory/erasure-lineage-backfill.ts):
// a correction of a fact that named an erased person, which the erasure left stored.
//
//   DATABASE_URL=<database> npx tsx scripts/erase-escaped-replacements.ts <orgId|--all>
//   DATABASE_URL=<database> npx tsx scripts/erase-escaped-replacements.ts <orgId> <adminUserId> --apply
//
// (Not through scripts/run-check.sh, which passes the script no arguments.)
//
// Without --apply it only reads, and prints one JSON line per org: how many blanked versions it
// started from and the ids of the versions it would remove, never their text. `--all` in place of
// an org id reports every org that has run an erasure. With --apply it removes them for one org,
// on behalf of `adminUserId`, a user with `access.manage` on that org's root (checked against the
// database's own grants, and named on the audit rows). Removing a graph copy needs
// GRAPHITI_SERVICE_URL and GRAPHITI_SERVICE_API_KEY. A second run finds nothing more.
import type { AccessContext } from "@/services/access";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const [orgArg, adminUserId] = args.filter((a) => a !== "--apply");
  if (!orgArg || (apply && (!adminUserId || orgArg === "--all"))) {
    throw new Error("Usage: scripts/erase-escaped-replacements.ts <orgId|--all> | <orgId> <adminUserId> --apply");
  }
  const { db } = await import("@/lib/db");
  const backfill = await import("@/services/memory/erasure-lineage-backfill");
  try {
    if (!apply) {
      const orgIds =
        orgArg === "--all"
          ? (
              await db.erasureSuppression.findMany({
                distinct: ["orgId"],
                select: { orgId: true },
                orderBy: { orgId: "asc" },
              })
            ).map((r) => r.orgId)
          : [orgArg];
      for (const orgId of orgIds) {
        const { erasedVersions, replacements } = await backfill.findEscapedReplacements(orgId);
        console.log(JSON.stringify({ orgId, erasedVersions: erasedVersions.length, replacements }));
      }
      return;
    }
    // The role comes from the database, never from the command line.
    const user = await db.user.findFirst({ where: { id: adminUserId, orgId: orgArg }, select: { role: true } });
    if (!user) throw new Error(`no user ${adminUserId} in org ${orgArg}`);
    const ctx: AccessContext = {
      orgId: orgArg,
      actor: { type: "human", id: adminUserId!, role: user.role },
      origin: "script",
    };
    const result = await backfill.eraseEscapedReplacements(ctx);
    console.log(JSON.stringify({ orgId: orgArg, ...result, erasedVersions: result.erasedVersions.length }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(`erase-escaped-replacements: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
