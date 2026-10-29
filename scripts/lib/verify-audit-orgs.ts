/**
 * The decision behind `npm run audit:verify`: verify each org in turn and turn
 * the reports into the exit code an operator acts on.
 *
 *   0  every org was read and none is broken
 *   1  at least one org is broken, even if another org could not be read
 *   2  none was found broken, but an org could not be read: nothing was proven
 *
 * Kept apart from the script so a test can drive it without a database.
 */
import type { AuditChainReport } from "@/services/access/audit-chain";

/** Where the run's lines go: stdout and stderr in the real CLI. */
export interface VerifyOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Verifies each org in turn and returns the exit code. An org that cannot be
 * read is reported and the run goes on, so a read error never hides a break
 * found in another org.
 */
export async function verifyOrgs(
  orgIds: readonly string[],
  verify: (orgId: string) => Promise<AuditChainReport>,
  out: VerifyOutput,
): Promise<0 | 1 | 2> {
  let broken = 0;
  let unread = 0;
  for (const orgId of orgIds) {
    let report: AuditChainReport;
    try {
      report = await verify(orgId);
    } catch (err) {
      unread += 1;
      out.error(`audit:verify could not read the audit log of org ${orgId}: ${errorText(err)}`);
      continue;
    }
    const counts = `${report.verified} chained, ${report.unchained} unchained (no position: written before the chain, or around its trigger)`;
    if (report.ok) {
      out.log(`ok      ${orgId}: ${counts}; head ${report.head ? `${report.head.seq} ${report.head.hash}` : "none"}`);
    } else {
      broken += 1;
      out.log(`BROKEN  ${orgId}: ${report.firstBreak?.message}; ${report.verified} row(s) verified before it`);
    }
  }
  out.log(`${orgIds.length} org(s) checked, ${broken} broken${unread > 0 ? `, ${unread} could not be read` : ""}`);
  if (broken > 0) return 1;
  return unread > 0 ? 2 : 0;
}
