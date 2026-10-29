// The audit row of an admin's permanent removal of an out-of-service record.
//
// The rule this file enforces: a removal leaves exactly one `record.removed` row, written
// in the transaction that deletes the record, so the row exists if and only if the
// record is gone. The route's `access.manage` decision is written whether or not
// anything is then deleted, and names only the id asked for; this row says what
// actually went (its kind, id, scope and type, and for a rule its lineage) so a reader
// of the trail can explain why the record is missing.
//
// The row carries ids and type names only, never a record's name, title or subject.
// The audit log is append-only and person erasure (./person-erasure.ts) never rewrites
// it, so free text copied here, such as a brief titled after a contact, could never be
// erased. What the record was called stays on the change feed, where erasure blanks it.
import type { Prisma } from "@/lib/generated/prisma/client";
import type { AccessContext, DerivedAuditAction } from "@/services/access";
import { writeAuditRow } from "@/services/access/audit-row";

/** What was removed, as the audit row records it: ids and type names, never free text. */
export type RemovedRecord = { id: string; scopePath: string } & (
  | { kind: "source"; sourceType: string }
  | { kind: "brief"; briefType: string }
  | {
      kind: "convention";
      /** The ids of the versions this rule replaced. */
      supersedes: string[];
      /** The ids of the versions that replaced this rule. */
      supersededBy: string[];
    }
);

/** Write the `record.removed` row for `record`, inside the transaction that deleted it. */
export async function recordRemoval(
  tx: Pick<Prisma.TransactionClient, "auditLog">,
  ctx: AccessContext,
  record: RemovedRecord,
): Promise<void> {
  await writeAuditRow(
    {
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action: "record.removed" satisfies DerivedAuditAction,
      target: `${record.scopePath}/${record.kind}:${record.id}`,
      decision: "allow",
      metadata: { ...record },
      runId: ctx.runId,
      origin: ctx.origin,
    },
    tx,
  );
}
