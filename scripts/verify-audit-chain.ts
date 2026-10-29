// Verifies the audit log's hash chain, for an administrator.
//
//   npm run audit:verify                 every org with audit rows
//   npm run audit:verify -- <orgId> ...  only these orgs
//
// Reads DATABASE_URL. Read-only, and safe to run while writes land: each org is
// read in one snapshot, so a row written mid-run is left out rather than read as
// a break. Prints one line per org: the rows verified, the rows with no position
// (normally those that predate the chain), and the head hash (as of that
// snapshot) to record somewhere the database cannot reach; on a break, the
// first broken position and why.
//
// Exits 1 if any chain is broken, even when another org could not be read, and
// 2 if nothing was found broken but an org, the org list or the tool itself
// could not be read or loaded (scripts/lib/verify-audit-orgs.ts).
import { errorText, verifyOrgs } from "./lib/verify-audit-orgs";

async function main(): Promise<0 | 1 | 2> {
  // Loaded here rather than at the top so that a load failure (an ungenerated
  // Prisma client, say) is caught below and exits 2: a broken tool must never
  // exit 1, which reads as a tampered log.
  const { db } = await import("@/lib/db");
  const { listAuditedOrgIds, verifyAuditChain } = await import("@/services/access/audit-chain");
  try {
    const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
    const orgIds = requested.length > 0 ? requested : await listAuditedOrgIds();
    return await verifyOrgs(orgIds, (orgId) => verifyAuditChain(orgId), { log: console.log, error: console.error });
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

// A reader that stops early (`| head`) closes stdout; that must not crash the
// run into exit 1. The exit code still carries the verdict.
process.stdout.on("error", () => undefined);

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`audit:verify could not read the audit log: ${errorText(err)}`);
    process.exitCode = 2;
  },
);
