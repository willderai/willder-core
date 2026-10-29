// How long the audit log is kept, and the floor no configuration can go below.
//
// The one rule this file enforces: the configured retention is never shorter than six
// months (EU AI Act Art. 19 asks for at least six; ISO 27001 A.8.15 asks that logs be
// protected against deletion). The default is to keep every row forever.
//
// Nothing in this product purges audit rows, and the database would refuse it if
// something tried: prisma/migrations/20261006160000_audit_log_tamper_evident makes
// `audit_log` refuse UPDATE, DELETE and TRUNCATE for every non-superuser role. A purge
// would also have to cut the start off each org's hash chain, which the chain verifier
// (services/access/audit-chain.ts) would rightly report as rows missing. So a configured
// number of days is a commitment the export states, never a schedule anything deletes
// on: supporting a real purge needs a verifiable chain checkpoint first, and a deliberate
// exemption in that trigger.

/** The shortest retention allowed: 184 days, the longest any six calendar months run. */
export const AUDIT_RETENTION_FLOOR_DAYS = 184;

/** The environment variable that sets the retention: `forever` (the default) or a number of days. */
export const AUDIT_RETENTION_ENV = "AUDIT_LOG_RETENTION_DAYS";

/** The retention in force, as every audit export reports it. */
export type AuditRetentionPolicy =
  | { keep: "forever"; floorDays: number }
  | { keep: "days"; days: number; floorDays: number };

/** A retention setting that is malformed or shorter than the floor. */
export class AuditRetentionConfigError extends Error {}

/**
 * Reads the retention from `env`. Unset, empty or `forever` keeps rows forever; a whole
 * number of days at or above {@link AUDIT_RETENTION_FLOOR_DAYS} is accepted; anything
 * else throws {@link AuditRetentionConfigError} with a one-line message naming the fix.
 */
export function auditRetentionPolicy(env: Record<string, string | undefined> = process.env): AuditRetentionPolicy {
  const raw = env[AUDIT_RETENTION_ENV];
  if (raw === undefined || raw === "" || raw === "forever") {
    return { keep: "forever", floorDays: AUDIT_RETENTION_FLOOR_DAYS };
  }
  const days = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(days) || days < AUDIT_RETENTION_FLOOR_DAYS) {
    throw new AuditRetentionConfigError(
      `${AUDIT_RETENTION_ENV} must be "forever" or a whole number of days of at least ${AUDIT_RETENTION_FLOOR_DAYS} (six months); got ${JSON.stringify(raw)}. Unset it to keep audit rows forever.`,
    );
  }
  return { keep: "days", days, floorDays: AUDIT_RETENTION_FLOOR_DAYS };
}
