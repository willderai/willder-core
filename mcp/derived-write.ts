// The derived-write rule as memory_ingest applies it (services/access/derived-writes.ts):
// decide the write against the agent's session before anything is authorized or stored,
// then make a declared share visible once it is stored.
//
// The one rule: a refused write leaves a deny row and nothing else, and a declared share
// never lands quietly. Its `derivedFrom` edge is written with the version
// (services/memory/pgvector-store.ts), and this file adds the `memory.write.declassified`
// audit row and the change event in each source scope, in one transaction.
//
// The audit row and the change event live in the SOURCE scope and name the target. They
// tell the people who read the source where its content went; a reader of the target
// alone is told only that the fact was shared from a restricted scope.
import { can, type AccessContext, type DerivedAuditAction } from "@/services/access";
import { writeAuditRow } from "@/services/access/audit-row";
import { recordRefusal } from "@/services/access/refusal";
import {
  DerivedWriteRefusedError,
  decideDerivedWrite,
  derivedFromMarkers,
  derivedFromTargets,
} from "@/services/access/derived-writes";
import { recordEdges } from "@/services/memory/edges";
import { lockOrgChangeFeed, recordChangeEvent } from "@/services/memory/change-events";
import { db } from "@/lib/db";
import type { ResolvedCapability } from "./tools/tool-context";

/** The change feed's `recordType` for a declared share, announced in the source scope.
 * Its `recordId` is the stored version, or the audit row when the write is still queued. */
export const FACT_SHARE_RECORD_TYPE = "fact-share";

/** What a write shares from, once decided. Both lists are empty for an ordinary write. */
export interface DerivedShare {
  /** The declared source scopes, by path. */
  from: string[];
  /** What each one's `derivedFrom` edge names (derivedFromTargets), in the same order. */
  edgeTargets: string[];
}

const NO_SHARE: DerivedShare = { from: [], edgeTargets: [] };

/**
 * Decide a write into `target` under the derived-write rule.
 *
 * A caller that may not write `target` at all is left to check(), which refuses and
 * audits it as any other write; the rule only speaks to writers who could store.
 *
 * @throws DerivedWriteRefusedError after recording its deny row.
 */
export async function authorizeDerivedWrite(
  ctx: AccessContext,
  cap: ResolvedCapability,
  target: string,
  declared: readonly string[] | undefined,
): Promise<DerivedShare> {
  let from: string[];
  try {
    from = await decideDerivedWrite(db, { orgId: cap.orgId, agentId: cap.agentId, target, declared });
  } catch (e) {
    if (!(e instanceof DerivedWriteRefusedError)) throw e;
    if (!(await can(ctx, { action: "memory.write", scope: target })).allowed) return NO_SHARE;
    await recordRefusal(ctx, { action: "memory.write", target, auditReason: e.auditReason });
    throw e;
  }
  if (from.length === 0) return NO_SHARE;
  return { from, edgeTargets: await derivedFromTargets(db, cap.orgId, from) };
}

/**
 * Decide a write into `target` that has no way to declare a share, such as a working
 * note: it is allowed only when the agent id holds nothing from outside `target`'s subtree.
 * A refusal records its deny row as authorizeDerivedWrite does, and its reply names the
 * scopes without offering a declaration this write cannot make.
 *
 * @throws DerivedWriteRefusedError after recording its deny row.
 */
export async function authorizeUndeclaredWrite(
  ctx: AccessContext,
  cap: ResolvedCapability,
  target: string,
  what: string,
): Promise<void> {
  try {
    await authorizeDerivedWrite(ctx, cap, target, undefined);
  } catch (e) {
    if (!(e instanceof DerivedWriteRefusedError) || e.toDeclare === undefined) throw e;
    const named = e.toDeclare.map((path) => `"${path}"`).join(", ");
    throw new DerivedWriteRefusedError(
      `derived_write: this agent id was shown content stored in ${named}, which not every reader of ${target} can read, ` +
        `so the ${what} was not stored. A ${what} cannot declare a share. Send it from an agent that has not read ` +
        `${e.toDeclare.length === 1 ? "that scope" : "those scopes"}, or keep the content with memory_ingest and intentionalShareFrom.`,
      e.auditReason,
      e.toDeclare,
    );
  }
}

/**
 * Make a stored declared share visible: the `derivedFrom` edges (again, for a write whose
 * text was already stored and so wrote no new version), then, in one transaction, a
 * `memory.write.declassified` audit row and a change event in each source scope.
 */
export async function announceDerivedWrite(
  ctx: AccessContext,
  cap: ResolvedCapability,
  share: DerivedShare,
  stored: { target: string; versionId?: string },
): Promise<void> {
  if (share.from.length === 0) return;
  const actor = { type: "agent" as const, id: cap.agentId };
  if (stored.versionId) {
    await recordEdges(
      db,
      share.edgeTargets.map((toId) => ({
        orgId: cap.orgId,
        fromId: stored.versionId!,
        toId,
        kind: "derivedFrom" as const,
        scopePath: stored.target,
        actor,
      })),
    );
  }
  await db.$transaction(async (tx) => {
    await lockOrgChangeFeed(tx, cap.orgId);
    for (const source of share.from) {
      const row = await writeAuditRow(
        {
          orgId: cap.orgId,
          actorType: "agent",
          actorId: cap.agentId,
          action: "memory.write.declassified" satisfies DerivedAuditAction,
          target: source,
          decision: "allow",
          metadata: { sharedInto: stored.target, ...(stored.versionId ? { versionId: stored.versionId } : {}) },
          runId: ctx.runId,
          origin: ctx.origin,
        },
        tx,
      );
      await recordChangeEvent(tx, {
        orgId: cap.orgId,
        scopePath: source,
        recordType: FACT_SHARE_RECORD_TYPE,
        recordId: stored.versionId ?? row.id,
        op: "create",
        actorId: cap.agentId,
        actorType: "agent",
        origin: ctx.origin,
        title: `Shared into ${stored.target}: content read in ${source} was written there, declared by its writer`,
        authorizedById: row.id,
      });
    }
  });
}

/**
 * The derived-write marker of each version in `versionIds` for the reader `ctx`
 * (services/access/derived-writes.ts derivedFromMarkers), deciding readability of each
 * source scope without an audit row.
 */
export function derivedMarkersFor(ctx: AccessContext, versionIds: readonly string[]): Promise<Map<string, string>> {
  return derivedFromMarkers(
    db,
    ctx,
    versionIds,
    async (scope) => (await can(ctx, { action: "memory.read", scope })).allowed,
  );
}
