// The one way an `audit_log` row is written.
//
// The one rule this file enforces: every audit row records the entry point its action
// came in through (`metadata.origin`, services/access/origin.ts), the source NIST AU-3
// asks every audit record for. `origin` is a required argument rather than a field a
// caller may remember to put in `metadata`, and it is written after the caller's
// metadata so no caller can overwrite it. eslint.audit-writer.mjs fails the build if
// any other file writes `audit_log`.
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import type { AuditOrigin } from "./origin";

/** One audit row, as a writer states it. `at` and `id` are assigned by the database. */
export interface AuditRowInput {
  orgId: string;
  /** "human", "agent", or "extraction" for a system job acting on its own. */
  actorType: string;
  actorId: string;
  action: string;
  target?: string | null;
  decision: "allow" | "deny";
  reason?: string | null;
  /** Row-specific detail. Must not carry `origin`: that is the argument below. */
  metadata?: Prisma.InputJsonObject;
  runId?: string | null;
  /** The entry point the audited action came in through. */
  origin: AuditOrigin;
}

/**
 * Append one audit row and return its id and the time the database stamped on it.
 *
 * @param client an open transaction when the row must commit with another write (the
 *   change event for the same ingest); the global client otherwise.
 */
export async function writeAuditRow(
  row: AuditRowInput,
  client: Pick<Prisma.TransactionClient, "auditLog"> = db,
): Promise<{ id: string; at: Date }> {
  return client.auditLog.create({
    data: {
      orgId: row.orgId,
      actorType: row.actorType,
      actorId: row.actorId,
      action: row.action,
      target: row.target,
      decision: row.decision,
      reason: row.reason,
      metadata: { ...row.metadata, origin: row.origin },
      runId: row.runId,
    },
  });
}
