// The last step of every backup restore (docs/consent-deletion-suite.md, "Restore
// procedure"), by hand: re-apply every org's erasures on the restored database, record that each
// org's are applied, and refuse to call the restore complete until every org's are.
//
// A deployment does this on its own: copying the suppression list back (the procedure's step 2)
// marks each org it adds entries to as due, check() refuses those orgs meanwhile, and the
// restore-completion job (lib/inngest/person-erasure.ts) runs the same pass within ten minutes.
// Run this to finish at once, or on a restored database no Inngest serves:
//
//   DATABASE_URL=<restored database> GRAPHITI_SERVICE_URL=<memory service> \
//   GRAPHITI_SERVICE_API_KEY=<key> bash scripts/run-check.sh scripts/complete-restore.ts
//
// Each org's re-apply runs as one of its owners or admins, or a member holding an admin grant on
// its root, whom check() must allow on the restored grants (services/memory/erasure-reapply.ts,
// completeRestore).
//
// Output: one JSON line per org (counts, never a value it removed), then one summary line.
// Exit 0 when every org's erasures are applied and none is due, 1 otherwise; sending it again
// completes a run that stopped part-way.
async function main(): Promise<number> {
  const { db } = await import("@/lib/db");
  const { completeRestore } = await import("@/services/memory/erasure-reapply");
  try {
    const completions = await completeRestore();
    for (const completion of completions) console.log(JSON.stringify(completion));
    const pending = completions.filter((c) => !c.applied).map((c) => c.orgId);
    console.log(
      JSON.stringify({ restoreComplete: pending.length === 0, orgs: completions.length, notApplied: pending }),
    );
    return pending.length === 0 ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`complete-restore: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
